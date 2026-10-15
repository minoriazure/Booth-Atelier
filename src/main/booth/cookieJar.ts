import { readFileSync, statSync, watch, existsSync } from 'fs'
import { CookieJar, Cookie } from 'tough-cookie'
import { createLogger } from '../util/log'

const log = createLogger('cookieJar')

/**
 * Netscape HTTP Cookie File 解析 → tough-cookie CookieJar。
 * 监听 cookies 文件 mtime，过期后用户重新导出即可热加载，无需重启。
 */
export class BoothCookieJar {
  private jar = new CookieJar()
  private lastMtime = 0
  private watcher: ReturnType<typeof watch> | null = null
  private cookieCount = 0
  private onChange: (() => void) | null = null

  constructor(private filePath: string) {}

  /** 加载（或重新加载）cookies 文件；文件缺失时降级为空 jar（不抛异常） */
  load(): void {
    if (!existsSync(this.filePath)) {
      this.jar = new CookieJar()
      this.cookieCount = 0
      log.warn(`cookies file not found: ${this.filePath}（请导出 cookies 到该路径）`)
      return
    }
    const text = readFileSync(this.filePath, 'utf-8')
    this.jar = new CookieJar()
    let count = 0
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const parts = line.split('\t')
      if (parts.length < 7) continue
      const [domain, includeSub, path, secure, expires, name, ...valueParts] = parts
      const value = valueParts.join('\t')
      if (!name || !value) continue
      const cookie = new Cookie({
        key: name,
        value,
        domain: domain.replace(/^\./, ''),
        path: path || '/',
        secure: secure === 'TRUE' || secure === 'true',
        httpOnly: true,
        expires: Number(expires) > 0 ? new Date(Number(expires) * 1000) : 'Infinity'
      })
      // tough-cookie v5：域以 . 开头的匹配通过 domainStartsWithDot 控制
      if (includeSub === 'TRUE') {
        ;(cookie as unknown as { domainStartsWithDot: boolean }).domainStartsWithDot = true
      }
      try {
        this.jar.setCookieSync(cookie, `${cookie.secure ? 'https' : 'http'}://${domain.replace(/^\./, '')}/`)
        count++
      } catch (e) {
        log.warn('cookie parse failed:', name, e)
      }
    }
    this.cookieCount = count
    try {
      this.lastMtime = statSync(this.filePath).mtimeMs
    } catch {
      this.lastMtime = 0
    }
    log.info(`cookies loaded: ${count} from ${this.filePath}`)
  }

  /** 启动 mtime 监听（自动热加载） */
  watch(onChange?: () => void): void {
    this.onChange = onChange ?? null
    if (this.watcher) return
    try {
      this.watcher = watch(this.filePath, () => {
        try {
          const mtime = statSync(this.filePath).mtimeMs
          if (mtime !== this.lastMtime) {
            log.info('cookies file changed, reloading')
            this.load()
            this.onChange?.()
          }
        } catch (e) {
          log.warn('cookie reload failed:', e)
        }
      })
    } catch (e) {
      log.warn('cookie watch failed:', e)
    }
  }

  stopWatch(): void {
    this.watcher?.close()
    this.watcher = null
  }

  get jarRef(): CookieJar {
    return this.jar
  }

  get count(): number {
    return this.cookieCount
  }

  /** 生成 Cookie 请求头（按 URL 过滤匹配域/路径） */
  async cookieHeader(url: string): Promise<string> {
    return this.jar.getCookieString(url)
  }

  get filePathRef(): string {
    return this.filePath
  }

  setPath(p: string): void {
    this.stopWatch()
    this.filePath = p
    this.load()
    this.watch(this.onChange ?? undefined)
  }
}
