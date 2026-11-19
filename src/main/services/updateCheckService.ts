import { existsSync } from 'fs'
import type { DeeplinkClient } from '../booth/deeplink'
import type { LibraryRepo } from '../db/repos'
import type { DownloadManager } from './downloadManager'
import type { CheckProgressEvent, CheckSummary, Fingerprint } from '../../shared/types'
import { isAuthError, BoothError } from '../booth/errors'
import { createLogger, describeLink } from '../util/log'

const log = createLogger('updateCheck')
/** 单次检查结束时逐条列出的失败上限，超出部分只写数量 */
const FAILURE_LIST_LIMIT = 50
const pendingGlobalCheckKey = 'pendingGlobalFileCheckIds'
const startupDownloadKeys = { api: 'pendingStartupApiDownloadIds', full: 'pendingStartupFullDownloadIds' } as const
type StartupDownloadSource = keyof typeof startupDownloadKeys
export type ProbeBaseline = Pick<Fingerprint, 'etag' | 'size'>

export interface FileProbeBatch {
  attemptedIds: Set<number>
  checkedIds: Set<number>
  /** 仅保留全量检查自身也能确认的变化，排除纯 API 时间戳提示。 */
  fingerprintUpdates: Set<number>
}

interface GlobalCheckOptions {
  batch?: FileProbeBatch
  resume?: boolean
}

/**
 * 文件级更新检查（用户需求 #1，比官方更细：精确到每个下载链接）：
 * deeplink resolve → Range probe 指纹 (etag, size, filename) → 与 DB 比对。
 * 变更 → status=update_available → 按设置自动入队下载。
 * 两个范围：checkGlobal（全部）/ checkItem（单商品全部链接）。
 */
export class UpdateCheckService {
  private running = false

  onProgress: ((e: CheckProgressEvent) => void) | null = null

  constructor(
    private deeplink: DeeplinkClient,
    private repo: LibraryRepo,
    private downloads: DownloadManager
  ) {}

  get isRunning(): boolean {
    return this.running
  }

  get hasPendingGlobalCheck(): boolean {
    return this.repo.getSetting<number[]>(pendingGlobalCheckKey, []).length > 0
  }

  enqueueUpdates(ids: ReadonlySet<number>): number {
    const pending = [...ids].filter((id) => this.repo.getDownloadable(id)?.status === 'update_available')
    return pending.length ? this.downloads.enqueueMany(pending, 'update') : 0
  }

  deferStartupDownloads(source: StartupDownloadSource, ids: Iterable<number>): void {
    const added = [...ids]
    if (!added.length) return
    const key = startupDownloadKeys[source]
    const previous = this.repo.getSetting<number[]>(key, [])
    this.repo.setSetting(key, [...new Set([...previous, ...added])])
  }

  flushStartupDownloads(apiEnabled: boolean, fullEnabled: boolean): number {
    const apiKey = startupDownloadKeys.api
    const fullKey = startupDownloadKeys.full
    const api = this.repo.getSetting<number[]>(apiKey, [])
    const full = this.repo.getSetting<number[]>(fullKey, [])
    const queued = this.enqueueUpdates(new Set([...(apiEnabled ? api : []), ...(fullEnabled ? full : [])]))
    if (api.length) this.repo.setSetting(apiKey, [])
    if (full.length) this.repo.setSetting(fullKey, [])
    return queued
  }

  async checkGlobal(autoDownload = false, options: GlobalCheckOptions = {}): Promise<CheckSummary> {
    if (this.running) throw new Error('检查已在进行中')
    const targets = this.repo.listAllDownloadables()
    const previous = this.repo.getSetting<number[]>(pendingGlobalCheckKey, [])
    const resumeIds = options.resume && previous.length ? new Set(previous) : null
    const pending = targets.filter((target) => !resumeIds || resumeIds.has(target.downloadableId))
    const batch = options.batch ?? { attemptedIds: new Set<number>(), checkedIds: new Set<number>(), fingerprintUpdates: new Set<number>() }
    const unprobed = pending.filter(({ downloadableId }) => !batch.attemptedIds.has(downloadableId))
    const reused = pending.filter(({ downloadableId }) => batch.checkedIds.has(downloadableId)).length
    const reusedFailures = pending.length - unprobed.length - reused
    const remaining = () => pending.flatMap(({ downloadableId }) => batch.checkedIds.has(downloadableId) ? [] : [downloadableId])
    const updated = () => new Set(pending.flatMap(({ downloadableId }) => batch.fingerprintUpdates.has(downloadableId) ? [downloadableId] : []))
    this.repo.setSetting('lastGlobalCheckAttemptAt', new Date().toISOString())
    this.repo.setSetting(pendingGlobalCheckKey, remaining())
    log.info(`global file check start: ${unprobed.length} link(s), reused=${reused}`)
    try {
      const summary = await this.checkMany(unprobed, '全局', true, undefined, undefined, batch)
      const confirmed = updated()
      summary.filesChecked += reused
      summary.failed += reusedFailures
      summary.filesUpdated = confirmed.size
      if (autoDownload && !options.resume) summary.downloaded = this.enqueueUpdates(confirmed)
      const retryIds = remaining()
      summary.filesRemaining = retryIds.length
      if (!retryIds.length && (pending.length || previous.length)) {
        this.repo.setSetting('lastGlobalCheckAt', new Date().toISOString())
      }
      log.info(`global file check done: ${JSON.stringify(summary)}, remaining=${retryIds.length}`)
      return summary
    } finally {
      if (autoDownload && options.resume) this.deferStartupDownloads('full', updated())
      this.repo.setSetting(pendingGlobalCheckKey, remaining())
    }
  }

