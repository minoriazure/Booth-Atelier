import type { LibraryCrawler } from '../booth/libraryCrawler'
import type { ItemPageParser } from '../booth/itemPageParser'
import { metadataHashOf, extractVideos } from '../booth/itemPageParser'
import type { LibraryRepo } from '../db/repos'
import type { HistoryManager } from './historyManager'
import type { ImageLocalizer } from './imageLocalizer'
import { existsSync } from 'fs'
import type { CheckProgressEvent, CheckSummary, ItemDetail } from '../../shared/types'
import { localDate } from '../util/filenames'
import { BoothError, isAuthError } from '../booth/errors'
import { createLogger, describeLink } from '../util/log'

const log = createLogger('librarySync')

/**
 * 库元数据同步（用户需求 #3 的"库更新"，与文件更新完全独立）：
 * - 抓列表页（购买+赠送）→ upsert items/downloadables，绝不入队任何文件下载
 * - 抓详情页 → 描述/宣传图/标题变化 → 写日期快照（历史备份）
 * - 详情页抓取节流：last_detail_at 超过 7 天 或 metadata 潜在变化才刷新
 */
export class LibrarySyncService {
  private running = false

  onProgress: ((e: CheckProgressEvent) => void) | null = null

  constructor(
    private crawler: LibraryCrawler,
    private itemPage: ItemPageParser,
    private repo: LibraryRepo,
    private history: HistoryManager,
    private images: ImageLocalizer,
    private opts: { detailStaleDays?: number } = {}
  ) {}

  get isRunning(): boolean {
    return this.running
  }

