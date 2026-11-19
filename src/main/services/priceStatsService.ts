import * as cheerio from 'cheerio'
import type { PriceStatsResult, PriceStatsRow, PriceStatsSnapshot } from '../../shared/types'
import { sniffAuthFailure, type HttpClient } from '../booth/httpClient'
import { BoothError } from '../booth/errors'
import { fetchBoothItem, type ReadBoothItem } from '../booth/itemApi'
import type { LibraryRepo } from '../db/repos'
import { createLogger } from '../util/log'

const log = createLogger('priceStats')
const ordersUrl = 'https://accounts.booth.pm/orders'
const snapshotKey = 'priceStatsSnapshot'

interface OrderLine {
  itemId: number
  orderTitle: string
  variationId: number | null
  amount: number
}

interface MarketItem {
  title: string
  variations: Map<number, { name: string | null; price: number | null }>
}

function orderPath(href: string, pattern: RegExp): URL | null {
  try {
    const url = new URL(href, ordersUrl)
    return url.origin === new URL(ordersUrl).origin && pattern.test(url.pathname) ? url : null
  } catch {
    return null
  }
}

function yen(text: string): number | null {
  const amount = /[¥￥]\s*(\d[\d,]*)/.exec(text)?.[1]
  const value = amount == null ? NaN : Number(amount.replaceAll(',', ''))
  return Number.isSafeInteger(value) ? value : null
}

function variationIds(from: string): number[] {
  try {
    const menu: Array<{ deeplinkDownloadableUrl?: string }> = JSON.parse(from)
    return menu.flatMap(({ deeplinkDownloadableUrl }) => {
      if (!deeplinkDownloadableUrl) return []
      const url = new URL(deeplinkDownloadableUrl, 'https://booth.pm')
      const id = url.searchParams.get('variation_id')
      return /\/downloadables\/\d+\/deeplink$/.test(url.pathname) && id && /^\d+$/.test(id) ? [Number(id)] : []
    })
  } catch {
    return []
  }
}