  async checkItem(itemId: number): Promise<CheckSummary> {
    // 免费商品不参与文件更新检查（作者限定免费，下载后即收费，不会进入用户库）
    if (this.repo.isFreeItem(itemId)) {
      log.info(`item #${itemId} check skipped: free item`)
      return { libraryChecked: 0, libraryChanged: 0, filesChecked: 0, filesUpdated: 0, downloaded: 0, failed: 0 }
    }
    const targets = this.repo.listDownloadablesOfItem(itemId)
    const title = targets[0]?.itemTitle ?? ''
    log.info(`item #${itemId}${title ? `「${title.slice(0, 40)}」` : ''} file check start: ${targets.length} link(s)`)
    const s = await this.checkMany(targets, `商品 ${itemId}`)
    log.info(`item #${itemId} file check done: ${JSON.stringify(s)}`)
    return s
  }

  checkSelected(
    itemId: number, ids: ReadonlySet<number>, apiChangedFiles?: ReadonlySet<number>, updatedIds?: Set<number>,
    batch?: FileProbeBatch, apiBaselines?: Readonly<Record<number, ProbeBaseline>>
  ): Promise<CheckSummary> {
    const targets = this.repo.listDownloadablesOfItem(itemId).filter((entry) => ids.has(entry.downloadableId))
    return this.checkMany(targets, `商品 ${itemId}`, false, apiChangedFiles, updatedIds, batch, apiBaselines)
  }

