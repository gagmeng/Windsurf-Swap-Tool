/**
 * Webview 视图提供者
 * 管理侧边栏面板，处理 Webview 和后端之间的消息通信
 * 开发者: Ti
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, exec, execSync } from 'child_process';
import { AccountManager } from './accountManager';
import { BalanceChecker } from './balanceChecker';
import { AutoSwitch } from './autoSwitch';
import { WindsurfPatch } from './windsurfPatch';
import { MachineIdManager } from './machineId';
import { getWebviewContent } from './webviewContent';
import { CUSTOM_COMMAND } from './windsurfPatch';
import { log } from './logger';
import { WebviewMessage } from './types';
import { mapLimit, resolveConcurrencyLimit } from './concurrency';
import { InstanceManager } from './instanceManager';

const TAG = 'ViewProvider';

export class ViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'wfSwitcher.panel';

  private view?: vscode.WebviewView;
  private accountManager: AccountManager;
  private balanceChecker: BalanceChecker;
  private autoSwitch: AutoSwitch;
  private windsurfPatch: WindsurfPatch;
  private machineIdManager: MachineIdManager;
  private instanceManager: InstanceManager;
  private statusBarItem: vscode.StatusBarItem;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext
  ) {
    this.accountManager = new AccountManager(context);
    this.balanceChecker = new BalanceChecker(this.accountManager);
    this.autoSwitch = new AutoSwitch(this.accountManager);
    this.windsurfPatch = new WindsurfPatch();
    this.machineIdManager = new MachineIdManager();
    this.instanceManager = new InstanceManager(context);

    /* 状态栏 */
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'wfSwitcher.quickSwitch';
    context.subscriptions.push(this.statusBarItem);

    /* 配额不足回调 -> 自动切号 (传日+周配额) */
    this.balanceChecker.setQuotaLowCallback((accountId, daily, weekly) => {
      this.autoSwitch.handleQuotaLow(accountId, daily, weekly);
    });

    /* 配额刷新成功 -> 同步更新状态栏（邮箱+日配额%） */
    this.balanceChecker.setQuotaUpdateCallback(() => {
      this.updateStatusBar();
    });

    /* 自动切号回调 -> 实际执行切换 */
    this.autoSwitch.setSwitchCallback(async (accountId) => {
      await this.doSwitchAccount(accountId);
    });

    /* Phase 2: 注入机器码重置依赖到自动切号模块 */
    this.autoSwitch.setMachineIdDeps(this.machineIdManager, this.windsurfPatch);

    this.updateStatusBar();

    /* 新分身首次启动: 检测标记文件 → 自动切号 (不等用户点面板) */
    this.checkAutoSwitchMarker();

    /* 启动时: 重新占锁 (已有活跃账号 → 写回注册表, 避免重启后显示 "未占用") */
    this.reacquireLockOnStartup();

    /* 心跳: 定时续锁 + 更新 lastSeen (60 秒间隔) */
    const heartbeatTimer = setInterval(() => {
      this.instanceManager.heartbeat();
    }, 60_000);
    context.subscriptions.push({ dispose: () => clearInterval(heartbeatTimer) });
  }

  /** 实现 WebviewViewProvider 接口 */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

    /* 监听 Webview 消息 */
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      undefined,
      this.context.subscriptions
    );

    /* 视图可见时刷新数据 */
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendFullState();
      }
    });

    /* 启动余额监控 */
    this.balanceChecker.startMonitor();

    /* 注: state 推送改由 webview 首屏的 'webviewReady' 消息触发 (见 handleMessage),
     * 避免旧的 setTimeout(300) 在低性能机器上抢在 webview 监听器注册之前发消息 → 白屏 */
  }

  /**
   * 检测 .auto-switch-pending 标记文件
   * 新分身首次启动时, 自动切换到指定账号
   */
  private async checkAutoSwitchMarker(): Promise<void> {
    const fs = await import('fs');
    const path = await import('path');
    const dataDir = this.instanceManager.getMyDataDir();
    const markerPath = path.join(dataDir, '.auto-switch-pending');

    if (!fs.existsSync(markerPath)) { return; }

    try {
      const raw = fs.readFileSync(markerPath, 'utf-8');
      let { accountId, email } = JSON.parse(raw);

      /* 删除标记 (无论切号成败都只执行一次) */
      fs.unlinkSync(markerPath);

      if (!accountId) { return; }

      /* 验锁: 标记里的账号可能已被其他分身占用, 重新选一个 */
      const targetAcct = this.accountManager.getAccounts().find(a => a.id === accountId);
      if (targetAcct?.email) {
        const conflict = this.instanceManager.getConflictInstance(targetAcct.email);
        if (conflict) {
          log('warn', TAG, `标记账号 ${email} 已被 ${conflict.label} 占用, 重新选择`);
          const config = vscode.workspace.getConfiguration('wfSwitcher');
          const threshold = config.get<number>('autoSwitchThreshold', 5);
          const planType = config.get<string>('autoSwitchPlanType', 'All');
          const lockedEmails = this.instanceManager.getOtherLockedEmails();
          const next = this.accountManager.getNextAvailableAccount(threshold, lockedEmails, planType);
          if (!next) {
            log('warn', TAG, '没有其他可用账号, 放弃自动切号');
            vscode.window.showWarningMessage('所有账号均已被其他分身占用，无法自动切号');
            return;
          }
          accountId = next.id;
          email = next.email;
          log('info', TAG, `已重新选择账号: ${email}`);
        }
      }

      log('info', TAG, `检测到自动切号标记, 正在切换到 ${email || accountId} ...`);
      vscode.window.showInformationMessage(`分身首次启动, 正在自动切换到 ${email || accountId} ...`);

      /* 延迟 2 秒等 webview 初始化完毕 */
      await new Promise(r => setTimeout(r, 2000));
      await this.doSwitchAccount(accountId);

      log('info', TAG, `分身自动切号完成: ${email}`);
    } catch (err: any) {
      log('error', TAG, `自动切号失败: ${err.message}`);
      try { fs.unlinkSync(markerPath); } catch { /* ignore */ }
    }
  }

  /**
   * 启动时重新占锁:
   * 如果当前实例已有活跃账号 (globalState 里有 activeAccountId),
   * 把它写回注册表, 避免重启后其他实例看到 "未占用"
   */
  private reacquireLockOnStartup(): void {
    const activeAccount = this.accountManager.getActiveAccount();
    if (activeAccount?.email) {
      this.instanceManager.acquireLock(activeAccount.email);
      log('info', TAG, `启动时重新占锁: ${activeAccount.email}`);
    }
  }

  /** 处理 Webview 发来的消息 */
  private async handleMessage(message: WebviewMessage): Promise<void> {
    log('debug', TAG, `收到消息: ${message.type}`);

    switch (message.type) {
      case 'webviewReady':
        /* webview 初始化完成 → 推送首屏状态 (替代旧的 setTimeout 300ms) */
        this.sendFullState();
        break;

      case 'webviewError':
        /* webview 脚本异常上报 → 记录日志便于排查白屏问题 */
        log('error', TAG, `Webview 脚本异常: ${(message as any).payload?.error || '未知错误'}`);
        log('error', TAG, `Webview 异常堆栈: ${(message as any).payload?.stack || '(无)'}`);
        break;

      case 'getState':
        this.sendFullState();
        break;

      case 'importAccounts':
        await this.handleImportAccounts(
          message.payload?.text,
          message.payload?.groupId
        );
        break;

      case 'serverImport':
        await this.handleServerImport(
          message.payload?.baseUrl,
          message.payload?.planType,
          message.payload?.credType,
          message.payload?.groupId
        );
        break;

      case 'switchAccount':
        await this.handleSwitchAccount(message.payload?.accountId);
        break;

      case 'deleteAccount':
        await this.handleDeleteAccount(message.payload?.accountId);
        break;

      case 'editAccount':
        await this.handleEditAccount(message.payload);
        break;

      case 'createGroup':
        await this.handleCreateGroup(message.payload?.name);
        break;

      case 'renameGroup':
        await this.handleRenameGroup(message.payload?.groupId, message.payload?.name);
        break;

      case 'deleteGroup':
        await this.handleDeleteGroup(message.payload?.groupId);
        break;

      case 'assignAccountGroup':
        await this.handleAssignAccountGroup(message.payload?.accountId, message.payload?.groupId);
        break;

      case 'bulkDelete':
        await this.handleBulkDelete(message.payload?.accountIds);
        break;

      case 'bulkAssignGroup':
        await this.handleBulkAssignGroup(
          message.payload?.accountIds,
          message.payload?.groupId
        );
        break;

      case 'clearAccounts':
        await this.handleClearAccounts();
        break;

      case 'exportAccounts':
        await this.handleExportAccounts(message.payload?.accountIds);
        break;

      case 'refreshBalance':
        await this.handleRefreshBalance(message.payload?.accountId);
        break;

      case 'refreshAllBalances':
        await this.handleRefreshAllBalances();
        break;

      case 'bulkRefresh':
        await this.handleBulkRefresh(message.payload?.accountIds);
        break;

      case 'applyPatch':
        await this.handleApplyPatch();
        break;

      case 'restorePatch':
        await this.handleRestorePatch();
        break;

      case 'resetMachineId':
        await this.handleResetMachineId();
        break;

      case 'getPatchStatus':
        this.sendPatchStatus();
        break;

      case 'setSwitchMode':
        /* UI 切 "Patch / URI" 模式时派发, payload.mode = 'patch' | 'uri' */
        await this.handleSetSwitchMode(message.payload?.mode);
        break;

      case 'applyUriPatch':
        /* UI 独立触发 URI 补丁 (不经过 switchViaUri 流程) */
        await this.handleApplyUriPatch();
        break;

      case 'restoreUriPatch':
        await this.handleRestoreUriPatch();
        break;

      case 'getInstances':
        this.sendInstances();
        break;

      case 'createInstance':
        await this.handleCreateInstance(message.payload);
        break;

      case 'deleteInstance':
        await this.handleDeleteInstance(message.payload);
        break;

      case 'updateSettings':
        await this.handleUpdateSettings(message.payload);
        break;

      default:
        log('warn', TAG, `未知消息类型: ${message.type}`);
    }
  }

  /** 发送完整状态到 Webview (不触发补丁系统扫描) */
  private sendFullState(): void {
    const accounts = this.accountManager.getAccounts();
    const groups = this.accountManager.getGroups();
    const activeAccount = this.accountManager.getActiveAccount();
    const config = vscode.workspace.getConfiguration('wfSwitcher');

    this.postMessage({
      type: 'stateUpdate',
      payload: {
        accounts,
        groups,
        activeAccountId: activeAccount?.id || null,
        /* 补丁状态延迟到用户请求时再获取，避免启动时扫描 Windsurf 核心文件 */
        patchStatus: null,
        schemeList: null,
        windsurfPath: this.windsurfPatch.getWindsurfPath(),
        myInstanceId: this.instanceManager.getMyInstanceId(),
        /* 首屏同步 switchMode, 避免 UI toggle 默认 patch 但实际 config 是 uri
         * (真正的 uriPatchApplied/processCount 留给 getPatchStatus 按需刷新, 避免启动时扫 extension.js) */
        switchMode: config.get<string>('switchMode', 'patch'),
        settings: {
          autoSwitchEnabled: config.get('autoSwitchEnabled', false),
          autoSwitchSilent: config.get('autoSwitchSilent', false),
          autoSwitchThreshold: config.get('autoSwitchThreshold', 5),
          autoSwitchPlanType: config.get('autoSwitchPlanType', 'All'),
          autoResetMachineIdOnAutoSwitch: config.get('autoResetMachineIdOnAutoSwitch', false),
          statusBarEnabled: config.get('statusBarEnabled', true),
          balanceAutoRefresh: config.get('balanceAutoRefresh', true),
          balanceRefreshInterval: config.get('balanceRefreshInterval', 30),
          concurrentLimit: config.get('concurrentLimit', 5),
          unlimitedConcurrent: config.get('unlimitedConcurrent', false)
        }
      }
    });
  }

  /** 新建分组（name 为空时不操作） */
  private async handleCreateGroup(name?: string): Promise<void> {
    if (!name || !name.trim()) { return; }
    try {
      await this.accountManager.addGroup(name);
      this.sendFullState();
    } catch (err: any) {
      vscode.window.showErrorMessage(`新建分组失败: ${err.message}`);
    }
  }

  /** 重命名分组 */
  private async handleRenameGroup(groupId?: string, name?: string): Promise<void> {
    if (!groupId || !name || !name.trim()) { return; }
    const ok = await this.accountManager.renameGroup(groupId, name);
    if (ok) { this.sendFullState(); }
  }

  /** 删除分组（组内账号保留但移出分组） */
  private async handleDeleteGroup(groupId?: string): Promise<void> {
    if (!groupId) { return; }
    await this.accountManager.deleteGroup(groupId);
    this.sendFullState();
  }

  /** 分配账号到分组 (或移出) */
  private async handleAssignAccountGroup(accountId?: string, groupId?: string): Promise<void> {
    if (!accountId) { return; }
    const changed = await this.accountManager.assignAccountGroup(accountId, groupId);
    if (changed) { this.sendFullState(); }
  }

  /**
   * 批量删除账号
   * @param accountIds - 要删除的账号 ID 列表
   */
  private async handleBulkDelete(accountIds?: string[]): Promise<void> {
    if (!accountIds || accountIds.length === 0) { return; }
    for (const id of accountIds) {
      await this.accountManager.removeAccount(id);
    }
    log('info', TAG, `批量删除 ${accountIds.length} 个账号`);
    this.sendFullState();
    this.updateStatusBar();
  }

  /**
   * 批量移入分组 (传空 groupId 表示移出分组)
   */
  private async handleBulkAssignGroup(accountIds?: string[], groupId?: string): Promise<void> {
    if (!accountIds || accountIds.length === 0) { return; }
    let changedCount = 0;
    for (const id of accountIds) {
      const ok = await this.accountManager.assignAccountGroup(id, groupId);
      if (ok) { changedCount++; }
    }
    log('info', TAG, `批量移入分组: ${changedCount}/${accountIds.length}`);
    if (changedCount > 0) { this.sendFullState(); }
  }

  /** 发送补丁状态 (仅在用户请求时才扫描文件) */
  private sendPatchStatus(): void {
    try {
      const patchStatus = this.windsurfPatch.getPatchStatus();
      const schemeList = this.windsurfPatch.getSchemeList();
      /* 额外采集 UI 需要展示的运行态: 切号模式、URI 补丁状态、Windsurf 进程数
       * 进程检测 tasklist 有 <100ms 开销, 放一起返回避免 UI 多次轮询 */
      const switchMode = vscode.workspace.getConfiguration('wfSwitcher')
        .get<string>('switchMode', 'patch');
      const uriPatchApplied = this.windsurfPatch.isUriPatchApplied();
      const processCount = this.windsurfPatch.getWindsurfProcessCount();
      this.postMessage({
        type: 'patchStatusUpdate',
        payload: {
          patchStatus,
          schemeList,
          windsurfPath: this.windsurfPatch.getWindsurfPath(),
          switchMode,
          uriPatchApplied,
          processCount
        }
      });
    } catch (err: any) {
      log('warn', TAG, `获取补丁状态失败: ${err.message}`);
      this.postMessage({
        type: 'patchStatusUpdate',
        payload: { patchStatus: null, schemeList: null, windsurfPath: this.windsurfPatch.getWindsurfPath() }
      });
    }
  }

  /** 发送分身实例列表给 Webview */
  private sendInstances(): void {
    try {
      const instances = this.instanceManager.getAllInstances();
      /* 给当前实例补充活跃账号邮箱 (锁记录可能还没更新) */
      const myId = this.instanceManager.getMyInstanceId();
      const activeAccount = this.accountManager.getActiveAccount();
      if (activeAccount) {
        const me = instances.find(i => i.id === myId);
        if (me && !me.lockedEmail) {
          me.lockedEmail = activeAccount.email;
        }
      }
      this.postMessage({ type: 'instancesUpdate', payload: instances });
    } catch (err: any) {
      log('error', TAG, `获取分身实例失败: ${err.message}`);
      this.postMessage({ type: 'instancesUpdate', payload: [] });
    }
  }

  /**
   * 创建分身:
   * 1. webview 弹窗获取分身名称
   * 2. 在 ~/.wf-switcher/profiles/<name> 创建独立数据目录
   * 3. 从主实例复制 extensions + session 数据 (免重新登录 + 免手动安装扩展)
   * 4. 用 --user-data-dir 启动新 Windsurf 实例
   */
  private async handleCreateInstance(payload?: { name?: string }): Promise<void> {
    const profileName = payload?.name?.trim();
    if (!profileName) { return; }

    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');
    const { execSync, spawn } = await import('child_process');

    const profileDir = path.join(os.homedir(), '.wf-switcher', 'profiles', profileName);
    const isNew = !fs.existsSync(profileDir) || fs.readdirSync(profileDir).length === 0;

    if (!isNew) {
      const choice = await vscode.window.showWarningMessage(
        `分身 "${profileName}" 已存在，是否直接启动？`,
        '启动', '取消'
      );
      if (choice !== '启动') { return; }
    } else {
      fs.mkdirSync(profileDir, { recursive: true });
      log('info', TAG, `创建分身数据目录: ${profileDir}`);

      /* 从主实例复制关键数据 (扩展 + 设置) */
      const mainDataDir = this.instanceManager.getMyDataDir();
      try {
        await this.cloneInstanceData(mainDataDir, profileDir);
      } catch (err: any) {
        log('warn', TAG, `复制主实例数据失败 (分身仍可用): ${err.message}`);
      }

      /* 写入自动切号标记: 新实例启动后自动切到下一个可用账号 */
      const otherLocked = this.instanceManager.getOtherLockedEmails();
      const cfgForSwitch = vscode.workspace.getConfiguration('wfSwitcher');
      const threshold = cfgForSwitch.get<number>('autoSwitchThreshold', 5);
      const planType = cfgForSwitch.get<string>('autoSwitchPlanType', 'All');
      const nextAccount = this.accountManager.getNextAvailableAccount(threshold, otherLocked, planType);
      if (nextAccount) {
        const markerPath = path.join(profileDir, '.auto-switch-pending');
        fs.writeFileSync(markerPath, JSON.stringify({
          accountId: nextAccount.id,
          email: nextAccount.email
        }), 'utf-8');
        log('info', TAG, `自动切号标记已写入: ${nextAccount.email}`);

        /* 立即为新分身预占锁, 防止后续创建分身时选到同一个账号 */
        this.instanceManager.preLockForProfile(profileDir, nextAccount.email);
      }
    }

    /* 启动新 Windsurf 实例 */
    const execPath = process.execPath;
    log('info', TAG, `分身启动: ${execPath}, --user-data-dir=${profileDir}`);

    try {
      if (process.platform === 'win32') {
        const batContent = [
          '@echo off',
          `start "" "${execPath}" --user-data-dir="${profileDir}"`,
        ].join('\r\n');
        const batPath = path.join(os.tmpdir(), `wf-instance-${profileName}.bat`);
        fs.writeFileSync(batPath, batContent, 'utf-8');
        spawnDetachedWin(batPath);
      } else if (process.platform === 'darwin') {
        const appPath = execPath.replace(/\/Contents\/MacOS\/.*$/, '');
        const child = spawn('open', ['-n', '-a', appPath, '--args', `--user-data-dir=${profileDir}`], {
          detached: true, stdio: 'ignore'
        });
        child.unref();
      } else {
        const child = spawn(execPath, [`--user-data-dir=${profileDir}`], {
          detached: true, stdio: 'ignore'
        });
        child.unref();
      }

      vscode.window.showInformationMessage(
        `✅ 分身 "${profileName}" 已启动，将自动切换账号。`
      );
      log('info', TAG, `分身 "${profileName}" 已启动`);
    } catch (err: any) {
      vscode.window.showErrorMessage(`创建分身失败: ${err.message}`);
      log('error', TAG, `创建分身失败: ${err.message}`);
    }
  }

  /** 删除分身 */
  private async handleDeleteInstance(payload?: { name?: string }): Promise<void> {
    const profileName = payload?.name?.trim();
    if (!profileName) { return; }

    const ok = this.instanceManager.deleteProfile(profileName);
    if (ok) {
      vscode.window.showInformationMessage(`已删除分身 "${profileName}"`);
    } else {
      vscode.window.showErrorMessage(`删除分身 "${profileName}" 失败，可能正在运行中`);
    }
    /* 刷新列表 */
    this.sendInstances();
  }

  /**
   * 从主实例复制关键数据到新分身:
   * - User/ 整个目录 (session、state.vscdb、settings、globalStorage 等)
   * - extensions/ (扩展, 包含 wf-switcher 自身)
   *
   * 跳过: Cache / CachedData / logs / GPUCache (体积大、无用)
   */
  private async cloneInstanceData(srcDir: string, dstDir: string): Promise<void> {
    const fs = await import('fs');
    const path = await import('path');

    /** 需要跳过的目录名 (缓存/日志, 体积大且无用) */
    const SKIP_DIRS = new Set([
      '.git', 'node_modules', 'Cache', 'CachedData', 'CachedExtensions',
      'CachedExtensionVSIXs', 'GPUCache', 'logs', 'Crashpad', 'blob_storage',
      'Service Worker', 'Code Cache', 'DawnCache', 'GrShaderCache',
      'Local Storage', 'Session Storage', 'WebStorage'
    ]);

    /** 递归复制目录 */
    const copyDir = (src: string, dst: string): void => {
      if (!fs.existsSync(src)) { return; }
      fs.mkdirSync(dst, { recursive: true });
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) { continue; }
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
          copyDir(srcPath, dstPath);
        } else {
          try {
            fs.copyFileSync(srcPath, dstPath);
          } catch { /* 跳过被锁定的文件 */ }
        }
      }
    };

    /* 1. 复制整个 User/ 目录 (session + state.vscdb + settings 全在里面) */
    log('info', TAG, '复制 User/ 目录 ...');
    copyDir(path.join(srcDir, 'User'), path.join(dstDir, 'User'));

    /* 2. 复制扩展目录 */
    log('info', TAG, '复制 extensions/ ...');
    copyDir(path.join(srcDir, 'extensions'), path.join(dstDir, 'extensions'));

    log('info', TAG, '主实例数据复制完成');
  }

  /**
   * 导入账号
   *
   * 两种模式:
   * 导入后统一走 refreshByIds: 登录 + 拉配额一步到位
   */
  private async handleImportAccounts(
    text?: string,
    groupId?: string
  ): Promise<void> {
    if (!text) { return; }

    const lines = text.split('\n').filter(l => l.trim().length > 0);
    this.postMessage({ type: 'importStart', payload: { total: lines.length } });

    const { success: count, duplicates, failed, importedIds } = await this.accountManager.importAccounts(
      text,
      (current, total, email, status) => {
        this.postMessage({
          type: 'importProgress',
          payload: { current, total, email, status }
        });
      }
    );

    /* 批量分配到指定分组 (非空时) */
    if (groupId && importedIds.length > 0) {
      for (const id of importedIds) {
        await this.accountManager.assignAccountGroup(id, groupId);
      }
      log('info', TAG, `导入账号分配到分组 ${groupId}: ${importedIds.length} 个`);
    }

    this.postMessage({
      type: 'importResult',
      payload: { count, total: lines.length }
    });
    this.sendFullState();

    /* 导入成功 → 异步刷余额 (登录 + 配额) */
    if (count > 0 && importedIds.length > 0) {
      /* 同时含重复时, 在 toast 里一并提示, 让用户知道为什么 count<lines.length */
      const dupTip = duplicates > 0 ? ` (跳过 ${duplicates} 个重复)` : '';
      vscode.window.showInformationMessage(`导入完成: ${count}/${lines.length}${dupTip}，正在验证...`);
      this.postMessage({ type: 'refreshStart' });
      this.balanceChecker.refreshByIds(importedIds, (c, t, e) => {
        this.postMessage({
          type: 'refreshProgress',
          payload: { current: c, total: t, email: e }
        });
      }).then(() => {
        this.sendFullState();
        this.postMessage({ type: 'refreshDone' });
        vscode.window.showInformationMessage(`验证完成: ${importedIds.length} 个账号`);
      }).catch((err: any) => {
        log('warn', TAG, `批量登录失败: ${err.message}`);
        this.postMessage({ type: 'refreshDone' });
      });
    } else if (lines.length > 0 && count === 0) {
      /* count===0 的三种情况, 分别给出不同文案 (避免把"全部重复"误报为"格式无效") */
      if (failed === 0 && duplicates > 0) {
        /* 全部重复, 这是常见场景 (重复导入同一份导出文件) */
        vscode.window.showInformationMessage(`${duplicates} 个账号已存在 (内容未变化, 无需重复导入)`);
      } else if (failed > 0 && duplicates === 0) {
        /* 全部格式无效 */
        vscode.window.showWarningMessage(`${failed} 条账号格式都无效，请检查输入 (支持分号/空格/tab/----)`);
      } else {
        /* 混合 (部分重复 + 部分格式错), 一并报告 */
        vscode.window.showWarningMessage(`${failed} 条格式无效, ${duplicates} 个已存在, 0 个新增`);
      }
    }
  }

  /**
   * 服务端导入: 从外部 API 拉取账号列表, 按选定导入方式转为批量文本, 再走 handleImportAccounts
   */
  private async handleServerImport(
    baseUrl?: string,
    planType?: string,
    credType?: string,
    groupId?: string
  ): Promise<void> {
    if (!baseUrl) {
      this.postMessage({ type: 'hideLoading' });
      return;
    }

    try {
      /* 构造请求 URL */
      let url = `${baseUrl}/accounts?page=1&page_size=10000`;
      if (planType && planType !== 'All') {
        url += `&plan_names=${encodeURIComponent(planType)}`;
      }

      log('info', TAG, `服务端导入: GET ${url}`);
      const http = await import('http');
      const https = await import('https');
      const { URL: NodeURL } = await import('url');

      const parsedUrl = new NodeURL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const body: string = await new Promise((resolve, reject) => {
        const req = client.get(url, (res: any) => {
          let data = '';
          res.on('data', (chunk: any) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            } else {
              resolve(data);
            }
          });
        });
        req.on('error', (e: any) => reject(e));
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时 (15s)')); });
      });

      const json = JSON.parse(body);
      const accounts: any[] = json.accounts || [];

      if (accounts.length === 0) {
        this.postMessage({ type: 'hideLoading' });
        vscode.window.showWarningMessage('服务端未返回任何账号');
        return;
      }

      /* 根据 credType 将 API 返回的账号转为批量导入文本行 */
      const lines: string[] = [];
      let skipped = 0;
      for (const acc of accounts) {
        const email = (acc.email || '').trim();
        if (!email) { skipped++; continue; }

        let cred = '';
        if (credType === 'password') {
          cred = acc.password || '';
        } else if (credType === 'refresh') {
          const rt = acc.refresh_token || '';
          cred = rt ? `rt:${rt}` : '';
        } else {
          /* 默认 auth1 */
          const auth1 = acc.devin_auth1_token || '';
          cred = auth1 ? `auth1:${auth1}` : '';
        }

        if (!cred) { skipped++; continue; }
        lines.push(`${email};${cred}`);
      }

      if (lines.length === 0) {
        this.postMessage({ type: 'hideLoading' });
        vscode.window.showWarningMessage(
          `获取到 ${accounts.length} 个账号, 但选定导入方式的凭据字段全部为空 (跳过 ${skipped} 个)`
        );
        return;
      }

      log('info', TAG, `服务端导入: 获取 ${accounts.length} 个账号, 有效 ${lines.length} 条, 跳过 ${skipped} 条`);
      this.postMessage({ type: 'setLoadingText', payload: { text: `获取到 ${lines.length} 个账号, 正在导入...` } });

      /* 复用批量导入流程 */
      await this.handleImportAccounts(lines.join('\n'), groupId);
    } catch (err: any) {
      log('error', TAG, `服务端导入失败: ${err.message}`);
      this.postMessage({ type: 'hideLoading' });
      vscode.window.showErrorMessage(`服务端导入失败: ${err.message}`);
    }
  }

  /** 切换账号 */
  private async handleSwitchAccount(accountId?: string): Promise<void> {
    if (!accountId) { return; }
    await this.doSwitchAccount(accountId);
  }

  /**
   * 实际执行账号切换 (v3 - 支持 patch / uri 双模式)
   *
   * 流程 (patch 模式, 默认):
   *   1. 冲突检测
   *   2. 补丁状态检查, 未应用则提示
   *   3. 登录获取 apiKey
   *   4. 登出 + 设活跃
   *   5. executeCommand(CUSTOM_COMMAND, {apiKey, name, apiServerUrl}) 注入 session
   *   6. 失败重试 3 次
   *
   * 流程 (uri 模式, 兜底):
   *   → 委托给 switchViaUri, 走 windsurf:// 协议回调
   *
   * 参考: wf-dialog-mcp WindsurfAutoLoginService.switchAccount
   */
  private async doSwitchAccount(accountId: string): Promise<void> {
    /* 先判 switchMode 分流: 用户选 uri 模式时直接走 URI 路径, 不走补丁命令 */
    const switchMode = vscode.workspace.getConfiguration('wfSwitcher')
      .get<string>('switchMode', 'patch');
    if (switchMode === 'uri') {
      return this.switchViaUri(accountId);
    }

    this.postMessage({ type: 'switchStart', payload: { accountId } });

    /* Step 0: 多分身冲突检测 */
    const targetAcct = this.accountManager.getAccounts().find(a => a.id === accountId);
    if (targetAcct?.email) {
      const conflict = this.instanceManager.getConflictInstance(targetAcct.email);
      if (conflict) {
        const ago = conflict.lockedAt
          ? Math.round((Date.now() - conflict.lockedAt) / 60000) + ' 分钟前'
          : '未知时间';
        const choice = await vscode.window.showWarningMessage(
          `⚠️ ${targetAcct.email} 正在被「${conflict.label}」使用 (${ago})，同时使用可能导致限速或封号`,
          '仍然切换', '取消'
        );
        if (choice !== '仍然切换') {
          this.postMessage({ type: 'switchError', payload: { accountId, error: '用户取消: 账号被其他分身占用' } });
          return;
        }
      }
    }

    /* Step 1: 检查补丁状态 */
    if (!this.windsurfPatch.isPatchApplied()) {
      const choice = await vscode.window.showWarningMessage(
        '切号需要先应用补丁。是否立即应用？',
        { modal: true },
        '立即应用'
      );
      if (choice !== '立即应用') {
        this.postMessage({ type: 'switchError', payload: { accountId, error: '未应用补丁' } });
        return;
      }

      try {
        await this.windsurfPatch.applyAll();
        const restart = await vscode.window.showWarningMessage(
          '✅ 补丁已应用，需要重启 Windsurf 才能生效',
          '立即重启', '稍后重启'
        );
        if (restart === '立即重启') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } catch (err: any) {
        this.postMessage({ type: 'switchError', payload: { accountId, error: `补丁应用失败: ${err.message}` } });
        vscode.window.showErrorMessage(`补丁应用失败: ${err.message}`);
      }
      return;
    }

    /* Step 2: Firebase 登录获取 apiKey */
    const loginErr = await this.accountManager.loginAccount(accountId);
    if (loginErr) {
      this.postMessage({ type: 'switchError', payload: { accountId, error: loginErr } });
      vscode.window.showErrorMessage(`切号失败: ${loginErr}`);
      return;
    }

    const account = this.accountManager.getAccounts().find(a => a.id === accountId);
    if (!account?.apiKey) {
      const msg = '登录成功但未获取到 apiKey';
      this.postMessage({ type: 'switchError', payload: { accountId, error: msg } });
      vscode.window.showErrorMessage(`切号失败: ${msg}`);
      return;
    }

    /* Step 3: 先登出旧账号 (静默失败) */
    await this.tryLogout();

    /* Step 4: 设置为活跃账号 (先标记，防止登出后状态混乱) */
    await this.accountManager.setActiveAccount(accountId);

    /* Step 5: 通过补丁注入的自定义命令切号 (3次重试) */
    const payload = {
      apiKey: account.apiKey,
      name: account.displayName || account.email,
      apiServerUrl: account.apiServerUrl || 'https://server.codeium.com'
    };

    let lastError: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result: any = await vscode.commands.executeCommand(CUSTOM_COMMAND, payload);

        if (result && result.error) {
          const errMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
          log('warn', TAG, `[${attempt}/3] 切号命令返回错误: ${errMsg}`);
          lastError = new Error(`补丁内部变量失效，请重新应用补丁`);
          break;
        }

        log('info', TAG, `✅ 切号成功: ${account.email}`);
        vscode.window.showInformationMessage(`✅ 已切换到: ${account.email}`);
        this.postMessage({ type: 'switchDone', payload: { accountId } });
        this.sendFullState();
        this.updateStatusBar();

        /* 占锁: 通知其他分身此账号已被占用 */
        if (account.email) {
          this.instanceManager.acquireLock(account.email);
        }

        /* 手动切号也触发静默重置机器码 (共享 autoResetMachineIdOnAutoSwitch 开关 + 冷却) */
        this.silentResetMachineId();
        return;
      } catch (err: any) {
        lastError = err;
        log('warn', TAG, `[${attempt}/3] 切号命令执行失败: ${err.message}`);
        if (attempt < 3) {
          await this.delay(1500);
        }
      }
    }

    /* 所有重试都失败 */
    const errMsg = lastError?.message || '未知错误';
    log('error', TAG, `切号最终失败: ${errMsg}`);
    this.postMessage({ type: 'switchError', payload: { accountId, error: errMsg } });
    vscode.window.showErrorMessage(`切号失败: ${errMsg} (请确认已应用补丁并重启 Windsurf)`);
  }

  /**
   * URI 模式切号 (兜底方案)
   *
   * 流程:
   *   1. 冲突检测 (同 patch 模式)
   *   2. 确保 URI Patch 已应用, 否则提示用户先应用并重启
   *   3. 登录获取 apiKey / name / apiServerUrl
   *   4. 登出旧账号 + 设活跃
   *   5. 构造 windsurf://windsurf.windsurf/auth-callback#api_key=XXX&name=YYY&api_server_url=ZZZ
   *      调 vscode.env.openExternal 触发 Windsurf 自己的 uriHandler
   *      (我们打的 URI patch 会从 fragment 里提 api_key 自己写 secrets.store)
   *   6. 占锁 + 静默重置机器码
   *
   * 关键区别 (相对 patch 模式):
   *   - 不依赖 CUSTOM_COMMAND, 核心 patch 被 Windsurf 干掉也能跑
   *   - 不会 executeCommand 直接触发 handleAuthTokenWithShit
   *   - session 生效是异步的, 不好同步等待, 所以 openExternal 返回 true 就当成功
   */
  private async switchViaUri(accountId: string): Promise<void> {
    this.postMessage({ type: 'switchStart', payload: { accountId } });

    /* Step 0: 冲突检测 (复用 patch 模式的逻辑) */
    const targetAcct = this.accountManager.getAccounts().find(a => a.id === accountId);
    if (targetAcct?.email) {
      const conflict = this.instanceManager.getConflictInstance(targetAcct.email);
      if (conflict) {
        const ago = conflict.lockedAt
          ? Math.round((Date.now() - conflict.lockedAt) / 60000) + ' 分钟前'
          : '未知时间';
        const choice = await vscode.window.showWarningMessage(
          `⚠️ ${targetAcct.email} 正在被「${conflict.label}」使用 (${ago})，同时使用可能导致限速或封号`,
          '仍然切换', '取消'
        );
        if (choice !== '仍然切换') {
          this.postMessage({ type: 'switchError', payload: { accountId, error: '用户取消: 账号被其他分身占用' } });
          return;
        }
      }
    }

    /* Step 1: 确保 URI Patch 已应用 */
    if (!this.windsurfPatch.isUriPatchApplied()) {
      const choice = await vscode.window.showWarningMessage(
        'URI 模式需要先应用 URI 补丁。是否立即应用？',
        { modal: true },
        '立即应用'
      );
      if (choice !== '立即应用') {
        this.postMessage({ type: 'switchError', payload: { accountId, error: '未应用 URI 补丁' } });
        return;
      }

      const res = await this.windsurfPatch.applyUriPatch();
      if (!res.success) {
        this.postMessage({ type: 'switchError', payload: { accountId, error: `URI 补丁应用失败: ${res.error}` } });
        vscode.window.showErrorMessage(`URI 补丁应用失败: ${res.error}`);
        return;
      }

      const restart = await vscode.window.showWarningMessage(
        '✅ URI 补丁已应用，需要重启 Windsurf 才能生效，重启后再点击切号',
        '立即重启', '稍后重启'
      );
      if (restart === '立即重启') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
      this.postMessage({ type: 'switchError', payload: { accountId, error: '需要重启 Windsurf 后重试' } });
      return;
    }

    /* Step 2: 登录拿 apiKey */
    const loginErr = await this.accountManager.loginAccount(accountId);
    if (loginErr) {
      this.postMessage({ type: 'switchError', payload: { accountId, error: loginErr } });
      vscode.window.showErrorMessage(`切号失败: ${loginErr}`);
      return;
    }

    const account = this.accountManager.getAccounts().find(a => a.id === accountId);
    if (!account?.apiKey) {
      const msg = '登录成功但未获取到 apiKey';
      this.postMessage({ type: 'switchError', payload: { accountId, error: msg } });
      vscode.window.showErrorMessage(`切号失败: ${msg}`);
      return;
    }

    /* Step 3: 登出旧账号 + 设活跃 */
    await this.tryLogout();
    await this.accountManager.setActiveAccount(accountId);

    /* Step 4: 构造 URI 并触发内部 URI handler
     *
     * 关键: 不用 vscode.env.openExternal (走 OS 协议 → 内核 Marketplace 查找 → 报错)
     * 改用内部命令 workbench.action.url.handle 直接分发给已注册的 URI handler
     * 如果内部命令不可用, 回退到 openExternal (至少功能不受影响, 只是有个烦人的提示)
     *
     * URLSearchParams 会自动 URL-encode, fragment 里的 apiKey 可能含特殊字符安全 */
    const fragment = new URLSearchParams({
      api_key: account.apiKey,
      name: account.displayName || account.email,
      api_server_url: account.apiServerUrl || 'https://server.codeium.com'
    }).toString();
    const uriStr = `windsurf://windsurf.windsurf/auth-callback#${fragment}`;

    try {
      /* 优先: 内部 URI 分发 (不触发 Marketplace 查找, 不弹 "无法安装扩展" 提示) */
      await vscode.commands.executeCommand('workbench.action.url.handle', uriStr);
    } catch {
      /* 回退: 旧版 Windsurf 可能没这个内部命令, 用 openExternal 兜底 */
      try {
        const uri = vscode.Uri.parse(uriStr);
        const opened = await vscode.env.openExternal(uri);
        if (!opened) {
          const msg = 'URI 回调触发失败 (openExternal 返回 false)';
          this.postMessage({ type: 'switchError', payload: { accountId, error: msg } });
          vscode.window.showErrorMessage(`切号失败: ${msg}`);
          return;
        }
      } catch (err: any) {
        this.postMessage({ type: 'switchError', payload: { accountId, error: err.message } });
        vscode.window.showErrorMessage(`URI 回调触发异常: ${err.message}`);
        return;
      }
    }

    /* Step 5: 上报成功 (session 生效是异步的, 无法同步等) */
    log('info', TAG, `✅ URI 切号已触发: ${account.email}`);
    vscode.window.showInformationMessage(`✅ 已通过 URI 回调切换到: ${account.email}`);
    this.postMessage({ type: 'switchDone', payload: { accountId } });
    this.sendFullState();
    this.updateStatusBar();

    /* Step 6: 占锁 + 静默重置机器码 */
    if (account.email) {
      this.instanceManager.acquireLock(account.email);
    }
    this.silentResetMachineId();
  }

  /**
   * 尝试登出当前账号
   * 依次尝试 windsurf.logout / codeium.signOut, 静默失败
   */
  private async tryLogout(): Promise<void> {
    try {
      const allCommands = await vscode.commands.getCommands(true);
      const logoutCmds = ['windsurf.logout', 'codeium.signOut'];
      for (const cmd of logoutCmds) {
        if (allCommands.includes(cmd)) {
          try {
            await vscode.commands.executeCommand(cmd);
            log('info', TAG, `已执行登出命令: ${cmd}`);
            await this.delay(300);
            return;
          } catch (err: any) {
            log('warn', TAG, `登出命令 ${cmd} 失败: ${err.message}`);
          }
        }
      }
    } catch (err: any) {
      log('warn', TAG, `获取命令列表失败: ${err.message}`);
    }
  }

  /** 延迟工具函数 */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** 删除账号 */
  private async handleDeleteAccount(accountId?: string): Promise<void> {
    if (!accountId) { return; }
    await this.accountManager.removeAccount(accountId);
    this.sendFullState();
  }

  /** 清空账号 */
  private async handleClearAccounts(): Promise<void> {
    await this.accountManager.clearAll();
    this.sendFullState();
    this.updateStatusBar();
  }

  /**
   * 导出账号
   * @param accountIds - 可选, 只导出指定 ID 的账号; 不传则导出全部
   */
  private async handleExportAccounts(accountIds?: string[]): Promise<void> {
    const text = this.accountManager.exportAccounts(accountIds);
    const count = text.split('\n').filter(l => l.trim()).length;
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`已复制 ${count} 个账号到剪贴板`);
  }

  /**
   * 编辑账号：接收 webview 弹窗提交的字段 (password + note + groupId)
   * 密码变更时自动清空登录缓存并重登验证
   * @param payload - {accountId, password?, note?, groupId?}
   */
  private async handleEditAccount(payload?: {
    accountId?: string;
    password?: string;
    note?: string;
    groupId?: string | null;
  }): Promise<void> {
    const accountId = payload?.accountId;
    if (!accountId) { return; }
    const account = this.accountManager.getAccounts().find(a => a.id === accountId);
    if (!account) { return; }

    /* 只改密码/备注/分组；邮箱不允许在这里改（避免踩坑） */
    const changed = await this.accountManager.updateAccount(accountId, {
      password: payload?.password,
      note: payload?.note,
      groupId: payload?.groupId
    });

    if (!changed) {
      vscode.window.showInformationMessage('未做任何修改');
      return;
    }

    /* 密码改了 → 立即重登验证；否则只保存备注 */
    if (payload?.password !== undefined && payload.password.length > 0) {
      const loginErr = await this.accountManager.loginAccount(accountId);
      if (loginErr) {
        vscode.window.showWarningMessage(`保存成功，但新密码登录失败: ${loginErr}`);
      } else {
        vscode.window.showInformationMessage(`账号已更新并重新登录: ${account.email}`);
        await this.balanceChecker.checkAccountById(accountId);
      }
    } else {
      vscode.window.showInformationMessage(`备注已更新: ${account.email}`);
    }
    this.sendFullState();
  }

  /**
   * 刷新指定账号余额
   * 无论是否活跃都能刷：先登录拿 apiKey，再查询配额
   *
   * 向前端发 singleRefreshStart/singleRefreshDone 消息, 使卡片的刷新图标转圈
   */
  private async handleRefreshBalance(accountId?: string): Promise<void> {
    if (!accountId) { return; }

    /* 开始: 通知前端加转圈 */
    this.postMessage({ type: 'singleRefreshStart', payload: { accountId } });

    try {
      const loginErr = await this.accountManager.loginAccount(accountId);
      if (loginErr) {
        vscode.window.showWarningMessage(`刷新失败: ${loginErr}`);
        this.sendFullState();
        return;
      }
      /* 按 ID 刷新（不管是不是活跃账号） */
      await this.balanceChecker.checkAccountById(accountId);
      this.sendFullState();
    } finally {
      /* 无论成功失败, 都通知前端移除转圈 */
      this.postMessage({ type: 'singleRefreshDone', payload: { accountId } });
    }
  }

  /** 刷新所有余额 */
  private async handleRefreshAllBalances(): Promise<void> {
    this.postMessage({ type: 'refreshStart' });

    await this.balanceChecker.refreshAll((current, total, email) => {
      this.postMessage({
        type: 'refreshProgress',
        payload: { current, total, email }
      });
    });

    this.postMessage({ type: 'refreshDone' });
    this.sendFullState();
  }

  /**
   * 批量刷新选中账号 (仅刷传入 ID 列表, 而非全量)
   *
   * 复用 refreshByIds 的有界并发能力; 前端在点击时已给卡片加转圈,
   * 每个账号的 singleRefreshDone 由内部 refreshByIds 走完 refreshSingleAccount → 发
   *
   * @param accountIds - 选中的账号 ID 列表
   */
  private async handleBulkRefresh(accountIds?: string[]): Promise<void> {
    if (!accountIds || accountIds.length === 0) { return; }

    /* 通知前端所有选中卡片开始转圈 (后端也发一遍, 防止前端漏同步) */
    for (const id of accountIds) {
      this.postMessage({ type: 'singleRefreshStart', payload: { accountId: id } });
    }
    this.postMessage({ type: 'refreshStart' });

    try {
      await this.balanceChecker.refreshByIds(accountIds, (current, total, email) => {
        this.postMessage({
          type: 'refreshProgress',
          payload: { current, total, email }
        });
      });
    } finally {
      /* 无论成败, 都要清掉每张卡片的转圈态 */
      for (const id of accountIds) {
        this.postMessage({ type: 'singleRefreshDone', payload: { accountId: id } });
      }
      this.postMessage({ type: 'refreshDone' });
      this.sendFullState();
    }
  }

  /** 应用补丁 */
  private async handleApplyPatch(): Promise<void> {
    this.postMessage({ type: 'patchStart' });

    try {
      const applied = await this.windsurfPatch.applyAll();
      this.postMessage({
        type: 'patchDone',
        payload: { applied, message: `成功应用 ${applied.length} 个补丁方案` }
      });
      vscode.window.showInformationMessage(
        `补丁应用完成: ${applied.join(', ')}。重启 Windsurf 后生效。`
      );
    } catch (err: any) {
      this.postMessage({
        type: 'patchError',
        payload: { error: err.message }
      });
      vscode.window.showErrorMessage(`补丁应用失败: ${err.message}`);
    }

    this.sendPatchStatus();
  }

  /** 恢复补丁 */
  private async handleRestorePatch(): Promise<void> {
    try {
      const ok = await this.windsurfPatch.restoreAll();
      if (ok) {
        vscode.window.showInformationMessage('补丁已恢复，重启 Windsurf 后生效');
      } else {
        vscode.window.showWarningMessage('未找到备份文件，无法恢复');
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`恢复失败: ${err.message}`);
    }

    this.sendPatchStatus();
  }

  /**
   * 切换切号模式 (patch / uri)
   *
   * 写入 workspace config → 下次 doSwitchAccount 读到新值立即生效
   * 切到 uri 模式时若 URI 补丁未应用, 不在这里强推 (让用户下次 switchAccount 时再处理)
   *
   * @param mode - "patch" | "uri"
   */
  private async handleSetSwitchMode(mode?: string): Promise<void> {
    if (mode !== 'patch' && mode !== 'uri') {
      log('warn', TAG, `非法 switchMode: ${mode}`);
      return;
    }
    try {
      const config = vscode.workspace.getConfiguration('wfSwitcher');
      await config.update('switchMode', mode, vscode.ConfigurationTarget.Global);
      log('info', TAG, `切号模式已切换: ${mode}`);
      vscode.window.showInformationMessage(
        mode === 'uri'
          ? '已切到 URI 模式。下次切号会通过 windsurf:// 协议回调'
          : '已切到 Patch 模式 (默认, 最快最稳)'
      );
    } catch (err: any) {
      log('error', TAG, `切换模式失败: ${err.message}`);
      vscode.window.showErrorMessage(`切换模式失败: ${err.message}`);
    }
    /* 回推最新状态给 UI (toggle 同步) */
    this.sendPatchStatus();
  }

  /** 独立应用 URI 补丁 (UI 按钮触发, 不经 switchViaUri 流程) */
  private async handleApplyUriPatch(): Promise<void> {
    this.postMessage({ type: 'patchStart' });
    try {
      const res = await this.windsurfPatch.applyUriPatch();
      if (res.success) {
        this.postMessage({
          type: 'patchDone',
          payload: { applied: ['uri_handler'], message: 'URI 补丁已应用' }
        });
        const restart = res.needsRestart
          ? await vscode.window.showInformationMessage(
              '✅ URI 补丁已应用，需要重启 Windsurf 才能生效',
              '立即重启', '稍后重启'
            )
          : undefined;
        if (restart === '立即重启') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } else {
        this.postMessage({ type: 'patchError', payload: { error: res.error } });
        vscode.window.showErrorMessage(`URI 补丁应用失败: ${res.error}`);
      }
    } catch (err: any) {
      this.postMessage({ type: 'patchError', payload: { error: err.message } });
      vscode.window.showErrorMessage(`URI 补丁应用失败: ${err.message}`);
    }
    this.sendPatchStatus();
  }

  /** 独立恢复 URI 补丁 (UI 按钮触发) */
  private async handleRestoreUriPatch(): Promise<void> {
    try {
      const ok = await this.windsurfPatch.restoreUriPatch();
      if (ok) {
        vscode.window.showInformationMessage('URI 补丁已恢复，重启 Windsurf 后生效');
      } else {
        vscode.window.showWarningMessage('未找到 URI 备份，无法恢复');
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`URI 补丁恢复失败: ${err.message}`);
    }
    this.sendPatchStatus();
  }

  /** 重置机器码 (Phase 1.5: 含 fingerprint + installationId 补丁 + 重启弹窗) */
  private async handleResetMachineId(): Promise<void> {
    this.postMessage({ type: 'machineIdStart' });

    try {
      /* 1. 基础重置: storage.json + 平台特定 (注册表/machine-id) */
      const result = await this.machineIdManager.resetAll();

      /* 2. extension.js 补丁: fingerprint + installationId */
      const fpStep = this.windsurfPatch.patchFingerprint();
      const iidStep = this.windsurfPatch.patchInstallationId();
      result.steps.push(fpStep, iidStep);

      /* 重新计算汇总 */
      const successCount = result.steps.filter(s => s.success).length;
      result.success = result.steps.length > 0 && successCount === result.steps.length;
      const hasPatchStep = fpStep.success || iidStep.success;

      /* 扁平化 results[] 字符串数组, 兼容前端旧 payload */
      const resultsFlat = result.steps.map(s =>
        s.success
          ? `${s.name}: ${s.value || '成功'}`
          : `${s.name} 失败: ${s.error || '未知'}`
      );
      this.postMessage({
        type: 'machineIdDone',
        payload: { ...result, results: resultsFlat }
      });

      const total = result.steps.length;
      const okCount = successCount;

      /* 3. 弹窗: 根据结果决定提示内容 */
      if (result.requiresAdminHint) {
        vscode.window.showWarningMessage(
          `机器码重置部分失败 (${okCount}/${total})。需以管理员身份运行 Windsurf 才能写入 HKLM 注册表`
        );
      } else if (!result.success) {
        const firstErr = result.steps.find(s => !s.success)?.error || '未知错误';
        vscode.window.showWarningMessage(
          `机器码重置部分失败 (${okCount}/${total}): ${firstErr}`
        );
      }

      /* 4. 补丁改的是磁盘文件, 必须重启 Windsurf 才生效 → 立刻弹窗问是否重启 */
      if (hasPatchStep) {
        const choice = await vscode.window.showInformationMessage(
          `机器码已重置 (${okCount}/${total})。extension.js 补丁需要重启 Windsurf 才能生效，是否立即重启？`,
          { modal: true },
          '立即重启',
          '稍后手动重启'
        );

        if (choice === '立即重启') {
          log('info', TAG, '用户选择立即重启 Windsurf');
          this.restartWindsurf();
        }
      } else {
        /* 没有补丁步骤 (可能 extension.js 没找到), 不需要重启 */
        vscode.window.showInformationMessage(
          `机器码已重置 (${okCount}/${total})`
        );
      }
    } catch (err: any) {
      this.postMessage({
        type: 'machineIdError',
        payload: { error: err.message }
      });
      vscode.window.showErrorMessage(`重置失败: ${err.message}`);
    }
  }

  /** 手动切号冷却截止时间戳 */
  private manualResetCooldownUntil: number = 0;

  /**
   * 静默重置机器码 (手动切号场景, fire-and-forget)
   * 共享 autoResetMachineIdOnAutoSwitch 开关 + 5 分钟冷却
   */
  private silentResetMachineId(): void {
    const config = vscode.workspace.getConfiguration('wfSwitcher');
    const enabled = config.get<boolean>('autoResetMachineIdOnAutoSwitch', false);

    if (!enabled) { return; }

    const now = Date.now();
    if (now < this.manualResetCooldownUntil) {
      const remaining = Math.ceil((this.manualResetCooldownUntil - now) / 1000);
      log('info', TAG, `手动切号重置机器码: 冷却中, 剩余 ${remaining}s, 跳过`);
      return;
    }
    this.manualResetCooldownUntil = now + 5 * 60 * 1000;

    const mgr = this.machineIdManager;
    const patch = this.windsurfPatch;

    (async () => {
      try {
        const result = await mgr.resetAll();
        const baseOk = result.steps.filter(s => s.success).length;
        const fpStep = patch.patchFingerprint();
        const iidStep = patch.patchInstallationId();
        const patchOk = (fpStep.success ? 1 : 0) + (iidStep.success ? 1 : 0);
        log('info', TAG,
          `手动切号重置机器码完成: 基础 ${baseOk}/${result.steps.length}, 补丁 ${patchOk}/2`
        );
      } catch (err: any) {
        log('error', TAG, `手动切号重置机器码异常: ${err.message}`);
      }
    })();
  }

  /**
   * 重启 Windsurf: 写临时脚本 → 用 start 创建独立进程 → 延迟退出当前实例
   *
   * 关键: spawn 的 detached 子进程仍会被 Electron 退出时的进程树清理杀掉,
   * 必须通过 cmd /c start 创建完全独立的进程树才能存活。
   * Windows 用 .bat + ping 延迟 (timeout 在无交互控制台中静默失败)
   */
  private restartWindsurf(): void {
    const execPath = process.execPath;
    log('info', TAG, `准备重启 Windsurf, execPath: ${execPath}`);

    try {
      const fs = require('fs');
      const path = require('path');

      if (process.platform === 'win32') {
        /* 写临时 .bat: ping 延迟 3 秒 → 启动 Windsurf → 自删 */
        const tmpDir = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
        const batPath = path.join(tmpDir, `wf-restart-${Date.now()}.bat`);
        const batContent = [
          '@echo off',
          'ping -n 4 127.0.0.1 >nul 2>&1',
          `start "" "${execPath}"`,
          'del "%~f0"',
        ].join('\r\n');
        fs.writeFileSync(batPath, batContent);

        /* 创建完全独立进程 (不在 Electron 进程树内)
         * fallback 链: wmic → Invoke-WmiMethod → Start-Process */
        spawnDetachedWin(batPath);
        log('info', TAG, `已写入重启脚本: ${batPath}`);
      } else if (process.platform === 'darwin') {
        /* macOS: process.execPath 是 Electron 二进制, 不能直接用
         * 必须用 open -a 启动 .app bundle, 或用 open 打开 Contents/MacOS 上级 */
        let appPath = execPath;
        const contentsIdx = execPath.indexOf('.app/Contents');
        if (contentsIdx !== -1) {
          appPath = execPath.substring(0, contentsIdx + 4); // .app
        }
        const shPath = path.join('/tmp', `wf-restart-${Date.now()}.sh`);
        const shContent = [
          '#!/bin/bash',
          'sleep 3',
          `open -a "${appPath}"`,
          `rm -f "$0"`,
        ].join('\n');
        fs.writeFileSync(shPath, shContent, { mode: 0o755 });

        /* nohup + & 确保脚本独立于 Electron 进程树 */
        execSync(`nohup /bin/bash "${shPath}" &`, { timeout: 3000, stdio: 'ignore' });
        log('info', TAG, `macOS 重启脚本: ${shPath}, app: ${appPath}`);
      } else {
        /* Linux: nohup 独立执行 */
        const shPath = path.join('/tmp', `wf-restart-${Date.now()}.sh`);
        const shContent = [
          '#!/bin/bash',
          'sleep 3',
          `"${execPath}" &`,
          `rm -f "$0"`,
        ].join('\n');
        fs.writeFileSync(shPath, shContent, { mode: 0o755 });
        execSync(`nohup /bin/bash "${shPath}" &`, { timeout: 3000, stdio: 'ignore' });
        log('info', TAG, `Linux 重启脚本: ${shPath}`);
      }
    } catch (err: any) {
      log('error', TAG, `启动重启进程失败: ${err.message}`);
    }

    /* 延迟 500ms 退出, 让 start 命令有时间创建独立进程 */
    setTimeout(() => {
      vscode.commands.executeCommand('workbench.action.quit');
    }, 500);
  }

  /** 更新设置 */
  private async handleUpdateSettings(settings?: any): Promise<void> {
    if (!settings) { return; }

    const config = vscode.workspace.getConfiguration('wfSwitcher');

    for (const [key, value] of Object.entries(settings)) {
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    }

    /* 重启余额监控 (间隔可能变了) */
    this.balanceChecker.startMonitor();
    this.sendFullState();
  }

  /**
   * 脱敏邮箱地址 (本地部分 + 域名部分双脱敏)
   *
   * 规则:
   *   - 本地部分 (`@` 前): 首 2 + **** + 末 1; ≤3 字符保持原样
   *   - 域名部分 (`@` 后): 顶级 `.tld` 保留, 二级前段取末 2 字符前加 `**`; 二级 ≤2 字符 (qq) 保持
   *
   * 示例:
   *   - kourichkhalid@gmail.com   → ko****d@**il.com
   *   - gebelo482@gimpmail.com    → ge****2@**il.com
   *   - user@qq.com               → us****r@qq.com         (qq 太短不脱敏)
   *   - admin@163.com             → ad****n@**63.com
   *
   * @param email - 完整邮箱
   * @returns 脱敏后的邮箱
   */
  private maskEmail(email: string): string {
    const atIdx = email.indexOf('@');
    if (atIdx <= 0) { return email; }
    const local = email.substring(0, atIdx);
    const domainPart = email.substring(atIdx + 1);

    /* 本地部分脱敏 */
    const maskedLocal = local.length <= 3
      ? local
      : local.substring(0, 2) + '****' + local.substring(local.length - 1);

    /* 域名部分脱敏: 找最后一个 dot 拆 sld + tld */
    const lastDotIdx = domainPart.lastIndexOf('.');
    let maskedDomain: string;
    if (lastDotIdx <= 0) {
      /* 异常域名 (无 dot 或 dot 在开头), 直接保留 */
      maskedDomain = domainPart;
    } else {
      const tld = domainPart.substring(lastDotIdx);          // ".com"
      const sld = domainPart.substring(0, lastDotIdx);       // "gmail"
      maskedDomain = sld.length <= 2
        ? domainPart                                          // qq.com 这种短 sld 保持原样
        : '**' + sld.substring(sld.length - 2) + tld;        // gmail → **il
    }

    return `${maskedLocal}@${maskedDomain}`;
  }

  /**
   * 更新状态栏 (脱敏邮箱 + 日/周双配额, 配额低自动告警)
   *
   * 文案:
   *   $(account) zm****t@**il.com  日62% · 周82%
   *
   * 背景色阈值 (基于自动切号阈值):
   *   - 日 ≤ threshold 且 周 ≤ 5 → errorBackground (红, 紧急)
   *   - 日 ≤ threshold 或 周 ≤ 5 → warningBackground (黄, 提醒)
   *   - 其他 → 默认透明
   */
  private updateStatusBar(): void {
    const config = vscode.workspace.getConfiguration('wfSwitcher');
    if (!config.get('statusBarEnabled', true)) {
      this.statusBarItem.hide();
      return;
    }

    const active = this.accountManager.getActiveAccount();
    if (!active) {
      this.statusBarItem.text = '$(account) WF-Swap';
      this.statusBarItem.tooltip = '点击切换账号';
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.show();
      return;
    }

    /* 文案: 紧凑双配额, "日X% · 周Y%" 中点分隔, 左日右周 */
    const dailyStr = active.dailyQuota !== undefined ? `日${active.dailyQuota}%` : '';
    const weeklyStr = active.weeklyQuota !== undefined ? `周${active.weeklyQuota}%` : '';
    const quotaPart = [dailyStr, weeklyStr].filter(Boolean).join(' · ');
    const maskedEmail = this.maskEmail(active.email);
    this.statusBarItem.text = `$(account) ${maskedEmail}${quotaPart ? '  ' + quotaPart : ''}`;

    /* tooltip: MarkdownString 支持 codicon + 加粗, 信息更丰富 */
    const md = new vscode.MarkdownString('', true);
    md.supportThemeIcons = true;
    md.appendMarkdown(`**WF-Swap**\n\n`);
    md.appendMarkdown(`${active.email}\n\n---\n\n`);
    if (active.dailyQuota !== undefined) {
      md.appendMarkdown(`$(calendar)  日额度: **${active.dailyQuota}%**\n\n`);
    }
    if (active.weeklyQuota !== undefined) {
      md.appendMarkdown(`$(history)  周额度: **${active.weeklyQuota}%**\n\n`);
    }
    if (active.planName) {
      md.appendMarkdown(`$(rocket)  套餐: ${active.planName}\n\n`);
    }
    md.appendMarkdown(`---\n\n点击切换账号`);
    this.statusBarItem.tooltip = md;

    /* 配额告警: 阈值取设置里的 autoSwitchThreshold (默认 5) */
    const threshold = config.get<number>('autoSwitchThreshold', 5);
    const dayLow = active.dailyQuota !== undefined && active.dailyQuota <= threshold;
    const weekLow = active.weeklyQuota !== undefined && active.weeklyQuota <= 5;
    if (dayLow && weekLow) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (dayLow || weekLow) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }

    this.statusBarItem.show();
  }

  /** 向 Webview 发送消息 */
  private postMessage(message: WebviewMessage): void {
    this.view?.webview.postMessage(message);
  }

  /** 快速切换账号 (命令面板调用) */
  async quickSwitch(): Promise<void> {
    const accounts = this.accountManager.getAccounts();
    if (accounts.length === 0) {
      vscode.window.showWarningMessage('没有可用的账号');
      return;
    }

    const items = accounts.map(a => {
      /* description (label 旁灰色副标题): 当前 · 套餐 */
      const tags: string[] = [];
      if (a.isActive) { tags.push('● 当前'); }
      if (a.planName) { tags.push(a.planName); }

      /* detail (第二行): 日/周配额; 未刷新时给提示 */
      const quotas: string[] = [];
      if (a.dailyQuota !== undefined) { quotas.push(`日 ${a.dailyQuota}%`); }
      if (a.weeklyQuota !== undefined) { quotas.push(`周 ${a.weeklyQuota}%`); }
      const detail = quotas.length > 0 ? quotas.join('  ·  ') : '配额未刷新, 请先刷新余额';

      return {
        label: a.email,
        description: tags.join('  ·  '),
        detail,
        accountId: a.id
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要切换的账号',
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (selected) {
      await this.doSwitchAccount((selected as any).accountId);
    }
  }

  /** 切换到下一个账号 */
  async switchNext(): Promise<void> {
    const planType = vscode.workspace.getConfiguration('wfSwitcher').get<string>('autoSwitchPlanType', 'All');
    const next = this.accountManager.getNextAvailableAccount(0, undefined, planType);
    if (next) {
      await this.doSwitchAccount(next.id);
    } else {
      vscode.window.showWarningMessage('没有下一个可用账号');
    }
  }

  /** 获取 AccountManager 引用 (供外部使用) */
  getAccountManager(): AccountManager {
    return this.accountManager;
  }

  /** 释放分身锁 + 注销实例 (extension deactivate 时调用) */
  releaseInstanceLock(): void {
    try {
      this.instanceManager.releaseLock();
      this.instanceManager.unregister();
    } catch (err: any) {
      log('error', TAG, `释放实例锁失败: ${err.message}`);
    }
  }

  /** 销毁 */
  dispose(): void {
    this.balanceChecker.dispose();
    this.statusBarItem.dispose();
  }
}

/* ================================================================
 * Windows 独立进程启动 (Electron 进程树外)
 *
 * Fallback 链:
 *   1. wmic process call create         — 最快, 但新 Win11 可能没有
 *   2. powershell Invoke-WmiMethod      — 等价机制, 所有 Win10/11 可用
 *   3. powershell Start-Process          — 兜底 (Job Object 里, 重启场景可能被杀)
 *
 * 首次调用自动探测可用方案并缓存, 后续直接走成功路径
 * ================================================================ */
let cachedWinSpawnMethod: 'wmic' | 'ps-wmi' | 'ps-start' | null = null;

/**
 * 在 Windows 上启动完全独立于 Electron 的进程 (用于分身 / 重启)
 * @param batPath - 要执行的 .bat 文件绝对路径
 */
function spawnDetachedWin(batPath: string): void {
  const methods: Array<{ key: typeof cachedWinSpawnMethod; run: () => void }> = [
    {
      key: 'wmic',
      run: () => execSync(
        `wmic process call create "cmd /c \\"${batPath}\\""`,
        { timeout: 5000, windowsHide: true }
      )
    },
    {
      key: 'ps-wmi',
      run: () => execSync(
        `powershell -NoProfile -Command "Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList 'cmd /c \\\"${batPath}\\\"'"`,
        { timeout: 8000, windowsHide: true }
      )
    },
    {
      key: 'ps-start',
      run: () => execSync(
        `powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c \\\"${batPath}\\\"' -WindowStyle Hidden"`,
        { timeout: 8000, windowsHide: true }
      )
    }
  ];

  /* 有缓存 → 直接用缓存方案 */
  if (cachedWinSpawnMethod) {
    const cached = methods.find(m => m.key === cachedWinSpawnMethod);
    if (cached) {
      try {
        cached.run();
        log('info', TAG, `独立进程启动成功 (缓存=${cached.key}): ${batPath}`);
        return;
      } catch {
        log('warn', TAG, `缓存方案 ${cached.key} 失效, 重新探测`);
        cachedWinSpawnMethod = null;
      }
    }
  }

  /* 无缓存 → 依次尝试, 成功即缓存 */
  for (const m of methods) {
    try {
      m.run();
      cachedWinSpawnMethod = m.key;
      log('info', TAG, `独立进程启动成功 (探测=${m.key}): ${batPath}`);
      return;
    } catch (err: any) {
      log('warn', TAG, `${m.key} 失败: ${err.message}`);
    }
  }

  throw new Error('所有独立进程启动方式均失败 (wmic / Invoke-WmiMethod / Start-Process)');
}
