import type { Db } from './database'
import type { Paths } from '../util/paths'
import type {
  DownloadableFileRow,
  DownloadableStatus,
  ItemDetailRow,
  ItemSummary,
  SnapshotEntry,
  FileHistoryEntry,
  FileHistoryGroup
} from '../../shared/types'

/** 商品图片引用（rid 为 item_images 的 rowid，用于游标分页） */
export interface ImageRef {
  rid: number
  url: string
  itemId: number
  kind: string
  filename: string
}

/** 派生图（缩略图/预览图）就绪状态 */
export type DerivStatus = 'ok' | 'missing' | 'unknown'

/** items + downloadables 读写 */
export class LibraryRepo {
  /** paths 用于 local_path 的相对存储：写入转相对，读取还原绝对（旧版绝对路径仍兼容） */
  constructor(
    private db: Db,
    private paths?: Paths
  ) {}

  private downloadLocalOut(p: string | null | undefined): string | null {
    if (!p) return null
    return this.paths ? this.paths.resolveLocal(p) : p
  }

  private downloadLocalIn(abs: string): string {
    return this.paths ? this.paths.toStoredLocal(abs) : abs
  }

  private dataLocalOut(p: string | null | undefined): string | null {
    if (!p) return null
    return this.paths ? this.paths.resolveDataLocal(p) : p
  }

  private dataLocalIn(abs: string): string {
    return this.paths ? this.paths.toStoredDataLocal(abs) : abs
  }

  /** 列表页同步：upsert 商品基础字段（不覆盖详情字段）；isFree 仅用于深链建立的免费商品 */
  upsertFromList(input: {
    itemId: number
    title: string
    thumbnailUrl: string
    isGift: boolean
    isFree?: boolean
    downloadables: Array<{ downloadableId: number; variationId: number | null; filename: string; fallbackUrl?: string }>
  }): void {
    const existing = this.db.get<{ item_id: number; metadata_hash: string | null }>(
      'SELECT item_id, metadata_hash FROM items WHERE item_id = ?',
      [input.itemId]
    )
    const isFree = input.isFree ? 1 : 0
    if (!existing) {
      this.db.run(
        `INSERT INTO items (item_id, title, thumbnail_url, is_gift, is_free, item_url, last_list_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [input.itemId, input.title, input.thumbnailUrl, input.isGift ? 1 : 0, isFree, `https://booth.pm/zh-cn/items/${input.itemId}`]
      )
    } else {
      this.db.run(
        `UPDATE items SET title = ?, thumbnail_url = ?, is_gift = ?, is_free = ?, last_list_at = datetime('now'), status = 'active', absent_count = 0 WHERE item_id = ?`,
        [input.title, input.thumbnailUrl, input.isGift ? 1 : 0, isFree, input.itemId]
      )
    }
    for (const d of input.downloadables) {
      const dExists = this.db.get('SELECT downloadable_id FROM downloadables WHERE downloadable_id = ?', [d.downloadableId])
      if (!dExists) {
        this.db.run(
          `INSERT INTO downloadables (downloadable_id, item_id, filename, variation_id, fallback_url) VALUES (?, ?, ?, ?, ?)`,
          [d.downloadableId, input.itemId, d.filename, d.variationId, d.fallbackUrl ?? null]
        )
      } else {
        this.db.run(
          `UPDATE downloadables SET filename = COALESCE(NULLIF(?, ''), filename), variation_id = COALESCE(?, variation_id), fallback_url = COALESCE(?, fallback_url) WHERE downloadable_id = ?`,
          [d.filename, d.variationId, d.fallbackUrl ?? null, d.downloadableId]
        )
      }
    }
  }

  /** 详情页同步：写入描述/宣传图/店铺并更新哈希 */
  updateDetail(input: {
    itemId: number
    title: string
    descriptionHtml: string
    ogImageUrl: string | null
    galleryUrls: string[]
    shopName: string | null
    metadataHash: string
  }): void {
    this.db.run(
      `UPDATE items SET title = ?, description_html = ?, og_image_url = ?, gallery_json = ?,
        shop_name = COALESCE(?, shop_name), metadata_hash = ?, last_detail_at = datetime('now'), status = 'active', absent_count = 0
       WHERE item_id = ?`,
      [input.title, input.descriptionHtml, input.ogImageUrl, JSON.stringify(input.galleryUrls), input.shopName, input.metadataHash, input.itemId]
    )
    this.reindexFts(input.itemId)
  }

  touchList(itemId: number): void {
    this.db.run(`UPDATE items SET last_list_at = datetime('now'), status = 'active', absent_count = 0 WHERE item_id = ?`, [itemId])
  }

  /** 标记缺席（连续 2 次后置 missing） */
  /** 商品标题（仅用于日志；不存在时返回空串） */
  getItemTitle(itemId: number): string {
    return this.db.get<{ title: string }>('SELECT title FROM items WHERE item_id = ?', [itemId])?.title ?? ''
  }

