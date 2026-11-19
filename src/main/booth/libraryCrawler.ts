import * as cheerio from 'cheerio'
import { BoothError } from './errors'
import { sniffAuthFailure, type HttpClient } from './httpClient'
import { isLibraryPageHtml } from './auth'
import type { DownloadableRef, LibraryItem } from '../../shared/types'

export interface ScopedLibraryItem {
  purchases: DownloadableRef[]
  gifts: DownloadableRef[]
}

const libraryOrigin = 'https://accounts.booth.pm'

/**
 * 库列表页爬虫：/library（购买）+ /library/gifts（赠送）。
 * 页面为服务端渲染 HTML，卡片内嵌每个文件的 data-href 与 data-dropdown-items。
 * 翻页直到空页为止（末页之后仍可能返回 200）。
 */
export class LibraryCrawler {
  constructor(private http: HttpClient) {}

  /** 使用服务端库搜索，逐页核实筛选条件，只接收目标商品卡片。 */
  async crawlItem(itemId: number, title: string, alternateTitle?: string): Promise<ScopedLibraryItem> {
    const keywords = [...new Set([alternateTitle, title].flatMap((name) => {
      if (!name?.trim() || name === `#${itemId}`) return []
      const words = name.replace(/\s+\([^()]*\)$/, '').match(/[\p{L}][\p{L}\p{N}]+/gu) ?? []
      return [...words.sort((a, b) => b.length - a.length).slice(0, 4), name.trim()]
    }))]
    for (const keyword of keywords) {
      const purchases = await this.searchItem('/library', keyword, itemId)
      if (!purchases?.length) continue
      const gifts = await this.searchItem('/library/gifts', keyword, itemId)
      return { purchases, gifts: gifts ?? [] }
    }
    throw new BoothError(`购买库搜索未找到商品 #${itemId}，无法核实当前下载项`, 'parse')
  }

  private async searchItem(path: string, keyword: string, itemId: number): Promise<DownloadableRef[] | null> {
    let found = false
    const links: DownloadableRef[] = []
    for (let page = 1; page <= 200; page++) {
      const url = new URL(path, libraryOrigin)
      url.searchParams.set('q', keyword)
      url.searchParams.set('page', String(page))
      const html = await this.fetchPage(url.href)
      const result = parseScopedLibraryPage(html, path, keyword, page, itemId)
      if (page > 1 && !result.cardCount) throw new BoothError('购买库筛选结果的下一页没有预期的商品', 'parse')
      if (result.links) {
        found = true
        links.push(...result.links)
      }
      if (!result.hasNext) return found ? links : null
    }
    throw new BoothError('购买库筛选结果分页不完整', 'parse')
  }

  async crawlAll(onPage?: (kind: 'library' | 'gifts', page: number, count: number) => void): Promise<LibraryItem[]> {
    const items: LibraryItem[] = []
    const seen = new Set<number>()
    for (const kind of ['library', 'gifts'] as const) {
      const list = await this.crawlKind(kind, onPage)
      for (const it of list) {
        if (seen.has(it.itemId)) continue
        seen.add(it.itemId)
        items.push(it)
      }
    }
    return items
  }

  async crawlKind(
    kind: 'library' | 'gifts',
    onPage?: (kind: 'library' | 'gifts', page: number, count: number) => void,
    onVerifiedList?: (items: LibraryItem[]) => void
  ): Promise<LibraryItem[]> {
    const items: LibraryItem[] = []
    const base = kind === 'library' ? '/library' : '/library/gifts'
    let verified = !!onVerifiedList
    let expectedNextPage = false
    let ended = false
    for (let page = 1; page <= 200; page++) {
      const url = `https://accounts.booth.pm${base}?page=${page}`
      const html = await this.fetchPage(url)
      const pageItems = parseLibraryPage(html, kind === 'gifts')
      if (expectedNextPage && !pageItems.length) throw new BoothError('购买库下一页缺少预期的商品', 'parse')
      if (verified) {
        const pageProof = verifyLibraryPage(html, base, page, pageItems)
        verified = !!pageProof
        expectedNextPage = pageProof?.hasNext ?? false
      }
      onPage?.(kind, page, pageItems.length)
      if (pageItems.length === 0) {
        ended = true
        break
      }
      items.push(...pageItems)
    }
    if (!ended) throw new BoothError('购买库分页不完整', 'parse')
    if (verified) onVerifiedList?.(items)
    return items
  }

