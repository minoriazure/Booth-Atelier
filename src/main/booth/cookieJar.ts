import { readFileSync, statSync, watch, existsSync } from 'fs'
import { dirname, basename } from 'path'
import { CookieJar, Cookie } from 'tough-cookie'
import { createLogger } from '../util/log'

const log = createLogger('cookieJar')

/**
 * Netscape HTTP Cookie File 解析 → tough-cookie CookieJar。
 * 热加载双保险（2026-10-16 修复「文件缺失后补放文件不生效」）：
 * - 监听**父目录**（按文件名过滤）而非直接监听文件：启动时文件不存在也能监听到
 *   「之后被创建」；文件被删除/替换（编辑器原子保存）时监听同样存活——直接
 *   fs.watch(文件) 在 ENOENT 后就永远不会再生效，曾导致重试/检测读到旧状态。
 * - 每次生成 Cookie 头前按 mtime 惰性核对：即使目录监听也失效，下一次
 *   检测登录/重试/任何请求都会自动读到新文件。
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
      this.lastMtime = 0
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

  /** 启动监听（自动热加载）；文件缺失也能监听到后续创建 */
  watch(onChange?: () => void): void {
    this.onChange = onChange ?? null
    if (this.watcher) return
    const base = basename(this.filePath)
    try {
      this.watcher = watch(dirname(this.filePath), (_event: string, name: string | Buffer | null) => {
        // 只关心目标文件名的事件（name 为 null 时交给 mtime 核对兜底）
        if (name != null && String(name) !== base) return
        this.handleFsEvent()
      })
    } catch (e) {
      // 父目录也不存在等极端情况：监听彻底失败，仅剩 cookieHeader 的 mtime 兜底
      log.warn('cookie watch failed:', e instanceof Error ? e.message : e)
    }
  }

  /**
   * 目录事件：文件缺失 → 清空 jar；存在且 mtime 变化 → 重载。
   * 两种真实变化都会通知 onChange（renderer 收到后自动重新检查登录状态）。
   */
  private handleFsEvent(): void {
    try {
      if (!existsSync(this.filePath)) {
        if (this.cookieCount > 0) {
          log.info('cookies file removed, clearing jar')
          this.load()
          this.onChange?.()
        }
        return
      }
      const mtime = statSync(this.filePath).mtimeMs
      if (mtime !== this.lastMtime) {
        log.info('cookies file changed, reloading')
        this.load()
        this.onChange?.()
      }
    } catch (e) {
      log.warn('cookie reload failed:', e)
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

  /**
   * 请求前 mtime 惰性核对（监听失效兜底）：文件与已加载状态不一致就重载并通知
   * （renderer 自动重查登录状态）。覆盖场景：启动时文件缺失后被补放、监听被
   * 系统回收、任何漏掉的变更。重载后 mtime 即一致，不会在后续请求里重复触发。
   */
  private ensureFresh(): void {
    try {
      if (!existsSync(this.filePath)) return
      const mtime = statSync(this.filePath).mtimeMs
      if (mtime !== this.lastMtime) {
        log.info('cookies file differs from loaded state, lazy reload')
        this.load()
        this.onChange?.()
      }
    } catch {
      /* 忽略：维持当前 jar */
    }
  }

  /** 生成 Cookie 请求头（按 URL 过滤匹配域/路径） */
  async cookieHeader(url: string): Promise<string> {
    this.ensureFresh()
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
