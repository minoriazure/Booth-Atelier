import type { LibraryCrawler, ScopedLibraryItem } from '../booth/libraryCrawler'
import type { ItemPageParser } from '../booth/itemPageParser'
import { metadataHashOf, normalizeHtml } from '../booth/itemPageParser'
import type { LibraryRepo } from '../db/repos'
import type { HistoryManager } from './historyManager'
import type { ImageLocalizer } from './imageLocalizer'
import type { PriceStatsService } from './priceStatsService'
import type { ItemMetadataChecks } from './itemMetadataChecks'
import type { ItemFileUpdates } from './itemFileUpdates'
import type { ReadBoothItem } from '../booth/itemApi'
import { retireMissingDownloadLinks } from './libraryDownloadLinks'
import type { ApiMetadataCheckResult, CheckProgressEvent, CheckSummary, ItemDetail, LibraryItem, LibrarySyncStats, RefreshItemResult } from '../../shared/types'
import { librarySummary } from '../../shared/librarySyncSummary'
import { BoothError, isAuthError } from '../booth/errors'
import { createLogger } from '../util/log'

const log = createLogger('librarySync')
const noDetailChange: RefreshItemResult = {
  changed: false, titleChanged: false, coverChanged: false, galleryChanged: false,
  galleryAdded: 0, galleryRemoved: 0, descriptionChanged: false, snapshotSaved: false, imagesPending: 0
}

/**
 * 库元数据同步（用户需求 #3 的"库更新"，与文件更新完全独立）：
 * - 抓列表页（购买+赠送）→ upsert items/downloadables，绝不入队任何文件下载
 * - 抓详情页 → 描述/宣传图/标题变化 → 写日期快照（历史备份）
 * - 每次同步完整检查库内商品详情；启动间隔由 StartupService 控制
 */
export class LibrarySyncService {
  private running = false
  private stopped = false
  private detailRefreshes = new Map<number, Promise<RefreshItemResult>>()

  onProgress: ((e: CheckProgressEvent) => void) | null = null

  constructor(
    private crawler: LibraryCrawler,
    private itemPage: ItemPageParser,
    private repo: LibraryRepo,
    private history: HistoryManager,
    private images: ImageLocalizer,
    private prices?: PriceStatsService,
    private metadataChecks?: ItemMetadataChecks,
    private fileUpdates?: ItemFileUpdates
  ) {}

  get isRunning(): boolean {
    return this.running
  }

  hasItems(): boolean {
    return this.repo.listAllItemIds().length > 0
  }

  stop(): void {
    this.stopped = true
    this.metadataChecks?.stop()
  }

  pollItemMetadataOnStartup(
    intervalHours: number,
    onItemRead?: (itemId: number, data: Awaited<ReturnType<ReadBoothItem>> | null) => void | Promise<void>,
    onProgress?: (event: CheckProgressEvent) => void
  ): Promise<boolean> {
    return this.metadataChecks?.pollOnStartup(intervalHours, (itemId) => this.refreshItem(itemId), onItemRead, onProgress) ?? Promise.resolve(false)
  }

  async checkItemMetadata(itemId: number): Promise<RefreshItemResult> {
    if (!this.metadataChecks) return this.refreshItem(itemId)
    const result = await this.metadataChecks.checkManually(itemId, (id) => this.refreshItem(id))
    return result ?? { ...noDetailChange, skippedHtml: true }
  }

  async checkAllItemMetadata(): Promise<ApiMetadataCheckResult> {
    if (this.running || this.fileUpdates?.isRunning) throw new Error('库同步或商品检查已在进行中')
    if (!this.metadataChecks) throw new Error('商品 API 检查不可用')
    this.running = true
    try {
      return await this.metadataChecks.checkAll((id) => this.refreshItem(id), (event) => this.onProgress?.(event))
    } finally {
      this.running = false
      this.onProgress?.({ phase: 'item-metadata', current: 0, total: 0 })
    }
  }

