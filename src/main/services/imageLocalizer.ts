import { createHash } from 'crypto'
import { existsSync, mkdirSync, statSync, writeFileSync, renameSync } from 'fs'
import { join, extname, basename } from 'path'
import sharp from 'sharp'
import type { ImageProgress, DerivativeProgress, ReconcileProgress, ReconcileResult, CheckAllImagesResult } from '../../shared/types'
import type { HttpClient } from '../booth/httpClient'
import type { LibraryRepo, ImageRef, DerivStatus } from '../db/repos'
import type { Paths } from '../util/paths'
import { createLogger } from '../util/log'

const log = createLogger('imageLocalizer')

/** 派生图生成任务：src 原图 → dest 缩略图 / preview 预览图 */
interface DerivativeJob {
  url: string
  itemId: number
  kind: string
  filename: string
  src: string
  dest: string
  preview: string
}

/** 原图不存在（被手动删除等）：不计入派生图失败，改为重新下载 */
class MissingOriginalError extends Error {}

/** 派生图补齐按游标分页读取的批大小，队列低于水位线才续读 */
const DERIV_PAGE = 200
const DERIV_LOW_WATER = 20
/** 一次对账中原图缺失超过该数量时打 warn，便于排查误删目录等情况 */
const BULK_REDOWNLOAD_WARN = 100

/**
 * 商品图片本地化（用户需求 #3）：
 * - 抓库时把缩略图/宣传图画廊/描述图片直接下载到 {root}/{itemId}/meta/images/
 * - 纯后台自动，无需人工确认；先文字后图片（同步服务先写库再登记图片）
 * - 状态批量写回 DB（sql.js 高频单写会打爆 WASM 内存）
 * - 全尺寸原图从国内拉取慢：120s 超时 + 失败指数退避 + 下次启动 requeue
 */
export class ImageLocalizer {
  private queue: Array<{ url: string; itemId: number; kind: string; filename: string; attempt: number }> = []
  private running = 0
  private paused = false
  private activeUrls = new Set<string>()
  private maxConcurrent = 3
  /** 单 URL 连续失败次数（会话内） */
  private failCount = new Map<string, number>()

  /** 状态写缓冲：url → 'done'|'failed'，批量刷入 DB */
  private statusBuf = new Map<string, { status: 'done' | 'failed'; bytes?: number }>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  /** 派生图（缩略图/预览图）生成队列：sharp 异步执行于 libvips 线程池，单并发即可不卡主线程 */
  private thumbQueue: DerivativeJob[] = []
  private thumbRunning = 0
  private thumbWanted = new Set<string>()
  /** 派生图候选的分页游标（rowid），队列低于水位线才续读，避免一次性灌入全库 */
  private derivCursor = 0
  private derivFeederDone = false
  /** 派生结果状态写缓冲（与下载状态分开，批量刷入） */
  private derivBuf: Array<{ url: string; ok: boolean; error?: string }> = []
  private derivFlushTimer: ReturnType<typeof setTimeout> | null = null
  /** 当前批次派生图进度（队列清空后归零） */
  private derivTotal = 0
  private derivOk = 0
  private derivFailed = 0
  private derivLastAt = 0
  private derivStartedAt = 0
  private derivTimer: ReturnType<typeof setTimeout> | null = null

  /** 一张图完成时触发（UI 刷新该商品） */
  onImageDone: ((itemId: number, url: string) => void) | null = null
  /** 队列清空时触发 */
  onIdle: (() => void) | null = null
  /** 进度（本会话累计，节流 ~500ms 上报） */
  onProgress: ((e: ImageProgress) => void) | null = null
  /** 派生图生成进度（当前批次，节流 ~500ms 上报） */
  onDerivativeProgress: ((e: DerivativeProgress) => void) | null = null
  /** 图片对账进度（每页上报一次，结束时 done=true） */
  onReconcileProgress: ((e: ReconcileProgress) => void) | null = null

