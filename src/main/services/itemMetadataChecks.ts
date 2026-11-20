import * as cheerio from 'cheerio'
import { STARTUP_INTERVALS, type ApiMetadataCheckResult, type CheckProgressEvent, type RefreshItemResult } from '../../shared/types'
import type { ReadBoothItem } from '../booth/itemApi'
import { parseVideoUrl, sha256Hex } from '../booth/itemPageParser'
import type { LibraryRepo } from '../db/repos'
import { createLogger } from '../util/log'

const log = createLogger('itemMetadataChecks')

type ReadMetadata = Awaited<ReturnType<ReadBoothItem>>
type RefreshHtml = (itemId: number) => Promise<RefreshItemResult>

export function itemApiMetadataHash(data: ReadMetadata): string {
  if (!data.name.trim() || typeof data.description !== 'string' || !Array.isArray(data.embeds) || !Array.isArray(data.images)) {
    throw new Error('商品 API 详情字段不完整')
  }
  const videoIds = new Set<string>()
  for (const embed of data.embeds) {
    if (typeof embed !== 'string') throw new Error('商品 API 视频格式异常')
    const $ = cheerio.load(embed, undefined, false)
    const urls = $('iframe[src], a[href]').map((_, el) => $(el).attr(el.tagName === 'iframe' ? 'src' : 'href')!).get()
    for (const url of urls.length ? urls : [embed.trim()]) {
      if (/^https?:\/\//i.test(url)) videoIds.add(parseVideoUrl(url)?.key ?? url)
    }
  }
  const imageIds = data.images.map((image) => {
    const url = new URL(image?.original || image?.resized)
    const id = /\/i\/\d+\/([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?=[_.]|$)/i.exec(url.pathname)?.[1]
    if (!id) throw new Error('商品 API 画廊图片缺少可识别的编号')
    return id.toLowerCase()
  })
  return sha256Hex(JSON.stringify([data.name.trim(), data.description.replace(/\r\n/g, '\n'), [...videoIds], imageIds]))
}

export class ItemMetadataChecks {
  private pending = new Map<number, Promise<RefreshItemResult | null>>()
  private stopped = false

  constructor(private repo: LibraryRepo, private readItem: ReadBoothItem,
    private observeFiles?: (itemId: number, data: ReadMetadata, seedOnly: boolean) => void) {}

  stop(): void {
    this.stopped = true
  }

  batchReader(shouldSeedFiles: (itemId: number) => boolean = () => true): ReadBoothItem {
    const requests = new Map<number, ReturnType<ReadBoothItem>>()
    return (itemId) => {
      const existing = requests.get(itemId)
      if (existing) return existing
      if (this.stopped) return Promise.reject(new Error('应用正在退出'))
      if (shouldSeedFiles(itemId)) this.repo.markItemMetadataChecked(itemId, Date.now())
      const request = this.readItem(itemId).then((data) => {
        if (shouldSeedFiles(itemId)) this.observe(itemId, data, true)
        return data
      })
      requests.set(itemId, request)
      return request
    }
  }

  async seedAfterSync(itemIds: number[], readItem: ReadBoothItem): Promise<void> {
    for (const itemId of itemIds) {
      await this.check(itemId, { readItem }).catch((error) => log.warn(`商品 #${itemId} API 基线登记失败：`, error instanceof Error ? error.message : error))
    }
  }

  async pollOnStartup(
    intervalHours: number,
    refreshHtml: RefreshHtml,
    onItemRead?: (itemId: number, data: ReadMetadata | null) => void | Promise<void>,
    onProgress?: (event: CheckProgressEvent) => void
  ): Promise<boolean> {
    if (this.stopped) return false
    let refreshed = false
    const intervalMs = Math.max(STARTUP_INTERVALS.itemApi.min, intervalHours) * 3_600_000
    const itemIds = this.repo.listItemIdsDueForApiCheck(Date.now() - intervalMs)
    for (const [index, itemId] of itemIds.entries()) {
      if (this.stopped) break
      onProgress?.({ phase: 'item-api', current: index, total: itemIds.length, label: `商品 #${itemId}` })
      try {
        if (await this.check(itemId, { refreshHtml, intervalMs, onItemRead })) refreshed = true
      } catch (error) {
        log.warn(`商品 #${itemId} 启动详情检查失败：`, error instanceof Error ? error.message : error)
      }
    }
    return refreshed
  }

  async checkAll(refreshHtml: RefreshHtml, onProgress: (event: CheckProgressEvent) => void): Promise<ApiMetadataCheckResult> {
    const result: ApiMetadataCheckResult = { checked: 0, refreshed: 0, failed: 0 }
    const itemIds = this.repo.listAllItemIds()
    for (const [index, itemId] of itemIds.entries()) {
      if (this.stopped) break
      onProgress({ phase: 'item-metadata', current: index, total: itemIds.length, label: `商品 #${itemId}` })
      try {
        const detail = await this.check(itemId, { refreshHtml })
        if (detail?.notFound) {
          result.failed++
          continue
        }
        result.checked++
        if (detail) result.refreshed++
      } catch (error) {
        result.failed++
        log.warn(`商品 #${itemId} 批量详情检查失败：`, error instanceof Error ? error.message : error)
      }
    }
    return result
  }

  checkManually(itemId: number, refreshHtml: RefreshHtml): Promise<RefreshItemResult | null> {
    return this.check(itemId, { refreshHtml, fallbackToHtml: true })
  }

  private observe(itemId: number, data: ReadMetadata, seedOnly = false): void {
    if (this.stopped) return
    try {
      this.observeFiles?.(itemId, data, seedOnly)
    } catch (error) {
      log.warn(`商品 #${itemId} API 文件检查失败：`, error instanceof Error ? error.message : error)
    }
  }

  private async check(itemId: number, options: {
    refreshHtml?: RefreshHtml
    intervalMs?: number
    fallbackToHtml?: boolean
    readItem?: ReadBoothItem
    onItemRead?: (itemId: number, data: ReadMetadata | null) => void | Promise<void>
  }): Promise<RefreshItemResult | null> {
    const previous = this.pending.get(itemId)
    const task = (async () => {
      if (previous) await previous.catch(() => {})
      if (this.stopped) return null
      const state = this.repo.getItemMetadataCheck(itemId)
      if (!state || (options.readItem && state.hash !== null)) return null
      const now = Date.now()
      if (options.intervalMs && state.checkedAt != null && now - state.checkedAt < options.intervalMs) return null
      if (options.intervalMs) this.repo.markItemMetadataChecked(itemId, now)

      let hash: string
      try {
        const data = await (options.readItem ?? this.readItem)(itemId).catch(async (error) => {
          if (!this.stopped) await options.onItemRead?.(itemId, null)
          throw error
        })
        if (!this.stopped && options.onItemRead) await options.onItemRead(itemId, data)
        else if (options.intervalMs) this.observe(itemId, data)
        hash = itemApiMetadataHash(data)
      } catch (error) {
        if (this.stopped) return null
        if (!options.fallbackToHtml || !options.refreshHtml) throw error
        log.warn(`商品 #${itemId} 手动检查 API 失败，回退到商品页：`, error instanceof Error ? error.message : error)
        return options.refreshHtml(itemId)
      }
      if (this.stopped || !this.repo.getItemMetadataCheck(itemId)) return null
      const needsHtml = !state.hasHtml || state.hash !== hash
      const result = options.refreshHtml && needsHtml ? await options.refreshHtml(itemId) : null
      if (!this.stopped && !result?.notFound && hash !== state.hash) this.repo.saveItemMetadataCheckHash(itemId, hash)
      return result
    })()
    this.pending.set(itemId, task)
    try {
      return await task
    } finally {
      if (this.pending.get(itemId) === task) this.pending.delete(itemId)
    }
  }
}
