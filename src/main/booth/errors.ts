/** BOOTH 网络层错误类型 */

export class BoothError extends Error {
  constructor(
    message: string,
    public readonly kind: BoothErrorKind,
    public readonly status?: number
  ) {
    super(message)
    this.name = 'BoothError'
  }
}

export type BoothErrorKind =
  | 'auth' // cookies 过期 / 跳转登录
  | 'cloudflare' // 人机验证挑战
  | 'not_found' // 404（商品/文件已删除）
  | 'rate_limited' // 429 / 403 限流风控（非登录失效）
  | 'network' // 连接层错误
  | 'server' // 5xx
  | 'parse' // 页面结构解析失败
  | 'invalid' // 参数/状态不合法

export function isAuthError(e: unknown): boolean {
  return e instanceof BoothError && (e.kind === 'auth' || e.kind === 'cloudflare')
}
