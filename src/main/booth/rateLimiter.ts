/**
 * 令牌桶限速器：所有 booth.pm 请求共享，带抖动，避免对站点造成压力。
 */
export class RateLimiter {
  private lastAt = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private minIntervalMs: number = 250,
    private jitterMs: number = 100
  ) {}

  setMinInterval(ms: number): void {
    this.minIntervalMs = Math.max(50, ms)
  }

  /** 等待到允许下一次请求的时刻（串行化，防止并发绕过间隔） */
  wait(): Promise<void> {
    const run = this.chain.then(async () => {
      const jitter = Math.floor(Math.random() * this.jitterMs)
      const waitMs = this.minIntervalMs + jitter
      const now = Date.now()
      const sleep = this.lastAt + waitMs - now
      if (sleep > 0) await new Promise((r) => setTimeout(r, sleep))
      this.lastAt = Date.now()
    })
    // 链上吞掉错误，避免打断后续等待
    this.chain = run.catch(() => {})
    return run
  }
}
