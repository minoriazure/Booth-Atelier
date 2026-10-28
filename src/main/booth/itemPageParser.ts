import * as cheerio from 'cheerio'
import { createHash } from 'crypto'
import { BoothError } from './errors'
import { sniffAuthFailure, type HttpClient } from './httpClient'
import type { ItemDetail, VideoPlatform } from '../../shared/types'

/** 描述中提取的视频 */
export interface ExtractedVideo {
  key: string
  platform: VideoPlatform
  videoId: string
  url: string
  embedUrl: string
}

/**
 * 商品详情页（/zh-cn/items/{id}）解析。
 * 结构（已实测）：左列 l-col-3of5 =
 *   primary-image-area（画廊大图，img.market-item-detail-item-image 的 data-origin/data-lazy）
 *   + thumbnails（缩略图）
 *   + section.main-info-column（描述文字）
 *   + div.my-40（后续段落 section.shop__text、内嵌视频 section[&>iframe] 等）
 * 描述完整 HTML = main-info-column 与其后 my-40 内全部内容。
 */
export class ItemPageParser {
  constructor(private http: HttpClient) {}

  async fetch(itemId: number): Promise<ItemDetail> {
    const url = `https://booth.pm/zh-cn/items/${itemId}`
    const res = await this.http.request(url, 'GET')
    const text = await res.text()
    const err = sniffAuthFailure(res.status, res.url, text.slice(0, 2000))
    if (err) throw err
    if (res.status === 404 || /お探しのページが見つかりません/.test(text)) {
      throw new BoothError(`商品 ${itemId} 不存在或已下架`, 'not_found', 404)
    }
    return parseItemPage(text, itemId)
  }
}

export function parseItemPage(html: string, itemId: number): ItemDetail {
  const $ = cheerio.load(html)

  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim() || ''
  const ogImage = $('meta[property="og:image"]').attr('content')?.trim() || null
  const title = ogTitle.replace(/\s*-\s*[^-]*-\s*BOOTH\s*$/, '').trim() || ogTitle

  // ── 画廊图（头部大图区，原图在 data-origin，懒加载在 data-lazy）──
  const galleryUrls: string[] = []
  const pushUrl = (u?: string | null): void => {
    if (!u) return
    if (!galleryUrls.includes(u)) galleryUrls.push(u)
  }
  pushUrl(ogImage)
  $('img.market-item-detail-item-image').each((_, el) => {
    const $img = $(el)
    pushUrl($img.attr('data-origin') || $img.attr('data-lazy') || $img.attr('src'))
  })

  // ── 描述完整 HTML：main-info-column 起，到其后的 my-40 结束 ──
  const $descCol = $('.js-market-item-detail-description').first()
  let descriptionHtml = ''
  if ($descCol.length) {
    const $section = $descCol.closest('section') // section.main-info-column
    const parts: string[] = []
    if ($section.length) parts.push($.html($section))
    else parts.push($.html($descCol))
    // 后续同级的 div.my-40（含更多段落与视频 iframe）
    let $next = $section.length ? $section.next() : $descCol.parent().next()
    while ($next.length) {
      const cls = $next.attr('class') || ''
      if ($next.is('div.my-40') || cls.includes('my-40')) {
        parts.push($.html($next))
        $next = $next.next()
      } else break
    }
    descriptionHtml = parts.join('\n')
  } else {
    // 回退：容器 class 可能变
    const $fallback = $('main .description, article .description, [class*="description"]').first()
    descriptionHtml = $fallback.length ? $.html($fallback) : ''
  }

  // 描述里的图片也计入画廊（用户插图）
  const descImgMatches = descriptionHtml.match(/https:\/\/booth\.pximg\.net\/[^"'\s)>]+/g) || []
  for (const u of descImgMatches) pushUrl(u.split('&quot;')[0])

  // ── 描述中的内嵌视频 ──
  const videos = extractVideos(descriptionHtml)

  // ── 视频缩略图若有（youtube img），不额外处理，用平台自带 ──

  const shopName =
    $('meta[name="author"]').attr('content')?.trim() ||
    $('.shop-name, [class*="shopName"]').first().text().trim() ||
    null

  // 文件名列表：详情页 downloadable 区块（详情页由 JS 渲染，通常为空，列表页已有）
  const filenames: string[] = []
  $('[data-href*="downloadables"]').each((_, el) => {
    const name = $(el).closest('div').find('.text-14').first().text().trim()
    if (name && !filenames.includes(name)) filenames.push(name)
  })

  if (!title && !descriptionHtml) {
    throw new BoothError(`商品 ${itemId} 页面解析失败`, 'parse')
  }

  return {
    itemId,
    title,
    descriptionHtml,
    ogImageUrl: ogImage,
    galleryUrls,
    shopName,
    filenames
  }
}

/** 从描述 HTML 提取内嵌视频（iframe/链接） */
export function extractVideos(descriptionHtml: string): ExtractedVideo[] {
  const out: ExtractedVideo[] = []
  const seen = new Set<string>()
  const add = (v: ExtractedVideo): void => {
    if (seen.has(v.key)) return
    seen.add(v.key)
    out.push(v)
  }

  // iframe src 与超链接 href 都扫
  const sources: string[] = []
  const iframeRe = /<iframe[^>]+src="([^"]+)"/gi
  let m: RegExpExecArray | null
  while ((m = iframeRe.exec(descriptionHtml))) sources.push(decodeEntities(m[1]))
  const linkRe = /href="(https?:\/\/[^"]+)"/gi
  while ((m = linkRe.exec(descriptionHtml))) sources.push(decodeEntities(m[1]))

  for (const src of sources) {
    const v = parseVideoUrl(src)
    if (v) add(v)
  }
  return out
}

