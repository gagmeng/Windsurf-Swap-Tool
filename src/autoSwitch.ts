/**
 * 自动切号模块
 * 配额耗尽时自动切换到下一个可用账号
 * 开发者: Ti
 */

import * as vscode from 'vscode';
import { AccountManager } from './accountManager';
import { MachineIdManager } from './machineId';
import { WindsurfPatch } from './windsurfPatch';
import { log } from './logger';

const TAG = 'AutoSwitch';

/** 机器码重置冷却时间 (毫秒) */
const RESET_COOLDOWN_MS = 5 * 60 * 1000;

export class AutoSwitch {
  private accountManager: AccountManager;
  private machineIdManager?: MachineIdManager;
  private windsurfPatch?: WindsurfPatch;
  private onSwitchAccount?: (accountId: string) => Promise<void>;
  private switchInProgress: boolean = false;

  /** 冷却截止时间戳: 在此之前不重复触发机器码重置 */
  private resetCooldownUntil: number = 0;

  constructor(accountManager: AccountManager) {
    this.accountManager = accountManager;
  }

  /** 注入机器码重置依赖 (由 ViewProvider 调用) */
  setMachineIdDeps(machineIdManager: MachineIdManager, windsurfPatch: WindsurfPatch): void {
    this.machineIdManager = machineIdManager;
    this.windsurfPatch = windsurfPatch;
  }

  /** 设置切号回调 (由 ViewProvider 注入，负责实际的 Token 注入) */
  setSwitchCallback(callback: (accountId: string) => Promise<void>): void {
    this.onSwitchAccount = callback;
  }

  /**
   * 处理配额不足事件
   * @param accountId - 当前账号 ID
   * @param dailyPercent - 剩余日配额百分比
   * @param weeklyPercent - 剩余周配额百分比
   */
  async handleQuotaLow(accountId: string, dailyPercent: number, weeklyPercent: number = -1): Promise<void> {
    const config = vscode.workspace.getConfiguration('wfSwitcher');
    const enabled = config.get<boolean>('autoSwitchEnabled', false);
    const silent = config.get<boolean>('autoSwitchSilent', false);
    const threshold = config.get<number>('autoSwitchThreshold', 5);
    const planType = config.get<string>('autoSwitchPlanType', 'All');

    if (!enabled) {
      return;
    }

    const currentAccount = this.accountManager.getActiveAccount();
    if (!currentAccount || currentAccount.id !== accountId) {
      return;
    }

    const weeklyExhausted = weeklyPercent <= 0;
    log('info', TAG,
      `账号 ${currentAccount.email} 周配额剩余 ${weeklyPercent}%, 日配额剩余 ${dailyPercent}%` +
      (weeklyExhausted ? ' (周配额已耗尽!)' : `, 日阈值 ${threshold}%`)
    );

    /* 找下一个可用账号 (按订阅类型过滤) */
    const nextAccount = this.accountManager.getNextAvailableAccount(threshold, undefined, planType);
    if (!nextAccount) {
      log('warn', TAG, '没有可用的账号可切换');
      vscode.window.showWarningMessage('所有账号配额均已不足，无法自动切换');
      return;
    }

    /* 静默模式或确认弹窗 */
    if (silent) {
      await this.doSwitch(nextAccount.id, nextAccount.email);
    } else {
      const choice = await vscode.window.showInformationMessage(
        weeklyExhausted
          ? `当前账号 ${currentAccount.email} 周配额已耗尽，是否切换到 ${nextAccount.email}?`
          : `当前账号 ${currentAccount.email} 日配额不足 (${dailyPercent}%)，是否切换到 ${nextAccount.email}?`,
        '切换',
        '取消'
      );

      if (choice === '切换') {
        await this.doSwitch(nextAccount.id, nextAccount.email);
      }
    }
  }

  /** 执行切换 */
  private async doSwitch(accountId: string, email: string): Promise<void> {
    if (this.switchInProgress) {
      log('warn', TAG, `自动切换进行中，跳过重复触发: ${email}`);
      return;
    }

    this.switchInProgress = true;
    try {
      if (!this.onSwitchAccount) {
        const msg = '切号回调未初始化';
        log('error', TAG, `自动切换失败 (${email}): ${msg}`);
        vscode.window.showErrorMessage(`自动切换失败: ${msg}`);
        return;
      }

      await this.onSwitchAccount(accountId);
      log('info', TAG, `自动切换流程已触发: ${email}`);
    } catch (err: any) {
      log('error', TAG, `自动切换失败: ${err.message}`);
      vscode.window.showErrorMessage(`自动切换失败: ${err.message}`);
    } finally {
      this.switchInProgress = false;
    }
  }

  /**
   * 静默重置机器码 (fire-and-forget)
   * - 只在配置开关打开时触发
   * - 5 分钟冷却, 防止短时间内反复重置
   * - 不弹窗不阻塞, 只写日志
   * - 包含 storage.json + 注册表 + fingerprint/installationId 补丁
   */
  private silentResetMachineId(): void {
    const config = vscode.workspace.getConfiguration('wfSwitcher');
    const enabled = config.get<boolean>('autoResetMachineIdOnAutoSwitch', false);

    if (!enabled) {
      log('info', TAG, '自动重置机器码: 开关未开启, 跳过');
      return;
    }

    if (!this.machineIdManager || !this.windsurfPatch) {
      log('warn', TAG, '自动重置机器码: 依赖未注入, 跳过');
      return;
    }

    /* 冷却检查 */
    const now = Date.now();
    if (now < this.resetCooldownUntil) {
      const remaining = Math.ceil((this.resetCooldownUntil - now) / 1000);
      log('info', TAG, `自动重置机器码: 冷却中, 剩余 ${remaining}s, 跳过`);
      return;
    }

    /* 设置冷却 */
    this.resetCooldownUntil = now + RESET_COOLDOWN_MS;

    /* fire-and-forget: 不 await, 不阻塞切号流程 */
    const machineIdMgr = this.machineIdManager;
    const patch = this.windsurfPatch;

    (async () => {
      try {
        /* 1. 基础重置: storage.json + 注册表/machine-id */
        const result = await machineIdMgr.resetAll();
        const baseOk = result.steps.filter(s => s.success).length;
        const baseTotal = result.steps.length;

        /* 2. extension.js 补丁: fingerprint + installationId */
        const fpStep = patch.patchFingerprint();
        const iidStep = patch.patchInstallationId();
        const patchOk = (fpStep.success ? 1 : 0) + (iidStep.success ? 1 : 0);

        log('info', TAG,
          `自动重置机器码完成: 基础 ${baseOk}/${baseTotal}, 补丁 ${patchOk}/2` +
          (result.requiresAdminHint ? ' (需管理员权限)' : '')
        );
      } catch (err: any) {
        log('error', TAG, `自动重置机器码异常: ${err.message}`);
      }
    })();
  }
}
