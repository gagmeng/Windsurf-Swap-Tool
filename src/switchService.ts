import * as vscode from 'vscode';
import { AccountManager } from './accountManager';
import { InstanceManager } from './instanceManager';
import { CUSTOM_COMMAND, WindsurfPatch } from './windsurfPatch';
import { log } from './logger';
import { AccountInfo, WebviewMessage } from './types';

const TAG = 'SwitchService';

type SwitchableAccount = AccountInfo & { apiKey: string };

interface SwitchServiceOptions {
  accountManager: AccountManager;
  instanceManager: InstanceManager;
  windsurfPatch: WindsurfPatch;
  postMessage: (message: WebviewMessage) => void;
  onStateChanged: () => void;
  onSwitchCompleted: () => void;
}

export class SwitchService {
  private accountManager: AccountManager;
  private instanceManager: InstanceManager;
  private windsurfPatch: WindsurfPatch;
  private postMessage: (message: WebviewMessage) => void;
  private onStateChanged: () => void;
  private onSwitchCompleted: () => void;

  constructor(options: SwitchServiceOptions) {
    this.accountManager = options.accountManager;
    this.instanceManager = options.instanceManager;
    this.windsurfPatch = options.windsurfPatch;
    this.postMessage = options.postMessage;
    this.onStateChanged = options.onStateChanged;
    this.onSwitchCompleted = options.onSwitchCompleted;
  }

  async switchAccount(accountId: string): Promise<void> {
    const switchMode = vscode.workspace.getConfiguration('wfSwitcher')
      .get<string>('switchMode', 'patch');
    if (switchMode === 'uri') {
      return this.switchViaUri(accountId);
    }

    this.postMessage({ type: 'switchStart', payload: { accountId } });

    const conflictAllowed = await this.confirmSwitchConflict(accountId);
    if (!conflictAllowed) {
      return;
    }

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

    const account = await this.loginAndResolveAccount(accountId);
    if (!account) {
      return;
    }

    await this.tryLogout();
    await this.accountManager.setActiveAccount(accountId);

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
          lastError = new Error('补丁内部变量失效，请重新应用补丁');
          break;
        }

        this.completeSwitch(accountId, account.email, `✅ 切号成功: ${account.email}`, `✅ 已切换到: ${account.email}`);
        return;
      } catch (err: any) {
        lastError = err;
        log('warn', TAG, `[${attempt}/3] 切号命令执行失败: ${err.message}`);
        if (attempt < 3) {
          await this.delay(1500);
        }
      }
    }

    const errMsg = lastError?.message || '未知错误';
    log('error', TAG, `切号最终失败: ${errMsg}`);
    this.postMessage({ type: 'switchError', payload: { accountId, error: errMsg } });
    vscode.window.showErrorMessage(`切号失败: ${errMsg} (请确认已应用补丁并重启 Windsurf)`);
  }

  private async switchViaUri(accountId: string): Promise<void> {
    this.postMessage({ type: 'switchStart', payload: { accountId } });

    const conflictAllowed = await this.confirmSwitchConflict(accountId);
    if (!conflictAllowed) {
      return;
    }

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

    const account = await this.loginAndResolveAccount(accountId);
    if (!account) {
      return;
    }

    await this.tryLogout();
    await this.accountManager.setActiveAccount(accountId);

    const fragment = new URLSearchParams({
      api_key: account.apiKey,
      name: account.displayName || account.email,
      api_server_url: account.apiServerUrl || 'https://server.codeium.com'
    }).toString();
    const uriStr = `windsurf://windsurf.windsurf/auth-callback#${fragment}`;

    try {
      await vscode.commands.executeCommand('workbench.action.url.handle', uriStr);
    } catch {
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

    this.completeSwitch(accountId, account.email, `✅ URI 切号已触发: ${account.email}`, `✅ 已通过 URI 回调切换到: ${account.email}`);
  }

  private async confirmSwitchConflict(accountId: string): Promise<boolean> {
    const targetAcct = this.accountManager.getAccounts().find(a => a.id === accountId);
    if (!targetAcct?.email) {
      return true;
    }

    const conflict = this.instanceManager.getConflictInstance(targetAcct.email);
    if (!conflict) {
      return true;
    }

    const ago = conflict.lockedAt
      ? Math.round((Date.now() - conflict.lockedAt) / 60000) + ' 分钟前'
      : '未知时间';
    const choice = await vscode.window.showWarningMessage(
      `⚠️ ${targetAcct.email} 正在被「${conflict.label}」使用 (${ago})，同时使用可能导致限速或封号`,
      '仍然切换', '取消'
    );
    if (choice !== '仍然切换') {
      this.postMessage({ type: 'switchError', payload: { accountId, error: '用户取消: 账号被其他分身占用' } });
      return false;
    }
    return true;
  }

  private async loginAndResolveAccount(accountId: string): Promise<SwitchableAccount | undefined> {
    const loginErr = await this.accountManager.loginAccount(accountId);
    if (loginErr) {
      this.postMessage({ type: 'switchError', payload: { accountId, error: loginErr } });
      vscode.window.showErrorMessage(`切号失败: ${loginErr}`);
      return undefined;
    }

    const account = this.accountManager.getAccounts().find(a => a.id === accountId);
    if (!account?.apiKey) {
      const msg = '登录成功但未获取到 apiKey';
      this.postMessage({ type: 'switchError', payload: { accountId, error: msg } });
      vscode.window.showErrorMessage(`切号失败: ${msg}`);
      return undefined;
    }
    return account as SwitchableAccount;
  }

  private completeSwitch(accountId: string, email: string, logMessage: string, userMessage: string): void {
    log('info', TAG, logMessage);
    vscode.window.showInformationMessage(userMessage);
    this.postMessage({ type: 'switchDone', payload: { accountId } });
    this.onStateChanged();

    if (email) {
      this.instanceManager.acquireLock(email);
    }
    this.onSwitchCompleted();
  }

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

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
