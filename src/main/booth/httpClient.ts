import { BoothError } from './errors'
import { systemFetch, systemManualGet } from './systemFetch'
import type { BoothCookieJar } from './cookieJar'
import type { RateLimiter } from './rateLimiter'

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export interface HttpResponse {
  status: number
  headers: Headers
  url: string
  body(): Promise<ArrayBuffer>
  text(): Promise<string>
  /** 流式下载：逐块回调，返回总字节数 */
  stream(onChunk: (chunk: Uint8Array) => void, signal?: AbortSignal): Promise<number>
  raw: Response
}

export interface HttpRequestOptions {
  headers?: Record<string, string>
  redirect?: 'follow' | 'manual'
  signal?: AbortSignal
  /** GET with Range，用于指纹探测 */
  range?: string
  /** 覆盖默认 30s 超时（大文件/图片用） */
  timeoutMs?: number
}

export interface HttpClient {
  request(url: string, method: string, opts?: HttpRequestOptions): Promise<HttpResponse>
}

/** 嗅探响应是否为登录失效 / Cloudflare 挑战 */
export function sniffAuthFailure(status: number, finalUrl: string, bodySample: string): BoothError | null {
  if (status === 403) {
    if (/cf-chl|challenge-platform|Just a moment/i.test(bodySample)) {
      return new BoothError('Cloudflare 人机验证挑战', 'cloudflare', status)
    }
    // 403 大多是 BOOTH 对高频访问的限流/风控，不是登录失效。
    // 真正的 cookie 过期表现为跳转登录页（下方 /login 分支），
    // 判为 rate_limited：任务记失败可重试，绝不触发认证弹窗/清空队列。
    return new BoothError('403 被 BOOTH 拒绝（可能触发访问限制，请稍后重试）', 'rate_limited', status)
  }
  if (finalUrl.includes('/login') || finalUrl.includes('/sessions')) {
    return new BoothError('已跳转到登录页，cookies 过期', 'auth', status)
  }
  if (status === 401) return new BoothError('401 未授权', 'auth', status)
  if (status === 429) return new BoothError('429 请求过于频繁', 'rate_limited', status)
  if (status === 404) return new BoothError('404 未找到', 'not_found', status)
  if (status >= 500) return new BoothError(`服务器错误 ${status}`, 'server', status)
  return null
}

/**
 * 基于 Node fetch 的 HttpClient（脚本/开发验证用）。
 * 生产环境主进程换用 ElectronNetHttpClient（见 electronHttpClient.ts）。
 */
export class NodeHttpClient implements HttpClient {
  constructor(
    private cookieJar: BoothCookieJar,
    private limiter: RateLimiter,
    private referer: string = 'https://accounts.booth.pm/library'
  ) {}

  async request(url: string, method: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
    await this.limiter.wait()
    const cookie = await this.cookieJar.cookieHeader(url)
    const { referer: refererOpt, ...restHeaders } = opts.headers ?? {}
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
      ...restHeaders
    }
    if (cookie) headers['cookie'] = cookie
    if (opts.range) headers['range'] = opts.range

    // Referer 策略（实测坑）：Chromium 会以 net::ERR_BLOCKED_BY_CLIENT 拦截
    // 「跨源且带路径」的 Referer（如 Referer: https://accounts.booth.pm/library 去请求 booth.pm）。
    // 同源发完整 URL；跨源降级为 origin 形式（https://host/，与浏览器
    // strict-origin-when-cross-origin 一致），已实测 origin 形式跨源不被拦。
    const referer = refererOpt ?? this.referer
    if (referer) {
      try {
        const target = new URL(url)
        const ref = new URL(referer)
        headers['referer'] = target.origin === ref.origin ? referer : `${ref.origin}/`
      } catch {
        /* 非法 referer 不发 */
      }
    }

    // 默认 30s 超时（可被调用方 signal 覆盖），防止请求无限挂起
    const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 30_000)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal
    const redirect = opts.redirect ?? 'follow'
    let res: Response
    try {
      // systemFetch / systemManualGet：Electron 下走 Chromium 网络栈（自动应用代理设置）。
      // manual 必须走 net.request 通道——net.fetch 的 manual 收到 302 会直接 reject，读不到 Location。
      res =
        redirect === 'manual'
          ? await systemManualGet(url, { method, headers, signal })
          : await systemFetch(url, { method, headers, redirect, signal })
    } catch (e) {
      if (e instanceof BoothError) throw e
      const name = e instanceof Error ? e.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new BoothError(`请求超时（${Math.round((opts.timeoutMs ?? 30_000) / 1000)}s）`, 'network')
      }
      const msg = e instanceof Error ? e.message : String(e)
      throw new BoothError(`网络错误: ${msg}`, 'network')
    }
    return wrapResponse(res)
  }
}

export function wrapResponse(res: Response): HttpResponse {
  return {
    status: res.status,
    headers: res.headers,
    url: res.url,
    raw: res,
    async body() {
      return res.arrayBuffer()
    },
    async text() {
      return res.text()
    },
    async stream(onChunk, signal) {
      if (!res.body) return 0
      const reader = res.body.getReader()
      let total = 0
      const onAbort = () => {
        reader.cancel().catch(() => {})
      }
      signal?.addEventListener('abort', onAbort)
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            total += value.byteLength
            onChunk(value)
          }
        }
        return total
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    }
  }
}
