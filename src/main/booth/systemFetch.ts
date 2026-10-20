/**
 * 网络传输层（Chromium 网络栈，自动走代理）：
 * - ⚠ BOOTH 流量一律走专用内存 session（partition 'booth-runtime'，不带 persist: 前缀），
 *   绝不允许落 defaultSession——defaultSession 的 cookie 库持久化在 %APPDATA% 共享给
 *   同机所有副本，曾导致 _plaza_session 登录态跨副本泄露（无 cookies 文件也能登录）。
 *   登录态唯一权威来源是 booth_cookies.txt（显式 Cookie 头注入），
 *   详见 docs/architecture.md「凭据模型」。
 * - systemFetch：session.fetch，用于普通请求（redirect: follow）。
 * - systemManualGet：net.fetch 的 redirect:'manual' 实现有缺陷——收到 302 会以
 *   "Redirect was cancelled" reject，根本读不到 Location。manual 语义必须走
 *   net.request 的原生 'redirect' 事件（拿到 3xx 状态 + Location 后停止跟随）。
 *   这是 deeplink resolve（302 → booth-library-manager://）与指纹 probe（3xx = 签名过期）的
 *   唯一正确通道。
 * - applyProxySettings：代理三档（system / custom / direct）运行时热切换。
 *   session.setProxy 对 session.fetch / net.request 全部即时生效，无需重启；
 *   system 模式与 Chrome 一样读取并监听 Windows WinINET 注册表（ProxyEnable/ProxyServer）。
 * - Node 脚本环境（tsx 验证脚本）回退全局 fetch（不读系统代理，仅测试用）。
 */
import { createLogger } from '../util/log'
import type { Settings } from '../../shared/types'

const log = createLogger('net')

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

interface ElectronSessionCookie {
  domain?: string
  name: string
  path?: string
  secure?: boolean
}
interface ElectronSession {
  fetch?: FetchFn
  setProxy?: (cfg: unknown) => Promise<void>
  resolveProxy?: (url: string) => Promise<string>
  cookies?: {
    get: (filter: Record<string, unknown>) => Promise<ElectronSessionCookie[]>
    remove: (url: string, name: string) => Promise<void>
  }
}
interface ElectronNet {
  fetch?: FetchFn
  request?: (opts: {
    url: string
    method?: string
    allowNonHttpProtocols?: boolean
    session?: unknown
    useSessionCookies?: boolean
  }) => ElectronClientRequest
}
interface ElectronClientRequest {
  setHeader(name: string, value: string): void
  on(event: 'redirect', cb: (statusCode: number, newMethod: string, newUrl: string, headers: Record<string, string | string[]>) => void): void
  on(event: 'response', cb: (res: ElectronIncomingMessage) => void): void
  on(event: 'error', cb: (e: Error) => void): void
  abort(): void
  end(): void
}
interface ElectronIncomingMessage {
  statusCode: number
  headers: Record<string, string | string[]>
  on(event: 'data', cb: (chunk: Buffer) => void): void
  on(event: 'end', cb: () => void): void
  on(event: 'error', cb: (e: Error) => void): void
}

let netModule: ElectronNet | null | undefined

function resolveNet(): ElectronNet | null {
  if (netModule !== undefined) return netModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { net?: ElectronNet; app?: unknown }
    // 纯 Node 里 require('electron') 返回可执行文件路径字符串，没有 .net
    netModule = electron && typeof electron === 'object' && electron.net && electron.app ? electron.net : null
  } catch {
    netModule = null
  }
  return netModule
}

/** BOOTH 专用内存 session 的 partition（不带 persist: 前缀 = 进程退出即消失，不落盘） */
const BOOTH_PARTITION = 'booth-runtime'
let boothSession: ElectronSession | null = null

/**
 * BOOTH 流量的专用 session（懒加载，app ready 后可用）。
 * 安全/正确性约束（实测踩坑，勿放宽）：
 * - partition 不带 persist: → Set-Cookie 只进内存、进程结束即消失（登录态唯一来源 = cookies 文件）；
 * - cache:false → 禁用 HTTP 缓存。曾出现换 cookie 后 auth 检查命中旧 Library 页缓存误报「有效」；
 * - 请求侧 credentials:'omit' / useSessionCookies:false → 绝不携带 session cookie 库里的 cookie，
 *   曾实测空 jar（零 cookie）仍被库里的 _plaza_session 冒充登录成功、换对文件也因旧会话残留误报失效。
 */
