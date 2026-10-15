import type { AuthChecker } from '../booth/auth'
import type { LibrarySyncService } from './librarySyncService'
import type { UpdateCheckService } from './updateCheckService'
import type { SettingsService } from './settingsService'
import type { CheckProgressEvent, CheckSummary } from '../../shared/types'
import { isAuthError } from '../booth/errors'
import { createLogger } from '../util/log'

const log = createLogger('startup')

export interface StartupResult {
  authOk: boolean
  authError?: string
  summary?: CheckSummary
  error?: string
}

/**
 * 启动编排：认证探测 → (可选)库同步 → (可选)全局文件检查。
 * 每步失败可独立降级（例如库同步失败但下载队列仍可工作）。
 */
export class StartupService {
  onProgress: ((e: CheckProgressEvent) => void) | null = null
  onAuthExpired: ((message: string) => void) | null = null

  constructor(
    private auth: AuthChecker,
    private sync: LibrarySyncService,
    private checker: UpdateCheckService,
    private settings: SettingsService
  ) {}

  async runOnStartup(): Promise<StartupResult> {
    const s = this.settings.get()
    const result: StartupResult = { authOk: false }

    try {
      await this.auth.check()
      result.authOk = true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      result.authError = msg
      if (isAuthError(e)) this.onAuthExpired?.(msg)
      log.warn('startup auth failed:', msg)
      return result
    }

    // 两个独立开关：库同步（元数据）与文件更新检查
    if (!s.autoSyncLibraryOnStartup && !s.autoCheckFilesOnStartup) {
      log.info('startup auto checks disabled, skip')
      return result
    }

    // 时间间隔门控：基于【上次全局检查时间】（非单个商品），手动检查不受影响。
    // interval=0 → 禁用间隔，每次启动都查；两类检查各用自己的全局时间戳独立判断。
    const intervalDays = s.startupCheckIntervalDays
    const due = (lastIso: string | null): boolean => {
      if (intervalDays <= 0) return true // 0 = 每次启动检查
      if (!lastIso) return true // 从未检查过
      const t = Date.parse(lastIso)
      if (isNaN(t)) return true
      return Date.now() - t >= intervalDays * 86_400_000
    }
    const libraryDue = due(s.lastLibrarySyncAt)
    const fileDue = due(s.lastGlobalCheckAt)
    log.info(`startup interval gate: ${intervalDays}d, libraryDue=${libraryDue} (last=${s.lastLibrarySyncAt}), fileDue=${fileDue} (last=${s.lastGlobalCheckAt})`)
    if (!libraryDue && !fileDue) {
      log.info('both checks within interval, skip')
      return result
    }

    try {
      let syncSummary: CheckSummary | null = null
      if (s.autoSyncLibraryOnStartup && libraryDue) {
        syncSummary = await this.sync.sync()
        this.onProgress?.({ phase: 'library', current: 0, total: 0, label: '库同步完成' })
      }
      let checkSummary: CheckSummary | null = null
      if (s.autoCheckFilesOnStartup && fileDue) {
        checkSummary = await this.checker.checkGlobal()
      }
      const zero: CheckSummary = { libraryChecked: 0, libraryChanged: 0, filesChecked: 0, filesUpdated: 0, downloaded: 0, failed: 0 }
      const a = syncSummary ?? zero
      const b = checkSummary ?? zero
      result.summary = {
        libraryChecked: a.libraryChecked + b.libraryChecked,
        libraryChanged: a.libraryChanged + b.libraryChanged,
        filesChecked: a.filesChecked + b.filesChecked,
        filesUpdated: a.filesUpdated + b.filesUpdated,
        downloaded: a.downloaded + b.downloaded,
        failed: a.failed + b.failed
      }
      log.info('startup done:', JSON.stringify(result.summary))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      result.error = msg
      if (isAuthError(e)) {
        this.onAuthExpired?.(msg)
        result.authOk = false
      }
      log.warn('startup sync/check failed:', msg)
    }
    return result
  }
}
