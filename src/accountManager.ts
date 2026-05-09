/**
 * 账号管理模块
 * 使用 VS Code globalState 存储账号数据，本地安全存储
 * 开发者: Ti
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { AccountInfo, AuthStrategy, GroupInfo } from './types';
import { log } from './logger';
import { signInWithPassword, refreshIdToken } from './firebaseAuth';
import { registerUser } from './windsurfApi';
import { passwordLogin as devinPasswordLogin } from './devinAuth';
import { runAuthChain } from './postAuthChain';

const TAG = 'AccountManager';
const STORAGE_KEY = 'wfSwitcher.accounts';
const ACTIVE_KEY = 'wfSwitcher.activeAccountId';
const GROUPS_KEY = 'wfSwitcher.groups';

/** 文件备份目录: ~/.wf-swap/ (不随扩展卸载而删除) */
const BACKUP_DIR = path.join(os.homedir(), '.wf-swap');
const BACKUP_ACCOUNTS_FILE = path.join(BACKUP_DIR, 'accounts.json');
const BACKUP_GROUPS_FILE = path.join(BACKUP_DIR, 'groups.json');
const BACKUP_ACTIVE_FILE = path.join(BACKUP_DIR, 'active.json');

/* Lite 版本已移除历史系统分组. 保留老 ID 仅用于启动迁移. */
const LEGACY_UNTRIAL_GROUP_ID = '__system_untrial__';

