import * as cheerio from 'cheerio'
import { BoothError } from './errors'
import { sniffAuthFailure, type HttpClient } from './httpClient'
import type { DownloadableRef, LibraryItem } from '../../shared/types'

/**
 * 库列表页爬虫：/library（购买）+ /library/gifts（赠送）。
 * 页面为服务端渲染 HTML，卡片内嵌每个文件的 data-href 与 data-dropdown-items。
 * 翻页直到空页为止（末页之后仍可能返回 200）。
 */
export class LibraryCrawler {
  constructor(private http: HttpClient) {}

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
    onPage?: (kind: 'library' | 'gifts', page: number, count: number) => void
  ): Promise<LibraryItem[]> {
    const items: LibraryItem[] = []
    const base = kind === 'library' ? '/library' : '/library/gifts'
    for (let page = 1; page <= 200; page++) {
      const url = `https://accounts.booth.pm${base}?page=${page}`
      const html = await this.fetchPage(url)
      const pageItems = parseLibraryPage(html, kind === 'gifts')
      onPage?.(kind, page, pageItems.length)
      if (pageItems.length === 0) break // 空页 = 已到最后
      items.push(...pageItems)
      // 页内条目少于 20 且无下一页链接，也可能是最后一页；仍由空页兜底
    }
    return items
  }

  private async fetchPage(url: string): Promise<string> {
    const res = await this.http.request(url, 'GET')
    const text = await res.text()
    const err = sniffAuthFailure(res.status, res.url, text.slice(0, 2000))
    if (err) throw err
    if (!/<title>Library - BOOTH/.test(text)) {
      // 登录页 title 为 BOOTH 登录相关，或其它异常
      if (/login|sign_in|ログイン/i.test(res.url) || /<title>[^<]*ログイン|Log in/i.test(text)) {
        throw new BoothError('cookies 过期，页面跳转到登录', 'auth', res.status)
      }
      throw new BoothError('库页面结构异常（可能未登录）', 'auth', res.status)
    }
    return text
  }
}

/** 解析单个库列表页 HTML → 商品条目 */
export function parseLibraryPage(html: string, isGift: boolean): LibraryItem[] {
  const $ = cheerio.load(html)
  const items: LibraryItem[] = []
  const seenIds = new Set<number>()

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
    if (seenIds.has(itemId)) continue
    seenIds.add(itemId)

    const title = ($a.attr('title') || $a.text() || '').trim() ||
      $a.parent().find('.text-text-default').first().text().trim()
    const thumb = $img.attr('src') || ''

    // 卡片容器 = 从锚点向上第一个包含下载按钮的祖先；
    // 若先遇到包含其它商品锚点的祖先（整个列表容器），说明本商品无下载链接
    let $card = $a.parent()
    let downloadables: DownloadableRef[] = []
    for (let up = 0; up < 6; up++) {
      if ($card.find('[data-href*="downloadables"]').length > 0) {
        downloadables = parseDownloadables($card, $)
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

    items.push({
      itemId,
      title: title || `#${itemId}`,
      itemUrl: `https://booth.pm/zh-cn/items/${itemId}`,
      thumbnailUrl: thumb,
      isGift,
      downloadables
    })
  }
  return items
}

/** 从卡片容器内提取全部下载链接 */
export function parseDownloadables($card: cheerio.Cheerio<any>, $: cheerio.CheerioAPI): DownloadableRef[] {
  const out: DownloadableRef[] = []
  const seen = new Set<number>()

  $card.find('[data-href*="downloadables"]').each((_, el) => {
    const $btn = $(el)
    const href = $btn.attr('data-href') || ''
    const idm = /downloadables\/(\d+)/.exec(href)
    if (!idm) return
    const downloadableId = Number(idm[1])
    if (seen.has(downloadableId)) return
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
