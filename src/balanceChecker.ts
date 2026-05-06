/**
 * 余额/配额检查模块
 * 定时查询当前账号配额，支持批量刷新
 * 开发者: Ti
 */

import * as vscode from 'vscode';
import { AccountManager } from './accountManager';
import { getPlanStatus } from './windsurfApi';
import { log } from './logger';
import { mapLimit, resolveConcurrencyLimit } from './concurrency';

const TAG = 'BalanceChecker';

export class BalanceChecker {
  private timer: NodeJS.Timeout | null = null;
  private accountManager: AccountManager;
  private onQuotaLow?: (accountId: string, daily: number, weekly: number) => void;
  private onQuotaUpdate?: () => void;

  constructor(accountManager: AccountManager) {
    this.accountManager = accountManager;
  }

  /** 设置配额不足回调 */
  setQuotaLowCallback(callback: (accountId: string, daily: number, weekly: number) => void): void {
    this.onQuotaLow = callback;
  }

  /** 设置配额更新回调 (每次成功刷新后触发，用于同步状态栏) */
  setQuotaUpdateCallback(callback: () => void): void {
    this.onQuotaUpdate = callback;
  }

  /** 启动定时检查 */
  startMonitor(): void {
    this.stopMonitor();

    const config = vscode.workspace.getConfiguration('wfSwitcher');
    const enabled = config.get<boolean>('balanceAutoRefresh', true);
    const intervalSec = config.get<number>('balanceRefreshInterval', 30);

    if (!enabled) {
      log('info', TAG, '自动刷新已禁用');
      return;
    }

    log('info', TAG, `启动定时检查，间隔 ${intervalSec} 秒`);

    /* 立即执行一次 */
    this.checkActiveAccount();

    /* 定时执行 */
    this.timer = setInterval(() => {
      this.checkActiveAccount();
    }, intervalSec * 1000);
  }