  /** 本会话图片下载进度 */
  private progressDone = 0
  private progressTotal = 0
  private progressLastAt = 0
  private progressTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private http: HttpClient,
    private repo: LibraryRepo,
    private paths: Paths
  ) {}

  /** 登记商品的全部图片（thumb/og/gallery/desc），新 URL 入队后台下载 */
  registerItemImages(itemId: number, urls: Array<{ url: string; kind: string }>): void {
    const rows = urls.map((u) => ({
      url: u.url,
      itemId,
      kind: u.kind,
      filename: imageFilename(u.url)
    }))
    this.repo.upsertImages(rows)
    for (const r of rows) {
      // 仅未完成的入队（内存队列去重 + DB 状态判断）
      if (this.queue.some((q) => q.url === r.url) || this.activeUrls.has(r.url)) continue
      const img = this.repo.getImage(r.url)
      const alreadyDone = img && img.status === 'done' && existsSync(this.localPath(r.itemId, r.filename))
      if (!alreadyDone) this.enqueue(r, 0)
    }
  }

  private enqueue(row: { url: string; itemId: number; kind: string; filename: string }, attempt: number): void {
    if (this.queue.some((q) => q.url === row.url)) return
    if (this.activeUrls.has(row.url)) return
    // 会话内失败 3 次放弃（留给下次启动 requeuePending）
    if ((this.failCount.get(row.url) ?? 0) >= 3) return
    this.queue.push({ ...row, attempt })
    if (attempt === 0) {
      this.progressTotal++
      this.emitProgress(true)
    }
    this.pump()
  }

  /** 上报进度：即时事件节流 500ms，队列清空时强制发最终值 */
  private emitProgress(force = false): void {
    if (!this.onProgress) return
    const now = Date.now()
    if (!force && now - this.progressLastAt < 500) {
      if (!this.progressTimer) {
        this.progressTimer = setTimeout(() => {
          this.progressTimer = null
          this.emitProgress(true)
        }, 500)
        this.progressTimer.unref?.()
      }
      return
    }
    this.progressLastAt = now
    this.onProgress({
      done: this.progressDone,
      total: this.progressTotal,
      active: this.running,
      queued: this.queue.length
    })
  }

  private markProgressDone(): void {
    this.progressDone++
    this.emitProgress()
  }

  private pump(): void {
    if (this.paused) return
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const row = this.queue.shift()!
      this.activeUrls.add(row.url)
      this.running++
      void this.downloadOne(row)
        .then(() => {
          this.failCount.delete(row.url)
          this.markProgressDone()
          this.onImageDone?.(row.itemId, row.url)
        })
        .catch((e) => {
          const n = (this.failCount.get(row.url) ?? 0) + 1
          this.failCount.set(row.url, n)
          log.warn(`image fail #${n} ${row.itemId}/${row.filename}:`, e instanceof Error ? e.message : e)
          if (n < 3) {
            // 指数退避重入队（2s/8s）——重试不再计 total
            const delay = Math.min(2000 * 2 ** (n - 1), 16000)
            setTimeout(() => {
              if (!this.paused) this.enqueue(row, row.attempt + 1)
            }, delay)
          } else {
            this.bufferStatus(row.url, 'failed')
            this.markProgressDone() // 最终失败也计入完成（进度不卡死）
          }
        })
        .finally(() => {
          this.activeUrls.delete(row.url)
          this.running--
          this.pump()
          if (this.running === 0 && this.queue.length === 0) {
            this.emitProgress(true)
            this.onIdle?.()
          }
        })
    }
    if (this.running === 0 && this.queue.length === 0) this.onIdle?.()
  }

  /**
   * 删除商品前清理图片后台任务：移除排队项与缩略图待办，并等待该商品进行中的下载收尾，
   * 避免之后又在已删除的目录里写入文件。
   */
  async purgeItem(itemId: number, urls: string[], timeoutMs = 15_000): Promise<void> {
    this.queue = this.queue.filter((q) => q.itemId !== itemId)
    const dataDir = join(this.paths.itemDataDir(itemId), '')
    this.thumbQueue = this.thumbQueue.filter((t) => !t.dest.startsWith(dataDir))
    for (const dest of [...this.thumbWanted]) if (dest.startsWith(dataDir)) this.thumbWanted.delete(dest)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && urls.some((u) => this.activeUrls.has(u))) {
      await new Promise((r) => setTimeout(r, 100))
    }
    // 等待期间进行中的下载可能追加了缩略图待办，再清一次
    this.thumbQueue = this.thumbQueue.filter((t) => !t.dest.startsWith(dataDir))
  }

  private disposed = false

  /** 状态批量写：30 条或 3 秒刷一次（减压 sql.js） */
  private bufferStatus(url: string, status: 'done' | 'failed', bytes?: number): void {
    if (this.disposed) return
    this.statusBuf.set(url, { status, bytes })
    if (this.statusBuf.size >= 30) {
      this.flushStatus()
      return
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        this.flushStatus()
      }, 3000)
      this.flushTimer.unref?.()
    }
  }

  private flushStatus(): void {
    if (this.statusBuf.size === 0) return
    const entries = Array.from(this.statusBuf.entries())
    this.statusBuf.clear()
    try {
      this.repo.transaction(() => {
        for (const [url, st] of entries) {
          if (st.status === 'done') this.repo.markImageDone(url, st.bytes ?? 0)
          else this.repo.markImageFailed(url)
        }
      })
    } catch (e) {
      // dispose 后 DB 已关闭的写入直接丢弃（下次 requeuePending 兜底）
      log.debug('image status flush skipped:', e instanceof Error ? e.message : e)
    }
  }

  private async downloadOne(row: { url: string; itemId: number; kind: string; filename: string }): Promise<void> {
    const dest = this.localPath(row.itemId, row.filename)
    if (existsSync(dest) && statSync(dest).size > 0) return
    mkdirSync(join(dest, '..'), { recursive: true })
    // 全尺寸原图可能 >30s：图片专用 120s 超时
    const res = await this.http.request(row.url, 'GET', {
      headers: { referer: 'https://booth.pm/' },
      timeoutMs: 120_000
    })
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.body())
    if (buf.byteLength < 100) throw new Error('response too small')
    const tmp = dest + '.tmp'
    writeFileSync(tmp, buf)
    renameSync(tmp, dest)
    this.bufferStatus(row.url, 'done', buf.byteLength)
    log.debug(`done: #${row.itemId} ${row.filename} (${buf.byteLength}B)`)
    // 原图落盘后异步生成 thumb/（360）与 preview/（长边 720）
    this.enqueueDerivatives({
      url: row.url,
      itemId: row.itemId,
      kind: row.kind,
      filename: row.filename,
      src: dest,
      dest: this.thumbPath(row.itemId, row.filename),
      preview: this.previewPath(row.itemId, row.filename)
    })
  }