  markAbsent(itemId: number): 'active' | 'missing' {
    this.db.run(`UPDATE items SET absent_count = absent_count + 1 WHERE item_id = ?`, [itemId])
    const row = this.db.get<{ absent_count: number; status: string }>('SELECT absent_count, status FROM items WHERE item_id = ?', [itemId])
    if (row && row.absent_count >= 2 && row.status !== 'missing') {
      this.db.run(`UPDATE items SET status = 'missing' WHERE item_id = ?`, [itemId])
      return 'missing'
    }
    return (row?.status as 'active' | 'missing') ?? 'active'
  }

  /** 底层 SQL 直通（服务层专用更新语句） */
  run(sql: string, params: unknown[] = []): number {
    return this.db.run(sql, params)
  }

  listAllItemIds(): number[] {
    return this.db.all<{ item_id: number }>('SELECT item_id FROM items').map((r) => r.item_id)
  }

  listFreeItemIds(): number[] {
    return this.db.all<{ item_id: number }>('SELECT item_id FROM items WHERE is_free = 1').map((r) => r.item_id)
  }

  isFreeItem(itemId: number): boolean {
    return this.db.get<{ is_free: number }>('SELECT is_free FROM items WHERE item_id = ?', [itemId])?.is_free === 1
  }

  getMetadataHash(itemId: number): string | null {
    return this.db.get<{ metadata_hash: string | null }>('SELECT metadata_hash FROM items WHERE item_id = ?', [itemId])?.metadata_hash ?? null
  }

  getLastDetailAt(itemId: number): string | null {
    return this.db.get<{ last_detail_at: string | null }>('SELECT last_detail_at FROM items WHERE item_id = ?', [itemId])?.last_detail_at ?? null
  }

  listSummaries(q?: string): ItemSummary[] {
    const where = q ? 'WHERE (i.title LIKE ? OR i.shop_name LIKE ?)' : ''
    const params = q ? [`%${q}%`, `%${q}%`] : []
    return this.db.all<ItemSummary>(
      `SELECT i.item_id AS itemId, i.title AS title, i.shop_name AS shopName, COALESCE(NULLIF(i.thumbnail_url, ''), i.og_image_url) AS thumbnailUrl,
              i.is_gift AS isGift, i.is_free AS isFree, i.status AS status,
              COUNT(d.downloadable_id) AS fileTotal,
              SUM(CASE WHEN d.status = 'downloaded' THEN 1 ELSE 0 END) AS fileDownloaded,
              SUM(CASE WHEN d.status = 'update_available' THEN 1 ELSE 0 END) AS fileUpdateAvailable
       FROM items i LEFT JOIN downloadables d ON d.item_id = i.item_id
       ${where}
       GROUP BY i.item_id ORDER BY i.last_list_at DESC, i.item_id DESC`,
      params
    ).map(boolifyItem)
  }

