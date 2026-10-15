/**
 * 网络传输层（Chromium 网络栈，自动走代理）：
 * - systemFetch：net.fetch，用于普通请求（redirect: follow）。
 * - systemManualGet：net.fetch 的 redirect:'manual' 实现有缺陷——收到 302 会以
 *   "Redirect was cancelled" reject，根本读不到 Location。manual 语义必须走
 *   net.request 的原生 'redirect' 事件（拿到 3xx 状态 + Location 后停止跟随）。
 *   这是 deeplink resolve（302 → booth-library-manager://）与指纹 probe（3xx = 签名过期）的
 *   唯一正确通道。
 * - applyProxySettings：代理三档（system / custom / direct）运行时热切换。
 *   session.setProxy 对 net.fetch / net.request / session.fetch 全部即时生效，无需重启；
 *   system 模式与 Chrome 一样读取并监听 Windows WinINET 注册表（ProxyEnable/ProxyServer）。
 * - Node 脚本环境（tsx 验证脚本）回退全局 fetch（不读系统代理，仅测试用）。
 */
import { createLogger } from '../util/log'
import type { Settings } from '../../shared/types'

const log = createLogger('net')

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>
interface ElectronNet {
  fetch?: FetchFn
  request?: (opts: { url: string; method?: string; allowNonHttpProtocols?: boolean }) => ElectronClientRequest
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

export async function systemFetch(url: string, init?: RequestInit): Promise<Response> {
  const n = resolveNet()
  if (n?.fetch) return n.fetch.call(n, url, init)
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

    const req = netRequest({ url, method: init.method || 'GET' })
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
 * 返回是否成功应用；custom 格式非法时回退 system 并返回 false。
 */
export async function applyProxySettings(mode: ProxyMode, customProxy: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { session?: { defaultSession?: { setProxy?: (cfg: unknown) => Promise<void> } } }
    const ses = electron.session?.defaultSession
    if (!ses?.setProxy) return false // 非 Electron（tsx 脚本）无会话，忽略
    if (mode === 'custom') {
      const rules = normalizeProxyRules(customProxy)
      if (rules) {
        await ses.setProxy({ mode: 'fixed_servers', proxyRules: rules })
        log.info(`proxy → custom ${rules}`)
        return true
      }
      await ses.setProxy({ mode: 'system' })
      log.warn(`proxy custom 格式非法（${JSON.stringify(customProxy)}），回退 system`)
      return false
    }
    if (mode === 'direct') {
      await ses.setProxy({ mode: 'direct' })
      log.info('proxy → direct（直连）')
      return true
    }
    await ses.setProxy({ mode: 'system' })
    log.info('proxy → system（跟随 Windows 系统代理）')
    return true
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
    if (!electron.app?.isReady?.() || !electron.session?.defaultSession?.resolveProxy) return null
    return await electron.session.defaultSession.resolveProxy('https://booth.pm/')
  } catch {
    return null
  }
}