  async sync(verifiedItems?: Map<number, ScopedLibraryItem>): Promise<CheckSummary> {
    if (this.running || this.fileUpdates?.isRunning) throw new Error('库同步或商品文件核对已在进行中')
    this.running = true
    log.info('library sync start')
    const summary: CheckSummary = { libraryChecked: 0, libraryChanged: 0, filesChecked: 0, filesUpdated: 0, downloaded: 0, failed: 0 }
    const stats: LibrarySyncStats = {
      added: 0, linksFetched: 0, linksAdded: 0, linksChanged: 0, linksRemoved: 0, newItemLinks: 0,
      coversChanged: 0, galleriesChanged: 0, descriptionsChanged: 0,
      detailsChecked: 0, detailsTotal: 0, listFailures: 0, detailFailures: 0, notFound: 0,
      imagesPending: 0, issues: [], changes: []
    }
    summary.library = stats
    try {
      // 1) 列表页
      this.onProgress?.({ phase: 'library', current: 0, total: 0, label: '抓取库列表…' })
      const knownIds = new Set(this.dbAllItemIds())
      const initialRead = !knownIds.size || !this.repo.getSetting<string | null>('lastLibrarySyncAt', null)
        ? this.metadataChecks?.batchReader() : undefined
      const initialDetails: number[] = []
      const fileBaselines = new Set<number>()
      const items = new Map<number, LibraryItem>()
      const verifiedLists = new Map<string, LibraryItem[]>()
      const kinds: Array<'library' | 'gifts'> = ['library', 'gifts']
      for (const kind of kinds) {
        this.onProgress?.({ phase: 'library', current: 0, total: 0, label: kind === 'library' ? '抓取购买库…' : '抓取赠送库…' })
        try {
          const listed = await this.crawler.crawlKind(kind, (_k, page, count) => {
            log.info(`[${kind}] page ${page}: ${count} items`)
          }, verifiedItems ? (list) => verifiedLists.set(kind, list) : undefined)
          for (const item of listed) {
            const previous = items.get(item.itemId)
            if (!previous) items.set(item.itemId, item)
            else {
              previous.downloadablesIncomplete ||= item.downloadablesIncomplete
              if (kind === 'library') {
                previous.purchasedVariationIds = previous.purchasedVariationIds && item.purchasedVariationIds
                  ? [...new Set([...previous.purchasedVariationIds, ...item.purchasedVariationIds])] : undefined
              }
              const links = new Map(previous.downloadables.map((link) => [link.downloadableId, link]))
              for (const link of item.downloadables) {
                if (!links.has(link.downloadableId)) links.set(link.downloadableId, link)
              }
              previous.downloadables = [...links.values()]
            }
          }
        } catch (e) {
          if (isAuthError(e)) throw e
          const reason = e instanceof Error ? e.message : String(e)
          stats.issues.push({ source: kind, reason })
          stats.listFailures++
          summary.failed++
          log.warn(`[${kind}] list fetch failed: ${reason}`)
        }
      }
      const verifiedPurchases = verifiedLists.get('library')
      const verifiedGifts = verifiedLists.get('gifts')
      if (verifiedItems && verifiedPurchases && verifiedGifts && stats.listFailures === 0) {
        for (const [kind, list] of [['purchases', verifiedPurchases], ['gifts', verifiedGifts]] as const) {
          for (const item of list) {
            const actual = verifiedItems.get(item.itemId) ?? { purchases: [], gifts: [] }
            actual[kind].push(...item.verifiedDownloadables ?? [])
            verifiedItems.set(item.itemId, actual)
          }
        }
      }

      const seen = new Set(items.keys())
      const fetchedLinks = new Set<number>()
      const crawledDl = new Map<number, Set<number>>()
      let incompleteDownloadLists = 0
      let processed = 0
      for (const item of items.values()) {
        if (++processed % 100 === 0) await new Promise<void>((done) => setImmediate(done))
        const isNew = !knownIds.has(item.itemId)
        if (isNew) {
          stats.added++
          stats.changes.push({ itemId: item.itemId, label: `新增商品：${item.title}` })
        }
        if (item.downloadablesIncomplete) {
          incompleteDownloadLists++
          summary.failed++
          stats.issues.push({ itemId: item.itemId, source: '库下载列表', reason: '下载项不完整，已保留原下载链接' })
        }
        const links = new Map(item.downloadables.map((link) => [link.downloadableId, link]))
        const addedDownloadIds: number[] = []
        for (const link of links.values()) {
          if (fetchedLinks.has(link.downloadableId)) continue
          fetchedLinks.add(link.downloadableId)
          const old = this.repo.getDownloadable(link.downloadableId)
          if (!isNew && stats.listFailures === 0 && (!old || old.status === 'missing')) {
            addedDownloadIds.push(link.downloadableId)
          }
          if (isNew) stats.newItemLinks++
          else if (!old) {
            stats.linksAdded++
            stats.changes.push({ itemId: item.itemId, label: `新增下载链接 #${link.downloadableId}` })
          } else if (old.status === 'missing' ||
            (link.filename && link.filename !== old.filename) ||
            (link.variationId != null && link.variationId !== old.variationId) ||
            (link.fallbackUrl && link.fallbackUrl !== old.fallbackUrl)) {
            stats.linksChanged++
            stats.changes.push({ itemId: item.itemId, label: `更新下载链接 #${link.downloadableId}` })
          }
        }
        crawledDl.set(item.itemId, new Set(links.keys()))
        this.repo.upsertFromList({ ...item, downloadables: [...links.values()] })
        if (item.purchasedVariationIds && stats.listFailures === 0) {
          this.fileUpdates?.rememberPurchases(item.itemId, item.purchasedVariationIds, addedDownloadIds)
          if (this.fileUpdates?.needsBaseline(item.itemId)) fileBaselines.add(item.itemId)
        }
        if (item.thumbnailUrl) stats.imagesPending += this.images.registerItemImages(item.itemId, [{ url: item.thumbnailUrl, kind: 'thumb' }]) ?? 0
      }
      summary.libraryChecked = seen.size
      stats.linksFetched = fetchedLinks.size

      // 2) 缺席检测（连续 2 次缺席 → missing）；免费商品不在列表中属正常，跳过
      const allIds = this.dbAllItemIds()
      const freeIds = new Set(this.repo.listFreeItemIds())
      for (const id of allIds) {
        if (stats.listFailures === 0 && !seen.has(id) && !freeIds.has(id)) {
          const title = this.repo.getItemTitle(id)
          const state = this.repo.markAbsent(id)
          if (state === 'missing') log.warn(`absent: item=#${id}「${title.slice(0, 40)}」 not in library list 2 times → marked missing`)
          else log.info(`absent: item=#${id}「${title.slice(0, 40)}」 not in library list (counted, not yet missing)`)
        }
      }

      // 2b) 消失的下载链接：作者删除旧文件改名重传（_V2 等）时，旧 downloadable 不再出现在列表。
      //     老文件立即归档到历史 + 链接标失效；新文件已在待下载。（只在该商品列表解析成功时才判定，防解析故障误伤）
      let vanished = 0
      for (const [itemId, keep] of crawledDl) {
        if (stats.listFailures > 0 || items.get(itemId)?.downloadablesIncomplete || keep.size === 0) continue
        const dbRows = this.repo.listDownloadablesOfItem(itemId)
        const knownLinks = new Set(dbRows.map((r) => r.downloadableId))
        for (const d of keep) {
          if (!knownLinks.has(d)) log.info(`new link on existing item: link=#${d} item=#${itemId}`)
        }
        for (const downloadableId of retireMissingDownloadLinks(this.repo, this.history, itemId, keep)) {
          vanished++
          stats.changes.push({ itemId, label: `移除下载链接 #${downloadableId}` })
        }
      }
      stats.linksRemoved = vanished
      stats.listFailures += incompleteDownloadLists
      if (vanished > 0) log.info(`vanished downloadables archived: ${vanished}`)

      // 3) 完整检查本轮库内商品及本地免费商品。
      const detailTargets = [...new Set([...seen, ...freeIds])]
      stats.detailsTotal = detailTargets.length
      log.info(`detail refresh targets: ${detailTargets.length}`)
      for (let i = 0; i < detailTargets.length; i++) {
        if (i > 0 && i % 25 === 0) await new Promise<void>((done) => setImmediate(done))
        const itemId = detailTargets[i]
        this.onProgress?.({ phase: 'library', current: i + 1, total: detailTargets.length, label: `商品详情 ${itemId}` })
        // 初次建档并行取得 API 基线，HTML 仍由原路径直接刷新。
        if (initialRead) void initialRead(itemId).catch(() => {})
        try {
          const result = await this.refreshItem(itemId)
          if (result.notFound) {
            stats.notFound++
            stats.issues.push({ itemId, source: '详情页 404', reason: `商品 ${itemId} 不存在或已下架` })
            continue
          }
          if (initialRead) initialDetails.push(itemId)
          stats.detailsChecked++
          stats.imagesPending += result.imagesPending
          if (knownIds.has(itemId)) {
            if (result.changed) {
              summary.libraryChanged++
              const fields = [
                result.titleChanged && '标题',
                result.coverChanged && '封面',
                result.galleryChanged && `画廊（新增 ${result.galleryAdded}，移除 ${result.galleryRemoved}）`,
                result.descriptionChanged && '简介'
              ].filter(Boolean)
              stats.changes.push({ itemId, label: fields.join('、') + '变化' })
            }
            if (result.coverChanged) stats.coversChanged++
            if (result.galleryChanged) stats.galleriesChanged++
            if (result.descriptionChanged) stats.descriptionsChanged++
          }
        } catch (e) {
          if (isAuthError(e)) throw e
          const title = this.repo.getItemTitle(itemId)
          const itemDesc = `item=#${itemId}「${title.slice(0, 40)}」`
          const status = e instanceof BoothError && e.status != null ? ` http=${e.status}` : ''
          log.warn(`detail fetch failed: ${itemDesc}${status} → ${e instanceof Error ? e.message : e}`)
          stats.detailFailures++
          stats.issues.push({ itemId, source: '商品详情', reason: e instanceof Error ? e.message : String(e) })
          summary.failed++
        }
      }

      // 增量对账：补入队中断遗留的 pending 图片，并核对已下载图片与派生图文件（后台分页执行，不阻塞同步结束）
      this.images.checkAllImages().catch((e) => log.warn('image check failed:', e instanceof Error ? e.message : e))

      const fileBaselineRead = !initialRead && fileBaselines.size
        ? this.metadataChecks?.batchReader((id) => fileBaselines.has(id)) : undefined
      await this.prices?.refresh((label, current, total) => this.onProgress?.({ phase: 'library', current, total, label }),
        initialRead ?? fileBaselineRead)
      if (initialRead) await this.metadataChecks?.seedAfterSync(initialDetails, initialRead)
      const readBaseline = initialRead ?? fileBaselineRead
      if (readBaseline) {
        for (const id of fileBaselines) {
          await readBaseline(id).catch((error) => log.warn(`商品 #${id} 的 API 文件基线建立失败：`, error))
        }
      }
      if (stats.listFailures === 0) {
        const now = new Date().toISOString()
        const lastSync = this.repo.getSetting<string | null>('lastLibrarySyncAt', null)
        if (!this.repo.getSetting('firstLibrarySyncAt', null)) this.repo.setSetting('firstLibrarySyncAt', lastSync ?? now)
        this.repo.setSetting('lastLibrarySyncAt', now)
      }
      log.info(librarySummary(summary))
      log.info(`下载链接：新商品首次登记 ${stats.newItemLinks} 条，已有商品新增 ${stats.linksAdded} 条，修改 ${stats.linksChanged} 条，移除 ${stats.linksRemoved} 条`)
      for (const issue of stats.issues) {
        log.info(`${issue.itemId ? '#' + issue.itemId + ' · ' : ''}${issue.source} · ${issue.reason}`)
      }
      for (const change of stats.changes) log.info(`#${change.itemId} · ${change.label}`)
      return summary
    } finally {
      this.running = false
      this.onProgress?.({ phase: 'library', current: 0, total: 0 })
    }
  }

