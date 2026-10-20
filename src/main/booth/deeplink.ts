import { BoothError } from './errors'
import { sniffAuthFailure, type HttpClient } from './httpClient'
import type { DeeplinkResult, Fingerprint } from '../../shared/types'

/**
 * BOOTH 官方 deeplink 兼容协议（已逆向验证；协议命名空间由 BOOTH 固定，勿改）：
 *
 *   GET https://booth.pm/downloadables/{id}/deeplink?client=booth-library-manager&variation_id={vid}
 *     → 302 Location: booth-library-manager://item-import?dlurl=<签名S3直链>&downloadable_filename=..&item_id=..&order_id=..
 *
 * dlurl 180 秒过期，绝不缓存、绝不入库，下载前即时 resolve。
 */
export class DeeplinkClient {
  constructor(private http: HttpClient) {}

  /** 解析 deeplink → 签名直链 */
  async resolve(downloadableId: number, variationId: number | null): Promise<DeeplinkResult> {
    const qs = new URLSearchParams({ client: 'booth-library-manager' })
    if (variationId != null) qs.set('variation_id', String(variationId))
    const url = `https://booth.pm/downloadables/${downloadableId}/deeplink?${qs}`

    const res = await this.http.request(url, 'GET', { redirect: 'manual' })
    const location = res.headers.get('location')

    if (res.status === 302 || res.status === 301 || res.status === 307) {
      if (!location) throw new BoothError('deeplink 重定向缺少 Location', 'parse', res.status)
      return parseItemImportLocation(location, downloadableId)
    }
    // 有时直接 200 返回自定义 scheme 页面或登录页
    const sample = await res.text().catch(() => '')
    const err = sniffAuthFailure(res.status, res.url, sample)
    if (err) throw err
    if (location) return parseItemImportLocation(location, downloadableId)
    throw new BoothError(`deeplink 意外响应 ${res.status}`, 'parse', res.status)
  }

  /**
   * 文件指纹探测：Range GET bytes=0-0 → 206 + Content-Range/ETag/Last-Modified。
   * ⚠ 不用 HEAD（会 301）；总大小必须从 Content-Range 解析（Content-Length 是 1）。
   */
  async probe(dlurl: string, signal?: AbortSignal): Promise<Fingerprint> {
    const res = await this.http.request(dlurl, 'GET', { range: 'bytes=0-0', redirect: 'manual', signal })
    if (res.status >= 300 && res.status < 400) {
      // 签名过期被重定向回 booth.pm
      throw new BoothError('签名直链已过期（应重新 resolve）', 'invalid', res.status)
    }
    if (res.status !== 206 && res.status !== 200) {
      const sample = await res.text().catch(() => '')
      const err = sniffAuthFailure(res.status, res.url, sample)
      if (err) throw err
      throw new BoothError(`指纹探测失败 ${res.status}`, 'server', res.status)
    }
    // 消费掉 body（只有 1 字节）
    await res.body().catch(() => {})

    const contentRange = res.headers.get('content-range')
    let size: number | null = null
    if (contentRange) {
      const m = /\/(\d+)\s*$/.exec(contentRange)
      if (m) size = Number(m[1])
    }
    if (size == null) {
      const cl = res.headers.get('content-length')
      // Range 响应里 CL 是 1，不可信；仅当没有 Content-Range 时才用
      if (!contentRange && cl) size = Number(cl)
    }
    const etagRaw = res.headers.get('etag')
    return {
      etag: etagRaw ? stripQuotes(etagRaw) : null,
      size,
      lastModified: res.headers.get('last-modified'),
      contentType: res.headers.get('content-type')
    }
  }
}

function stripQuotes(s: string): string {
  let out = s.trim()
  if (out.startsWith('W/')) out = out.slice(2)
  if (out.startsWith('"') && out.endsWith('"')) out = out.slice(1, -1)
  return out
}

/** 解析 booth-library-manager://item-import?... */
export function parseItemImportLocation(location: string, fallbackId: number): DeeplinkResult {
  let parsed: URL
  try {
    parsed = new URL(location)
  } catch {
    throw new BoothError(`无法解析 deeplink Location: ${location.slice(0, 120)}`, 'parse')
  }
  if (parsed.protocol !== 'booth-library-manager:') {
    throw new BoothError(`非预期的协议: ${parsed.protocol}`, 'parse')
  }
  const q = parsed.searchParams
  const dlurl = q.get('dlurl')
  if (!dlurl) throw new BoothError('deeplink 缺少 dlurl 参数', 'parse')
  return {
    dlurl,
    filename: q.get('downloadable_filename') || `downloadable_${fallbackId}`,
    itemId: Number(q.get('item_id') || 0),
    orderId: q.get('order_id') ? Number(q.get('order_id')) : null,
    variationId: q.get('variation_id') ? Number(q.get('variation_id')) : null
  }
}