function resolveBoothSession(): ElectronSession | null {
  if (boothSession) return boothSession
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as {
      app?: { isReady?: () => boolean }
      session?: { fromPartition?: (partition: string, options?: { cache?: boolean }) => ElectronSession }
    }
    if (!electron.app?.isReady?.() || !electron.session?.fromPartition) return null
    boothSession = electron.session.fromPartition(BOOTH_PARTITION, { cache: false })
    log.info(`booth session ready (in-memory partition '${BOOTH_PARTITION}', 不落盘, HTTP 缓存关闭)`)
  } catch (e) {
    log.warn('booth session create failed:', e)
    boothSession = null
  }
  return boothSession
}

export async function systemFetch(url: string, init?: RequestInit): Promise<Response> {
  const ses = resolveBoothSession()
  // credentials:'omit' 放最后：任何调用方都不得改回——显式 Cookie 头（jar 注入）不受影响，照常发送
  if (ses?.fetch) return ses.fetch(url, { ...init, credentials: 'omit' })
  // session 就绪前的兜底：net.fetch 走 defaultSession（正常启动时请求都发生在 ready 之后，不会命中）
  const n = resolveNet()
  if (n?.fetch) {
    log.warn('booth session unavailable, falling back to net.fetch (defaultSession)')
    return n.fetch.call(n, url, init)
  }
  return fetch(url, init)
}

/** manual 请求缓冲上限（resolve/probe 只会遇到 0 字节重定向体或登录页，4MB 足够） */
const MANUAL_BODY_CAP = 4 * 1024 * 1024

function buildHeaders(rec: Record<string, string | string[] | undefined> | undefined, location?: string): Headers {
  const h = new Headers()
  for (const [k, v] of Object.entries(rec || {})) {
    if (v == null) continue
    if (Array.isArray(v)) for (const x of v) h.append(k, x)
    else h.append(k, v)
  }
  if (location && !h.has('location')) h.set('location', location)
  return h
}

function makeResponse(status: number, headers: Headers, body: BodyInit | null, url: string): Response {
  // 101/204/205/304 是 null-body 状态，构造非空 body 会抛错
  const nullBody = status === 101 || status === 204 || status === 205 || status === 304
  const res = new Response(nullBody ? null : body, { status, headers })
  // Response.url 构造后只读，定义同名自有属性遮蔽原型 getter（sniffAuthFailure 需要它）
  try {
    Object.defineProperty(res, 'url', { value: url, configurable: true })
  } catch {
    /* 忽略 */
  }
  return res
}

function abortError(): Error {
  try {
    return new DOMException('The operation was aborted.', 'AbortError')
  } catch {
    const e = new Error('The operation was aborted.')
    e.name = 'AbortError'
    return e
  }
}

export interface ManualGetInit {
  method?: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

/**
 * 发起一次「不跟随重定向」的 GET：
 * - 收到 3xx → 返回该 3xx 响应（Location 可读），不跳转；
 * - 收到 2xx/4xx → 返回正常响应（body 已缓冲，上限 4MB）。
 * Electron 环境走 net.request；纯 Node 环境走 fetch（undici 原生支持 manual）。
 */
export function systemManualGet(url: string, init: ManualGetInit = {}): Promise<Response> {
  const n = resolveNet()
  if (!n?.request) {
    return fetch(url, {
      method: init.method || 'GET',
      headers: init.headers,
      redirect: 'manual',
      signal: init.signal
    })
  }
  const netRequest = n.request.bind(n)
  // BOOTH 专用内存 session：cookie 只进内存不落盘；useSessionCookies:false ——
  // 绝不携带 session cookie 库里的 cookie（曾因开着导致旧 _plaza_session 冒充/干扰 jar 认证），
  // 认证 cookie 唯一来源 = jar 注入的显式 Cookie 头。
  const boothSes = resolveBoothSession()

  return new Promise<Response>((resolve, reject) => {
    let settled = false
    const cleanupFns: Array<() => void> = []
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      for (const c of cleanupFns) {
        try {
          c()
        } catch {
          /* 忽略 */
        }
      }
      fn()
    }

    const req = netRequest(
      boothSes
        ? { url, method: init.method || 'GET', session: boothSes, useSessionCookies: false }
        : { url, method: init.method || 'GET' } // 兜底：defaultSession（正常启动不会命中）
    )
    for (const [k, v] of Object.entries(init.headers || {})) {
      if (v == null) continue
      try {
        req.setHeader(k, v)
      } catch {
        /* 被禁止/非法的头直接忽略 */
      }
    }

    if (init.signal) {
      if (init.signal.aborted) {
        reject(abortError())
        return
      }
      const onAbort = (): void =>
        finish(() => {
          try {
            req.abort()
          } catch {
            /* 忽略 */
          }
          reject(abortError())
        })
      init.signal.addEventListener('abort', onAbort, { once: true })
      cleanupFns.push(() => init.signal?.removeEventListener('abort', onAbort))
    }

    req.on('redirect', (statusCode, _newMethod, newUrl, headers) => {
      // manual 语义：拿到 3xx + Location 即止，不 followRedirect
      finish(() => resolve(makeResponse(statusCode, buildHeaders(headers, newUrl), null, url)))
    })

    req.on('response', (res) => {
      const chunks: Buffer[] = []
      let size = 0
      let overflow = false
      res.on('data', (c) => {
        size += c.byteLength
        if (size > MANUAL_BODY_CAP) {
          if (!overflow) {
            overflow = true
            try {
              req.abort()
            } catch {
              /* 忽略 */
            }
          }
          return
        }
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
      })
      res.on('end', () => {
        if (overflow) {
          finish(() => reject(new TypeError(`响应体超过 manual 缓冲上限（${MANUAL_BODY_CAP} 字节）`)))
          return
        }
        finish(() => resolve(makeResponse(res.statusCode, buildHeaders(res.headers), Buffer.concat(chunks), url)))
      })
      res.on('error', (e) => finish(() => reject(new TypeError(e?.message || String(e)))))
    })

    req.on('error', (e) => finish(() => reject(new TypeError(e?.message || String(e)))))

    try {
      req.end()
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new TypeError(String(e))))
    }
  })
}

