/**
 * 多分身协同管理模块
 * 通过共享注册表文件 (~/.wf-switcher/instances.json) 实现:
 * - 实例注册/注销
 * - 账号占用锁 (切号时 acquireLock, 退出时 releaseLock)
 * - 冲突检测 (切号前检查目标账号是否被其他分身占用)
 * - 孤儿清理 (启动时清理已不存在的分身条目)
 * - 锁自动过期 (24h 未更新视为僵尸锁)
 * 开发者: Ti
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './logger';

const TAG = 'InstanceManager';

/** 锁过期时间: 24 小时 */
const LOCK_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** 单个实例条目 */
export interface InstanceEntry {
  /** 实例 ID: 主实例 = '__main__', 分身 = dataDir 路径 */
  id: string;
  /** 显示标签 */
  label: string;
  /** 数据目录 (用于判断实例是否还存在) */
  dataDir: string;
  /** 当前占用的账号邮箱 (小写) */
  lockedEmail?: string;
  /** 占锁时间戳 */
  lockedAt?: number;
  /** 最后活跃时间戳 */
  lastSeen?: number;
}

/** 注册表文件结构 */
interface InstanceRegistry {
  instances: InstanceEntry[];
}

export class InstanceManager {
  /** 注册表目录 */
  private static REGISTRY_DIR = path.join(os.homedir(), '.wf-switcher');
  /** 注册表文件 */
  private static REGISTRY_FILE = path.join(InstanceManager.REGISTRY_DIR, 'instances.json');

  private context: vscode.ExtensionContext;
  private registry: InstanceRegistry = { instances: [] };
  private myInstanceId: string = '';

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.myInstanceId = this.resolveMyInstanceId();

    this.loadRegistry();
    this.cleanupOrphaned();
    this.ensureRegistered();