export class AccountManager {
  private accounts: AccountInfo[] = [];
  private groups: GroupInfo[] = [];
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.loadAccounts();
    this.loadGroups();
    /* 启动迁移: 老用户从主线升级到 lite 时清理遗留系统分组 */
    void this.cleanupLegacyUntrialGroup();
  }

  /**
   * 启动迁移 (Lite 专用): 清理遗留系统分组
   *
   * 场景: 老用户从主线版 升级到 lite 版本, globalState 中仍有
   * id=__system_untrial__ 的分组. Lite 已不再保留该系统分组, 需要自动清理.
   *
   * 迁移动作:
   *   1. 如果分组存在: 把里面账号的 groupId 清空 (变为未分组)
   *   2. 从分组列表中删除该分组
   *   3. 持久化变更
   * 幂等: 多次启动重复调用不会出错 (find 不到直接返回)
   */
  private async cleanupLegacyUntrialGroup(): Promise<void> {
    const idx = this.groups.findIndex(g => g.id === LEGACY_UNTRIAL_GROUP_ID);
    if (idx < 0) { return; }

    /* 1) 清空账号上的 groupId 引用 */
    let movedCount = 0;
    for (const a of this.accounts) {
      if (a.groupId === LEGACY_UNTRIAL_GROUP_ID) {
        a.groupId = undefined;
        movedCount++;
      }
    }
    /* 2) 删除分组 */
    this.groups.splice(idx, 1);
    /* 3) 持久化 */
    if (movedCount > 0) { await this.saveAccounts(); }
    await this.saveGroups();
    log('info', TAG, `Lite 迁移: 已清理遗留系统分组 (${movedCount} 个账号转为未分组)`);
  }

  /** 判断分组是否为系统分组 (Lite 版无系统分组) */
  isSystemGroup(_groupId: string): boolean {
    return false;
  }

  /** 从持久化存储加载账号 (globalState 优先, 为空时从文件备份恢复) */
  private loadAccounts(): void {
    let data = this.context.globalState.get<AccountInfo[]>(STORAGE_KEY, []);
    if (data.length === 0) {
      /* globalState 为空 (可能是重装后丢失), 尝试从文件备份恢复 */
      const backup = this.readBackupFile<AccountInfo[]>(BACKUP_ACCOUNTS_FILE);
      if (backup && backup.length > 0) {
        data = backup;
        log('info', TAG, `从文件备份恢复了 ${data.length} 个账号`);
        /* 异步回写 globalState */
        void this.context.globalState.update(STORAGE_KEY, data);
      }
    }
    /* 回填 createdAt: 老账号没有此字段, 补上当前时间 */
    const nowSec = Math.floor(Date.now() / 1000);
    let backfilled = false;
    for (const a of data) {
      if (!a.createdAt) {
        a.createdAt = nowSec;
        backfilled = true;
      }
    }
    if (backfilled) {
      void this.context.globalState.update(STORAGE_KEY, data);
    }
    this.accounts = data;
    log('info', TAG, `已加载 ${this.accounts.length} 个账号`);
  }

  /** 持久化保存账号 (同时写文件备份) */
  private async saveAccounts(): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, this.accounts);
    this.writeBackupFile(BACKUP_ACCOUNTS_FILE, this.accounts);
  }

  /** 从持久化存储加载分组 (globalState 优先, 为空时从文件备份恢复) */
  private loadGroups(): void {
    let data = this.context.globalState.get<GroupInfo[]>(GROUPS_KEY, []);
    if (data.length === 0) {
      const backup = this.readBackupFile<GroupInfo[]>(BACKUP_GROUPS_FILE);
      if (backup && backup.length > 0) {
        data = backup;
        log('info', TAG, `从文件备份恢复了 ${data.length} 个分组`);
        void this.context.globalState.update(GROUPS_KEY, data);
      }
    }
    this.groups = data;
    log('info', TAG, `已加载 ${this.groups.length} 个分组`);
  }

  /** 持久化保存分组 (同时写文件备份) */
  private async saveGroups(): Promise<void> {
    await this.context.globalState.update(GROUPS_KEY, this.groups);
    this.writeBackupFile(BACKUP_GROUPS_FILE, this.groups);
  }

  /* ---------- 文件备份读写 ---------- */

  /** 确保备份目录存在 */
  private ensureBackupDir(): void {
    try {
      if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
      }
    } catch (e: any) {
      log('warn', TAG, `创建备份目录失败: ${e.message}`);
    }
  }

  /** 写文件备份 (同步, 不影响主流程) */
  private writeBackupFile(filePath: string, data: any): void {
    try {
      this.ensureBackupDir();
      fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
    } catch (e: any) {
      log('warn', TAG, `写入备份文件失败 ${filePath}: ${e.message}`);
    }
  }

  /** 读文件备份 */
  private readBackupFile<T>(filePath: string): T | null {
    try {
      if (!fs.existsSync(filePath)) { return null; }
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as T;
    } catch (e: any) {
      log('warn', TAG, `读取备份文件失败 ${filePath}: ${e.message}`);
      return null;
    }
  }

  /** 获取所有分组 */
  getGroups(): GroupInfo[] {
    return [...this.groups];
  }

  /**
   * 新建分组
   * @param name - 分组名称（重名返回已存在的组）
   * @param color - 可选颜色
   * @returns 新建或已存在的分组
   */
  async addGroup(name: string, color?: string): Promise<GroupInfo> {
    const trimmed = name.trim();
    if (!trimmed) { throw new Error('分组名不能为空'); }
    const existed = this.groups.find(g => g.name === trimmed);
    if (existed) { return existed; }

    const group: GroupInfo = {
      id: uuidv4(),
      name: trimmed,
      color,
      createdAt: Date.now()
    };
    this.groups.push(group);
    await this.saveGroups();
    log('info', TAG, `新建分组: ${trimmed}`);
    return group;
  }

  /**
   * 重命名分组 (系统分组不可重命名)
   * @returns true 表示成功
   */
  async renameGroup(groupId: string, newName: string): Promise<boolean> {
    if (this.isSystemGroup(groupId)) {
      log('warn', TAG, `系统分组不可重命名: ${groupId}`);
      return false;
    }
    const group = this.groups.find(g => g.id === groupId);
    if (!group) { return false; }
    const trimmed = newName.trim();
    if (!trimmed || trimmed === group.name) { return false; }
    group.name = trimmed;
    await this.saveGroups();
    log('info', TAG, `分组重命名: ${groupId} -> ${trimmed}`);
    return true;
  }

  /**
   * 删除分组 (系统分组不可删除); 组内账号的 groupId 会被清空 (变为未分组)
   */
  async deleteGroup(groupId: string): Promise<void> {
    if (this.isSystemGroup(groupId)) {
      log('warn', TAG, `系统分组不可删除: ${groupId}`);
      return;
    }
    this.groups = this.groups.filter(g => g.id !== groupId);
    /* 清理账号上的分组引用 */
    let accChanged = false;
    for (const acc of this.accounts) {
      if (acc.groupId === groupId) {
        acc.groupId = undefined;
        accChanged = true;
      }
    }
    await this.saveGroups();
    if (accChanged) { await this.saveAccounts(); }
    log('info', TAG, `已删除分组: ${groupId}`);
  }

  /**
   * 设置账号的分组
   * @param accountId - 账号 ID
   * @param groupId - 目标分组 ID，传 undefined / 空字符串表示移出分组
   */
  async assignAccountGroup(accountId: string, groupId?: string): Promise<boolean> {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account) { return false; }
    const newGroupId = groupId && groupId.length > 0 ? groupId : undefined;
    if (account.groupId === newGroupId) { return false; }
    account.groupId = newGroupId;
    await this.saveAccounts();
    return true;
  }

  /** 获取所有账号 */
  getAccounts(): AccountInfo[] {
    return [...this.accounts];
  }

  /** 获取当前活跃账号 (globalState 优先, 为空时从文件备份恢复) */
  getActiveAccount(): AccountInfo | undefined {
    let activeId = this.context.globalState.get<string>(ACTIVE_KEY);
    if (!activeId) {
      const backup = this.readBackupFile<{ activeAccountId?: string }>(BACKUP_ACTIVE_FILE);
      if (backup?.activeAccountId) {
        activeId = backup.activeAccountId;
        void this.context.globalState.update(ACTIVE_KEY, activeId);
        log('info', TAG, `从文件备份恢复了活跃账号 ID`);
      }
    }
    return this.accounts.find(a => a.id === activeId);
  }

  /** 设置活跃账号 */
  async setActiveAccount(accountId: string): Promise<void> {
    /* 先把所有账号标记为非活跃 */
    this.accounts.forEach(a => { a.isActive = false; });

    const account = this.accounts.find(a => a.id === accountId);
    if (account) {
      account.isActive = true;
      await this.context.globalState.update(ACTIVE_KEY, accountId);
      this.writeBackupFile(BACKUP_ACTIVE_FILE, { activeAccountId: accountId });
      await this.saveAccounts();
      log('info', TAG, `已切换到: ${account.email}`);
    }
  }

  /**
   * 获取下一个可用账号 (用于配额耗尽自动切换)
   *
   * 选号策略 (v1.2.6 改为"按到期时间升序"，优先使用快到期账号):
   *   1. 排除当前活跃账号 (即正被替换的这个)
   *   2. 排除 planEndAt 已过期的账号 (套餐已死)
   *   3. 剩余候选按优先级排序:
   *        A. 已刷过配额 && 有 planEndAt → 按 planEndAt 升序 (越快到期越先用，"用完就扔")
   *        B. 已刷过配额 && 无 planEndAt (如 Pro/Free 长期号) → 次级优先
   *        C. 从未刷过配额的账号 → 最低优先级 (数据不确定，兜底候选)
   *   4. 同优先级二级排序: dailyQuota 降序 (配额更多的先用)
   *   5. 额度过滤:
   *      a. 周配额 = 0 → 排除 (本周已耗尽, 完全不可用)
   *      b. 日配额 ≤ threshold → 排除 (今日额度不足)
   *      c. 未刷过的允许作为兜底
   *
   * @param threshold - 日配额阈值 (百分比)，低于此视为不够用
   */
  getNextAvailableAccount(threshold: number = 5, excludeEmails?: Set<string>, planType?: string): AccountInfo | undefined {
    const activeId = this.context.globalState.get<string>(ACTIVE_KEY);
    const nowSec = Math.floor(Date.now() / 1000);

    /* 候选池过滤 */
    const candidates = this.accounts.filter(a => {
      if (a.id === activeId) { return false; }
      /* 排除被其他分身占用的账号 */
      if (excludeEmails && a.email && excludeEmails.has(a.email.toLowerCase())) { return false; }
      /* 按订阅类型过滤 (All 或空 = 不限制) */
      if (planType && planType !== 'All' && a.planName) {
        if (a.planName.toLowerCase() !== planType.toLowerCase()) { return false; }
      }
      /* 已过期的套餐不考虑 (planEndAt 是 unix 秒) */
      if (a.planEndAt && a.planEndAt < nowSec) { return false; }
      /* 周配额已耗尽 → 本周完全不可用 */
      if (a.weeklyQuota !== undefined && a.weeklyQuota <= 0) { return false; }
      /* 日配额 ≤ threshold → 今日额度不足 */
      if (a.dailyQuota !== undefined && a.dailyQuota <= threshold) { return false; }
      return true;
    });

    if (candidates.length === 0) { return undefined; }

    /* 计算排序主键：越小越优先 */
    const sortKey = (a: AccountInfo): number => {
      if (a.dailyQuota === undefined) {
        /* 从未刷过 → 最低优先级 (兜底候选) */
        return Number.MAX_SAFE_INTEGER;
      }
      if (!a.planEndAt) {
        /* 已刷过但没有到期信息 (可能是 Pro/Free 长期号) → 次低优先级 */
        return Number.MAX_SAFE_INTEGER - 1;
      }
      /* 有到期信息 → 越早越优先 */
      return a.planEndAt;
    };

    candidates.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      if (ka !== kb) { return ka - kb; }
      /* 同优先级：dailyQuota 高的先 (undefined 视为 -1，排后) */
      const qa = a.dailyQuota ?? -1;
      const qb = b.dailyQuota ?? -1;
      return qb - qa;
    });

    return candidates[0];
  }

  /**
   * 批量导入账号
   *
   * 解析文本 → 保存基础字段 (邮箱 / 密码 / refresh_token / auth1_token)
   * 导入后由 balanceChecker.refreshByIds 统一做登录 + 拉配额
   *
   * 支持格式:
   *   邮箱;密码                              普通密码
   *   邮箱;rt:refresh_token                 Firebase refresh token (旧版)
   *   邮箱;auth1:auth1_xxxx                 Devin auth1 token (新版)
   *   邮箱----密码 / 邮箱 密码 / 邮箱,密码   分隔符通用
   *   邮箱 密码----WFT-XXXX                 卡密后缀自动剥离
   *
   * @param text - 多行文本
   * @param onProgress - 进度回调 (current, total, email, status)
   *                     status 可能值: 已导入/已更新/已存在/格式无效/邮箱格式无效
   * @returns 导入结果
   *   - success: 成功导入/更新数
   *   - duplicates: 已存在且未更新数 (跟 success/failed 不重叠, 一行只会落入一类)
   *   - failed: 格式/邮箱无效数
   *   - importedIds: 新建或更新的账号 ID 列表
   */
  async importAccounts(
    text: string,
    onProgress?: (current: number, total: number, email: string, status: string) => void
  ): Promise<{ success: number; duplicates: number; failed: number; importedIds: string[] }> {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let success = 0;
    let failed = 0;
    let duplicates = 0;
    const importedIds: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = this.stripLicenseSuffix(lines[i]);
      const parsed = this.parseLine(line);

      if (!parsed) {
        failed++;
        log('warn', TAG, `跳过无效行: ${line}`);
        onProgress?.(i + 1, lines.length, line.substring(0, 30), '格式无效');
        continue;
      }

      /* 基本格式校验 */
      if (!parsed.email.includes('@')) {
        failed++;
        log('warn', TAG, `邮箱格式无效: ${parsed.email}`);
        onProgress?.(i + 1, lines.length, parsed.email, '邮箱格式无效');
        continue;
      }

      /* 检查是否已存在 */
      const existing = this.accounts.find(a => a.email.toLowerCase() === parsed.email.toLowerCase());
      if (existing) {
        /* 已存在: 根据 credKind 更新对应字段 */
        let updated = false;
        if (parsed.credKind === 'refresh_token') {
          if (existing.refreshToken !== parsed.secret) {
            existing.refreshToken = parsed.secret;
            updated = true;
          }
        } else if (parsed.credKind === 'auth1_token') {
          if (existing.devinAuth1Token !== parsed.secret) {
            existing.devinAuth1Token = parsed.secret;
            /* auth1 变更 → 失效 apiKey/session, 下次切号自动经 runAuthChain 重拉 */
            existing.apiKey = undefined;
            existing.devinSessionToken = undefined;
            updated = true;
          }
        } else {
          if (existing.password !== parsed.secret) {
            existing.password = parsed.secret;
            updated = true;
          }
        }

        if (updated) {
          success++;
          importedIds.push(existing.id);
          onProgress?.(i + 1, lines.length, parsed.email, '已更新');
        } else {
          duplicates++;
          onProgress?.(i + 1, lines.length, parsed.email, '已存在');
        }
        continue;
      }

      /* 新建账号 (按 credKind 填对应字段; 不做 Firebase 验证, 保存即可) */
      const account: AccountInfo = {
        id: uuidv4(),
        email: parsed.email,
        password: parsed.credKind === 'password' ? parsed.secret : '',
        ...(parsed.credKind === 'refresh_token' && { refreshToken: parsed.secret }),
        ...(parsed.credKind === 'auth1_token' && { devinAuth1Token: parsed.secret }),
        createdAt: Math.floor(Date.now() / 1000)
      };

      this.accounts.push(account);
      importedIds.push(account.id);
      success++;
      onProgress?.(i + 1, lines.length, parsed.email, '已导入');
    }

    if (success > 0) {
      await this.saveAccounts();
    }
    log('info', TAG, `导入完成: 成功 ${success} 个, 重复 ${duplicates} 个, 失败 ${failed} 个`);

    return { success, duplicates, failed, importedIds };
  }

  /**
   * 剥离行尾的卡密后缀 (形如 ----WFT-XXXX-... 或 ----WFP-XXXX-...)
   * @param line - 原始行
   * @returns 剥离后的行
   */
  private stripLicenseSuffix(line: string): string {
    const idx = line.indexOf('----WF');
    if (idx > 0) {
      const suffix = line.substring(idx + 4);
      if (/^WF[THPD]-[A-F0-9]{8}-/.test(suffix)) {
        return line.substring(0, idx);
      }
    }
    return line;
  }

  /**
   * 解析单行账号文本
   *
   * 支持格式 (凭据自动识别, 无需显式前缀):
   *   - `邮箱 密码`                  普通密码
   *   - `邮箱 auth1_xxxx`            Devin auth1 token (裸 token, 自动识别)
   *   - `邮箱 <100+字符长串>`        Firebase refresh_token (按长度自动识别)
   *
   * 分隔符 (通用, 取第一个命中的):
   *   ;   半角分号 (优先)
   *   :   半角冒号
   *   ,   半角逗号 / 全角逗号
   *   ----    四短横
   *   空格 / tab / 全角空格 / 全角分号 / 全角冒号
   *
   * 兼容旧格式 (仍然支持):
   *   - `邮箱;rt:refresh_token`
   *   - `邮箱;auth1:auth1_xxxx`
   *
   * @param line - 单行文本
   * @returns { email, secret, credKind } | null
   */
  private parseLine(line: string): { email: string; secret: string; credKind: 'password' | 'refresh_token' | 'auth1_token' } | null {
    const trimmed = line.trim();
    if (!trimmed) { return null; }

    let email = '';
    let secret = '';

    /* 格式1: 邮箱;密码 (半角分号，优先, 这是最常见的导入格式) */
    const semiIdx = trimmed.indexOf(';');
    if (semiIdx > 0) {
      email = trimmed.substring(0, semiIdx).trim();
      secret = trimmed.substring(semiIdx + 1).trim();
    } else if (trimmed.includes('----')) {
      /* 格式2: 邮箱----密码 */
      const idx = trimmed.indexOf('----');
      email = trimmed.substring(0, idx).trim();
      secret = trimmed.substring(idx + 4).trim();
    } else {
      /* 格式3: 其他分隔符
       * tab / 全角分号 / 全角冒号 / 全角逗号 / 半角逗号 / 全角空格 / 半角空格 / 半角冒号
       * 注意: 半角冒号 `:` 放最后, 避免邮箱里含 `:` (其实邮箱标准不允许, 但防御一下) */
      const match = trimmed.match(/\t|\uff1b|\uff1a|\uff0c|,|\u3000| |:/);
      if (match && match.index !== undefined && match.index > 0) {
        email = trimmed.substring(0, match.index).trim();
        secret = trimmed.substring(match.index + match[0].length).trim();
      } else {
        return null;
      }
    }

    if (!email || !secret) { return null; }

    /* 判断凭据类型 (优先级: 显式前缀 > 启发式)
     * 启发式规则能覆盖绝大多数场景, 所以用户**无需**手动加 auth1:/rt: 前缀 */
    let credKind: 'password' | 'refresh_token' | 'auth1_token' = 'password';
    if (secret.startsWith('auth1:')) {
      /* 兼容: 显式 auth1: 前缀 */
      credKind = 'auth1_token';
      secret = secret.substring(6);
    } else if (secret.startsWith('rt:')) {
      /* 兼容: 显式 rt: 前缀 */
      credKind = 'refresh_token';
      secret = secret.substring(3);
    } else if (secret.startsWith('auth1_')) {
      /* 启发式: 裸 auth1_xxxx, 自动识别为 Devin auth1 token */
      credKind = 'auth1_token';
    } else if (secret.length >= 100) {
      /* 启发式: 超长字符串大概率是 Firebase refresh_token (通常 200+ 字符) */
      credKind = 'refresh_token';
    }

    return { email, secret, credKind };
  }

  /** 删除账号 */
  async removeAccount(accountId: string): Promise<void> {
    this.accounts = this.accounts.filter(a => a.id !== accountId);
    await this.saveAccounts();
    log('info', TAG, `已删除账号: ${accountId}`);
  }

  /**
   * 更新账号凭据（邮箱+密码）
   * 凭据变更时清空登录相关缓存，强制下次重新登录
   * @param accountId - 账号 ID
   * @param updates - 要更新的字段
   * @returns true 表示成功
   */
  async updateAccount(
    accountId: string,
    updates: { email?: string; password?: string; note?: string; groupId?: string | null }
  ): Promise<boolean> {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account) { return false; }

    let credentialsChanged = false;
    let metaChanged = false;

    if (updates.email && updates.email !== account.email) {
      account.email = updates.email;
      credentialsChanged = true;
    }
    /* 密码：只有传入非空值时才更新 */
    if (updates.password !== undefined && updates.password.length > 0
        && updates.password !== account.password) {
      account.password = updates.password;
      credentialsChanged = true;
    }
    /* 备注：允许清空（传空字符串即清空） */
    if (updates.note !== undefined && updates.note !== (account.note || '')) {
      account.note = updates.note || undefined;
      metaChanged = true;
    }
    /* 分组：null 或空串 = 移出分组 */
    if (updates.groupId !== undefined) {
      const newGroupId = (updates.groupId && updates.groupId.length > 0) ? updates.groupId : undefined;
      if (account.groupId !== newGroupId) {
        account.groupId = newGroupId;
        metaChanged = true;
      }
    }

    if (credentialsChanged) {
      /* 凭据变更后所有 token 都失效，清空缓存强制重登 */
      account.idToken = undefined;
      account.refreshToken = undefined;
      account.tokenExpiresAt = undefined;
      account.apiKey = undefined;
      account.devinAuth1Token = undefined;
      account.devinSessionToken = undefined;
    }

    const changed = credentialsChanged || metaChanged;
    if (changed) {
      await this.saveAccounts();
      log('info', TAG, `已更新账号: ${account.email}`);
    }
    return changed;
  }

  /** 清空所有账号 */
  async clearAll(): Promise<void> {
    this.accounts = [];
    await this.context.globalState.update(ACTIVE_KEY, undefined);
    await this.saveAccounts();
    log('info', TAG, '已清空所有账号');
  }

  /**
   * 导出账号为文本
   *
   * 格式与 importAccounts 对称, 可直接重新导入. 凭据按"持久度"优先级选择, 让导出
   * 文件保存数月后重新导入仍可用:
   *   - 有 password       → 邮箱;密码           (永不过期, 首选)
   *   - 有 devinAuth1Token → 邮箱;auth1_xxxx    (Devin auth1 token, 数周到几月后失效)
   *   - 有 refreshToken    → 邮箱;rt:xxxx        (Firebase refresh token, 兜底)
   *
   * @param accountIds - 可选, 只导出指定 ID 的账号; 不传则导出全部
   */
  exportAccounts(accountIds?: string[]): string {
    const list = accountIds && accountIds.length > 0
      ? this.accounts.filter(a => accountIds.includes(a.id))
      : this.accounts;

    return list.map(a => {
      /* 按持久度优先级: password (永不过期) > devinAuth1Token > refreshToken */
      if (a.password) {
        return `${a.email};${a.password}`;
      }
      if (a.devinAuth1Token) {
        return `${a.email};${a.devinAuth1Token}`;
      }
      if (a.refreshToken) {
        return `${a.email};rt:${a.refreshToken}`;
      }
      /* 几乎不可能走到 (3 种凭据全空), 兜底返回空 */
      return `${a.email};`;
    }).join('\n');
  }

  /**
   * 登录并获取 api_key
   * 策略：记忆上次成功的认证体系 → 优先用；否则 Devin Auth 优先 → Firebase 回落
   * 两种体系最终都会填充 account.apiKey + account.apiServerUrl 字段
   *
   * @param accountId - 账号 ID
   * @returns null 表示成功，string 表示错误信息
   */
  async loginAccount(accountId: string): Promise<string | null> {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account) {
      return `账号不存在: ${accountId}`;
    }

    /* 缓存命中: 已有 apiKey 且 Firebase token 未过期时直接复用 */
    if (account.apiKey && account.authStrategy === 'devin_auth') {
      log('info', TAG, `使用缓存 apiKey (Devin): ${account.email}`);
      return null;
    }
    if (account.apiKey && account.authStrategy === 'firebase'
        && account.tokenExpiresAt && Date.now() < account.tokenExpiresAt) {
      log('info', TAG, `使用缓存 apiKey (Firebase): ${account.email}`);
      return null;
    }

    /* 按策略顺序尝试：上次成功的方式优先 */
    const order: AuthStrategy[] = account.authStrategy === 'firebase'
      ? ['firebase', 'devin_auth']
      : ['devin_auth', 'firebase'];

    const errors: string[] = [];

    for (const strategy of order) {
      try {
        if (strategy === 'devin_auth') {
          await this.loginViaDevinAuth(account);
        } else {
          await this.loginViaFirebase(account);
        }
        account.authStrategy = strategy;
        await this.saveAccounts();
        log('info', TAG, `登录成功 (${strategy}): ${account.email}`);
        return null;
      } catch (err: any) {
        const msg = err.message || String(err);
        log('warn', TAG, `${strategy} 登录失败 (${account.email}): ${msg}`);
        errors.push(`[${strategy}] ${msg}`);
      }
    }

    return errors.join('; ');
  }

  /**
   * Devin Auth 登录路径
   * 优先级:
   *   1. 已有 devinAuth1Token → 直接跑 runAuthChain (复用 token 导入场景)
   *   2. runAuthChain 失败 (auth1 过期) 且有密码 → fallback 到 devinPasswordLogin
   *   3. 没 auth1 也没密码 → 直接抛错
   *
   * 成功后填充 account 的 Devin 相关字段 + apiKey + apiServerUrl
   */
  private async loginViaDevinAuth(account: AccountInfo): Promise<void> {
    let chain: Awaited<ReturnType<typeof runAuthChain>> | null = null;

    /* 路径 A: 已有 auth1 token, 直接换 apiKey (无需密码) */
    if (account.devinAuth1Token) {
      try {
        log('info', TAG, `复用已有 auth1 token 换 apiKey: ${account.email}`);
        chain = await runAuthChain(account.devinAuth1Token);
      } catch (err: any) {
        /* auth1 可能过期, 记下来但不抛, 继续尝试密码登录 */
        log('warn', TAG, `auth1 token 失效, 尝试密码登录: ${err.message}`);
      }
    }

    /* 路径 B: 密码登录 (auth1 没有或已过期) */
    if (!chain) {
      if (!account.password) {
        throw new Error('账号缺少密码且 auth1 token 失效, 无法登录');
      }
      const loginResp = await devinPasswordLogin(account.email, account.password);
      chain = await runAuthChain(loginResp.token);
    }

    account.apiKey = chain.apiKey;
    account.apiServerUrl = chain.apiServerUrl;
    account.displayName = chain.name;
    account.devinAuth1Token = chain.auth1Token;
    account.devinSessionToken = chain.sessionToken;
    account.devinAccountId = chain.accountId;
    account.devinPrimaryOrgId = chain.primaryOrgId;
    /* Firebase 字段清空 */
    account.idToken = undefined;
    account.refreshToken = undefined;
    account.tokenExpiresAt = undefined;
  }

  /**
   * Firebase 登录路径 (旧体系)：signInWithPassword → RegisterUser → api_key
   * 成功后填充 Firebase token 字段 + apiKey + apiServerUrl
   */
  private async loginViaFirebase(account: AccountInfo): Promise<void> {
    /* 优先尝试 refresh_token */
    if (account.refreshToken) {
      try {
        const refreshResp = await refreshIdToken(account.refreshToken);
        account.idToken = refreshResp.id_token;
        account.refreshToken = refreshResp.refresh_token;
        account.tokenExpiresAt = Date.now() + parseInt(refreshResp.expires_in) * 1000;

        const regResp = await registerUser(account.idToken!);
        account.apiKey = regResp.api_key;
        account.apiServerUrl = regResp.api_server_url || 'https://server.codeium.com';
        account.displayName = regResp.name;
        return;
      } catch {
        log('warn', TAG, 'Firebase Refresh Token 失效，改用密码登录');
      }
    }

    /* 密码登录 (无密码时直接抛错, 避免 signInWithPassword 15s 超时) */
    if (!account.password) {
      throw new Error('账号缺少密码且 refresh_token 失效, 无法登录');
    }
    const authResp = await signInWithPassword(account.email, account.password);
    account.idToken = authResp.idToken;
    account.refreshToken = authResp.refreshToken;
    account.tokenExpiresAt = Date.now() + parseInt(authResp.expiresIn) * 1000;

    const regResp = await registerUser(account.idToken);
    account.apiKey = regResp.api_key;
    account.apiServerUrl = regResp.api_server_url || 'https://server.codeium.com';
    account.displayName = regResp.name;
  }

  /**
   * 更新账号配额信息
   * @param accountId - 账号 ID
   * @param daily - 日配额剩余百分比
   * @param weekly - 周配额剩余百分比
   * @param extras - 额外信息 (套餐名 / 重置时间)
   */
  async updateQuota(
    accountId: string,
    daily: number,
    weekly: number,
    extras?: {
      planName?: string;
      dailyResetAt?: number;
      weeklyResetAt?: number;
      planStartAt?: number;
      planEndAt?: number;
    }
  ): Promise<void> {
    const account = this.accounts.find(a => a.id === accountId);
    if (account) {
      account.dailyQuota = daily;
      account.weeklyQuota = weekly;
      account.lastBalanceCheck = Date.now();
      if (extras?.planName) { account.planName = extras.planName; }
      if (extras?.dailyResetAt) { account.dailyResetAt = extras.dailyResetAt; }
      if (extras?.weeklyResetAt) { account.weeklyResetAt = extras.weeklyResetAt; }
      if (extras?.planStartAt) { account.planStartAt = extras.planStartAt; }
      if (extras?.planEndAt) { account.planEndAt = extras.planEndAt; }
      await this.saveAccounts();
    }
  }

}
