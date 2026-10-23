import { sniffAuthFailure, type HttpClient } from './httpClient'
import { BoothError } from './errors'
import { createLogger } from '../util/log'

const log = createLogger('auth')

/**
 * 库页标题随 BOOTH 界面语言变化（日语为 ライブラリ，其余语言为 Library）。
 * 登录页标题（Sign in / ログイン）不在此列表中，因此不会被误判为有效。
 */
const LIBRARY_PAGE_TITLES = ['Library - BOOTH', 'ライブラリ - BOOTH']

/** 从 HTML 取出 <title>（已 trim），取不到返回空串 */
export function extractPageTitle(html: string): string {
  return /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim() ?? ''
}

/** 判断 HTML 是否为库页（语言无关：按允许的库页标题白名单匹配） */
export function isLibraryPageHtml(html: string): boolean {
  return LIBRARY_PAGE_TITLES.includes(extractPageTitle(html))
}

/**
 * 登录态探测：GET 库页第 1 页，检查 title 与跳转。
 * cookies 过期 / Cloudflare 挑战 → 抛 BoothError(kind=auth|cloudflare)。
 */
export class AuthChecker {
  constructor(private http: HttpClient) {}

  async check(): Promise<{ ok: true; sampleTitle: string }> {
    try {
      const r = await this.probe()
      log.info('auth OK')
      return r
    } catch (e) {
      const kind = e instanceof BoothError ? e.kind : 'unknown'
      log.warn(`auth check failed kind=${kind}: ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
  }

  private async probe(): Promise<{ ok: true; sampleTitle: string }> {
    const url = 'https://accounts.booth.pm/library?page=1'
    const res = await this.http.request(url, 'GET')
    const text = await res.text()
    const err = sniffAuthFailure(res.status, res.url, text.slice(0, 2000))
    if (err) throw err
    const title = extractPageTitle(text)
    if (!isLibraryPageHtml(text)) {
      if (/login|ログイン|sign/i.test(res.url) || /login|ログイン/i.test(title)) {
        throw new BoothError('cookies 已过期（页面跳转到登录）', 'auth', res.status)
      }
      throw new BoothError(`未登录或页面异常（title=${title}）`, 'auth', res.status)
    }
    return { ok: true, sampleTitle: title }
  }
}
