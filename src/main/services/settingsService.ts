import { join, resolve } from 'path'
import { existsSync, mkdirSync } from 'fs'
import type { Settings } from '../../shared/types'
import type { LibraryRepo } from '../db/repos'
import type { Paths } from '../util/paths'

const DEFAULTS: Omit<Settings, 'downloadRoot'> = {
  autoSyncLibraryOnStartup: true,
  autoCheckFilesOnStartup: true,
  themeMode: 'dark',
  themeAccent: '#4c8dff',
  startupCheckIntervalDays: 7,
  autoDownloadUpdates: true,
  downloadConcurrency: 3,
  minRequestIntervalMs: 250,
  proxyMode: 'system',
  customProxy: '',
  // cookiesPath = 纯覆盖项：'' 表示未指定，走默认查找链（exe 同级优先）。
  // 旧 DB 可能持久化过「首启默认路径」，消费侧仅当路径真实存在时才当作覆盖。
  cookiesPath: '',
  autoRegisterDeepLink: true,
  lastLibrarySyncAt: null,
  lastGlobalCheckAt: null
}

export class SettingsService {
  constructor(
    private repo: LibraryRepo,
    private paths: Paths
  ) {}

  get(): Settings {
    const keys = Object.keys(DEFAULTS)
    const stored: Record<string, unknown> = {}
    for (const k of keys) stored[k] = this.repo.getSetting(k, DEFAULTS[k as keyof typeof DEFAULTS])

    let downloadRoot = this.repo.getSetting<string>('downloadRoot', '')
    if (!downloadRoot) {
      downloadRoot = join(this.paths.rootPath || resolve('.'), '')
      this.repo.setSetting('downloadRoot', downloadRoot)
    }
    const cookiesPath = this.repo.getSetting<string>('cookiesPath', '')
    return { ...DEFAULTS, ...stored, downloadRoot, cookiesPath } as Settings
  }

  /** DB 里是否已保存过下载根（区分首次启动默认值） */
  hasDownloadRoot(): boolean {
    const v = this.repo.getSetting<string>('downloadRoot', '')
    return !!v
  }

  set(patch: Partial<Settings>): Settings {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      this.repo.setSetting(k, v)
      if (k === 'downloadRoot') {
        this.paths.setRoot(v as string)
        mkdirSync(v as string, { recursive: true })
      }
    }
    return this.get()
  }
}
