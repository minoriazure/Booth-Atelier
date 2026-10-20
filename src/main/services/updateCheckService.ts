import { existsSync } from 'fs'
import type { DeeplinkClient } from '../booth/deeplink'
import type { LibraryRepo } from '../db/repos'
import type { DownloadManager } from './downloadManager'
import type { CheckProgressEvent, CheckSummary } from '../../shared/types'
import { isAuthError, BoothError } from '../booth/errors'
import { createLogger } from '../util/log'

const log = createLogger('updateCheck')

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
    private downloads: DownloadManager,
    private getAutoDownload: () => boolean
  ) {}

  get isRunning(): boolean {
    return this.running
  }

  async checkGlobal(): Promise<CheckSummary> {
    const targets = this.repo.listAllDownloadables()
    return this.checkMany(targets, '全局')
  }

  async checkItem(itemId: number): Promise<CheckSummary> {
    // 免费商品不参与文件更新检查（作者限定免费，下载后即收费，不会进入用户库）
    if (this.repo.isFreeItem(itemId)) {
      return { libraryChecked: 0, libraryChanged: 0, filesChecked: 0, filesUpdated: 0, downloaded: 0, failed: 0 }
    }
    const targets = this.repo.listDownloadablesOfItem(itemId)
    return this.checkMany(targets, `商品 ${itemId}`)
  }

  private async checkMany(
    targets: Array<{ downloadableId: number; itemId: number; filename: string; variationId: number | null; status: string; lastEtag: string | null; lastSize: number | null; localPath?: string | null }>,
    label: string
  ): Promise<CheckSummary> {
    if (this.running) throw new Error('检查已在进行中')
    this.running = true
    const summary: CheckSummary = { libraryChecked: 0, libraryChanged: 0, filesChecked: 0, filesUpdated: 0, downloaded: 0, failed: 0 }
    const toDownload: number[] = []
    let consecutiveLimited = 0
    try {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i]
        this.onProgress?.({ phase: 'files', current: i + 1, total: targets.length, label: `${label} ${t.filename || t.downloadableId}` })
        try {
          const resolved = await this.deeplink.resolve(t.downloadableId, t.variationId)
          const fp = await this.deeplink.probe(resolved.dlurl)
          summary.filesChecked++
          consecutiveLimited = 0

          const etagChanged = fp.etag != null && t.lastEtag != null && fp.etag !== t.lastEtag
          const sizeChanged = fp.size != null && t.lastSize != null && fp.size !== t.lastSize
          const firstFingerprint = t.lastEtag == null && t.lastSize == null
          const remoteChanged = etagChanged || sizeChanged

          // 本地文件缺失但库中认为已下载 → 视为需要重新下载
          const localMissing = t.status === 'downloaded' && (!t.lastEtag || !existsSync(t.localPath || ''))

          this.repo.updateFingerprint(t.downloadableId, {
            etag: fp.etag,
            size: fp.size,
            lastModified: fp.lastModified,
            filename: resolved.filename
          })

          if (remoteChanged || localMissing) {
            this.repo.setStatus(t.downloadableId, 'update_available')
            summary.filesUpdated++
            toDownload.push(t.downloadableId)
            log.info(`update: item=${t.itemId} file=${t.filename} ${t.lastSize}→${fp.size}`)
            // 老文件立即归档到历史（同名覆盖与改名 _V2 两种情况统一：历史里永远保留旧版本）
            if (remoteChanged) {
              try {
                this.downloads.archiveCurrentFile(t.downloadableId)
              } catch (e) {
                log.warn('archive old file failed:', e instanceof Error ? e.message : e)
              }
            }
          } else if (!firstFingerprint) {
            // 指纹已知且未变：若已下载保持 downloaded，否则 remote
            const cur = this.repo.getDownloadable(t.downloadableId)
            if (cur?.status === 'update_available') {
              // 检查中发现其实没变（上次标记过期）→ 回退
              if (cur.localPath && existsSync(cur.localPath)) {
                this.repo.setStatus(t.downloadableId, 'downloaded')
              } else {
                this.repo.setStatus(t.downloadableId, 'remote')
              }
            } else if (cur?.status === 'remote' && cur.localPath && existsSync(cur.localPath)) {
              this.repo.setStatus(t.downloadableId, 'downloaded')
            }
          } else {
            // 首次指纹：记录但不触发下载（拉库≠下载，符合需求 #3）
            if (t.status === 'downloaded') this.repo.setStatus(t.downloadableId, 'downloaded')
          }
        } catch (e) {
          if (isAuthError(e)) throw e
          summary.failed++
          const msg = e instanceof Error ? e.message : String(e)
          if (e instanceof BoothError && e.kind === 'not_found') {
            this.repo.setStatus(t.downloadableId, 'missing')
            log.warn(`missing: ${t.downloadableId} ${t.filename}`)
          } else if (e instanceof BoothError && e.kind === 'rate_limited') {
            // 被 BOOTH 限流：冷却 2s 再继续，连续 5 次熔断（避免雪崩式骚扰）
            consecutiveLimited++
            log.warn(`rate limited (${consecutiveLimited}/5): ${msg}`)
            if (consecutiveLimited >= 5) {
              log.warn('too many rate limits, aborting check early (可稍后手动重试)')
              break
            }
            await new Promise((r) => setTimeout(r, 2000))
          } else {
            log.warn(`check failed ${t.downloadableId}: ${msg}`)
          }
        }
      }

      // 自动下载检测到的更新
      if (toDownload.length > 0 && this.getAutoDownload()) {
        this.onProgress?.({ phase: 'download', current: 0, total: toDownload.length, label: '自动下载更新…' })
        const n = this.downloads.enqueueMany(toDownload, 'update')
        summary.downloaded = n
      }

      if (label === '全局') {
        this.repo.setSetting('lastGlobalCheckAt', new Date().toISOString())
      }
      return summary
    } finally {
      this.running = false
    }
  }
}
