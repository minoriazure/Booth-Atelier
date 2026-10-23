import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import { dirname } from 'path'
import type { DownloadProgressEvent, DownloadDoneEvent, DownloadSource, Fingerprint, FileListRow, DownloadStats } from '../../shared/types'
import type { DeeplinkClient } from '../booth/deeplink'
import type { HttpClient } from '../booth/httpClient'
import { BoothError, isAuthError } from '../booth/errors'
import { systemFetch } from '../booth/systemFetch'
import type { LibraryRepo } from '../db/repos'
import type { HistoryManager } from './historyManager'
import type { Paths } from '../util/paths'
import { sanitizeFilename, localDate } from '../util/filenames'
import { createLogger } from '../util/log'

const log = createLogger('download')

interface Job {
  downloadableId: number
  itemId: number
  source: DownloadSource
  enqueuedAt: number
}

interface ActiveJob extends Job {
  recordId: number
  abort: AbortController
}

/**
 * 下载管理器：FIFO 队列 + N 并发 worker + 单 downloadable 去重锁。
 * 关键规则：dlurl 180s 过期 → job 内即时 resolve，绝不缓存；
 * 下载到 .part → fsync → 校验大小 → 原子 rename → 归档旧版本 → 落库。
 */
export class DownloadManager {
  private queue: Job[] = []
  private active = new Map<number, ActiveJob>()
  private paused = false
  /** 用户手动全局暂停（保留队列，仅停止派发） */
  private userPaused = false
  private disposed = false
  private concurrency = 3

  onProgress: ((e: DownloadProgressEvent) => void) | null = null
  onDone: ((e: DownloadDoneEvent) => void) | null = null
  onError: ((e: { downloadableId: number; itemId: number; filename: string; error: string; auth: boolean }) => void) | null = null
  onQueueChanged: (() => void) | null = null

