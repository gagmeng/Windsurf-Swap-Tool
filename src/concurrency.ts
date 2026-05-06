/**
 * 通用有界并发执行器
 *
 * 设计参考 Rust `futures::stream::buffer_unordered(n)`：
 * - 同一时刻最多 `limit` 个任务在跑
 * - 一个任务完成立刻从队列里拉下一个
 * - 任务之间**按索引顺序**写回结果数组 (但完成顺序不保证)
 * - 任一任务抛错不会中断其他任务, 错误会被包在结果对象里
 *
 * 相比 `Promise.all` + 分批 (chunk) 的好处: 不会被最慢的任务拖垮整批进度
 *
 * @author Ti
 */

/** 单任务的执行结果 (成功或失败都包起来, 便于统计) */
export interface ConcurrencyResult<T> {
  /** 输入项原始索引 (用于映射回账号) */
  index: number;
  /** 是否成功 */
  ok: boolean;
  /** 成功时的返回值 */
  value?: T;
  /** 失败时的错误信息 */
  error?: string;
}

/**
 * 有界并发执行器
 *
 * @param items - 输入项数组
 * @param limit - 并发上限 (<=0 或 >= items.length 时视为无限并发)
 * @param task - 单项任务函数, 接收 item 和索引
 * @param onProgress - 每个任务完成时回调 (done = 已完成数量; total = 总数; item = 刚完成的输入项; result = 结果)
 * @returns 所有结果数组 (与输入顺序一致)
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number, item: T, result: ConcurrencyResult<R>) => void
): Promise<ConcurrencyResult<R>[]> {
  const total = items.length;
  const results: ConcurrencyResult<R>[] = new Array(total);
  if (total === 0) { return results; }

  /* 无限并发: limit <=0 或 >= total, 直接 all-in */
  const effectiveLimit = (limit <= 0 || limit >= total) ? total : limit;

  let done = 0;
  let cursor = 0;

  /**
   * 单个 worker: 循环拉下一个索引, 跑任务, 写结果, 上报进度
   * 所有 worker 共享 cursor, 第一个空闲的抢下一个
   */
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= total) { return; }
      const item = items[idx];
      let result: ConcurrencyResult<R>;
      try {
        const value = await task(item, idx);
        result = { index: idx, ok: true, value };
      } catch (err: any) {
        result = {
          index: idx,
          ok: false,
          error: err && err.message ? err.message : String(err)
        };
      }
      results[idx] = result;
      done++;
      try {
        onProgress?.(done, total, item, result);
      } catch {
        /* 进度回调抛错不影响并发流程 */
      }
    }
  };

  /* 启动 effectiveLimit 个 worker 一起跑 */
  const workers: Promise<void>[] = [];
  for (let i = 0; i < effectiveLimit; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * 根据用户设置推导实际并发上限
 *
 * 规则:
 *   - `unlimitedConcurrent = true` → 返回 0 (代表无限并发)
 *   - 否则返回 `concurrentLimit`, 并 clamp 到 [1, 20]
 *
 * @param concurrentLimit - 用户配置的并发上限
 * @param unlimitedConcurrent - 是否无限并发
 * @returns 给 mapLimit 用的 limit 值
 */
export function resolveConcurrencyLimit(
  concurrentLimit: number,
  unlimitedConcurrent: boolean
): number {
  if (unlimitedConcurrent) { return 0; }
  const n = Math.floor(concurrentLimit);
  if (isNaN(n) || n < 1) { return 1; }
  if (n > 20) { return 20; }
  return n;
}