  private async checkMany(
    targets: Array<{ downloadableId: number; itemId: number; itemTitle: string; filename: string; variationId: number | null; status: string; lastEtag: string | null; lastSize: number | null; localPath?: string | null }>,
    label: string,
    showProgress = true,
    apiChangedFiles?: ReadonlySet<number>,
    updatedIds?: Set<number>,
    batch?: FileProbeBatch,
    apiBaselines?: Readonly<Record<number, ProbeBaseline>>
  ): Promise<CheckSummary> {
    if (this.running) throw new Error('检查已在进行中')
    this.running = true
    const summary: CheckSummary = { libraryChecked: 0, libraryChanged: 0, filesChecked: 0, filesUpdated: 0, downloaded: 0, failed: 0 }
    const failures: string[] = []
    let consecutiveLimited = 0
    try {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i]
        if (batch?.attemptedIds.has(t.downloadableId)) continue
        batch?.attemptedIds.add(t.downloadableId)
        const desc = describeLink(t)
        if (showProgress) this.onProgress?.({ phase: 'files', current: i + 1, total: targets.length, label: `${label} ${t.filename || t.downloadableId}` })
        let stage: 'resolve' | 'probe' = 'resolve'
        try {
          let resolved = await this.deeplink.resolve(t.downloadableId, t.variationId)
          stage = 'probe'
          const fp = await this.deeplink.probe(resolved.dlurl).catch(async (error: unknown) => {
            if (!(error instanceof BoothError) || (error.kind !== 'invalid' && error.kind !== 'not_found')) throw error
            stage = 'resolve'
            resolved = await this.deeplink.resolve(t.downloadableId, t.variationId)
            stage = 'probe'
            return this.deeplink.probe(resolved.dlurl)
          })
          consecutiveLimited = 0
          const current = this.repo.getDownloadable(t.downloadableId)
          if (!current || current.status === 'missing') {
            batch?.checkedIds.add(t.downloadableId)
            continue
          }
          if (this.downloads.isActive(t.downloadableId)) {
            throw new BoothError('下载仍在进行，文件检查将稍后重试', 'invalid')
          }
          const downloadChanged = current.status === 'downloaded' &&
            (t.status !== current.status || t.localPath !== current.localPath ||
              t.lastEtag !== current.lastEtag || t.lastSize !== current.lastSize)
          if (downloadChanged) {
            // 探测可能对应下载完成前的对象。只有能确认当前下载结果时才结清。
            if (fp.etag == null || fp.etag !== current.lastEtag ||
                (fp.size != null && current.lastSize != null && fp.size !== current.lastSize)) {
              throw new BoothError('探测期间下载记录已变化，文件检查将稍后重试', 'invalid')
            }
            summary.filesChecked++
            batch?.checkedIds.add(t.downloadableId)
            continue
          }
          summary.filesChecked++

          const etagChanged = fp.etag != null && current.lastEtag != null && fp.etag !== current.lastEtag
          const sizeChanged = fp.size != null && current.lastSize != null && fp.size !== current.lastSize
          const firstFingerprint = current.lastEtag == null && current.lastSize == null
          const remoteChanged = etagChanged || sizeChanged
          const apiBaseline = apiBaselines?.[t.downloadableId]
          const apiRetryConfirmed = apiBaseline && current.status === 'update_available' &&
            ((fp.etag != null && apiBaseline.etag != null && fp.etag !== apiBaseline.etag) ||
              (fp.size != null && apiBaseline.size != null && fp.size !== apiBaseline.size))
          const apiChangeWithoutComparableEtag = apiChangedFiles?.has(t.downloadableId) &&
            ((apiBaseline ? apiBaseline.etag : current.lastEtag) == null || fp.etag == null) && current.status !== 'update_available'

          // 本地文件缺失但库中认为已下载 → 视为需要重新下载
          const localMissing = current.status === 'downloaded' && (!current.lastEtag || !existsSync(current.localPath || ''))

          if (remoteChanged || localMissing || apiChangeWithoutComparableEtag || apiRetryConfirmed) {
            this.repo.setStatus(t.downloadableId, 'update_available')
            summary.filesUpdated++
            updatedIds?.add(t.downloadableId)
            if (remoteChanged || localMissing) batch?.fingerprintUpdates.add(t.downloadableId)
            const reason = remoteChanged
              ? `远端变化 ${etagChanged ? `etag ${current.lastEtag}→${fp.etag}` : ''}${sizeChanged ? ` size ${current.lastSize}→${fp.size}` : ''}`.trim()
              : localMissing ? '本地文件缺失，需重新下载'
                : apiRetryConfirmed ? 'API 待核对文件的变化已由其他检查确认' : 'API 文件时间发生变化，购买库已核实可下载'
            log.info(`update: ${desc} ${reason}`)
            // 老文件立即归档到历史（同名覆盖与改名 _V2 两种情况统一：历史里永远保留旧版本）
            if (remoteChanged) {
              try {
                this.downloads.archiveCurrentFile(t.downloadableId)
              } catch (e) {
                log.warn(`archive old file failed: ${desc}:`, e instanceof Error ? e.message : e)
              }
            }
          } else if (!firstFingerprint && current.status === 'remote' && current.localPath && existsSync(current.localPath)) {
            this.repo.setStatus(t.downloadableId, 'downloaded')
          }
          this.repo.updateFingerprint(t.downloadableId, {
            etag: fp.etag,
            size: fp.size,
            lastModified: fp.lastModified,
            filename: resolved.filename
          })
          batch?.checkedIds.add(t.downloadableId)
        } catch (e) {
          if (isAuthError(e)) throw e
          summary.failed++
          const msg = e instanceof Error ? e.message : String(e)
          const status = e instanceof BoothError && e.status != null ? ` http=${e.status}` : ''
          const failLine = `${desc} stage=${stage}${status} → ${msg}`
          if (failures.length < FAILURE_LIST_LIMIT) failures.push(failLine)
          if (e instanceof BoothError && e.kind === 'not_found') {
            log.warn(`download endpoint not found; keeping library link: ${desc} stage=${stage}${status} → ${msg}`)
          } else if (e instanceof BoothError && e.kind === 'rate_limited') {
            // 被 BOOTH 限流：冷却 2s 再继续，连续 5 次熔断（避免雪崩式骚扰）
            consecutiveLimited++
            log.warn(`rate limited (${consecutiveLimited}/5): ${failLine}`)
            if (consecutiveLimited >= 5) {
              const remaining = targets.length - i - 1
              log.warn(`too many rate limits, aborting ${label} check early: stopped at ${desc}, ${remaining} link(s) not checked (可稍后手动重试)`)
              break
            }
            await new Promise((r) => setTimeout(r, 2000))
          } else {
            log.warn(`check failed: ${failLine}`)
          }
        }
      }

      if (failures.length > 0) {
        log.warn(`${label} failed links (${summary.failed}${summary.failed > failures.length ? `, 仅列出前 ${failures.length} 条` : ''}):`)
        for (const line of failures) log.warn(`  - ${line}`)
      }

      return summary
    } finally {
      this.running = false
      if (showProgress) this.onProgress?.({ phase: 'files', current: 0, total: 0 })
    }
  }
}