  constructor(
    private deeplink: DeeplinkClient,
    private http: HttpClient,
    private repo: LibraryRepo,
    private history: HistoryManager,
    private paths: Paths,
    private jar?: { cookieHeader(url: string): Promise<string> }
  ) {}

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.min(8, n))
    this.pump()
  }

  /** 入队单个链接；已在队列/进行中则忽略，返回是否新入队。deferPump=true 时不立即派发 */
  enqueue(downloadableId: number, source: DownloadSource, deferPump = false): boolean {
    const d = this.repo.getDownloadable(downloadableId)
    if (!d) {
      log.warn(`enqueue unknown downloadable ${downloadableId}`)
      return false
    }
    if (this.active.has(downloadableId)) return false
    if (this.queue.some((j) => j.downloadableId === downloadableId)) return false
    this.queue.push({ downloadableId, itemId: d.itemId, source, enqueuedAt: Date.now() })
    this.repo.setQueuedAt(downloadableId, new Date().toISOString()) // 持久化：重启后恢复排队，不回退待下载
    this.onQueueChanged?.()
    if (!deferPump) this.pump()
    return true
  }

  enqueueMany(ids: number[], source: DownloadSource): number {
    let n = 0
    for (const id of ids) if (this.enqueue(id, source)) n++
    return n
  }

  /**
   * 立即下载：无视并发上限与队列顺序，直接进入下载中。
   * - 排队中的任务：从队列摘出直接跑（不回待下载）
   * - 待下载/失败的：直接构造 job 跑
   * 用于「排队中的立即下载」按钮，以及网页端 deeplink 直下（模拟原版行为）。
   */
  downloadNow(downloadableId: number, source: DownloadSource = 'manual'): Promise<'started' | 'active' | 'skipped' | 'missing'> {
    if (this.disposed) return Promise.resolve('missing')
    if (this.active.has(downloadableId)) return Promise.resolve('active')
    const d = this.repo.getDownloadable(downloadableId)
    if (!d) return Promise.resolve('missing')

    let job: Job
    const idx = this.queue.findIndex((j) => j.downloadableId === downloadableId)
    if (idx >= 0) {
      job = this.queue.splice(idx, 1)[0]
    } else {
      job = { downloadableId, itemId: d.itemId, source, enqueuedAt: Date.now() }
    }
    // 排队标记保留：下载中/中断后重启都能经 restoreQueue 恢复；runJob 结束时清
    this.repo.setQueuedAt(downloadableId, new Date().toISOString())
    // 决策点：downloadOne 的 resolve+probe 完成后才 settle（不是下载完成）——
    // skipped = 本地已下载且指纹一致（未重新下载）；probe 前异常由 runJob finally 兜底 'started'
    let settle!: (r: 'started' | 'skipped') => void
    const decided = new Promise<'started' | 'skipped'>((ok) => {
      settle = ok
    })
    let fired = false
    const decide = (r: 'started' | 'skipped'): void => {
      if (fired) return
      fired = true
      settle(r)
    }
    void this.runJob(job, decide) // 不经 pump —— 绕开 concurrency 上限
    this.onQueueChanged?.()
    log.info(`downloadNow: #${downloadableId}（跳过队列与并发限制）`)
    return decided
  }

  enqueueItem(itemId: number, source: DownloadSource): number {
    const files = this.repo.listDownloadablesOfItem(itemId).filter((f) => f.status !== 'downloaded')
    return this.enqueueMany(
      files.map((f) => f.downloadableId),
      source
    )
  }

  /**
   * 开始全部：把【待下载】（remote/update_available、未排队、非失败）全部入队并立即派发。
   * 只动待下载——已完成（downloaded）与失败（failed）不在此操作范围。
   * 若处于用户暂停/认证暂停，显式点击开始会清除暂停并继续（与 BOOTH 网页点下载一致）。
   */
  startAll(source: DownloadSource): number {
    const wasPaused = this.userPaused || this.paused
    this.userPaused = false
    this.paused = false
    const ids = this.repo.listPendingIds()
    let n = 0
    for (const id of ids) {
      if (this.enqueue(id, source, true)) n++
    }
    if (n > 0 || wasPaused) this.onQueueChanged?.()
    this.pump()
    if (n > 0) log.info(`startAll: queued ${n} pending files, dispatched`)
    return n
  }

  /**
   * 重启恢复：queued_at 非空的任务（排队中/下载中断）按入队顺序重新入队并自动开始，
   * 不回退到「待下载」。
   */
  restoreQueue(): number {
    const ids = this.repo.listQueuedIds()
    let n = 0
    for (const id of ids) {
      if (this.active.has(id) || this.queue.some((j) => j.downloadableId === id)) continue
      const d = this.repo.getDownloadable(id)
      if (!d) continue
      this.queue.push({ downloadableId: id, itemId: d.itemId, source: 'initial', enqueuedAt: Date.now() })
      n++
    }
    if (n > 0) {
      this.onQueueChanged?.()
      this.pump() // 自动继续下载
      log.info(`restoreQueue: resumed ${n} queued jobs from previous session`)
    }
    return n
  }

  /**
   * 更新检测到远程变化时：立即把该链接的本地旧文件归档到历史
   * （同名覆盖与改名 _V2 两种情况统一在此处理——文件先进历史，新文件下载后落 current）。
   */
  archiveCurrentFile(downloadableId: number): string | null {
    const d = this.repo.getDownloadable(downloadableId)
    if (!d?.localPath) return null
    const archived = this.history.archivePath(d.itemId, d.localPath)
    if (!archived) return null
    this.repo.addFileHistory({
      itemId: d.itemId,
      downloadableId,
      date: localDate(),
      archivedPath: archived,
      filename: d.localPath.split(/[\/]/).pop() || d.filename,
      etag: d.lastEtag,
      size: d.lastSize
    })
    this.repo.run('UPDATE downloadables SET local_path = NULL, local_size = NULL WHERE downloadable_id = ?', [downloadableId])
    log.info(`archive on update: ${d.localPath} → ${archived}`)
    return archived
  }

  cancel(downloadableId: number): boolean {
    const idx = this.queue.findIndex((j) => j.downloadableId === downloadableId)
    if (idx >= 0) {
      const job = this.queue.splice(idx, 1)[0]
      this.repo.setQueuedAt(downloadableId, null)
      this.repo.addDownloadRecord({
        downloadableId: job.downloadableId,
        itemId: job.itemId,
        source: job.source,
        status: 'cancelled'
      })
      this.onQueueChanged?.()
      log.info(`cancelled queued: #${downloadableId}`)
      return true
    }
    const act = this.active.get(downloadableId)
    if (act) {
      act.abort.abort()
      log.info(`cancel requested for active download: #${downloadableId}`)
      return true
    }
    return false
  }

  /** 取消某商品的全部排队与进行中任务，并等待进行中任务收尾（写完记录、释放文件句柄） */
  async cancelItem(itemId: number, timeoutMs = 10_000): Promise<void> {
    for (const j of this.queue.filter((x) => x.itemId === itemId)) this.cancel(j.downloadableId)
    for (const a of this.active.values()) if (a.itemId === itemId) a.abort.abort()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && [...this.active.values()].some((a) => a.itemId === itemId)) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  /**
   * 认证过期：暂停派发。队列【不清空】，中断的活跃任务回队首（.part 保留）。
   * 恢复途径：认证检查通过时自动 resume（见 IPC auth:check）或用户点「开始下载」。
   */
  pauseForAuth(): void {
    if (this.paused) return
    this.paused = true
    const interrupted: Job[] = []
    for (const act of this.active.values()) {
      interrupted.push({ downloadableId: act.downloadableId, itemId: act.itemId, source: act.source, enqueuedAt: act.enqueuedAt })
      act.abort.abort()
    }
    for (const job of interrupted.reverse()) {
      if (!this.queue.some((j) => j.downloadableId === job.downloadableId)) {
        this.queue.unshift(job)
      }
    }
    this.onQueueChanged?.()
    log.warn(`queue paused for auth (${this.queue.length} jobs kept)`)
  }

  /** 认证恢复后的自动续传：只清除认证暂停，尊重用户的手动暂停 */
  resumeAfterAuth(): void {
    if (!this.paused) return
    this.paused = false
    this.onQueueChanged?.()
    this.pump()
    log.info('queue auto-resumed after auth check passed')
  }

  /** 恢复派发（清除 用户暂停 与 认证暂停 两种状态） */
  resume(): void {
    this.paused = false
    this.userPaused = false
    this.onQueueChanged?.()
    this.pump()
  }

  get stats(): DownloadStats {
    return { queued: this.queue.length, active: this.active.size, paused: this.paused, userPaused: this.userPaused }
  }

  /** 进程退出前调用：停止派发、中断活跃任务、丢弃队列（防止退出竞态写 DB） */
  dispose(): void {
    this.disposed = true
    this.userPaused = true
    this.paused = true
    this.queue.length = 0
    for (const act of this.active.values()) act.abort.abort()
    this.active.clear()
    log.info('download manager disposed')
  }

  /** 用户全局暂停：停止派发新任务并中断进行中任务（.part 保留，恢复后续传），
   *  中断的任务重新放回队列头部，恢复时继续 */
  pauseAll(): void {
    if (this.userPaused) return
    this.userPaused = true
    const interrupted: Job[] = []
    for (const act of this.active.values()) {
      interrupted.push({ downloadableId: act.downloadableId, itemId: act.itemId, source: act.source, enqueuedAt: act.enqueuedAt })
      act.abort.abort()
    }
    // 放回队首（active 清理由 runJob finally 完成），去重防止与队列已有项冲突
    for (const job of interrupted.reverse()) {
      if (!this.queue.some((j) => j.downloadableId === job.downloadableId)) {
        this.queue.unshift(job)
      }
    }
    this.onQueueChanged?.()
    log.info(`queue paused by user (${interrupted.length} interrupted, requeued)`)
  }

  /** 开始下载：清除用户暂停与认证暂停，立即派发（队列有任务时可用） */
  resumeAll(): void {
    this.userPaused = false
    this.paused = false
    this.onQueueChanged?.()
    this.pump()
    log.info('queue started by user')
  }

  /** 重试所有最近失败的文件，返回入队数 */
  retryFailed(): number {
    const ids = this.repo.listFailedDownloadableIds()
    let n = 0
    for (const id of ids) if (this.enqueue(id, 'manual')) n++
    return n
  }

  /** 全文件列表：DB 行 + 运行时队列/活动状态合并 */
  listFiles(): FileListRow[] {
    const rows = this.repo.listAllFileRows()
    return rows.map((r) => ({
      downloadableId: r.downloadableId,
      itemId: r.itemId,
      itemTitle: r.itemTitle,
      filename: r.filename,
      status: r.status as FileListRow['status'],
      localPath: r.localPath,
      localSize: r.localSize,
      lastSize: r.lastSize,
      inQueue: this.queue.some((j) => j.downloadableId === r.downloadableId) || !!r.queuedAt,
      active: this.active.has(r.downloadableId),
      failed: !!r.failed && !this.active.has(r.downloadableId),
      lastError: r.lastError
    }))
  }

  listActive(): Array<DownloadProgressEvent & { source: DownloadSource }> {
    return Array.from(this.active.values()).map((a) => {
      const d = this.repo.getDownloadable(a.downloadableId)
      return {
        downloadableId: a.downloadableId,
        itemId: a.itemId,
        filename: d?.filename ?? '',
        bytesDone: 0,
        bytesTotal: 0,
        source: a.source
      }
    })
  }

  private pump(): void {
    if (this.paused || this.userPaused) return
    while (this.active.size < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!
      void this.runJob(job)
    }
  }

  private async runJob(job: Job, decide?: (r: 'started' | 'skipped') => void): Promise<void> {
    if (this.disposed) {
      decide?.('started')
      return
    }
    const recordId = this.repo.addDownloadRecord({
      downloadableId: job.downloadableId,
      itemId: job.itemId,
      source: job.source,
      status: 'running'
    })
    const abort = new AbortController()
    this.active.set(job.downloadableId, { ...job, recordId, abort })

    const d = this.repo.getDownloadable(job.downloadableId)
    const label = d?.filename || `#${job.downloadableId}`

    try {
      const result = await this.downloadOne(job, abort.signal, label, decide)
      if (this.disposed) return // 下载完成但进程退出中：文件已落盘，跳过 DB 写
      // 旧文件归档已在 downloadOne 内、rename 覆盖之前完成（result.archivedPath）
      const archivedPath = result.archivedPath

      // skipped 时也保留：markDownloaded 幂等（local_size 对齐磁盘真值）、
      // setQueuedAt 清 downloadNow 写入的排队标记、updateFingerprint 刷新 last_checked_at
      this.repo.markDownloaded(job.downloadableId, result.path, result.size)
      this.repo.setQueuedAt(job.downloadableId, null)
      if (result.etag) {
        this.repo.updateFingerprint(job.downloadableId, {
          etag: result.etag,
          size: result.size,
          lastModified: result.lastModified,
          filename: result.filename
        })
      } else {
        this.repo.run('UPDATE downloadables SET last_size = ?, last_checked_at = datetime(\'now\'), status = ? WHERE downloadable_id = ?', [
          result.size,
          'downloaded',
          job.downloadableId
        ])
      }
      // 跳过也必须补终态（开头已插 running），否则留下悬挂的 running 行
      this.repo.addDownloadRecord({
        downloadableId: job.downloadableId,
        itemId: job.itemId,
        source: job.source,
        status: result.skipped ? 'skipped' : 'done',
        bytesTotal: result.skipped ? null : result.size,
        bytesDone: result.skipped ? null : result.size,
        toPath: result.path,
        etag: result.etag,
        size: result.size
      })

      if (result.skipped) {
        log.info(`skipped: ${label} (up-to-date，指纹一致未重新下载) source=${job.source}`)
      } else {
        this.onDone?.({
          downloadableId: job.downloadableId,
          itemId: job.itemId,
          filename: result.filename,
          path: result.path,
          source: job.source,
          archivedPath
        })
        log.info(`done: ${label} (${result.size} bytes) source=${job.source}`)
      }
    } catch (e) {
      if (this.disposed) return // 进程退出竞态：DB 已关，丢弃记录
      const auth = isAuthError(e)
      const msg = e instanceof Error ? e.message : String(e)
      const cancelled = abort.signal.aborted && !auth
      if (cancelled) {
        // 暂停中断且已回队的任务保留 queued_at（重启恢复/继续排队）；
        // 用户显式取消的（已不在队列）才清 queued_at 回待下载
        const stillQueued = this.queue.some((j) => j.downloadableId === job.downloadableId)
        if (!stillQueued) this.repo.setQueuedAt(job.downloadableId, null)
        // 记 cancelled，不进失败重试列表、不弹错误
        this.repo.addDownloadRecord({
          downloadableId: job.downloadableId,
          itemId: job.itemId,
          source: job.source,
          status: 'cancelled'
        })
        log.info(`cancelled: ${label}`)
      } else {
        // 认证中断回队的保留 queued_at；真失败回失败态（清排队标记）
        const stillQueued = this.queue.some((j) => j.downloadableId === job.downloadableId)
        if (!stillQueued) this.repo.setQueuedAt(job.downloadableId, null)
        this.repo.addDownloadRecord({
          downloadableId: job.downloadableId,
          itemId: job.itemId,
          source: job.source,
          status: 'failed',
          error: msg
        })
        if (auth && !this.paused) {
          log.warn('auth error during download, pausing queue')
          this.pauseForAuth()
        }
        log.error(`failed: ${label}: ${msg}`)
        this.onError?.({ downloadableId: job.downloadableId, itemId: job.itemId, filename: label, error: msg, auth })
      }
    } finally {
      decide?.('started') // 兜底：probe 前抛错/取消时不让 downloadNow 的调用方悬挂（保持原“已开始”语义）
      this.active.delete(job.downloadableId)
      this.onQueueChanged?.()
      this.pump()
    }
  }

  private async downloadOne(
    job: Job,
    signal: AbortSignal,
    label: string,
    decide?: (r: 'started' | 'skipped') => void
  ): Promise<{ path: string; size: number; filename: string; etag: string | null; lastModified: string | null; archivedPath: string | null; skipped: boolean }> {
    const d = this.repo.getDownloadable(job.downloadableId)
    if (!d) throw new BoothError('链接不存在', 'invalid')

    // 即时 resolve（180s 过期规则）；失败时回退浏览器直下链接（zip 包装，需带 cookies）
    let resolved: { dlurl: string; filename: string } | null = null
    let fallbackUsed = false
    let fp: Fingerprint
    try {
      resolved = await this.deeplink.resolve(job.downloadableId, d.variationId)
      fp = await this.deeplink.probe(resolved.dlurl, signal)
    } catch (e) {
      if (isAuthError(e) || signal.aborted) throw e
      if (!d.fallbackUrl) throw e
      // 回退通道：booth.pm/downloadables/{id}（浏览器 Download 按钮，服务端打包 zip）
      fallbackUsed = true
      log.warn(`deeplink failed for ${job.downloadableId}, using fallback URL:`, e instanceof Error ? e.message : e)
      resolved = { dlurl: d.fallbackUrl, filename: `${d.filename || `downloadable_${job.downloadableId}`}.zip` }
      fp = { etag: null, size: null, lastModified: null, contentType: 'application/zip' }
    }
    const filename = sanitizeFilename(resolved.filename)
    // 下载根所在磁盘/父目录不存在（如外接盘未挂载）：直接失败，不在别处静默创建目录
    if (!existsSync(this.paths.rootPath) && !existsSync(dirname(this.paths.rootPath))) {
      throw new BoothError(`下载目录不可用（所在位置不存在）：${this.paths.rootPath}，请在设置中检查或重新指定下载目录`, 'invalid')
    }
    this.paths.ensureItemDownloadDirs(job.itemId)
    const finalPath = this.paths.currentFilePath(job.itemId, filename)
    const partPath = finalPath + '.part'
    const total = fp.size

    // 已存在同指纹文件且本地已是最新 → 跳过。
    // 注意：updateCheck 检测到更新后会立即把新指纹写入 DB，
    // 因此 status=update_available 时本地文件仍是旧版，绝不能跳过。
    // manual = 用户明确点击"重新下载"，即使指纹一致也强制拉取
    // deeplink = 网页深链自动接收：指纹一致时跳过（不重下不归档），给「已是最新」提示
    const localIsFresh = d.status === 'downloaded' && job.source !== 'manual'
    if (localIsFresh && existsSync(finalPath) && fp.etag && d.lastEtag === fp.etag && d.lastSize === fp.size) {
      decide?.('skipped')
      return { path: finalPath, size: statSync(finalPath).size, filename, etag: fp.etag, lastModified: fp.lastModified, archivedPath: null, skipped: true }
    }
    decide?.('started') // 探测完成、确认要下载（后台继续，不等下载结束）

    // Range 断点续传（.part 存在且 < 总大小）
    let startByte = 0
    if (existsSync(partPath)) {
      const partSize = statSync(partPath).size
      if (total != null && partSize > 0 && partSize < total) {
        startByte = partSize
      } else if (total != null && partSize >= total) {
        // .part 已完整，直接收尾（覆盖前归档旧文件）
        const archivedPath = this.archiveExisting(job, finalPath, filename, d)
        renameSync(partPath, finalPath)
        return { path: finalPath, size: statSync(finalPath).size, filename, etag: fp.etag, lastModified: fp.lastModified, archivedPath, skipped: false }
      } else {
        unlinkSync(partPath)
      }
    }

    const headers: Record<string, string> = {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    }
    if (startByte > 0) headers['range'] = `bytes=${startByte}-`
    if (fallbackUsed) {
      // 浏览器直下通道需要登录 cookies（S3 签名直链则不需要）
      if (this.jar) headers['cookie'] = await this.jar.cookieHeader(resolved.dlurl)
      // 不带 Referer：跨源带路径的 Referer 会被 Chromium 以 ERR_BLOCKED_BY_CLIENT 拦截，
      // 且直下端点已实测无 Referer 也返回 302 直链
    }

    let res: Response
    // 首字节 60s 超时：仅用独立 controller，拿到响应头后必须解除，
    // 否则信号会随 body 流继续生效，把大文件下载在 60s 时杀掉。
    // body 阶段的停滞由下方读取看门狗单独保护。
    const firstByteCtrl = new AbortController()
    const firstByteTimer = setTimeout(() => firstByteCtrl.abort(), 60_000)
    const firstByteSignal = AbortSignal.any([signal, firstByteCtrl.signal])
    try {
      res = await systemFetch(resolved.dlurl, { headers, signal: firstByteSignal, redirect: 'follow' })
    } catch (e) {
      if (signal.aborted) throw new BoothError('已取消', 'invalid')
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new BoothError('下载请求超时（60s 未获响应）', 'network')
      }
      throw new BoothError(`下载请求失败: ${e instanceof Error ? e.message : e}`, 'network')
    } finally {
      clearTimeout(firstByteTimer)
      // 解除首字节超时（保留用户取消能力：firstByteCtrl 不再触发）
    }
    if (res.status === 403) {
      // 签名过期（罕见，因为我们刚 resolve）→ 报错让上层重试
      throw new BoothError('签名直链 403（可能已过期）', 'invalid', 403)
    }
    if (!res.ok && res.status !== 206) {
      throw new BoothError(`下载失败 HTTP ${res.status}`, res.status >= 500 ? 'server' : 'invalid', res.status)
    }
    if (!res.body) throw new BoothError('响应无内容', 'network')

    const ws = createWriteStream(partPath, { flags: startByte > 0 ? 'a' : 'w' })
    const hash = startByte > 0 ? null : createHash('sha256') // 续传时放弃整体 hash（后续可重算）
    let done = startByte
    let lastProgressAt = Date.now()
    const reader = res.body.getReader()
    const STALL_TIMEOUT = 60_000 // 60 秒无数据视为连接停滞

    const cleanup = () => {
      reader.cancel().catch(() => {})
    }
    signal.addEventListener('abort', cleanup)

    // 监听器泄漏修复：drain 等待期间 error 监听必须成对移除
    const waitForDrain = (): Promise<void> =>
      new Promise<void>((ok, err) => {
        const onDrain = (): void => {
          ws.off('error', onError)
          ok()
        }
        const onError = (e: Error): void => {
          ws.off('drain', onDrain)
          err(e)
        }
        ws.once('drain', onDrain)
        ws.once('error', onError)
      })

    try {
      for (;;) {
        // 看门狗：限时等待下一块数据，防止服务器停滞导致永久挂起
        const readPromise = reader.read()
        let timer: NodeJS.Timeout | undefined
        const stallPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reader.cancel().catch(() => {})
            reject(new BoothError(`下载停滞（${STALL_TIMEOUT / 1000}s 无数据）`, 'network'))
          }, STALL_TIMEOUT)
        })
        let chunk: Awaited<typeof readPromise>
        try {
          chunk = await Promise.race([readPromise, stallPromise])
        } finally {
          clearTimeout(timer)
        }
        const { done: finished, value } = chunk
        if (finished) break
        if (value) {
          if (!ws.write(Buffer.from(value))) {
            await waitForDrain()
          }
          hash?.update(Buffer.from(value))
          done += value.byteLength
          const now = Date.now()
          if (now - lastProgressAt > 500) {
            lastProgressAt = now
            this.onProgress?.({
              downloadableId: job.downloadableId,
              itemId: job.itemId,
              filename,
              bytesDone: done,
              bytesTotal: total ?? 0
            })
          }
        }
      }
      await new Promise<void>((ok, err) => {
        const onErr = (e: Error): void => err(e)
        ws.once('error', onErr)
        ws.end(() => {
          ws.off('error', onErr)
          ok()
        })
      })
    } catch (e) {
      ws.destroy()
      if (signal.aborted) throw new BoothError('已取消', 'invalid')
      throw e instanceof BoothError ? e : new BoothError(`流中断: ${e instanceof Error ? e.message : e}`, 'network')
    } finally {
      signal.removeEventListener('abort', cleanup)
    }

    // 校验大小
    const actual = statSync(partPath).size
    if (total != null && actual !== total) {
      throw new BoothError(`大小校验失败: ${actual} != ${total}`, 'network')
    }

    // 覆盖前归档旧文件（历史备份：不删除任何旧数据）
    const archivedPath = this.archiveExisting(job, finalPath, filename, d)
    renameSync(partPath, finalPath)
    this.onProgress?.({ downloadableId: job.downloadableId, itemId: job.itemId, filename, bytesDone: actual, bytesTotal: actual })
    return { path: finalPath, size: actual, filename, etag: fp.etag, lastModified: fp.lastModified, archivedPath, skipped: false }
  }

  /**
   * 若 current 下已存在同名旧文件，将其移动到 history/{今日}/ 并记录 file_history。
   * 调用时机必须在 rename 覆盖之前。无旧文件或首次下载返回 null。
   */
  private archiveExisting(job: Job, finalPath: string, filename: string, d: { lastEtag: string | null; lastSize: number | null }): string | null {
    if (!existsSync(finalPath)) return null
    // 归档对象的真实大小以磁盘为准（DB 里的指纹可能已被 updateCheck 更新为新值）
    let oldSize: number | null = null
    try {
      oldSize = statSync(finalPath).size
    } catch {
      oldSize = d.lastSize
    }
    const archived = this.history.archivePath(job.itemId, finalPath)
    if (!archived) return null
    this.repo.addFileHistory({
      itemId: job.itemId,
      downloadableId: job.downloadableId,
      date: localDate(),
      archivedPath: archived,
      filename,
      etag: d.lastEtag,
      size: oldSize
    })
    log.info(`archive before replace: ${finalPath} → ${archived}`)
    return archived
  }
}
