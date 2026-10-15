import { createHash } from 'crypto'
import { existsSync, mkdirSync, statSync, writeFileSync, renameSync } from 'fs'
import { join, extname } from 'path'
import type { ImageProgress } from '../../shared/types'
import type { HttpClient } from '../booth/httpClient'
import type { LibraryRepo } from '../db/repos'
import type { Paths } from '../util/paths'
import { createLogger } from '../util/log'

const log = createLogger('imageLocalizer')

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

  /** 缩略图生成队列（本地 CPU 操作，2 并发防内存尖峰） */
  private thumbQueue: Array<{ src: string; dest: string }> = []
  private thumbRunning = 0
  private thumbWanted = new Set<string>()

  /** 一张图完成时触发（UI 刷新该商品） */
  onImageDone: ((itemId: number, url: string) => void) | null = null
  /** 队列清空时触发 */
  onIdle: (() => void) | null = null
  /** 进度（本会话累计，节流 ~500ms 上报） */
  onProgress: ((e: ImageProgress) => void) | null = null

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

  private async downloadOne(row: { url: string; itemId: number; filename: string }): Promise<void> {
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
    // 原图落盘后顺手生成缩略图（thumb/ 与 images/ 平级）
    this.enqueueThumb(dest, this.thumbPath(row.itemId, row.filename))
  }

/** 缩略图本地路径（与 images 平级的 thumb/ 目录） */
  thumbPath(itemId: number, filename: string): string {
    // 统一 jpg 输出
    const base = filename.replace(/\.[^.]+$/, '')
    return join(this.paths.thumbsDir(itemId), `${base}.jpg`)
  }

  /**
   * 解析缩略图：已生成返回 thumb；未生成则返回原图兜底并后台生成。
   * 原图本身 ≤ 缩略图宽度时直接用原图（列表页 300x300 缩略图属于此类）。
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
   * 启动后台补齐存量图片的缩略图。
   * 逐张排队、单并发 + 每张间隔 250ms，让出主线程，不卡 UI。
   */
  startThumbBackfill(limit = 5000): void {
    if (this.disposed) return
    const rows = this.repo.listDoneImages(limit)
    let queued = 0
    for (const r of rows) {
      const thumb = this.thumbPath(r.itemId, r.filename)
      if (existsSync(thumb) && statSync(thumb).size > 0) continue
      const orig = this.localPath(r.itemId, r.filename)
      if (!existsSync(orig)) continue
      this.enqueueThumb(orig, thumb)
      queued++
    }
    if (queued > 0) log.info(`thumb backfill queued: ${queued} (total scanned ${rows.length})`)
  }

  private enqueueThumb(src: string, dest: string): void {
    if (this.thumbWanted.has(dest)) return
    this.thumbWanted.add(dest)
    this.thumbQueue.push({ src, dest })
    this.pumpThumbs()
  }

  private pumpThumbs(): void {
    if (this.disposed || this.thumbRunning > 0 || this.thumbQueue.length === 0) return
    const job = this.thumbQueue.shift()!
    this.thumbRunning++
    void (async () => {
      try {
        generateThumb(job.src, job.dest)
      } catch (e) {
        log.debug('thumb gen failed:', e instanceof Error ? e.message : e)
      } finally {
        this.thumbRunning--
        // 单张 nativeImage 操作会同步占用主线程 ~200ms，
        // 任务间强制留 250ms 空隙让 UI/IPC 处理，绝不连发卡死
        if (this.thumbQueue.length > 0 && !this.disposed) {
          const t = setTimeout(() => this.pumpThumbs(), 250)
          t.unref?.()
        }
      }
    })()
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

  /** 启动时把历史遗留 pending/failed 的图重新入队 */
  requeuePending(limit = 2000): void {
    this.flushStatus()
    const rows = this.repo.listPendingImages(limit)
    for (const r of rows) {
      if (this.queue.some((q) => q.url === r.url)) continue
      // 已存在本地文件的直接标记完成
      const p = this.localPath(r.itemId, r.filename)
      if (existsSync(p) && statSync(p).size > 0) {
        this.bufferStatus(r.url, 'done', statSync(p).size)
        continue
      }
      this.enqueue(r, 0)
    }
    log.info(`requeued ${this.queue.length} pending images (${rows.length} rows scanned)`)
    this.flushStatus()
  }

  dispose(): void {
    // 先停队列再刷状态：防止 DB 关闭后仍有 in-flight 写入
    this.disposed = true
    if (this.progressTimer) {
      clearTimeout(this.progressTimer)
      this.progressTimer = null
    }
    this.paused = true
    this.queue.length = 0
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.flushStatus()
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

/** 缩略图目标宽度（画廊条 72px、retina 2x 富余） */
export const THUMB_WIDTH = 360

/**
 * 用 Electron nativeImage 生成 JPEG 缩略图（零依赖）。
 * 非 Electron 环境（验证脚本）直接跳过。
 */
function generateThumb(src: string, dest: string): boolean {
  let nativeImage: typeof import('electron').nativeImage | undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    nativeImage = require('electron')?.nativeImage
  } catch {
    return false
  }
  if (!nativeImage) return false
  if (!existsSync(dest) || statSync(dest).size === 0) {
    const img = nativeImage.createFromPath(src)
    if (img.isEmpty()) return false
    const size = img.getSize()
    if (size.width <= THUMB_WIDTH) {
      // 原图已经很小：转存 JPEG 即可（体积接近，直接跳过——resolveThumb 返回原图）
      return false
    }
    mkdirSync(join(dest, '..'), { recursive: true })
    const resized = img.resize({ width: THUMB_WIDTH, quality: 'better' })
    const tmp = dest + '.tmp'
    writeFileSync(tmp, resized.toJPEG(82))
    renameSync(tmp, dest)
    log.debug(`thumb: ${dest} (${size.width}→${THUMB_WIDTH}px)`)
  }
  return true
}