/** 缩略图本地路径（与 images 平级的 thumb/ 目录） */
  thumbPath(itemId: number, filename: string): string {
    // 统一 jpg 输出
    const base = filename.replace(/\.[^.]+$/, '')
    return join(this.paths.thumbsDir(itemId), `${base}.jpg`)
  }

  /** 预览图本地路径（与 images 平级的 preview/ 目录，长边 720） */
  previewPath(itemId: number, filename: string): string {
    const base = filename.replace(/\.[^.]+$/, '')
    return join(this.paths.previewsDir(itemId), `${base}.jpg`)
  }

  /**
   * 解析缩略图：已生成返回 thumb；未生成则返回原图兜底并后台生成。
   */
  resolveThumbLocal(url: string): string | null {
    const img = this.repo.getImage(url)
    if (!img) return null
    const orig = this.localPath(img.itemId, img.filename)
    if (!existsSync(orig) || statSync(orig).size === 0) return null
    const thumb = this.thumbPath(img.itemId, img.filename)
    if (existsSync(thumb) && statSync(thumb).size > 0) return thumb
    // 不在详情页打开时触发生成（会瞬间压垮主线程）——
    // 缩略图在下载完成时构建，存量图由启动后台队列 startThumbBackfill 补齐
    return orig
  }

  /**
   * 解析展示用预览图（长边 720）：已生成返回 preview；未生成则回退原图。
   */
  resolvePreviewLocal(url: string): string | null {
    const img = this.repo.getImage(url)
    if (!img) return null
    const orig = this.localPath(img.itemId, img.filename)
    if (!existsSync(orig) || statSync(orig).size === 0) return null
    const preview = this.previewPath(img.itemId, img.filename)
    if (existsSync(preview) && statSync(preview).size > 0) return preview
    return orig
  }

  /**
   * 启动后台补齐（不再全量扫盘）：从 rowid=0 开始按页读取派生图候选（依据持久化的派生状态），
   * 队列低于水位线才续读。原图是否缺失在执行任务时才发现（见 MissingOriginalError）。
   */
  startThumbBackfill(): void {
    if (this.disposed) return
    this.derivCursor = 0
    this.derivFeederDone = false
    this.feedDerivatives()
  }

  /** 按需续读一页派生图候选入队；队列未降到水位线以下或已读完则直接返回 */
  private feedDerivatives(): void {
    if (this.disposed || this.derivFeederDone || this.thumbQueue.length >= DERIV_LOW_WATER) return
    // 先刷新未落库的派生结果，避免刚完成的行被再次读出
    this.flushDerivStatus()
    const rows = this.repo.listDerivativeCandidates(this.derivCursor, DERIV_PAGE)
    if (rows.length === 0) {
      this.derivFeederDone = true
      return
    }
    this.derivCursor = rows[rows.length - 1].rid
    let queued = 0
    for (const r of rows) {
      if (this.addDerivJob(this.jobFromRef(r), false)) queued++
    }
    log.info(`backfill: fed ${queued} derivative jobs (page ${rows.length}, cursor ${this.derivCursor})`)
    if (rows.length < DERIV_PAGE) this.derivFeederDone = true
  }

  private jobFromRef(r: ImageRef): DerivativeJob {
    return {
      url: r.url,
      itemId: r.itemId,
      kind: r.kind,
      filename: r.filename,
      src: this.localPath(r.itemId, r.filename),
      dest: this.thumbPath(r.itemId, r.filename),
      preview: this.previewPath(r.itemId, r.filename)
    }
  }

  /** 下载完成后的派生图任务入队（队尾） */
  private enqueueDerivatives(job: DerivativeJob): void {
    this.addDerivJob(job, false)
  }

  /** 入队派生任务（dest 去重）；atFront 用于可见卡片优先。返回是否真正入队 */
  private addDerivJob(job: DerivativeJob, atFront: boolean): boolean {
    if (this.disposed || this.thumbWanted.has(job.dest)) return false
    this.thumbWanted.add(job.dest)
    if (atFront) this.thumbQueue.unshift(job)
    else this.thumbQueue.push(job)
    if (this.derivTotal === 0) this.derivStartedAt = Date.now()
    this.derivTotal++
    this.emitDerivProgress()
    this.pumpThumbs()
    return true
  }

  /**
   * 可见商品优先：把该商品的派生图候选提到队首（已在队列中的前移，未入队的插入队首）。
   * 由渲染层进入可视区/打开详情时调用。
   */
  prioritizeItem(itemId: number): void {
    if (this.disposed) return
    const rows = this.repo.listDerivativeCandidatesByItem(itemId)
    for (const r of rows) {
      const job = this.jobFromRef(r)
      const idx = this.thumbQueue.findIndex((q) => q.dest === job.dest)
      if (idx > 0) {
        const [hit] = this.thumbQueue.splice(idx, 1)
        this.thumbQueue.unshift(hit)
      } else if (idx < 0) {
        this.addDerivJob(job, true)
      }
    }
  }

  /** 单并发执行派生图任务；sharp 在 libvips 线程池异步运行不占主线程，任务间用 setImmediate 让出事件循环 */
  private pumpThumbs(): void {
    if (this.disposed || this.thumbRunning > 0 || this.thumbQueue.length === 0) return
    const job = this.thumbQueue.shift()!
    this.thumbRunning++
    void this.runDerivJob(job)
      .then(() => {
        this.derivOk++
        this.bufferDerivResult(job.url, true)
      })
      .catch((e) => {
        if (e instanceof MissingOriginalError) {
          this.recoverMissingOriginal(job)
          return
        }
        this.derivFailed++
        const msg = e instanceof Error ? e.message : String(e)
        log.warn(`thumbnail fail #${job.itemId}/${basename(job.src)}: ${msg}`)
        this.bufferDerivResult(job.url, false, msg)
      })
      .finally(() => {
        this.thumbRunning--
        this.thumbWanted.delete(job.dest)
        this.emitDerivProgress()
        if (this.thumbQueue.length < DERIV_LOW_WATER) this.feedDerivatives()
        if (this.thumbQueue.length > 0 && !this.disposed) {
          setImmediate(() => this.pumpThumbs())
        } else if (this.thumbRunning === 0) {
          this.flushDerivStatus()
          this.finishDerivBatch()
        }
      })
  }

  private async runDerivJob(job: DerivativeJob): Promise<void> {
    if (!fileOk(job.src)) throw new MissingOriginalError(job.src)
    await generateDerivatives(job.src, job.dest, job.preview)
  }

  /** 原图被删：退回待下载，下载完成会再次生成派生图（不计为派生失败） */
  private recoverMissingOriginal(job: DerivativeJob): void {
    this.derivTotal = Math.max(0, this.derivTotal - 1)
    try {
      this.repo.markImagePending(job.url)
      this.repo.setDerivativeStatus(job.url, 'unknown', 'unknown')
    } catch {
      return
    }
    this.failCount.delete(job.url)
    log.info(`original missing, re-download #${job.itemId}/${job.filename}`)
    this.enqueue({ url: job.url, itemId: job.itemId, kind: job.kind, filename: job.filename }, 0)
  }

  /** 派生结果缓冲：30 条或 3 秒批量落库 */
  private bufferDerivResult(url: string, ok: boolean, error?: string): void {
    if (this.disposed) return
    this.derivBuf.push({ url, ok, error })
    if (this.derivBuf.length >= 30) {
      this.flushDerivStatus()
      return
    }
    if (!this.derivFlushTimer) {
      this.derivFlushTimer = setTimeout(() => {
        this.derivFlushTimer = null
        this.flushDerivStatus()
      }, 3000)
      this.derivFlushTimer.unref?.()
    }
  }

  private flushDerivStatus(): void {
    if (this.derivFlushTimer) {
      clearTimeout(this.derivFlushTimer)
      this.derivFlushTimer = null
    }
    if (this.derivBuf.length === 0) return
    const entries = this.derivBuf.splice(0)
    try {
      this.repo.transaction(() => {
        for (const e of entries) {
          if (e.ok) this.repo.markDerivativeOk(e.url)
          else this.repo.markDerivativeFailed(e.url, e.error ?? 'unknown')
        }
      })
    } catch (e) {
      log.debug('derivative status flush skipped:', e instanceof Error ? e.message : e)
    }
  }

  /**
   * 对账（库同步后调用，与 localFileReconciler 思路一致）：
   * 分页核对已完成行的原图与派生图文件是否与 DB 状态一致；原图缺失则重新下载，
   * 派生图缺失则标记为未就绪并重新入队。按页让出事件循环，根目录不存在时跳过。
   */
  async reconcileImages(scope?: { itemId: number }): Promise<ReconcileResult> {
    const result: ReconcileResult = { checked: 0, redownload: 0, derivMarked: 0, derivMissing: 0 }
    if (this.disposed) return result
    if (!existsSync(this.paths.dataRootPath)) {
      log.warn('reconcileImages skipped: library data root missing')
      return result
    }
    const itemId = scope?.itemId
    const total = this.repo.countDoneImages(itemId)
    this.flushStatus()
    this.flushDerivStatus()
    let afterRowid = 0
    for (;;) {
      const page = this.repo.listDoneImagePage(afterRowid, 500, itemId)
      if (page.length === 0) break
      afterRowid = page[page.length - 1].rid
      for (const r of page) {
        result.checked++
        const orig = this.localPath(r.itemId, r.filename)
        if (!fileOk(orig)) {
          this.repo.markImagePending(r.url)
          this.repo.setDerivativeStatus(r.url, 'unknown', 'unknown')
          this.failCount.delete(r.url)
          this.enqueue({ url: r.url, itemId: r.itemId, kind: r.kind, filename: r.filename }, 0)
          result.redownload++
          log.warn(`original missing, re-download: #${r.itemId} ${r.filename}`)
          continue
        }
        const thumbStatus: DerivStatus = fileOk(this.thumbPath(r.itemId, r.filename)) ? 'ok' : 'missing'
        const previewStatus: DerivStatus = fileOk(this.previewPath(r.itemId, r.filename)) ? 'ok' : 'missing'
        if (thumbStatus === 'missing' || previewStatus === 'missing') result.derivMissing++
        if (thumbStatus !== r.thumbStatus || previewStatus !== r.previewStatus) {
          this.repo.setDerivativeStatus(r.url, thumbStatus, previewStatus)
          result.derivMarked++
        }
      }
      this.onReconcileProgress?.({ checked: result.checked, total, done: false })
      await new Promise((resolve) => setImmediate(resolve))
    }
    this.onReconcileProgress?.({ checked: result.checked, total, done: true })
    if (result.redownload > BULK_REDOWNLOAD_WARN) {
      log.warn(`reconcile: ${result.redownload} original images missing, bulk re-download queued`)
    }
    if (result.derivMarked > 0 || result.redownload > 0) {
      // 有派生状态变化：重新从头续读候选
      this.startThumbBackfill()
    }
    const scopeLabel = itemId !== undefined ? `item #${itemId}` : 'library'
    log.info(
      `image reconcile (${scopeLabel}): checked ${result.checked}, redownload ${result.redownload}, derivative marked ${result.derivMarked}, derivative missing ${result.derivMissing}`
    )
    return result
  }

  /**
   * 商品详情页单品检查：只核对该商品的已完成记录（纯本地 stat），
   * 原图缺失自动重下，派生图缺失标记后优先补齐。
   */
  async checkItem(itemId: number): Promise<ReconcileResult> {
    const r = await this.reconcileImages({ itemId })
    if (r.derivMissing > 0 || r.redownload > 0) {
      this.prioritizeItem(itemId)
    }
    return r
  }

  /** 手动修复：清零派生失败计数后做一次全量检查（补下 pending + 对账）并重新补齐派生图 */
  async repairDerivatives(): Promise<CheckAllImagesResult & { reset: number }> {
    const reset = this.repo.resetDerivativeAttempts()
    const r = await this.checkAllImages()
    this.startThumbBackfill()
    return { reset, ...r }
  }

  private finishDerivBatch(): void {
    if (this.derivTotal === 0) return
    const ms = Date.now() - this.derivStartedAt
    log.info(`thumbnail batch done: ok ${this.derivOk}, failed ${this.derivFailed}, total ${this.derivTotal}, ${ms}ms`)
    this.emitDerivProgress(true)
    this.derivTotal = 0
    this.derivOk = 0
    this.derivFailed = 0
  }

  /** 派生图进度上报：节流 500ms，末尾强制补发一次 */
  private emitDerivProgress(force = false): void {
    if (!this.onDerivativeProgress) return
    const now = Date.now()
    if (!force && now - this.derivLastAt < 500) {
      if (!this.derivTimer) {
        this.derivTimer = setTimeout(() => {
          this.derivTimer = null
          this.emitDerivProgress(true)
        }, 500)
        this.derivTimer.unref?.()
      }
      return
    }
    this.derivLastAt = now
    this.onDerivativeProgress({
      done: this.derivOk + this.derivFailed,
      total: this.derivTotal,
      failed: this.derivFailed
    })
  }

  /** 本地文件绝对路径 */
  localPath(itemId: number, filename: string): string {
    return join(this.paths.imagesDir(itemId), filename)
  }

  /**
   * 按 URL 查本地路径：直接探测文件（状态缓冲有 3s 延迟，以文件存在为准）。
   * 已下载返回绝对路径，否则 null。
   */
  resolveLocal(url: string): string | null {
    const img = this.repo.getImage(url)
    if (!img) return null
    const p = this.localPath(img.itemId, img.filename)
    return existsSync(p) && statSync(p).size > 0 ? p : null
  }

  /** item 已知场景的解析（DB 行还没写时按 URL 哈希探测） */
  resolveLocalFor(itemId: number, url: string): string | null {
    const direct = this.localPath(itemId, imageFilename(url))
    if (existsSync(direct) && statSync(direct).size > 0) return direct
    return this.resolveLocal(url)
  }

  get stats(): { queued: number; active: number } {
    return { queued: this.queue.length, active: this.running }
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    this.pump()
  }

  /**
   * 把中断遗留的 pending/failed 图片重新入队（分页扫描，不设上限）。
   * 文件已存在的直接标记完成；其余按 缩略图 → og → 其余、同档按 rowid 入队下载。返回真实入队数。
   */
  requeuePending(): { scanned: number; queued: number } {
    this.flushStatus()
    let cursor = { prio: -1, rid: 0 }
    let scanned = 0
    let queued = 0
    for (;;) {
      const rows = this.repo.listPendingImagePage(cursor, 500)
      if (rows.length === 0) break
      const last = rows[rows.length - 1]
      cursor = { prio: last.prio, rid: last.rid }
      for (const r of rows) {
        scanned++
        const p = this.localPath(r.itemId, r.filename)
        if (fileOk(p)) {
          this.bufferStatus(r.url, 'done', statSync(p).size)
          continue
        }
        if (this.queue.some((q) => q.url === r.url) || this.activeUrls.has(r.url)) continue
        this.enqueue(r, 0)
        queued++
      }
      this.flushStatus()
    }
    log.info(`requeued ${queued} pending images (${scanned} rows scanned)`)
    this.flushStatus()
    return { scanned, queued }
  }

  /**
   * 全量图片检查（手动「检查图片」与启动时共用）：
   * 先把中断遗留的 pending/failed 行补入队列，再对已完成行做原图/派生图对账。
   */
  async checkAllImages(): Promise<CheckAllImagesResult> {
    const { scanned, queued } = this.requeuePending()
    const r = await this.reconcileImages()
    return { ...r, pendingScanned: scanned, pendingQueued: queued }
  }


  dispose(): void {
    // 先停队列再刷状态：防止 DB 关闭后仍有 in-flight 写入
    this.disposed = true
    if (this.progressTimer) {
      clearTimeout(this.progressTimer)
      this.progressTimer = null
    }
    if (this.derivTimer) {
      clearTimeout(this.derivTimer)
      this.derivTimer = null
    }
    this.paused = true
    this.queue.length = 0
    this.thumbQueue.length = 0
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.flushStatus()
    this.flushDerivStatus()
  }
}

