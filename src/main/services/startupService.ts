import type { AuthChecker } from '../booth/auth'
import type { ScopedLibraryItem } from '../booth/libraryCrawler'
import type { LibrarySyncService } from './librarySyncService'
import type { FileProbeBatch, UpdateCheckService } from './updateCheckService'
import type { SettingsService } from './settingsService'
import type { CheckSummary } from '../../shared/types'
import { isAuthError } from '../booth/errors'
import { createLogger } from '../util/log'

const log = createLogger('startup')

export interface StartupResult {
  authOk: boolean
  authError?: string
  summary?: CheckSummary
  error?: string
}

interface StartupApiCheck {
  intervalHours: number
  canCheckLibrary: boolean
  verifiedItems: ReadonlyMap<number, ScopedLibraryItem>
  batch: FileProbeBatch
  onAuthExpired: (message: string) => void
  enqueueUpdates?: (ids: number[]) => void
}

/**
 * 启动编排：认证探测 → (可选)库同步 → (可选)全局文件检查。
 * 每步失败可独立降级（例如库同步失败但下载队列仍可工作）。
 */
export class StartupService {
  onAuthExpired: ((message: string) => void) | null = null

  constructor(
    private auth: AuthChecker,
    private sync: LibrarySyncService,
    private checker: UpdateCheckService,
    private settings: SettingsService
  ) {}

  async runOnStartup(
    startItemApiCheck?: (options: StartupApiCheck) => void | Promise<void>
  ): Promise<StartupResult> {
    const s = this.settings.get()
    const hadLibrary = this.sync.hasItems()
    const result: StartupResult = { authOk: false }

    try {
      await this.auth.check()
      result.authOk = true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      result.authError = msg
      if (isAuthError(e)) this.onAuthExpired?.(msg)
      log.warn('startup auth failed:', msg)
    }

    const due = (lastIso: string | null, intervalDays: number): boolean => {
      if (intervalDays === 0) return true
      if (!lastIso) return true // 从未检查过
      const t = Date.parse(lastIso)
      if (isNaN(t)) return true
      return Date.now() - t >= intervalDays * 86_400_000
    }
    const libraryDue = result.authOk && s.autoSyncLibraryOnStartup && due(s.lastLibrarySyncAt, s.startupLibrarySyncIntervalDays)
    const fullCheckAnchor = s.lastGlobalCheckAt ?? s.firstLibrarySyncAt ?? s.lastLibrarySyncAt
    const fileDue = result.authOk && hadLibrary && s.autoForceCheckFilesOnStartup &&
      (this.checker.hasPendingGlobalCheck || (!!fullCheckAnchor && due(fullCheckAnchor, s.startupFullFileCheckIntervalDays)))
    log.info(`startup: libraryDue=${libraryDue} (${s.startupLibrarySyncIntervalDays}d), fullFilesDue=${fileDue} (${s.startupFullFileCheckIntervalDays}d)`)

    const reportFailure = (label: string, error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error)
      result.error = result.error ? `${result.error} · ${message}` : message
      if (isAuthError(error)) {
        this.onAuthExpired?.(message)
        result.authOk = false
      }
      log.warn(`startup ${label} failed:`, message)
    }

    let syncSummary: CheckSummary | null = null
    const checkApi = hadLibrary && s.autoCheckItemApiOnStartup && startItemApiCheck
    const verifiedItems = new Map<number, ScopedLibraryItem>()
    if (libraryDue) {
      try {
        syncSummary = await this.sync.sync(checkApi ? verifiedItems : undefined)
      } catch (error) {
        verifiedItems.clear()
        reportFailure('library sync', error)
      }
    }
    const batch: FileProbeBatch = { attemptedIds: new Set(), checkedIds: new Set(), fingerprintUpdates: new Set() }
    const apiAutoDownload = s.autoCheckItemApiOnStartup && s.autoDownloadStartupApiUpdates
    const fullAutoDownload = s.autoForceCheckFilesOnStartup && s.autoDownloadStartupFullCheckUpdates
    if (checkApi) {
      await checkApi({
        intervalHours: s.startupMetadataCheckIntervalHours,
        canCheckLibrary: result.authOk,
        verifiedItems,
        batch,
        onAuthExpired: (message) => {
          result.authOk = false
          result.authError = message
          this.onAuthExpired?.(message)
        },
        enqueueUpdates: apiAutoDownload ? (ids) => this.checker.deferStartupDownloads('api', ids) : undefined
      })
    }

    let checkSummary: CheckSummary | null = null
    if (fileDue && result.authOk) {
      try {
        checkSummary = await this.checker.checkGlobal(fullAutoDownload, { batch, resume: true })
      } catch (error) {
        reportFailure('full file check', error)
      }
    }
    const enqueued = result.authOk ? this.checker.flushStartupDownloads(apiAutoDownload, fullAutoDownload) : 0
    if (syncSummary || checkSummary) {
      const zero: CheckSummary = { libraryChecked: 0, libraryChanged: 0, filesChecked: 0, filesUpdated: 0, downloaded: 0, failed: 0 }
      const a = syncSummary ?? zero
      const b = checkSummary ?? zero
      result.summary = {
        libraryChecked: a.libraryChecked + b.libraryChecked,
        library: a.library,
        libraryChanged: a.libraryChanged + b.libraryChanged,
        filesChecked: a.filesChecked + b.filesChecked,
        filesUpdated: a.filesUpdated + b.filesUpdated,
        filesRemaining: checkSummary?.filesRemaining,
        downloaded: a.downloaded + b.downloaded + enqueued,
        failed: a.failed + b.failed
      }
      log.info('startup done:', JSON.stringify(result.summary))
    }
    return result
  }
}