  /**
   * 深链商品不在本地库时的处理：不联网查购买/赠送列表（耗时），直接视为免费商品建库。
   * 抓取商店页信息建库并标记 is_free，同时登记深链所需的文件。
   * 若该商品实为新购，下次全局同步库时会出现在列表中，列表写入会自动清除免费标记。
   * 商店页抓取失败直接抛出，由调用方提示且不下载。
   */
  async importDeeplinkItem(itemId: number, files: Array<{ downloadableId: number; variationId: number | null; filename: string }>): Promise<void> {
    const detail = await this.itemPage.fetch(itemId)
    this.repo.upsertFromList({
      itemId,
      title: detail.title,
      thumbnailUrl: '',
      isGift: false,
      isFree: true,
      downloadables: files.map((f) => ({ downloadableId: f.downloadableId, variationId: f.variationId, filename: f.filename }))
    })
    this.applyDetail(itemId, detail)
    log.info(`deeplink item ${itemId}: marked free (not checked against library)`)
  }

  /**
   * 单商品元数据刷新：只抓该商品的商店页并写入详情（同 applyDetail 逻辑），
   * 不抓列表、不入队任何文件下载。对所有商品生效（含免费商品）。
   * 返回元数据是否有变化；抓取失败直接抛出。
   */
  async refreshItem(itemId: number): Promise<RefreshItemResult> {
    const existing = this.detailRefreshes.get(itemId)
    if (existing) return existing
    const request = this.fetchAndApplyDetail(itemId)
    this.detailRefreshes.set(itemId, request)
    try {
      return await request
    } finally {
      this.detailRefreshes.delete(itemId)
    }
  }