  /** 停止定时检查 */
  stopMonitor(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 按 ID 查询并更新指定账号的配额
   * @param accountId - 账号 ID
   * @returns 剩余日配额百分比 (无数据返回 -1)
   */
  async checkAccountById(accountId: string): Promise<number> {
    const account = this.accountManager.getAccounts().find(a => a.id === accountId);
    if (!account?.apiKey) { return -1; }
    try {
      const status = await getPlanStatus(account.apiKey, account);
      await this.accountManager.updateQuota(
        account.id,
        status.dailyRemainingPercent,
        status.weeklyRemainingPercent,
        {
          planName: status.planName,
          dailyResetAt: status.dailyResetAtUnix,
          weeklyResetAt: status.weeklyResetAtUnix,
          planStartAt: status.planStartAtUnix,
          planEndAt: status.planEndAtUnix
        }
      );
      /* 同步刷新状态栏 */
      this.onQuotaUpdate?.();
      return status.dailyRemainingPercent;
    } catch (err: any) {
      log('error', TAG, `刷新配额失败 (${account.email}): ${err.message}`);
      return -1;
    }
  }

  /** 检查当前活跃账号的配额 */
  async checkActiveAccount(): Promise<void> {
    const account = this.accountManager.getActiveAccount();
    if (!account || !account.apiKey) {
      return;
    }

    try {
      const status = await getPlanStatus(account.apiKey, account);
      const dailyPercent = status.dailyRemainingPercent;
      const weeklyPercent = status.weeklyRemainingPercent;

      await this.accountManager.updateQuota(account.id, dailyPercent, weeklyPercent, {
        planName: status.planName,
        dailyResetAt: status.dailyResetAtUnix,
        weeklyResetAt: status.weeklyResetAtUnix,
        planStartAt: status.planStartAtUnix,
        planEndAt: status.planEndAtUnix
      });

      /* 检查是否需要触发切号:
       * 1. 周配额 = 0 → 直接切 (本周已耗尽, 完全不可用)
       * 2. 周配额 > 0 + 日配额 ≤ 阈值 → 切 (今日额度不足) */
      const threshold = vscode.workspace.getConfiguration('wfSwitcher')
        .get<number>('autoSwitchThreshold', 5);

      const weeklyExhausted = weeklyPercent <= 0;
      const dailyLow = dailyPercent <= threshold;

      if ((weeklyExhausted || dailyLow) && this.onQuotaLow) {
        this.onQuotaLow(account.id, dailyPercent, weeklyPercent);
      }

      /* 配额刷新成功 → 通知外部更新 UI (状态栏等) */
      this.onQuotaUpdate?.();
    } catch (err: any) {
      log('error', TAG, `检查配额失败 (${account.email}): ${err.message}`);
    }
  }

  /**
   * 读取当前并发配置 (limit=0 表示无限并发)
   */
  private getConcurrencyLimit(): number {
    const config = vscode.workspace.getConfiguration('wfSwitcher');
    const limit = config.get<number>('concurrentLimit', 5);
    const unlimited = config.get<boolean>('unlimitedConcurrent', false);
    return resolveConcurrencyLimit(limit, unlimited);
  }

  /**
   * 刷新单个账号 (内部子任务): 确保登录 + 查配额
   * 失败时抛错由并发器捕获, 不阻断其他账号
   * @param accountId - 账号 ID
   * @returns void
   */
  private async refreshSingleAccount(accountId: string): Promise<void> {
    /* 1) 确保已登录 (拿到 apiKey) */
    const account = this.accountManager.getAccounts().find(a => a.id === accountId);
    if (!account) { throw new Error('账号不存在'); }
    if (!account.apiKey) {
      const loginErr = await this.accountManager.loginAccount(accountId);
      if (loginErr) { throw new Error(loginErr); }
    }
    /* 2) 重新拿最新 apiKey 查配额 */
    const latest = this.accountManager.getAccounts().find(a => a.id === accountId);
    if (!latest?.apiKey) { throw new Error('缺少 apiKey'); }
    const status = await getPlanStatus(latest.apiKey, latest);
    await this.accountManager.updateQuota(
      accountId,
      status.dailyRemainingPercent,
      status.weeklyRemainingPercent,
      {
        planName: status.planName,
        dailyResetAt: status.dailyResetAtUnix,
        weeklyResetAt: status.weeklyResetAtUnix,
        planStartAt: status.planStartAtUnix,
        planEndAt: status.planEndAtUnix
      }
    );
  }

  /**
   * 按 ID 列表批量刷新指定账号 (用于导入后只刷新新导入的)
   *
   * 有界并发模式 (并发数读自用户设置):
   *   - 默认 5 个并发任务, 账号多时分批流水处理
   *   - 用户开启“无限并发”则一次性全打出去 (高风险)
   *
   * @param accountIds - 要刷新的账号 ID 列表
   * @param onProgress - 进度回调 (current/total/email 按完成顺序上报)
   */
  async refreshByIds(
    accountIds: string[],
    onProgress?: (current: number, total: number, email: string) => void
  ): Promise<void> {
    const all = this.accountManager.getAccounts();
    const targets = accountIds
      .map(id => all.find(a => a.id === id))
      .filter((a): a is NonNullable<typeof a> => !!a);
    const limit = this.getConcurrencyLimit();
    log('info', TAG, `按 ID 批量刷新 ${targets.length} 个账号 (并发=${limit || '无限'})`);

    await mapLimit(
      targets,
      limit,
      async (account) => {
        try {
          await this.refreshSingleAccount(account.id);
        } catch (err: any) {
          log('warn', TAG, `刷新失败 (${account.email}): ${err.message}`);
          throw err;
        }
      },
      (done, total, account) => {
        onProgress?.(done, total, account.email);
      }
    );
    this.onQuotaUpdate?.();
  }

  /**
   * 批量刷新所有账号余额 (全量刷新)
   *
   * 同 refreshByIds, 有界并发
   */
  async refreshAll(
    onProgress?: (current: number, total: number, email: string) => void
  ): Promise<void> {
    const accounts = this.accountManager.getAccounts();
    const limit = this.getConcurrencyLimit();
    log('info', TAG, `开始批量刷新 ${accounts.length} 个账号 (并发=${limit || '无限'})`);

    await mapLimit(
      accounts,
      limit,
      async (account) => {
        try {
          await this.refreshSingleAccount(account.id);
        } catch (err: any) {
          log('warn', TAG, `刷新失败 (${account.email}): ${err.message}`);
          throw err;
        }
      },
      (done, total, account) => {
        onProgress?.(done, total, account.email);
      }
    );
    this.onQuotaUpdate?.();
    log('info', TAG, '批量刷新完成');
  }

  /** 销毁 */
  dispose(): void {
    this.stopMonitor();
  }
}