export function parseVideoUrl(rawUrl: string): ExtractedVideo | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  const host = u.hostname.replace(/^www\./, '')

  // YouTube
  let ytId: string | null = null
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname.startsWith('/embed/')) ytId = u.pathname.slice(7).split('/')[0]
    else if (u.pathname === '/watch') ytId = u.searchParams.get('v')
    else if (u.pathname.startsWith('/shorts/')) ytId = u.pathname.slice(8).split('/')[0]
  } else if (host === 'youtu.be') {
    ytId = u.pathname.slice(1).split('/')[0]
  }
  if (ytId && /^[\w-]{6,}$/.test(ytId)) {
    return {
      key: `youtube:${ytId}`,
      platform: 'youtube',
      videoId: ytId,
      url: `https://www.youtube.com/watch?v=${ytId}`,
      embedUrl: `https://www.youtube.com/embed/${ytId}`
    }
  }

  // NicoNico
  if (host.endsWith('nicovideo.jp') || host === 'nico.ms') {
    const sm = /\/watch\/(sm\d+)/.exec(u.pathname) || (host === 'nico.ms' ? /^\/(\w+)$/.exec(u.pathname) : null)
    if (sm) {
      const vid = sm[1]
      return {
        key: `nicovideo:${vid}`,
        platform: 'nicovideo',
        videoId: vid,
        url: `https://www.nicovideo.jp/watch/${vid}`,
        embedUrl: `https://embed.nicovideo.jp/watch/${vid}`
      }
    }
  }

  // Vimeo
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const vm = /(\d+)/.exec(u.pathname)
    if (vm) {
      const vid = vm[1]
      return {
        key: `vimeo:${vid}`,
        platform: 'vimeo',
        videoId: vid,
        url: `https://vimeo.com/${vid}`,
        embedUrl: `https://player.vimeo.com/video/${vid}`
      }
    }
  }

  return null
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

/** 计算元数据哈希（检测作者修改简介/宣传图/标题/视频） */
export function metadataHashOf(d: {
  title: string
  descriptionHtml: string
  ogImageUrl: string | null
  galleryUrls: string[]
}): string {
  const payload = JSON.stringify({
    t: d.title,
    d: normalizeHtml(d.descriptionHtml),
    o: d.ogImageUrl,
    g: d.galleryUrls
  })
  return sha256Hex(payload)
}

/**
 * 是否需要写历史快照：仅比较标题、简介（含简介内图片）、封面。
 * 画廊增删不触发快照，只静默更新画廊展示。
 */
export function metadataContentChanged(
  prev: { title: string; descriptionHtml: string; ogImageUrl: string | null },
  next: { title: string; descriptionHtml: string; ogImageUrl: string | null }
): boolean {
  return (
    prev.title !== next.title ||
    normalizeHtml(prev.descriptionHtml) !== normalizeHtml(next.descriptionHtml) ||
    prev.ogImageUrl !== next.ogImageUrl
  )
}

function normalizeHtml(html: string): string {
  return html.replace(/\s+/g, ' ').trim()
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex')
}