  private async fetchPage(url: string): Promise<string> {
    const res = await this.http.request(url, 'GET')
    const text = await res.text()
    const err = sniffAuthFailure(res.status, res.url, text.slice(0, 2000))
    if (err) throw err
    if (res.status !== 200) throw new BoothError(`库列表 HTTP ${res.status}`, 'server', res.status)
    if (!isLibraryPageHtml(text)) {
      // 登录页 title 为 BOOTH 登录相关（Sign in / ログイン），或其它异常
      if (/login|sign_in|ログイン/i.test(res.url) || /<title>[^<]*ログイン|Log in/i.test(text)) {
        throw new BoothError('cookies 过期，页面跳转到登录', 'auth', res.status)
      }
      throw new BoothError('库页面结构异常（可能未登录）', 'auth', res.status)
    }
    return text
  }
}

function verifyLibraryPage(html: string, path: string, page: number, items: LibraryItem[]): { hasNext: boolean } | null {
  if (!/<\/html>\s*$/i.test(html)) return null
  const $ = cheerio.load(html)
  const main = $('main')
  const search = $('#js-library-search-data')
  try {
    const params = JSON.parse(search.attr('data-search-params') ?? 'null')
    if (main.length !== 1 || search.length !== 1 || search.attr('data-search-url') !== libraryOrigin + path ||
        !params || params.q || Number(params.page ?? 1) !== page) return null
    const verified = new Map<number, DownloadableRef[]>()
    const cards = new Set(main.find('img.l-library-item-thumbnail').toArray().map((image) => $(image).closest('div.bg-white')[0]))
    for (const card of cards) {
      if (!card) return null
      const element = $(card)
      const images = element.find('img.l-library-item-thumbnail')
      const itemId = Number(/\/items\/(\d+)(?:[/?#]|$)/.exec(images.closest('a').attr('href') ?? '')?.[1])
      if (images.length !== 1 || !Number.isSafeInteger(itemId) || itemId <= 0) return null
      const files = parseVerifiedDownloadables(element, $, () => { throw new Error('下载项清单不完整') })
      if (!files.length) return null
      verified.set(itemId, [...verified.get(itemId) ?? [], ...files])
    }
    if (verified.size !== items.length || items.some((item) => !verified.has(item.itemId))) return null
    const next = main.find('a[rel="next"]')
    if (next.length > 1) return null
    if (next.length === 1) {
      const href = next.attr('href')
      if (!href) return null
      const url = new URL(href, libraryOrigin)
      if (url.origin !== libraryOrigin || url.pathname !== path || url.searchParams.get('q') ||
          url.searchParams.get('page') !== String(page + 1)) return null
    }
    if (items.length === 0 && main.find('a[rel="next"], [data-href*="downloadables"], [data-dropdown-items*="downloadables/"]').length) return null
    for (const item of items) item.verifiedDownloadables = verified.get(item.itemId)
    return { hasNext: next.length === 1 }
  } catch {
    return null
  }
}

/** 解析单个库列表页 HTML → 商品条目 */
export function parseLibraryPage(html: string, isGift: boolean): LibraryItem[] {
  const $ = cheerio.load(html)
  const items: LibraryItem[] = []
  const seenIds = new Map<number, LibraryItem>()

  // 卡片分隔：每张卡片以缩略图开始，位于白底列表容器内
  // 结构：a[href*="/items/"] > img.l-library-item-thumbnail，随后同卡片内的文件行
  const anchors = $('a[href*="/items/"]').toArray()
  for (const a of anchors) {
    const $a = $(a)
    const href = $a.attr('href') || ''
    const m = /\/items\/(\d+)/.exec(href)
    if (!m) continue
    const itemId = Number(m[1])
    const $img = $a.find('img.l-library-item-thumbnail')
    if ($img.length === 0) continue // 不是列表卡片的链接（如导航推荐）

    const title = ($a.attr('title') || $a.text() || '').trim() ||
      $a.parent().find('.text-text-default').first().text().trim()
    const thumb = $img.attr('src') || ''

    // 卡片容器 = 从锚点向上第一个包含下载按钮的祖先；
    // 若先遇到包含其它商品锚点的祖先（整个列表容器），说明本商品无下载链接
    const explicitCard = $a.closest('div.bg-white')
    let $card = $a.parent()
    let downloadables: DownloadableRef[] = []
    let downloadButtons = 0
    let downloadablesIncomplete = false
    for (let up = 0; up < 6; up++) {
      downloadButtons = $card.find('[data-href*="downloadables"]').length
      if (downloadButtons > 0) {
        downloadables = parseDownloadables($card, $, false)
        downloadablesIncomplete = downloadables.length !== downloadButtons
        break
      }
      // 检查是否已跨到其它商品（整个列表容器）
      const foreign = $card.find('a[href*="/items/"]').toArray().some((el) => {
        const hm = /\/items\/(\d+)/.exec($(el).attr('href') || '')
        return hm && Number(hm[1]) !== itemId
      })
      if (foreign) break
      const $next = $card.parent()
      if ($next.length === 0) break
      $card = $next
    }
    if (explicitCard.find('img.l-library-item-thumbnail').length === 1 &&
        hasUnmatchedDownloadMenus(explicitCard, $)) downloadablesIncomplete = true

    const owned = !isGift && !downloadablesIncomplete && downloadables.length &&
      downloadables.every((link) => link.variationId != null)
      ? [...new Set(downloadables.map((link) => link.variationId!))] : undefined
    const previous = seenIds.get(itemId)
    if (previous) {
      previous.downloadablesIncomplete ||= downloadablesIncomplete
      if (previous.purchasedVariationIds && owned) previous.purchasedVariationIds = [...new Set([...previous.purchasedVariationIds, ...owned])]
      else previous.purchasedVariationIds = undefined
    }
    const filesById = new Map(previous?.downloadables.map((file) => [file.downloadableId, file]))
    for (const file of downloadables) {
      if (!filesById.has(file.downloadableId)) filesById.set(file.downloadableId, file)
    }
    if (previous) {
      previous.downloadables = [...filesById.values()]
      continue
    }
    const item: LibraryItem = {
      itemId,
      title: title || `#${itemId}`,
      itemUrl: `https://booth.pm/zh-cn/items/${itemId}`,
      thumbnailUrl: thumb,
      isGift,
      downloadables: [...filesById.values()],
      downloadablesIncomplete,
      purchasedVariationIds: owned
    }
    seenIds.set(itemId, item)
    items.push(item)
  }
  return items
}

/** 从卡片容器内提取全部下载链接 */
export function parseDownloadables($card: cheerio.Cheerio<any>, $: cheerio.CheerioAPI, deduplicate = true): DownloadableRef[] {
  const out: DownloadableRef[] = []
  const seen = new Set<number>()

  $card.find('[data-href*="downloadables"]').each((_, el) => {
    const $btn = $(el)
    const href = $btn.attr('data-href') || ''
    const idm = /downloadables\/(\d+)/.exec(href)
    if (!idm) return
    const downloadableId = Number(idm[1])
    if (deduplicate && seen.has(downloadableId)) return
    seen.add(downloadableId)

    // 行容器：按钮的 .mt-8 行（data-href 按钮与 data-dropdown-items 按钮是兄弟）
    const $row = $btn.closest('div.mt-8').length ? $btn.closest('div.mt-8') : $btn.parent().parent()

    // 文件名：行容器的前一个兄弟里（文件名 div 包裹层与行同级）
    let filename = ''
    let $prev = $row.prev()
    for (let i = 0; i < 3 && $prev.length; i++) {
      const name = $prev.find('.text-14').first().text().trim() || ($prev.filter('.text-14').text() || '').trim()
      if (name) {
        filename = name
        break
      }
      $prev = $prev.prev()
    }
    if (!filename) {
      // 兜底：卡片内位于该按钮之前的最后一个 .text-14
      const btnPos = htmlPosition($card, $btn)
      for (const t of $card.find('.text-14').toArray()) {
        if (htmlPosition($card, $(t)) < btnPos) filename = $(t).text().trim()
      }
    }

    // 下拉项：同兄弟节点的 [data-dropdown-items]（HTML 实体编码 JSON）
    let variationId: number | null = null
    let fallbackUrl = href
    const $dd = $row.find('[data-dropdown-items]').first()
    const raw = $dd.length ? $dd.attr('data-dropdown-items') : $btn.attr('data-dropdown-items')
    if (raw) {
      try {
        const arr = JSON.parse(unescapeHtmlEntities(raw)) as Array<Record<string, string>>
        for (const entry of arr) {
          const du = entry.deeplinkDownloadableUrl || ''
          if (du.includes('client=booth-library-manager')) {
            const vm = /variation_id=(\d+)/.exec(du)
            if (vm) variationId = Number(vm[1])
          }
          if (entry.text === 'Download' && entry.deeplinkDownloadableUrl) {
            fallbackUrl = entry.deeplinkDownloadableUrl
          }
        }
      } catch {
        // 忽略解析失败，仅保留 data-href 回退
      }
    }

    out.push({ downloadableId, variationId, filename, fallbackUrl })
  })
  return out
}

export function parseScopedLibraryPage(html: string, path: string, keyword: string, page: number, itemId: number):
  { links: DownloadableRef[] | null; hasNext: boolean; cardCount: number } {
  const $ = cheerio.load(html)
  const fail = (): never => { throw new BoothError(`购买库商品 #${itemId} 的查询结果不完整或结构异常`, 'parse') }
  if (!/<\/html>\s*$/i.test(html)) fail()
  const search = $('#js-library-search-data')
  const params = JSON.parse(search.attr('data-search-params') ?? 'null')
  if (search.attr('data-search-url') !== libraryOrigin + path || params?.q !== keyword || Number(params.page) !== page) fail()

  const main = $('main')
  if (main.length !== 1) fail()
  const thumbnails = main.find('img.l-library-item-thumbnail').toArray()
  const cards = new Set(thumbnails.flatMap((image) => {
    const anchor = $(image).closest('a')
    const match = /\/items\/(\d+)(?:[/?#]|$)/.exec(anchor.attr('href') ?? '')
    if (!match) return fail()
    if (Number(match[1]) !== itemId) return []
    const card = anchor.closest('div.bg-white')
    if (!card.length || card.find('img.l-library-item-thumbnail').length !== 1) return fail()
    return card.toArray()
  }))
  const links = [...cards].flatMap((card) => parseVerifiedDownloadables($(card), $, fail))

  const next = main.find('a[rel="next"]').attr('href')
  const laterPage = main.find('a[href*="page="]').toArray().some((link) => {
    const url = new URL($(link).attr('href')!, libraryOrigin)
    return url.origin === libraryOrigin && url.pathname === path && url.searchParams.get('q') === keyword &&
      Number(url.searchParams.get('page')) > page
  })
  if (laterPage && !next) fail()
  if (next) {
    const url = new URL(next, libraryOrigin)
    if (url.origin !== libraryOrigin || url.pathname !== path || url.searchParams.get('q') !== keyword ||
        url.searchParams.get('page') !== String(page + 1)) fail()
  }
  if (!thumbnails.length && (next || main.find('[data-href*="downloadables"], [data-dropdown-items*="downloadables/"]').length)) fail()
  return { links: cards.size ? links : null, hasNext: Boolean(next), cardCount: thumbnails.length }
}

function parseVerifiedDownloadables(
  element: Parameters<typeof parseDownloadables>[0], $: cheerio.CheerioAPI, fail: () => never
): DownloadableRef[] {
  const buttons = element.find('[data-href*="downloadables"]').toArray()
  const parsed = parseDownloadables(element, $, false)
  if (buttons.length !== parsed.length) fail()
  if (hasUnmatchedDownloadMenus(element, $)) fail()
  for (const [index, button] of buttons.entries()) {
    const url = new URL($(button).attr('data-href')!, 'https://booth.pm')
    const file = parsed[index]
    if (url.origin !== 'https://booth.pm' || url.pathname !== `/downloadables/${file.downloadableId}` ||
        !file.filename || !file.variationId || !Number.isSafeInteger(file.downloadableId)) fail()
    const row = $(button).closest('div.mt-8')
    const filename = row.prev().find('.text-14').first().text().trim() || row.prev('.text-14').text().trim()
    const menuSource = row.find('[data-dropdown-items]').first().attr('data-dropdown-items') ?? $(button).attr('data-dropdown-items')
    if (filename !== file.filename || !menuSource) fail()
    const menu: unknown = JSON.parse(unescapeHtmlEntities(menuSource!))
    if (!Array.isArray(menu)) return fail()
    const scopedLinks = menu.flatMap((entry) => {
      if (typeof entry?.deeplinkDownloadableUrl !== 'string') return []
      const link = new URL(entry.deeplinkDownloadableUrl, 'https://booth.pm')
      return link.searchParams.get('client') === 'booth-library-manager' ? [link] : []
    })
    if (!scopedLinks.length || scopedLinks.some((link) => link.origin !== 'https://booth.pm' ||
        link.pathname !== `/downloadables/${file.downloadableId}/deeplink` ||
        link.searchParams.get('variation_id') !== String(file.variationId))) fail()
  }
  return parsed
}

function hasUnmatchedDownloadMenus(element: Parameters<typeof parseDownloadables>[0], $: cheerio.CheerioAPI): boolean {
  const buttonRows = new Set(element.find('[data-href*="downloadables"]').toArray()
    .map((button) => $(button).closest('div.mt-8')[0]))
  return element.find('[data-dropdown-items*="downloadables/"]').toArray().some((menu) => {
    const row = $(menu).closest('div.mt-8')[0]
    return !row || !buttonRows.has(row)
  })
}

/** 文档位置序号（用于兜底文件名匹配），解析一次缓存 */
const positionCache = new WeakMap<object, number>()
function htmlPosition($root: cheerio.Cheerio<any>, $el: cheerio.Cheerio<any>): number {
  const node = $el[0]
  if (!node) return -1
  const cached = positionCache.get(node as object)
  if (cached !== undefined) return cached
  // 线性扫描 root 内所有元素求位置（卡片规模小，可接受）
  const all = $root.find('*').toArray()
  const idx = all.indexOf(node as never)
  positionCache.set(node as object, idx)
  return idx
}

/** HTML 实体解码（cheerio 的 text() 已解码一层，这里处理属性里的 &quot; &amp; 等） */
export function unescapeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
