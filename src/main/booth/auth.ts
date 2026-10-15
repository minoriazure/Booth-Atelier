import { sniffAuthFailure, type HttpClient } from './httpClient'
import { BoothError } from './errors'
import { createLogger } from '../util/log'

const log = createLogger('auth')

/**
 * 登录态探测：GET 库页第 1 页，检查 title 与跳转。
 * cookies 过期 / Cloudflare 挑战 → 抛 BoothError(kind=auth|cloudflare)。
 */
export class AuthChecker {
  constructor(private http: HttpClient) {}

  async check(): Promise<{ ok: true; sampleTitle: string }> {
    const url = 'https://accounts.booth.pm/library?page=1'
    const res = await this.http.request(url, 'GET')
    const text = await res.text()
    const err = sniffAuthFailure(res.status, res.url, text.slice(0, 2000))
    if (err) throw err
    const title = /<title>([^<]*)<\/title>/.exec(text)?.[1]?.trim() ?? ''
    if (title !== 'Library - BOOTH') {
      if (/login|ログイン|sign/i.test(res.url) || /login|ログイン/i.test(title)) {
        throw new BoothError('cookies 已过期（页面跳转到登录）', 'auth', res.status)
      }
      throw new BoothError(`未登录或页面异常（title=${title}）`, 'auth', res.status)
    }
    log.info('auth OK')
    return { ok: true, sampleTitle: title }
  }
}