    log('info', TAG, `实例已注册: ${this.myInstanceId} (${this.isMainInstance() ? '主实例' : '分身'})`);
  }

  // ─── 公开 API ───────────────────────────────────────────

  /**
   * 获取当前实例 ID
   * @returns 主实例返回 '__main__', 分身返回 dataDir 路径
   */
  getMyInstanceId(): string {
    return this.myInstanceId;
  }

  /** 当前是否主实例 (使用 Windsurf 默认数据目录) */
  isMainInstance(): boolean {
    return this.myInstanceId === '__main__';
  }

  /**
   * 占用账号锁
   * @param email - 要占用的账号邮箱
   */
  acquireLock(email: string): void {
    this.reloadRegistry();
    const me = this.findMyEntry();
    if (me) {
      me.lockedEmail = email.toLowerCase();
      me.lockedAt = Date.now();
      me.lastSeen = Date.now();
      this.saveRegistry();
      log('info', TAG, `已占锁: ${email}`);
    }
  }

  /** 释放当前实例的锁 */
  releaseLock(): void {
    this.reloadRegistry();
    const me = this.findMyEntry();
    if (me) {
      const prev = me.lockedEmail;
      me.lockedEmail = undefined;
      me.lockedAt = undefined;
      me.lastSeen = Date.now();
      this.saveRegistry();
      if (prev) {
        log('info', TAG, `已释放锁: ${prev}`);
      }
    }
  }

  /**
   * 获取其他实例占用的邮箱集合 (已过滤过期锁)
   * @returns 其他实例正在使用的邮箱 Set (小写)
   */
  getOtherLockedEmails(): Set<string> {
    this.reloadRegistry();
    const myId = this.myInstanceId;
    const now = Date.now();

    return new Set(
      this.registry.instances
        .filter(i => {
          if (i.id === myId) { return false; }
          if (!i.lockedEmail) { return false; }
          /* 24h 过期检查 */
          if (i.lockedAt && (now - i.lockedAt) > LOCK_EXPIRY_MS) { return false; }
          return true;
        })
        .map(i => i.lockedEmail!.toLowerCase())
    );
  }

  /**
   * 检查指定邮箱是否被其他实例占用
   * @param email - 要检查的邮箱
   * @returns 占用该邮箱的实例信息, 没占用返回 null
   */
  getConflictInstance(email: string): InstanceEntry | null {
    this.reloadRegistry();
    const myId = this.myInstanceId;
    const now = Date.now();
    const target = email.toLowerCase();

    return this.registry.instances.find(i => {
      if (i.id === myId) { return false; }
      if (i.lockedEmail?.toLowerCase() !== target) { return false; }
      if (i.lockedAt && (now - i.lockedAt) > LOCK_EXPIRY_MS) { return false; }
      return true;
    }) || null;
  }

  /** 获取所有实例信息 (给 UI 面板用): 注册表 + 磁盘 profiles 合并 */
  getAllInstances(): InstanceEntry[] {
    this.reloadRegistry();
    const result = [...this.registry.instances];

    /** Windows 路径大小写不敏感 + 去尾斜杠 */
    const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
    const knownDirs = new Set(result.map(i => norm(i.dataDir || i.id)));

    /* 扫描磁盘 profiles 目录，把未注册的分身也列出来 */
    const profilesDir = path.join(os.homedir(), '.wf-switcher', 'profiles');
    if (fs.existsSync(profilesDir)) {
      try {
        for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) { continue; }
          const profilePath = path.join(profilesDir, entry.name);
          if (!knownDirs.has(norm(profilePath))) {
            result.push({
              id: profilePath,
              label: `分身: ${entry.name}`,
              dataDir: profilePath,
              lockedEmail: undefined,
              lockedAt: undefined,
              lastSeen: undefined
            });
          }
        }
      } catch { /* 读取失败忽略 */ }
    }

    return result;
  }

  /**
   * 删除分身 (删除磁盘数据 + 注册表条目)
   * @param profileName - 分身目录名
   */
  deleteProfile(profileName: string): boolean {
    const profileDir = path.join(os.homedir(), '.wf-switcher', 'profiles', profileName);

    /* 1. 从注册表移除 */
    this.reloadRegistry();
    this.registry.instances = this.registry.instances.filter(i => {
      const normalize = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
      return normalize(i.id) !== normalize(profileDir) && normalize(i.dataDir) !== normalize(profileDir);
    });
    this.saveRegistry();

    /* 2. 删除磁盘目录 */
    if (fs.existsSync(profileDir)) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        log('info', TAG, `已删除分身目录: ${profileDir}`);
        return true;
      } catch (err: any) {
        log('error', TAG, `删除分身目录失败: ${err.message}`);
        return false;
      }
    }
    return true;
  }

  /** 更新心跳 (lastSeen), 保持锁不过期 */
  heartbeat(): void {
    this.reloadRegistry();
    const me = this.findMyEntry();
    if (me) {
      me.lastSeen = Date.now();
      if (me.lockedEmail) {
        me.lockedAt = Date.now(); /* 续锁 */
      }
      this.saveRegistry();
    }
  }

  /**
   * 为即将启动的分身预占锁 (创建分身时调用)
   * 在注册表里新增/更新该分身条目, 写入 lockedEmail
   * 这样下一次 getOtherLockedEmails() 就能看到它, 避免多个分身选同一个账号
   * @param profileDir - 分身数据目录绝对路径
   * @param email - 要预占的账号邮箱
   */
  preLockForProfile(profileDir: string, email: string): void {
    this.reloadRegistry();
    const normalize = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
    const normDir = normalize(profileDir);

    let entry = this.registry.instances.find(
      i => normalize(i.id) === normDir || normalize(i.dataDir) === normDir
    );
    if (!entry) {
      const profileName = profileDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
      entry = {
        id: profileDir,
        label: `分身 (${profileName})`,
        dataDir: profileDir,
        lastSeen: Date.now()
      };
      this.registry.instances.push(entry);
    }
    entry.lockedEmail = email.toLowerCase();
    entry.lockedAt = Date.now();
    this.saveRegistry();
    log('info', TAG, `预占锁: ${email} → ${profileDir}`);
  }

  /** 注销当前实例 (扩展停用时调用) */
  unregister(): void {
    this.reloadRegistry();
    const myNorm = InstanceManager.normPath(this.myInstanceId);
    this.registry.instances = this.registry.instances.filter(i =>
      InstanceManager.normPath(i.id) !== myNorm && InstanceManager.normPath(i.dataDir) !== myNorm
    );
    this.saveRegistry();
    log('info', TAG, `实例已注销: ${this.myInstanceId}`);
  }

  // ─── 内部逻辑 ───────────────────────────────────────────

  /** 推导当前实例 ID */
  private resolveMyInstanceId(): string {
    const myDataDir = this.getMyDataDir();
    const defaultDir = this.getDefaultWindsurfDataDir();

    /* 路径比较: 忽略大小写 + 末尾分隔符 */
    const normalize = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
    if (normalize(myDataDir) === normalize(defaultDir)) {
      return '__main__';
    }
    return myDataDir;
  }

  /**
   * 当前实例数据目录
   * 从 context.globalStorageUri 向上 3 层推导:
   * globalStorageUri = .../Windsurf/User/globalStorage/Ti.wf-switcher
   * 上 3 层 = .../Windsurf
   */
  getMyDataDir(): string {
    const gs = this.context.globalStorageUri?.fsPath || '';
    return path.resolve(gs, '..', '..', '..');
  }

  /** Windsurf 默认数据目录 */
  private getDefaultWindsurfDataDir(): string {
    switch (process.platform) {
      case 'win32':
        return path.join(process.env.APPDATA || '', 'Windsurf');
      case 'darwin':
        return path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf');
      default: /* linux */
        return path.join(os.homedir(), '.config', 'Windsurf');
    }
  }

  /** 加载注册表 (容错: JSON 坏了就重置) */
  private loadRegistry(): void {
    try {
      if (fs.existsSync(InstanceManager.REGISTRY_FILE)) {
        const raw = fs.readFileSync(InstanceManager.REGISTRY_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.instances)) {
          this.registry = parsed;
          return;
        }
      }
    } catch (err: any) {
      log('warn', TAG, `注册表解析失败, 将重置: ${err.message}`);
    }
    this.registry = { instances: [] };
  }

  /** 重新从文件加载 (避免多实例写冲突) */
  private reloadRegistry(): void {
    this.loadRegistry();
  }

  /** 保存注册表 */
  private saveRegistry(): void {
    try {
      fs.mkdirSync(InstanceManager.REGISTRY_DIR, { recursive: true });
      fs.writeFileSync(
        InstanceManager.REGISTRY_FILE,
        JSON.stringify(this.registry, null, 2),
        'utf-8'
      );
    } catch (err: any) {
      log('error', TAG, `注册表保存失败: ${err.message}`);
    }
  }

  /** 确保当前实例已注册 */
  private ensureRegistered(): void {
    const existing = this.findMyEntry();
    if (existing) {
      /* 校正 id: preLockForProfile 写入的 id 可能与本实例推导的 id 大小写/斜杠不同 */
      if (existing.id !== this.myInstanceId && this.myInstanceId !== '__main__') {
        existing.id = this.myInstanceId;
      }
      existing.dataDir = this.getMyDataDir();
      existing.lastSeen = Date.now();
      this.saveRegistry();
      return;
    }

    const entry: InstanceEntry = {
      id: this.myInstanceId,
      label: this.myInstanceId === '__main__' ? '主实例' : `分身 (${path.basename(this.getMyDataDir())})`,
      dataDir: this.getMyDataDir(),
      lastSeen: Date.now(),
    };
    this.registry.instances.push(entry);
    this.saveRegistry();
  }

  /** Windows 路径归一化: 去尾斜杠 + 全小写 */
  private static normPath(p: string): string {
    return p.replace(/[\\/]+$/, '').toLowerCase();
  }

  /** 找到当前实例在注册表中的条目 (路径归一化匹配, 兼容大小写/斜杠差异) */
  private findMyEntry(): InstanceEntry | undefined {
    if (this.myInstanceId === '__main__') {
      return this.registry.instances.find(i => i.id === '__main__');
    }
    const myNorm = InstanceManager.normPath(this.myInstanceId);
    return this.registry.instances.find(i =>
      InstanceManager.normPath(i.id) === myNorm || InstanceManager.normPath(i.dataDir) === myNorm
    );
  }

  /**
   * 清理孤儿条目:
   * 1. dataDir 不存在的实例 (已删除)
   * 2. lastSeen 超过 7 天的实例 (长期离线)
   */
  private cleanupOrphaned(): void {
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const before = this.registry.instances.length;

    this.registry.instances = this.registry.instances.filter(i => {
      /* 主实例不按 dataDir 清理 (默认目录总是存在) */
      if (i.id !== '__main__' && !fs.existsSync(i.dataDir)) {
        log('info', TAG, `清理孤儿实例: ${i.id} (目录不存在)`);
        return false;
      }
      /* 7 天没活跃的清掉 */
      if (i.lastSeen && (now - i.lastSeen) > sevenDays) {
        log('info', TAG, `清理过期实例: ${i.id} (离线 > 7 天)`);
        return false;
      }
      return true;
    });

    if (this.registry.instances.length < before) {
      this.saveRegistry();
    }
  }
}