function parseOrder(html: string): OrderLine[] {
  const $ = cheerio.load(html)
  const state = $('.order-state').text().trim()
  if (/キャンセル|返金済|(?:入金|支払(?:い)?)待ち|cancell?ed|refunded|awaiting payment/i.test(state)) return []
  const order = $('.l-order-detail-by-shop')
  if (!order.length) throw new Error('BOOTH 订单详情结构异常')

  const lines = order.find('.sheet').toArray().flatMap((element) => {
    const row = $(element)
    const priceBlock = row.find('[class~="desktop:flex-1"]').first()
    const amount = yen(priceBlock.children().eq(1).text())
    const product = priceBlock.find('a[href*="/items/"]').first()
    const itemId = /\/items\/(\d+)(?:[/?#]|$)/.exec(product.attr('href') ?? '')?.[1]
    if (!itemId && amount === null) return []
    if (!itemId || amount === null) throw new Error('有订单商品缺少可识别的编号或购买金额')

    const ids = new Set(row.find('[data-dropdown-items]').toArray()
      .flatMap((menu) => variationIds($(menu).attr('data-dropdown-items') ?? '')))
    return [{
      itemId: Number(itemId),
      orderTitle: product.text().trim(),
      variationId: ids.size === 1 ? [...ids][0] : null,
      amount
    }]
  })
  if (!lines.length) throw new Error('BOOTH 订单详情未识别到商品行')
  return lines
}

function splitOrderTitle(title: string): { title: string; variation: string | null } {
  // BOOTH renders the purchased option as a parenthesized suffix in the order line.
  let depth = 0
  if (title.endsWith(')')) {
    for (let index = title.length - 1; index > 0; index--) {
      if (title[index] === ')') depth++
      if (title[index] === '(' && --depth === 0) {
        if (title[index - 1] === ' ') return { title: title.slice(0, index).trimEnd(), variation: title.slice(index + 1, -1) }
        break
      }
    }
  }
  return { title, variation: null }
}

export class PriceStatsService {
  private error: string | null = null

  constructor(private http: HttpClient, private repo: Pick<LibraryRepo, 'getSetting' | 'setSetting'>) {}

  get(): PriceStatsResult {
    return { snapshot: this.repo.getSetting<PriceStatsSnapshot | null>(snapshotKey, null), error: this.error }
  }

  async refresh(onProgress: (label: string, current: number, total: number) => void,
    readItem: ReadBoothItem = (itemId) => fetchBoothItem(this.http, itemId)): Promise<void> {
    try {
      const paths = await this.listOrders(onProgress)
      const byItem = new Map<number, OrderLine[]>()
      for (const [index, path] of paths.entries()) {
        onProgress('读取购买订单', index + 1, paths.length)
        for (const line of parseOrder(await this.fetchOrderPage(path))) {
          const lines = byItem.get(line.itemId)
          if (lines) lines.push(line)
          else byItem.set(line.itemId, [line])
        }
      }

      const rows: PriceStatsRow[] = []
      let rateLimited = false
      for (const [itemId, lines] of byItem) {
        onProgress('获取商品现价', rows.length + 1, byItem.size)
        let market: MarketItem | null = null
        if (!rateLimited) {
          try {
            market = this.marketItem(await readItem(itemId))
          } catch (error) {
            rateLimited = error instanceof BoothError && error.kind === 'rate_limited'
            if (!(error instanceof BoothError && error.kind === 'not_found')) {
              log.warn(`读取商品 #${itemId} 现价失败：${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
        const orderTitle = splitOrderTitle(lines[0].orderTitle)
        const names = new Set<string>()
        let purchasePrice = 0
        let currentPrice: number | null = null
        let hasMissingCurrentPrice = false
        for (const line of lines) {
          purchasePrice += line.amount
          const variation = line.variationId == null ? undefined : market?.variations.get(line.variationId)
          const purchasedName = line.orderTitle === market?.title ? null : splitOrderTitle(line.orderTitle).variation
          names.add(purchasedName ?? variation?.name ?? (variation ? '默认规格' : line.variationId ? `变体 #${line.variationId}` : '未知'))
          if (variation?.price == null) hasMissingCurrentPrice = true
          else currentPrice = (currentPrice ?? 0) + variation.price
        }
        rows.push({ itemId, title: market?.title || orderTitle.title, variationNames: [...names], purchasePrice, currentPrice, hasMissingCurrentPrice })
      }
      const snapshot: PriceStatsSnapshot = {
        updatedAt: new Date().toISOString(),
        rows,
        purchaseTotal: rows.reduce((total, row) => total + row.purchasePrice, 0),
        currentTotal: rows.length === 0 || rows.some((row) => row.currentPrice !== null)
          ? rows.reduce((total, row) => total + (row.currentPrice ?? 0), 0)
          : null,
        missingCurrentItems: rows.filter((row) => row.hasMissingCurrentPrice).length
      }
      this.repo.setSetting(snapshotKey, snapshot)
      this.error = null
      log.info(`价格统计完成：${paths.length} 笔订单，${rows.length} 个商品，${snapshot.missingCurrentItems} 个商品现价缺失`)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      log.warn(`价格统计更新失败：${this.error}`)
    }
  }

  private async listOrders(onProgress: (label: string, current: number, total: number) => void): Promise<string[]> {
    const paths = new Set<string>()
    const visited = new Set<string>()
    let next = ordersUrl
    while (next) {
      if (visited.has(next)) throw new Error('BOOTH 购买记录分页重复')
      visited.add(next)
      onProgress(`读取购买记录第 ${visited.size} 页…`, 0, 0)
      const $ = cheerio.load(await this.fetchOrderPage(next))
      const list = $('.l-orders-index')
      if (!list.length) throw new Error('BOOTH 购买记录页面结构异常')
      list.find('a[href]').each((_, element) => {
        const url = orderPath($(element).attr('href') ?? '', /^\/orders\/\d+$/)
        if (url) paths.add(url.origin + url.pathname)
      })
      const href = $('a[rel="next"]').attr('href')
      const nextPage = href ? orderPath(href, /^\/orders$/) : null
      if (href && !nextPage) throw new Error('BOOTH 购买记录分页地址异常')
      next = nextPage?.href ?? ''
    }
    return [...paths]
  }

  private async fetchOrderPage(url: string): Promise<string> {
    const response = await this.http.request(url, 'GET', { headers: { 'accept-language': 'ja' } })
    const html = await response.text()
    const error = sniffAuthFailure(response.status, response.url, html.slice(0, 2000))
    if (error) throw error
    if (response.status !== 200) throw new Error(`BOOTH 订单请求失败（HTTP ${response.status}）`)
    return html
  }

  private marketItem(data: Awaited<ReturnType<ReadBoothItem>>): MarketItem {
    if (!Array.isArray(data.variations)) throw new Error('商品 API 响应结构异常')
    const variations: MarketItem['variations'] = new Map()
    for (const v of data.variations) {
      if (!Number.isSafeInteger(v?.id)) continue
      variations.set(v.id, {
        name: typeof v.name === 'string' ? v.name : null,
        price: Number.isSafeInteger(v.price) && v.price >= 0 ? v.price : null
      })
    }
    return { title: data.name, variations }
  }
}