/** 代理模式：system=跟随 Windows 系统代理；custom=自定义；direct=直连 */
export type ProxyMode = Settings['proxyMode']

/** 把用户输入规范成 session.setProxy 的 proxyRules；非法返回 null */
export function normalizeProxyRules(input: string): string | null {
  const s = input.trim().replace(/\/+$/, '')
  if (!s) return null
  // 带协议头：http:// host:port / https:// / socks4:// / socks5://
  if (/^(https?|socks5?|socks4a?):\/\/[^\s/]+$/i.test(s)) return s
  // 裸 host:port（域名/IPv4，或 [IPv6]:port）——Chromium 默认按 http 代理处理，对所有协议生效
  if (/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\]):\d{1,5}$/i.test(s)) return s
  return null
}

/**
 * 应用代理设置（运行时热切换，无需重启）。
 * 同时应用到 booth 内存 session（实际出口）与 defaultSession（renderer 兜底，保持行为一致）。
 * 返回是否成功应用；custom 格式非法时回退 system 并返回 false。
 */
export async function applyProxySettings(mode: ProxyMode, customProxy: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { session?: { defaultSession?: { setProxy?: (cfg: unknown) => Promise<void> } } }
    const targets = [resolveBoothSession(), electron.session?.defaultSession].filter(
      (s): s is ElectronSession => !!s?.setProxy
    )
    if (targets.length === 0) return false // 非 Electron（tsx 脚本）无会话，忽略

    let cfg: { mode: string; proxyRules?: string }
    let ok = true
    if (mode === 'custom') {
      const rules = normalizeProxyRules(customProxy)
      if (rules) {
        cfg = { mode: 'fixed_servers', proxyRules: rules }
        log.info(`proxy → custom ${rules}`)
      } else {
        cfg = { mode: 'system' }
        log.warn(`proxy custom 格式非法（${JSON.stringify(customProxy)}），回退 system`)
        ok = false
      }
    } else if (mode === 'direct') {
      cfg = { mode: 'direct' }
      log.info('proxy → direct（直连）')
    } else {
      cfg = { mode: 'system' }
      log.info('proxy → system（跟随 Windows 系统代理）')
    }
    for (const ses of targets) await ses.setProxy!(cfg)
    return ok
  } catch (e) {
    log.warn('applyProxySettings failed:', e instanceof Error ? e.message : e)
    return false
  }
}

/** 当前生效的代理（仅 Electron；如 "PROXY 127.0.0.1:7890" 或 "DIRECT"）——设置页展示 */
export async function resolveSystemProxy(): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as {
      app?: { isReady?: () => boolean }
      session?: { defaultSession?: { resolveProxy?: (url: string) => Promise<string> } }
    }
    if (!electron.app?.isReady?.()) return null
    // 优先问 booth session（实际出口），defaultSession 兜底
    const boothSes = resolveBoothSession()
    if (boothSes?.resolveProxy) return await boothSes.resolveProxy('https://booth.pm/')
    const def = electron.session?.defaultSession
    if (!def?.resolveProxy) return null
    return await def.resolveProxy('https://booth.pm/')
  } catch {
    return null
  }
}