  getItemDetail(itemId: number): ItemDetailRow | undefined {
    const i = this.db.get<Record<string, unknown>>(
      `SELECT item_id, title, shop_name, thumbnail_url, og_image_url, description_html, gallery_json, item_url, is_gift, is_free, status, metadata_hash
       FROM items WHERE item_id = ?`,
      [itemId]
    )
    if (!i) return undefined
    const files = this.db.all<DownloadableFileRow>(
      `SELECT downloadable_id AS downloadableId, item_id AS itemId, filename, variation_id AS variationId, status,
              local_path AS localPath, local_size AS localSize, last_size AS lastSize, last_etag AS lastEtag,
              last_checked_at AS lastCheckedAt
       FROM downloadables WHERE item_id = ? ORDER BY downloadable_id`,
      [itemId]
    )
    const counts = this.db.get<{ total: number; downloaded: number; updates: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'downloaded' THEN 1 ELSE 0 END) AS downloaded,
              SUM(CASE WHEN status = 'update_available' THEN 1 ELSE 0 END) AS updates
       FROM downloadables WHERE item_id = ?`,
      [itemId]
    )
    return {
      itemId,
      title: String(i.title ?? ''),
      shopName: (i.shop_name as string) ?? null,
      thumbnailUrl: (i.thumbnail_url as string) ?? null,
      isGift: Number(i.is_gift) === 1,
      isFree: Number(i.is_free) === 1,
      status: (i.status as 'active' | 'missing') ?? 'active',
      itemUrl: String(i.item_url ?? ''),
      ogImageUrl: (i.og_image_url as string) ?? null,
      descriptionHtml: String(i.description_html ?? ''),
      galleryUrls: safeJsonArray(i.gallery_json),
      fileTotal: counts?.total ?? files.length,
      fileDownloaded: counts?.downloaded ?? 0,
      fileUpdateAvailable: counts?.updates ?? 0,
      downloadables: files.map((f) => ({ ...f, localPath: this.downloadLocalOut(f.localPath) })),
      localThumb: null, // 由上层（组装 media URL）填充
      localGallery: [],
      videos: []
    }
  }

  listAllDownloadables(limit?: number): Array<{ downloadableId: number; itemId: number; itemTitle: string; filename: string; variationId: number | null; status: string; lastEtag: string | null; lastSize: number | null; localPath: string | null }> {
    type Row = { downloadableId: number; itemId: number; itemTitle: string; filename: string; variationId: number | null; status: string; lastEtag: string | null; lastSize: number | null; localPath: string | null }
    const rows = this.db.all<Row>(
      `SELECT d.downloadable_id AS downloadableId, d.item_id AS itemId, COALESCE(i.title, '') AS itemTitle, d.filename, d.variation_id AS variationId,
              d.status, d.last_etag AS lastEtag, d.last_size AS lastSize, d.local_path AS localPath
       FROM downloadables d
       LEFT JOIN items i ON i.item_id = d.item_id
       WHERE d.status != 'missing' AND d.item_id NOT IN (SELECT item_id FROM items WHERE is_free = 1)
       ORDER BY d.item_id, d.downloadable_id ${limit ? 'LIMIT ' + limit : ''}`
    )
    return rows.map((r) => ({ ...r, localPath: this.downloadLocalOut(r.localPath) }))
  }

  /** 标记入队（持久化，重启后恢复） */
  setQueuedAt(downloadableId: number, at: string | null): void {
    this.db.run('UPDATE downloadables SET queued_at = ? WHERE downloadable_id = ?', [at, downloadableId])
  }

  /** 排队/下载中的任务（按入队顺序，重启恢复用） */
  listQueuedIds(): number[] {
    return this.db
      .all<{ downloadable_id: number }>(
        `SELECT downloadable_id FROM downloadables WHERE queued_at IS NOT NULL ORDER BY queued_at, downloadable_id`
      )
      .map((r) => r.downloadable_id)
  }

  /**
   * 待下载：remote / update_available、未排队、最近一次下载未失败。
   * 已完成（downloaded）与失败（failed）都不在此列——「开始全部」只动这里。
   */
  listPendingIds(): number[] {
    return this.db
      .all<{ downloadable_id: number }>(
        `SELECT d.downloadable_id FROM downloadables d
         WHERE d.status IN ('remote', 'update_available')
           AND d.queued_at IS NULL
           AND d.status != 'missing'
           AND d.item_id NOT IN (SELECT item_id FROM items WHERE is_free = 1)
           AND NOT EXISTS (
             SELECT 1 FROM download_records r
             WHERE r.downloadable_id = d.downloadable_id
               AND r.status = 'failed'
               AND r.id = (SELECT MAX(id) FROM download_records WHERE downloadable_id = d.downloadable_id)
           )
         ORDER BY d.item_id DESC, d.downloadable_id`
      )
      .map((r) => r.downloadable_id)
  }

  /**
   * 本地文件缺失（根目录存在但文件不在）：回到待下载，但保留远端指纹（last_size/last_etag），
   * 目录恢复后可被重新识别，不会丢失已有信息。
   */
  releaseMissingLocal(downloadableId: number): void {
    this.db.run(
      `UPDATE downloadables SET status = 'remote', local_path = NULL, local_size = NULL WHERE downloadable_id = ?`,
      [downloadableId]
    )
  }

  /** 全文件列表（含最近下载记录状态、队列/活动状态由 DownloadManager 运行时合并） */
  listAllFileRows(): Array<{
    downloadableId: number
    itemId: number
    itemTitle: string
    filename: string
    status: string
    localPath: string | null
    localSize: number | null
    lastSize: number | null
    failed: boolean
    lastError: string | null
    queuedAt: string | null
  }> {
    const rows = this.db.all<{
      downloadableId: number
      itemId: number
      itemTitle: string
      filename: string
      status: string
      localPath: string | null
      localSize: number | null
      lastSize: number | null
      failed: number
      lastError: string | null
      queuedAt: string | null
    }>(
      `SELECT d.downloadable_id AS downloadableId, d.item_id AS itemId, i.title AS itemTitle,
              d.filename, d.status, d.local_path AS localPath, d.local_size AS localSize, d.last_size AS lastSize,
              CASE WHEN (SELECT r.status FROM download_records r WHERE r.downloadable_id = d.downloadable_id ORDER BY r.id DESC LIMIT 1) = 'failed' THEN 1 ELSE 0 END AS failed,
              d.queued_at AS queuedAt,
              (SELECT r.error FROM download_records r WHERE r.downloadable_id = d.downloadable_id ORDER BY r.id DESC LIMIT 1) AS lastError
       FROM downloadables d
       JOIN items i ON i.item_id = d.item_id
       ORDER BY d.item_id DESC, d.downloadable_id`
    )
    return rows.map((r) => ({ ...r, failed: Number(r.failed) === 1, localPath: this.downloadLocalOut(r.localPath) }))
  }

  /** 最近一次下载记录为 failed 的 downloadable（全局重试用） */
  listFailedDownloadableIds(): number[] {
    return this.db
      .all<{ downloadable_id: number }>(
        `SELECT r.downloadable_id FROM download_records r
         WHERE r.status = 'failed'
           AND r.id = (SELECT MAX(id) FROM download_records WHERE downloadable_id = r.downloadable_id)
           AND r.downloadable_id IN (SELECT downloadable_id FROM downloadables WHERE status != 'missing')`
      )
      .map((r) => r.downloadable_id)
  }

  listDownloadablesOfItem(itemId: number): Array<{ downloadableId: number; itemId: number; itemTitle: string; filename: string; variationId: number | null; status: string; lastEtag: string | null; lastSize: number | null; localPath: string | null }> {
    const rows = this.db.all<{ downloadableId: number; itemId: number; itemTitle: string; filename: string; variationId: number | null; status: string; lastEtag: string | null; lastSize: number | null; localPath: string | null }>(
      `SELECT d.downloadable_id AS downloadableId, d.item_id AS itemId, COALESCE(i.title, '') AS itemTitle, d.filename, d.variation_id AS variationId,
              d.status, d.last_etag AS lastEtag, d.last_size AS lastSize, d.local_path AS localPath
       FROM downloadables d
       LEFT JOIN items i ON i.item_id = d.item_id
       WHERE d.item_id = ? AND d.status != 'missing' ORDER BY d.downloadable_id`,
      [itemId]
    )
    return rows.map((r) => ({ ...r, localPath: this.downloadLocalOut(r.localPath) }))
  }

  getDownloadable(downloadableId: number): { downloadableId: number; itemId: number; filename: string; variationId: number | null; status: DownloadableStatus; localPath: string | null; lastEtag: string | null; lastSize: number | null; fallbackUrl: string | null } | undefined {
    const r = this.db.get<{ downloadableId: number; itemId: number; filename: string; variationId: number | null; status: DownloadableStatus; localPath: string | null; lastEtag: string | null; lastSize: number | null; fallbackUrl: string | null }>(
      `SELECT downloadable_id AS downloadableId, item_id AS itemId, filename, variation_id AS variationId,
              status, local_path AS localPath, last_etag AS lastEtag, last_size AS lastSize, fallback_url AS fallbackUrl
       FROM downloadables WHERE downloadable_id = ?`,
      [downloadableId]
    )
    if (!r) return undefined
    return { ...r, localPath: this.downloadLocalOut(r.localPath) }
  }

  updateFingerprint(downloadableId: number, fp: { etag: string | null; size: number | null; lastModified: string | null; filename?: string }): void {
    this.db.run(
      `UPDATE downloadables SET last_etag = ?, last_size = ?, last_modified_remote = ?,
        last_checked_at = datetime('now'), filename = COALESCE(?, filename)
       WHERE downloadable_id = ?`,
      [fp.etag, fp.size, fp.lastModified, fp.filename ?? null, downloadableId]
    )
  }

  /** localPath 为绝对路径，入库时转为相对下载根的存储值 */
  markDownloaded(downloadableId: number, localPath: string, localSize: number): void {
    this.db.run(
      `UPDATE downloadables SET status = 'downloaded', local_path = ?, local_size = ?, last_checked_at = datetime('now') WHERE downloadable_id = ?`,
      [this.downloadLocalIn(localPath), localSize, downloadableId]
    )
  }

  setStatus(downloadableId: number, status: DownloadableStatus): void {
    this.db.run(`UPDATE downloadables SET status = ? WHERE downloadable_id = ?`, [status, downloadableId])
  }

  updateFilename(downloadableId: number, filename: string): void {
    this.db.run(`UPDATE downloadables SET filename = ? WHERE downloadable_id = ?`, [filename, downloadableId])
  }

  // ---- 快照 / 文件历史 / 下载记录 ----

  addSnapshot(s: {
    itemId: number
    date: string
    title: string
    descriptionHtml: string
    ogImageUrl: string | null
    galleryUrls: string[]
  }): void {
    this.db.run(
      `INSERT INTO metadata_snapshots (item_id, snapshot_date, title, description_html, og_image_url, gallery_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [s.itemId, s.date, s.title, s.descriptionHtml, s.ogImageUrl, JSON.stringify(s.galleryUrls)]
    )
  }