  async sync(forceDetail = false): Promise<CheckSummary> {
    if (this.running) throw new Error('同步已在进行中')
    this.running = true
    log.info(`library sync start (forceDetail=${forceDetail})`)
    const summary: CheckSummary = { libraryChecked: 0, libraryChanged: 0, filesChecked: 0, filesUpdated: 0, downloaded: 0, failed: 0 }
    try {
      // 1) 列表页
      this.onProgress?.({ phase: 'library', current: 0, total: 0, label: '抓取库列表…' })
      const seen = new Set<number>()
      const knownIds = new Set(this.dbAllItemIds())
      /** 商品 → 列表页当前提供的 downloadable 集合（检测消失的旧链接用） */
      const crawledDl = new Map<number, Set<number>>()
      const kinds: Array<'library' | 'gifts'> = ['library', 'gifts']
      for (const kind of kinds) {
        const items = await this.crawler.crawlKind(kind, (_k, page, count) => {
          log.info(`[${kind}] page ${page}: ${count} items`)
        })
        for (const it of items) {
          seen.add(it.itemId)
          if (!knownIds.has(it.itemId)) {
            log.info(`new item (${kind}): item=#${it.itemId}「${it.title.slice(0, 40)}」 links=${it.downloadables.length}`)
            for (const d of it.downloadables) log.info(`  - new link: link=#${d.downloadableId} file="${d.filename}"`)
          }
          crawledDl.set(it.itemId, new Set(it.downloadables.map((d) => d.downloadableId)))
          this.repo.upsertFromList({
            itemId: it.itemId,
            title: it.title,
            thumbnailUrl: it.thumbnailUrl,
            isGift: it.isGift,
            downloadables: it.downloadables.map((d) => ({
              downloadableId: d.downloadableId,
              variationId: d.variationId,
              filename: d.filename,
              fallbackUrl: d.fallbackUrl
            }))
          })
          summary.libraryChecked++
          // 缩略图立即登记（图片墙用），后台下载
          if (it.thumbnailUrl) {
            this.images.registerItemImages(it.itemId, [{ url: it.thumbnailUrl, kind: 'thumb' }])
          }
        }
      }

      // 2) 缺席检测（连续 2 次缺席 → missing）；免费商品不在列表中属正常，跳过
      const allIds = this.dbAllItemIds()
      const freeIds = new Set(this.repo.listFreeItemIds())
      for (const id of allIds) {
        if (!seen.has(id) && !freeIds.has(id)) {
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
        if (keep.size === 0) continue // 列表解析异常，跳过判定
        const dbRows = this.repo.listDownloadablesOfItem(itemId)
        const knownLinks = new Set(dbRows.map((r) => r.downloadableId))
        for (const d of keep) {
          if (!knownLinks.has(d)) log.info(`new link on existing item: link=#${d} item=#${itemId}`)
        }
        for (const row of dbRows) {
          if (row.status === 'missing' || keep.has(row.downloadableId)) continue
          const desc = describeLink(row)
          if (row.localPath && existsSync(row.localPath)) {
            const archived = this.history.archivePath(itemId, row.localPath)
            if (archived) {
              this.repo.addFileHistory({
                itemId,
                downloadableId: row.downloadableId,
                date: localDate(),
                archivedPath: archived,
                filename: row.localPath.split(/[\/]/).pop() || row.filename,
                etag: row.lastEtag,
                size: row.lastSize
              })
              log.info(`vanished link (old file archived): ${desc} → ${archived}`)
            }
          } else {
            log.info(`vanished link (no local file): ${desc}`)
          }
          this.repo.setStatus(row.downloadableId, 'missing')
          this.repo.run('UPDATE downloadables SET local_path = NULL, local_size = NULL WHERE downloadable_id = ?', [row.downloadableId])
          vanished++
        }
      }
      if (vanished > 0) log.info(`vanished downloadables archived: ${vanished}`)

      // 3) 详情页刷新（节流）；免费商品的介绍随同步库更新，文件不在此处理
      const staleDays = this.opts.detailStaleDays ?? 7
      const detailTargets = this.pickDetailTargets([...Array.from(seen), ...freeIds], staleDays, forceDetail)
      log.info(`detail refresh targets: ${detailTargets.length}`)
      for (let i = 0; i < detailTargets.length; i++) {
        const itemId = detailTargets[i]
        this.onProgress?.({ phase: 'library', current: i + 1, total: detailTargets.length, label: `商品详情 ${itemId}` })
        try {
          const detail = await this.itemPage.fetch(itemId)
          if (this.applyDetail(itemId, detail)) summary.libraryChanged++
        } catch (e) {
          if (isAuthError(e)) throw e
          const title = this.repo.getItemTitle(itemId)
          const itemDesc = `item=#${itemId}「${title.slice(0, 40)}」`
          if (e instanceof BoothError && e.kind === 'not_found') {
            this.repo.run(`UPDATE items SET status = 'missing' WHERE item_id = ?`, [itemId])
            log.info(`${itemDesc} not found on BOOTH (404), marked missing`)
            continue
          }
          const status = e instanceof BoothError && e.status != null ? ` http=${e.status}` : ''
          log.warn(`detail fetch failed: ${itemDesc}${status} → ${e instanceof Error ? e.message : e}`)
          summary.failed++
        }
      }

      // 把历史遗留的 pending 图片重新入队（含旧商品缩略图）
      this.images.requeuePending()

      this.repo.setSetting('lastLibrarySyncAt', new Date().toISOString())
      log.info(`library sync done: ${JSON.stringify(summary)}`)
      return summary
    } finally {
      this.running = false
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
      thumbnailUrl: detail.ogImageUrl ?? '',
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
  async refreshItem(itemId: number): Promise<{ changed: boolean }> {
    const detail = await this.itemPage.fetch(itemId)
    const changed = this.applyDetail(itemId, detail)
    log.info(`refreshItem ${itemId}: ${changed ? 'changed' : 'unchanged'}`)
    return { changed }
  }

  /** 写入详情字段（变化时备份旧版本并写新快照）+ 登记图片与视频；返回元数据是否变化 */
  private applyDetail(itemId: number, detail: ItemDetail): boolean {
    const hash = metadataHashOf(detail)
    const prev = this.repo.getMetadataHash(itemId)
    const changed = prev !== hash
    if (changed) {
      // 变化前先备份旧版本（若从未快照过，把当前库里存的旧描述作为首个快照）
      if (prev != null) {
        const old = this.repo.getItemDetail(itemId)
        if (old && old.descriptionHtml) {
          this.history.writeMetadataSnapshot({
            itemId,
            title: old.title,
            descriptionHtml: old.descriptionHtml,
            ogImageUrl: old.ogImageUrl,
            galleryUrls: old.galleryUrls
          })
        }
      }
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
    if (changed) {
      // 新版本快照
      this.history.writeMetadataSnapshot({
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
    if (imgList.length) this.images.registerItemImages(itemId, imgList)

    // 视频登记（描述里内嵌的 iframe/链接）
    const vids = extractVideos(detail.descriptionHtml)
    if (vids.length) {
      this.repo.upsertVideos(
        vids.map((v) => ({ key: v.key, itemId, platform: v.platform, videoId: v.videoId, url: v.url, embedUrl: v.embedUrl }))
      )
    }
    return changed
  }

  private dbAllItemIds(): number[] {
    return this.repo.listAllItemIds()
  }

  /** 选需要刷新详情的商品：强制 / 超龄 / 列表缩略图或标题变化的启发式（此处简单用超龄+新商品） */
  private pickDetailTargets(ids: number[], staleDays: number, force: boolean): number[] {
    const cutoff = Date.now() - staleDays * 86400_000
    const out: number[] = []
    for (const id of ids) {
      if (force) {
        out.push(id)
        continue
      }
      const last = this.repo.getLastDetailAt(id)
      if (!last) {
        out.push(id) // 从未抓过详情
        continue
      }
      const t = Date.parse(last.replace(' ', 'T') + 'Z')
      if (isNaN(t) || t < cutoff) out.push(id)
    }
    return out
  }
}
