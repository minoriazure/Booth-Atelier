import { basename, isAbsolute, resolve } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { STARTUP_INTERVALS, type Settings } from '../../shared/types'
import type { LibraryRepo } from '../db/repos'
import type { Paths } from '../util/paths'

const DEFAULTS: Omit<Settings, 'downloadRoot' | 'downloadRootMissing'> = {
  autoSyncLibraryOnStartup: true,
  autoCheckItemApiOnStartup: true,
  autoDownloadStartupApiUpdates: false,
  autoForceCheckFilesOnStartup: true,
  autoDownloadStartupFullCheckUpdates: false,
  autoCheckImagesOnStartup: true,
  themeMode: 'dark',
  themeAccent: '#4c8dff',
  startupLibrarySyncIntervalDays: STARTUP_INTERVALS.library.defaultValue,
  startupMetadataCheckIntervalHours: STARTUP_INTERVALS.itemApi.defaultValue,
  startupFullFileCheckIntervalDays: STARTUP_INTERVALS.fullFiles.defaultValue,
  downloadConcurrency: 3,
  minRequestIntervalMs: 250,
  proxyMode: 'system',
  customProxy: '',
  // cookiesPath = 纯覆盖项：'' 表示未指定，走默认查找链（exe 同级优先）。
  // 旧 DB 可能持久化过「首启默认路径」，消费侧仅当路径真实存在时才当作覆盖。
  cookiesPath: '',
  autoRegisterDeepLink: true,
  logRetentionDays: 60,
  lastLibrarySyncAt: null,
  firstLibrarySyncAt: null,
  lastGlobalCheckAt: null
}

function boundedInterval(value: unknown, { min, max, defaultValue }: { min: number; max: number; defaultValue: number }): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : defaultValue
}

export class SettingsService {
  constructor(
    private repo: LibraryRepo,
    private paths: Paths,
    /** 默认下载根（portable = exe 同级 downloads）：运行时计算，不落库 */
    private defaultRoot: string
  ) {}

  get(): Settings {
    const keys = Object.keys(DEFAULTS)
    const stored: Record<string, unknown> = {}
    for (const k of keys) stored[k] = this.repo.getSetting(k, DEFAULTS[k as keyof typeof DEFAULTS])
    // 旧共享天数只迁入库同步，原全量检查开关继续控制全量检查。
    const legacyDays = this.repo.getSetting('startupCheckIntervalDays', DEFAULTS.startupLibrarySyncIntervalDays)
    const legacyForceEnabled = this.repo.getSetting('autoCheckFilesOnStartup', DEFAULTS.autoForceCheckFilesOnStartup)
    const forceEnabled = this.repo.getSetting('autoForceCheckFilesOnStartup', legacyForceEnabled)

    const downloadRoot = this.resolveDownloadRoot()
    const cookiesPath = this.repo.getSetting<string>('cookiesPath', '')
    return {
      ...DEFAULTS,
      ...stored,
      autoForceCheckFilesOnStartup: typeof forceEnabled === 'boolean' ? forceEnabled : DEFAULTS.autoForceCheckFilesOnStartup,
      startupLibrarySyncIntervalDays: boundedInterval(this.repo.getSetting('startupLibrarySyncIntervalDays', legacyDays), STARTUP_INTERVALS.library),
      startupMetadataCheckIntervalHours: boundedInterval(stored.startupMetadataCheckIntervalHours, STARTUP_INTERVALS.itemApi),
      startupFullFileCheckIntervalDays: boundedInterval(stored.startupFullFileCheckIntervalDays, STARTUP_INTERVALS.fullFiles),
      downloadRoot,
      downloadRootMissing: !existsSync(downloadRoot) && downloadRoot !== this.defaultRoot,
      cookiesPath
    } as Settings
  }

  /** DB 里是否已保存过用户指定的下载根（默认值不落库，所以仅 custom 才算） */
  hasCustomDownloadRoot(): boolean {
    return this.repo.getSetting<string>('downloadRootSource', '') === 'custom'
  }

  /**
   * 解析下载根：
   * - 未设置 → 当前默认目录（随 exe 位置变化，整目录搬家即生效）
   * - 旧版本把「首启默认绝对路径」写进了 DB：该路径已不存在且目录名为 downloads 时视为旧默认值，回落到当前默认目录
   * - 其余（用户自定义）→ 按存储值还原；目录缺失时保持原设置（由 UI 告警，不静默回退）
   */
  private resolveDownloadRoot(): string {
    const stored = this.repo.getSetting<string>('downloadRoot', '')
    if (!stored) return this.defaultRoot
    const abs = this.paths.decodeRootSetting(stored)
    const isLegacyDefault =
      !this.hasCustomDownloadRoot() && isAbsolute(stored) && !existsSync(abs) && basename(abs).toLowerCase() === 'downloads'
    return isLegacyDefault ? this.defaultRoot : abs
  }

  set(patch: Partial<Settings>): Settings {
    const nextRoot = patch.downloadRoot === undefined ? null : resolve(patch.downloadRoot)
    if (nextRoot) mkdirSync(nextRoot, { recursive: true })
    this.repo.transaction(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue
        if (k === 'downloadRoot') {
          const abs = resolve(String(v))
          this.repo.setSetting('downloadRoot', this.paths.encodeRootSetting(abs))
          this.repo.setSetting('downloadRootSource', 'custom')
          continue
        }
        this.repo.setSetting(k, v)
      }
    })
    if (nextRoot) this.paths.setRoot(nextRoot)
    return this.get()
  }
}