  listSnapshotDates(itemId: number): SnapshotEntry[] {
    return this.db.all<SnapshotEntry>(
      `SELECT id, snapshot_date AS snapshotDate, captured_at AS capturedAt, title
       FROM metadata_snapshots WHERE item_id = ? ORDER BY id DESC`,
      [itemId]
    )
  }

  getSnapshotById(id: number): (SnapshotEntry & { descriptionHtml: string; ogImageUrl: string | null; galleryJson: string; itemId: number }) | undefined {
    return this.db.get(
      `SELECT id, item_id AS itemId, snapshot_date AS snapshotDate, captured_at AS capturedAt, title,
              description_html AS descriptionHtml, og_image_url AS ogImageUrl, gallery_json AS galleryJson
       FROM metadata_snapshots WHERE id = ?`,
      [id]
    )
  }

  /** 取 ≤ date 的最新快照 */
  getSnapshotAsOf(itemId: number, date: string): { snapshotDate: string; title: string; descriptionHtml: string; ogImageUrl: string | null; galleryJson: string } | undefined {
    return this.db.get(
      `SELECT snapshot_date AS snapshotDate, title, description_html AS descriptionHtml, og_image_url AS ogImageUrl, gallery_json AS galleryJson
       FROM metadata_snapshots WHERE item_id = ? AND snapshot_date <= ? ORDER BY snapshot_date DESC, id DESC LIMIT 1`,
      [itemId, date]
    )
  }

