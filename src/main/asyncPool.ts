/**
 * 以固定并发上限对列表执行异步任务并汇总结果。
 * 适用于搜索、书源测试、批量书架更新等场景。
 * @param items - 待处理的数据项列表
 * @param concurrency - 最大并发数（会钳制到至少 1、至多 items.length）
 * @param worker - 处理单个元素的异步函数，接收元素与下标
 * @returns 与输入顺序一致的结果数组
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!items.length) return []
  const results = new Array<R>(items.length)
  let cursor = 0
  const limit = Math.max(1, Math.min(concurrency, items.length))

  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) break
      results[index] = await worker(items[index], index)
    }
  })

  await Promise.all(runners)
  return results
}

/**
 * 若 Promise 在指定毫秒内未完成则拒绝。
 * @param promise - 被监控的 Promise
 * @param ms - 超时时间（毫秒）
 * @param label - 超时错误文案，默认「操作超时」
 * @returns 原 Promise 的成功结果
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = '操作超时'
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