/** URL → 本地文件名（哈希 + 原扩展名） */
export function imageFilename(url: string): string {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 16)
  let ext = '.jpg'
  try {
    const pathname = new URL(url).pathname
    const e = extname(pathname).toLowerCase()
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'].includes(e)) ext = e
  } catch {
    /* default */
  }
  return `${hash}${ext}`
}

/** 缩略图目标宽度（画廊条、详情页底层占位） */
export const THUMB_WIDTH = 360
/** 预览图目标长边（详情页展示、列表卡片、商品描述） */
export const PREVIEW_LONG_EDGE = 720

/**
 * 用 sharp 从原图生成两层 JPEG（异步，libvips 线程池执行）：
 * - thumb：宽 360（不放大）
 * - preview：长边 720（不放大）
 * 已存在的层跳过；按 EXIF 方向旋转；透明通道压平为白底。
 * 支持 jpg/png/webp/gif/avif（nativeImage 不支持后三者）。
 */
async function generateDerivatives(src: string, thumbDest: string, previewDest: string): Promise<void> {
  const thumbMissing = !fileOk(thumbDest)
  const previewMissing = !fileOk(previewDest)
  if (!thumbMissing && !previewMissing) return
  mkdirSync(join(thumbDest, '..'), { recursive: true })
  mkdirSync(join(previewDest, '..'), { recursive: true })

  const base = sharp(src).rotate().flatten({ background: '#ffffff' })
  if (thumbMissing) {
    const buf = await base
      .clone()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer()
    writeAtomic(thumbDest, buf)
  }
  if (previewMissing) {
    const buf = await base
      .clone()
      .resize({ width: PREVIEW_LONG_EDGE, height: PREVIEW_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer()
    writeAtomic(previewDest, buf)
  }
}

function fileOk(p: string): boolean {
  return existsSync(p) && statSync(p).size > 0
}


function writeAtomic(dest: string, data: Buffer): void {
  const tmp = dest + '.tmp'
  writeFileSync(tmp, data)
  renameSync(tmp, dest)
}
