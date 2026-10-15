/**
 * 脚本共用引导：cookieJar + NodeHttpClient + RateLimiter
 * 用法: npx tsx scripts/<script>.ts
 */
import { resolve } from 'path'
import { existsSync } from 'fs'
import { BoothCookieJar } from '../src/main/booth/cookieJar'
import { NodeHttpClient } from '../src/main/booth/httpClient'
import { RateLimiter } from '../src/main/booth/rateLimiter'
import { DeeplinkClient } from '../src/main/booth/deeplink'
import { LibraryCrawler } from '../src/main/booth/libraryCrawler'
import { ItemPageParser } from '../src/main/booth/itemPageParser'

export function bootstrap() {
  const cookiesPath = resolve(__dirname, '../booth_cookies.txt')
  if (!existsSync(cookiesPath)) {
    console.error(`找不到 cookies 文件: ${cookiesPath}`)
    process.exit(1)
  }
  const jar = new BoothCookieJar(cookiesPath)
  jar.load()
  const limiter = new RateLimiter(250, 100)
  const http = new NodeHttpClient(jar, limiter)
  return {
    jar,
    limiter,
    http,
    deeplink: new DeeplinkClient(http),
    crawler: new LibraryCrawler(http),
    itemPage: new ItemPageParser(http),
    cookiesPath
  }
}

export function fatal(e: unknown): never {
  if (e && typeof e === 'object' && 'kind' in e) {
    const err = e as { kind: string; message: string; status?: number }
    console.error(`[${err.kind}] ${err.message}${err.status ? ` (HTTP ${err.status})` : ''}`)
    if (err.kind === 'auth' || err.kind === 'cloudflare') {
      console.error('→ 请重新导出 booth_cookies.txt 后重试。')
    }
  } else {
    console.error(e)
  }
  process.exit(1)
}