  addFileHistory(h: {
    itemId: number
    downloadableId: number
    date: string
    archivedPath: string
    filename: string
    etag: string | null
    size: number | null
  }): void {
    this.db.run(
      `INSERT INTO file_history (item_id, downloadable_id, archived_date, archived_path, filename, etag, size)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [h.itemId, h.downloadableId, h.date, h.archivedPath, h.filename, h.etag, h.size]
    )
  }

  listFileHistoryDates(itemId: number): FileHistoryEntry[] {
    return this.db.all<FileHistoryEntry>(
      `SELECT archived_date AS archivedDate, archived_at AS archivedAt, archived_path AS archivedPath, filename, size
       FROM file_history WHERE item_id = ? ORDER BY archived_at DESC, id DESC`,
      [itemId]
    )
  }

  /** 按归档秒分组（同一秒归档的文件为一组），新的在前 */
  listFileHistoryGroups(itemId: number): FileHistoryGroup[] {
    return this.db.all<FileHistoryGroup>(
      `SELECT archived_at AS archivedAt, COUNT(*) AS count FROM file_history
       WHERE item_id = ? GROUP BY archived_at ORDER BY archived_at DESC`,
      [itemId]
    )
  }

  listFilesAtArchive(itemId: number, archivedAt: string): FileHistoryEntry[] {
    return this.db.all<FileHistoryEntry>(
      `SELECT archived_date AS archivedDate, archived_at AS archivedAt, archived_path AS archivedPath, filename, size
       FROM file_history WHERE item_id = ? AND archived_at = ? ORDER BY filename`,
      [itemId, archivedAt]
    )
  }

  addDownloadRecord(r: {
    downloadableId: number
    itemId: number
    source: string
    status: string
    bytesTotal?: number | null
    bytesDone?: number | null
    error?: string | null
    toPath?: string | null
    etag?: string | null
    size?: number | null
  }): number {
    this.db.run(
      `INSERT INTO download_records (downloadable_id, item_id, source, status, bytes_total, bytes_done, error, to_path, etag_at_download, size_at_download, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IN ('done','failed','cancelled','skipped') THEN datetime('now') ELSE NULL END)`,
      [r.downloadableId, r.itemId, r.source, r.status, r.bytesTotal ?? null, r.bytesDone ?? null, r.error ?? null, r.toPath ?? null, r.etag ?? null, r.size ?? null, r.status]
    )
    const row = this.db.get<{ id: number }>('SELECT last_insert_rowid() AS id')
    return row?.id ?? 0
  }

  listDownloadRecords(limit = 100): Array<Record<string, unknown>> {
    return this.db.all(
      `SELECT r.id, r.downloadable_id AS downloadableId, r.item_id AS itemId, i.title AS itemTitle, d.filename,
              r.source, r.status, r.started_at AS startedAt, r.finished_at AS finishedAt,
              r.bytes_total AS bytesTotal, r.bytes_done AS bytesDone, r.error, r.to_path AS toPath
       FROM download_records r
       LEFT JOIN items i ON i.item_id = r.item_id
       LEFT JOIN downloadables d ON d.downloadable_id = r.downloadable_id
       ORDER BY r.id DESC LIMIT ?`,
      [limit]
    )
  }

  listUpdatesAvailable(): Array<Record<string, unknown>> {
    const rows = this.db.all<Record<string, unknown> & { localPath: string | null }>(
      `SELECT d.downloadable_id AS downloadableId, d.item_id AS itemId, i.title AS itemTitle, d.filename,
              d.last_size AS lastSize, d.last_etag AS lastEtag, d.local_path AS localPath, d.status
       FROM downloadables d JOIN items i ON i.item_id = d.item_id
       WHERE d.status = 'update_available' ORDER BY d.item_id`
    )
    return rows.map((r) => ({ ...r, localPath: this.downloadLocalOut(r.localPath) }))

  }

  setSetting(key: string, value: unknown): void {
    const json = JSON.stringify(value)
    this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, json])
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  private reindexFts(itemId: number): void {
    const i = this.db.get<{ title: string; shop_name: string | null; description_html: string }>(
      'SELECT title, shop_name, description_html FROM items WHERE item_id = ?',
      [itemId]
    )
    if (!i) return
    const text = stripHtml(i.description_html).slice(0, 5000)
    this.db.run('DELETE FROM items_search WHERE item_id = ?', [itemId])
    this.db.run('INSERT INTO items_search (item_id, title, shop_name, description_text) VALUES (?, ?, ?, ?)', [
      itemId,
      i.title,
      i.shop_name ?? '',
      text
    ])
  }

  search(q: string): ItemSummary[] {
    const like = `%${q}%`
    // items 表为主（列表同步即有标题），items_search 补充描述匹配
    const hits = this.db.all<{ item_id: number }>(
      `SELECT item_id FROM items WHERE title LIKE ? OR shop_name LIKE ? LIMIT 200`,
      [like, like]
    )
    const ids = new Set(hits.map((r) => r.item_id))
    const descHits = this.db.all<{ item_id: number }>(
      `SELECT item_id FROM items_search WHERE description_text LIKE ? LIMIT 200`,
      [like]
    )
    for (const r of descHits) ids.add(r.item_id)
    if (ids.size === 0) return []
    const list = Array.from(ids)
    const placeholders = list.map(() => '?').join(',')
    return this.db.all<ItemSummary>(
      `SELECT i.item_id AS itemId, i.title AS title, i.shop_name AS shopName, COALESCE(NULLIF(i.thumbnail_url, ''), i.og_image_url) AS thumbnailUrl,
              i.is_gift AS isGift, i.is_free AS isFree, i.status AS status,
              COUNT(d.downloadable_id) AS fileTotal,
              SUM(CASE WHEN d.status = 'downloaded' THEN 1 ELSE 0 END) AS fileDownloaded,
              SUM(CASE WHEN d.status = 'update_available' THEN 1 ELSE 0 END) AS fileUpdateAvailable
       FROM items i LEFT JOIN downloadables d ON d.item_id = i.item_id
       WHERE i.item_id IN (${placeholders})
       GROUP BY i.item_id ORDER BY i.title`,
      list
    ).map(boolifyItem)
  }

  /** 协议唤起时的最小登记：商品/链接不存在则建占位行（同步时会被补全） */
  ensureAdhoc(input: { itemId: number; downloadableId: number; filename: string; variationId: number | null }): void {
    const item = this.db.get('SELECT item_id FROM items WHERE item_id = ?', [input.itemId])
    if (!item) {
      this.db.run(
        `INSERT INTO items (item_id, title, item_url, status, last_list_at) VALUES (?, ?, ?, 'active', datetime('now'))`,
        [input.itemId, `商品 #${input.itemId}（待同步）`, `https://booth.pm/zh-cn/items/${input.itemId}`]
      )
    }
    const dl = this.db.get('SELECT downloadable_id FROM downloadables WHERE downloadable_id = ?', [input.downloadableId])
    if (!dl) {
      this.db.run(
        `INSERT INTO downloadables (downloadable_id, item_id, filename, variation_id) VALUES (?, ?, ?, ?)`,
        [input.downloadableId, input.itemId, input.filename, input.variationId]
      )
    } else if (input.variationId != null) {
      this.db.run(`UPDATE downloadables SET variation_id = COALESCE(variation_id, ?) WHERE downloadable_id = ?`, [
        input.variationId,
        input.downloadableId
      ])
    }
  }

  // ── 商品图片（抓库时自动下载本地化） ──

  /** 批量登记图片（已存在则保留状态，仅在 URL 变化时重置为 pending） */
  upsertImages(rows: Array<{ url: string; itemId: number; kind: string; filename: string }>): void {
    for (const r of rows) {
      const existing = this.db.get<{ status: string; filename: string }>(
        'SELECT status, filename FROM item_images WHERE url = ?',
        [r.url]
      )
      if (!existing) {
        this.db.run(
          `INSERT INTO item_images (url, item_id, kind, filename, status, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
          [r.url, r.itemId, r.kind, r.filename, 'pending']
        )
      } else if (existing.filename !== r.filename) {
        // 文件名变化意味着派生图路径也变了，派生状态一并重置为未知
        this.db.run(
          `UPDATE item_images SET filename = ?, status = 'pending', thumb_status = 'unknown', preview_status = 'unknown', derivative_attempts = 0, derivative_error = NULL, updated_at = datetime('now') WHERE url = ?`,
          [r.filename, r.url]
        )
      }
    }
  }

  markImageDone(url: string, bytes: number): void {
    this.db.run(`UPDATE item_images SET status = 'done', bytes = ?, updated_at = datetime('now') WHERE url = ?`, [bytes, url])
  }

  markImageFailed(url: string): void {
    this.db.run(`UPDATE item_images SET status = 'failed', updated_at = datetime('now') WHERE url = ?`, [url])
  }

  /**
   * 派生图候选（按 rowid 游标分页，启动回填与优先级队列共用）：
   * 已下载、缩略图或预览图未确认就绪、失败次数未达上限。
   */
  listDerivativeCandidates(afterRowid: number, limit: number): ImageRef[] {
    return this.db.all(
      `SELECT rowid AS rid, url, item_id AS itemId, kind, filename FROM item_images
       WHERE status = 'done' AND derivative_attempts < 3
         AND (thumb_status != 'ok' OR preview_status != 'ok') AND rowid > ?
       ORDER BY rowid LIMIT ?`,
      [afterRowid, limit]
    )
  }

  /** 某商品的派生图候选（用于可见卡片优先生成） */
  listDerivativeCandidatesByItem(itemId: number): ImageRef[] {
    return this.db.all(
      `SELECT rowid AS rid, url, item_id AS itemId, kind, filename FROM item_images
       WHERE status = 'done' AND derivative_attempts < 3
         AND (thumb_status != 'ok' OR preview_status != 'ok') AND item_id = ?
       ORDER BY rowid`,
      [itemId]
    )
  }

  /** 对账用：已下载完成的行分页（按 rowid）；传 itemId 时只取该商品 */
  listDoneImagePage(
    afterRowid: number,
    limit: number,
    itemId?: number
  ): Array<ImageRef & { thumbStatus: string; previewStatus: string }> {
    return this.db.all(
      `SELECT rowid AS rid, url, item_id AS itemId, kind, filename,
              thumb_status AS thumbStatus, preview_status AS previewStatus
       FROM item_images WHERE status = 'done' AND rowid > ? AND (? IS NULL OR item_id = ?)
       ORDER BY rowid LIMIT ?`,
      [afterRowid, itemId ?? null, itemId ?? null, limit]
    )
  }

  /** 对账进度总数：已下载完成的行数，可按商品过滤 */
  countDoneImages(itemId?: number): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM item_images WHERE status = 'done' AND (? IS NULL OR item_id = ?)`,
      [itemId ?? null, itemId ?? null]
    )
    return Number(row?.n ?? 0)
  }

  /** 原图文件缺失时，把已完成记录退回待下载 */
  markImagePending(url: string): void {
    this.db.run(`UPDATE item_images SET status = 'pending', updated_at = datetime('now') WHERE url = ?`, [url])
  }

  /** 派生图状态：'ok' 文件已确认存在；'missing' 确认缺失；'unknown' 未核实 */
  setDerivativeStatus(url: string, thumb: DerivStatus, preview: DerivStatus): void {
    this.db.run(`UPDATE item_images SET thumb_status = ?, preview_status = ? WHERE url = ?`, [thumb, preview, url])
  }

  markDerivativeOk(url: string): void {
    this.db.run(
      `UPDATE item_images SET thumb_status = 'ok', preview_status = 'ok', derivative_error = NULL WHERE url = ?`,
      [url]
    )
  }

  /** 派生图生成失败：计数 +1（达到 3 次后不再自动重试） */
  markDerivativeFailed(url: string, error: string): void {
    this.db.run(
      `UPDATE item_images SET derivative_attempts = derivative_attempts + 1, derivative_error = ? WHERE url = ?`,
      [error.slice(0, 500), url]
    )
  }

  /** 手动修复：派生图失败计数与错误清零，允许重新尝试 */
  resetDerivativeAttempts(): number {
    const before = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM item_images WHERE derivative_attempts > 0`)
    this.db.run(`UPDATE item_images SET derivative_attempts = 0, derivative_error = NULL WHERE derivative_attempts > 0`)
    return Number(before?.n ?? 0)
  }

  /**
   * 图片待下载/失败行分页（供启动与手动检查全量扫描）。
   * 排序：thumb → og → 其余，同档按 rowid；游标为 (prio, rowid)，不设总量上限。
   */
  listPendingImagePage(
    after: { prio: number; rid: number },
    limit: number
  ): Array<{ prio: number; rid: number; url: string; itemId: number; kind: string; filename: string }> {
    const prio = `(CASE kind WHEN 'thumb' THEN 0 WHEN 'og' THEN 1 ELSE 2 END)`
    return this.db.all(
      `SELECT ${prio} AS prio, rowid AS rid, url, item_id AS itemId, kind, filename FROM item_images
       WHERE status IN ('pending','failed') AND (${prio}, rowid) > (?, ?)
       ORDER BY prio, rid LIMIT ?`,
      [after.prio, after.rid, limit]
    )
  }

  getImage(url: string): { url: string; itemId: number; kind: string; filename: string; status: string } | undefined {
    return this.db.get('SELECT url, item_id AS itemId, kind, filename, status FROM item_images WHERE url = ?', [url])
  }

  /** 底层事务直通（批量状态写用） */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)
  }

  /** 删除某商品在所有表中的记录（单事务）。仅影响本地数据，BOOTH 端不受影响 */
  deleteItemRows(itemId: number): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM item_images WHERE item_id = ?', [itemId])
      this.db.run('DELETE FROM item_videos WHERE item_id = ?', [itemId])
      this.db.run('DELETE FROM items_search WHERE item_id = ?', [itemId])
      this.db.run('DELETE FROM metadata_snapshots WHERE item_id = ?', [itemId])
      this.db.run('DELETE FROM file_history WHERE item_id = ?', [itemId])
      this.db.run('DELETE FROM download_records WHERE item_id = ?', [itemId])
      this.db.run('DELETE FROM downloadables WHERE item_id = ?', [itemId])
      this.db.run('DELETE FROM items WHERE item_id = ?', [itemId])
    })
  }

  /** 某商品某类别的图片（按 URL 原顺序不保证，调用方按 galleryUrls 排序） */
  listImagesByItem(itemId: number, kind?: string): Array<{ url: string; filename: string; status: string }> {
    if (kind) {
      return this.db.all('SELECT url, filename, status FROM item_images WHERE item_id = ? AND kind = ? ORDER BY rowid', [itemId, kind])
    }
    return this.db.all('SELECT url, filename, status FROM item_images WHERE item_id = ? ORDER BY rowid', [itemId])
  }

  countImagesByItem(itemId: number): { total: number; done: number } {
    const r = this.db.get<{ total: number; done: number }>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done FROM item_images WHERE item_id = ?`,
      [itemId]
    )
    return { total: r?.total ?? 0, done: r?.done ?? 0 }
  }

  // ── 描述内嵌视频 ──

  upsertVideos(rows: Array<{ key: string; itemId: number; platform: string; videoId: string; url: string; embedUrl: string }>): void {
    for (const r of rows) {
      const existing = this.db.get('SELECT key FROM item_videos WHERE key = ?', [r.key])
      if (!existing) {
        this.db.run(
          `INSERT INTO item_videos (key, item_id, platform, video_id, url, embed_url, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'remote', datetime('now'))`,
          [r.key, r.itemId, r.platform, r.videoId, r.url, r.embedUrl]
        )
      } else {
        this.db.run(`UPDATE item_videos SET url = ?, embed_url = ?, updated_at = datetime('now') WHERE key = ?`, [r.url, r.embedUrl, r.key])
      }
    }
  }

  listVideosByItem(itemId: number): Array<{ key: string; platform: string; videoId: string; url: string; embedUrl: string; localPath: string | null; status: string }> {
    const rows = this.db.all<{ key: string; platform: string; videoId: string; url: string; embedUrl: string; localPath: string | null; status: string }>(
      `SELECT key, platform, video_id AS videoId, url, embed_url AS embedUrl, local_path AS localPath, status FROM item_videos WHERE item_id = ? ORDER BY rowid`,
      [itemId]
    )
    return rows.map((r) => ({ ...r, localPath: this.dataLocalOut(r.localPath) }))
  }

  /** localPath 为绝对路径，入库时转为相对数据根的存储值 */
  setVideoStatus(key: string, status: string, localPath?: string | null): void {
    this.db.run(`UPDATE item_videos SET status = ?, local_path = COALESCE(?, local_path), updated_at = datetime('now') WHERE key = ?`, [
      status,
      localPath ? this.dataLocalIn(localPath) : null,
      key
    ])
  }

  setVideoProgress(key: string, status: string): void {
    this.db.run(`UPDATE item_videos SET status = ?, updated_at = datetime('now') WHERE key = ?`, [status, key])
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
}

function safeJsonArray(v: unknown): string[] {
  if (typeof v !== 'string') return []
  try {
    const arr = JSON.parse(v)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** SQLite is_gift 是 0/1 → 转为真 boolean（避免 React 渲染出 0） */
function boolifyItem<T extends { isGift: unknown; isFree: unknown }>(row: T): T & { isGift: boolean; isFree: boolean } {
  return { ...row, isGift: Number(row.isGift) === 1, isFree: Number(row.isFree) === 1 }
}
