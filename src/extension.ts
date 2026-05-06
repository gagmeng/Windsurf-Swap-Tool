/**
 * WF-Swap 扩展入口
 * Windsurf 多账号管理与自动切换工具 - 安全直连版
 * 所有认证请求直连 Firebase/Windsurf 官方服务器，无第三方代理
 * 开发者: Ti
 */

import * as vscode from 'vscode';
import { ViewProvider } from './viewProvider';
import { WindsurfPatch } from './windsurfPatch';
import { initLogger, log, showOutput } from './logger';

/** 模块级 ViewProvider 引用, 供 deactivate 释放锁 */
let viewProvider: ViewProvider | null = null;

/** 扩展激活入口 */
export function activate(context: vscode.ExtensionContext): void {
  /* 初始化日志通道 */
  const outputChannel = vscode.window.createOutputChannel('WF-Swap');
  initLogger(outputChannel);
  context.subscriptions.push(outputChannel);

  log('info', 'Extension', 'WF-Swap 正在启动...');
  log('info', 'Extension', '安全模式: 所有请求直连官方服务器');

  /* 自动修复旧补丁造成的核心文件损坏 (静默执行，不阻塞启动) */
  const patchRepair = new WindsurfPatch();
  patchRepair.repairCorruption().then(result => {
    if (result.repaired) {
      vscode.window.showInformationMessage(
        `WF-Swap: 已自动修复 ${result.files.length} 个被旧补丁损坏的核心文件 (${result.files.join(', ')})，请重启 Windsurf 消除警告`
      );
      log('info', 'Extension', `自动修复完成: ${result.files.join(', ')}`);
    }
  }).catch(() => { /* 静默 */ });

  /**
   * 补丁版本静默升级
   *
   * 场景: 用户升级了插件 (补丁代码递增了 PATCH_VERSION), 但 Windsurf 的 extension.js
   *       里还是旧版注入, 新补丁逻辑永远跑不到 → 用户不知道要手动回退再重装
   *
   * 这里检测到旧版就自动 restoreAll + applyAll, 一步到位, 仅需重启 Windsurf 生效
   * fire-and-forget, 失败只记日志, 不阻塞主流程
   */
  (async () => {
    try {
      if (patchRepair.isPatchOutdated()) {
        log('info', 'Extension', '检测到旧版补丁, 开始静默升级...');
        const result = await patchRepair.upgradePatch();
        if (result.success && result.needsRestart) {
          const choice = await vscode.window.showWarningMessage(
            'WF-Swap: 补丁已自动升级到新版，需要重启 Windsurf 才能生效',
            '立即重启', '稍后重启'
          );
          if (choice === '立即重启') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
          }
        } else if (!result.success) {
          log('warn', 'Extension', `补丁自动升级失败: ${result.error}`);
        }
      }
    } catch (err: any) {
      log('warn', 'Extension', `补丁版本检查异常: ${err.message}`);
    }
  })();

  /* 创建 ViewProvider */
  viewProvider = new ViewProvider(context.extensionUri, context);

  /* 注册 Webview 视图 */
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ViewProvider.viewType,
      viewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  /* 注册命令 */
  context.subscriptions.push(
    vscode.commands.registerCommand('wfSwitcher.show', () => {
      vscode.commands.executeCommand('wfSwitcher.panel.focus');
    }),

    vscode.commands.registerCommand('wfSwitcher.quickSwitch', () => {
      viewProvider!.quickSwitch();
    }),

    vscode.commands.registerCommand('wfSwitcher.switchNext', () => {
      viewProvider!.switchNext();
    }),

    vscode.commands.registerCommand('wfSwitcher.importAccounts', async () => {
      const text = await vscode.window.showInputBox({
        prompt: '输入账号 (每行一个，格式: 邮箱;密码)',
        placeHolder: 'user@example.com;password123'
      });
      if (text) {
        const manager = viewProvider!.getAccountManager();
        const count = await manager.importAccounts(text);
        vscode.window.showInformationMessage(`成功导入 ${count} 个账号`);
      }
    }),

    vscode.commands.registerCommand('wfSwitcher.exportAccounts', () => {
      const manager = viewProvider!.getAccountManager();
      const text = manager.exportAccounts();
      const count = text.split('\n').filter(l => l.trim()).length;
      vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(`已复制 ${count} 个账号到剪贴板`);
    }),

    vscode.commands.registerCommand('wfSwitcher.clearAccounts', async () => {
      const choice = await vscode.window.showWarningMessage(
        '确定要清空所有账号吗？此操作不可恢复。',
        { modal: true },
        '确定清空'
      );
      if (choice === '确定清空') {
        const manager = viewProvider!.getAccountManager();
        await manager.clearAll();
        vscode.window.showInformationMessage('所有账号已清空');
      }
    }),

    vscode.commands.registerCommand('wfSwitcher.refreshAllBalances', () => {
      /* 通过 ViewProvider 触发，以便更新 UI */
      vscode.commands.executeCommand('wfSwitcher.panel.focus');
    }),

    vscode.commands.registerCommand('wfSwitcher.applyPatch', () => {
      vscode.commands.executeCommand('wfSwitcher.panel.focus');
    }),

    vscode.commands.registerCommand('wfSwitcher.restorePatch', () => {
      vscode.commands.executeCommand('wfSwitcher.panel.focus');
    }),

    vscode.commands.registerCommand('wfSwitcher.resetMachineId', () => {
      vscode.commands.executeCommand('wfSwitcher.panel.focus');
    })
  );

  /* 监听配置变更 */
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('wfSwitcher')) {
        log('info', 'Extension', '配置已变更');
      }
    })
  );

  log('info', 'Extension', 'WF-Swap 已启动');
}

/** 扩展停用: 释放分身锁 + 注销实例 */
export function deactivate(): void {
  if (viewProvider) {
    viewProvider.releaseInstanceLock();
  }
  log('info', 'Extension', 'WF-Swap 已停用');
}