  private async fetchAndApplyDetail(itemId: number): Promise<RefreshItemResult> {
    try {
      const detail = await this.itemPage.fetch(itemId)
      if (this.stopped || !this.repo.getItemMetadataCheck(itemId)) throw new Error(`商品 ${itemId} 已离开资源库`)
      const result = this.applyDetail(itemId, detail)
      log.info(`refreshItem ${itemId}: ${JSON.stringify(result)}`)
      return result
    } catch (e) {
      if (!(e instanceof BoothError) || e.kind !== 'not_found') throw e
      if (!this.stopped) this.repo.markDetailNotFound(itemId)
      log.info(`refreshItem ${itemId}: not found on BOOTH (404)`)
      return { ...noDetailChange, notFound: true }
    }
  }

  private applyDetail(itemId: number, detail: ItemDetail): RefreshItemResult {
    const hash = metadataHashOf(detail)
    const prev = this.repo.getMetadataHash(itemId)
    const old = this.repo.getItemDetail(itemId)
    const titleChanged = old?.title !== detail.title
    const coverChanged = (old?.ogImageUrl ?? null) !== detail.ogImageUrl
    const descriptionChanged = normalizeHtml(old?.descriptionHtml ?? '') !== normalizeHtml(detail.descriptionHtml)
    const previousGallery = old?.galleryUrls ?? []
    const galleryChanged = JSON.stringify(previousGallery) !== JSON.stringify(detail.galleryUrls)
    const galleryAdded = detail.galleryUrls.filter((url) => !previousGallery.includes(url)).length
    const galleryRemoved = previousGallery.filter((url) => !detail.galleryUrls.includes(url)).length
    const changed = titleChanged || coverChanged || descriptionChanged || galleryChanged
    const snapshotNeeded = prev == null || titleChanged || coverChanged || descriptionChanged
    let snapshotSaved = false
    // 仅兼容已有详情但缺少历史的旧数据；正常更新的旧版本已在历史中，不再次写入。
    if (snapshotNeeded && prev != null && old?.descriptionHtml && !this.repo.getLatestSnapshot(itemId)) {
      this.history.writeMetadataSnapshot({
        itemId,
        title: old.title,
        descriptionHtml: old.descriptionHtml,
        ogImageUrl: old.ogImageUrl,
        galleryUrls: old.galleryUrls
      })
    }
    this.repo.updateDetail({
      itemId,
      title: detail.title,
      descriptionHtml: detail.descriptionHtml,
      ogImageUrl: detail.ogImageUrl,
      galleryUrls: detail.galleryUrls,
      shopName: detail.shopName,
      metadataHash: hash
    })
    if (snapshotNeeded) {
      snapshotSaved = this.history.writeMetadataSnapshot({
        itemId,
        title: detail.title,
        descriptionHtml: detail.descriptionHtml,
        ogImageUrl: detail.ogImageUrl,
        galleryUrls: detail.galleryUrls
      })
      log.info(`metadata changed: ${itemId} ${detail.title.slice(0, 40)}`)
    }
    // 图片本地化（og + 画廊）：登记后后台下载，文字更新不等图片
    const imgList: Array<{ url: string; kind: string }> = []
    if (detail.ogImageUrl) imgList.push({ url: detail.ogImageUrl, kind: 'og' })
    for (const u of detail.galleryUrls) imgList.push({ url: u, kind: 'gallery' })
    const imagesPending = imgList.length ? this.images.registerItemImages(itemId, imgList) ?? 0 : 0
    // 画廊远程移除标记（仅标记，不删除记录与本地文件）
    this.repo.syncGalleryRemoval(itemId, detail.galleryUrls)

    this.repo.upsertVideos(itemId, detail.videos)
    return { changed, titleChanged, coverChanged, descriptionChanged, galleryChanged, galleryAdded, galleryRemoved, snapshotSaved, imagesPending }
  }

  private dbAllItemIds(): number[] {
    return this.repo.listAllItemIds()
  }
}
