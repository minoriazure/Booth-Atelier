import { z } from 'zod'
import { STARTUP_INTERVALS } from '../../shared/types'

export const settingsPatch = z.object({
  downloadRoot: z.string().trim().min(1).max(32767),
  cookiesPath: z.string().trim().max(32767),
  autoRegisterDeepLink: z.boolean(), logRetentionDays: z.number().int().min(7).max(180),
  autoSyncLibraryOnStartup: z.boolean(), autoCheckItemApiOnStartup: z.boolean(), autoForceCheckFilesOnStartup: z.boolean(),
  autoCheckImagesOnStartup: z.boolean(),
  autoDownloadStartupApiUpdates: z.boolean(), autoDownloadStartupFullCheckUpdates: z.boolean(),
  themeMode: z.enum(['dark', 'light']), themeAccent: z.string().regex(/^#[0-9a-f]{6}$/i),
  startupLibrarySyncIntervalDays: z.number().int().min(STARTUP_INTERVALS.library.min).max(STARTUP_INTERVALS.library.max),
  startupMetadataCheckIntervalHours: z.number().int().min(STARTUP_INTERVALS.itemApi.min).max(STARTUP_INTERVALS.itemApi.max),
  startupFullFileCheckIntervalDays: z.number().int().min(STARTUP_INTERVALS.fullFiles.min).max(STARTUP_INTERVALS.fullFiles.max),
  downloadConcurrency: z.number().int().min(1).max(8),
  minRequestIntervalMs: z.number().int().min(50).max(60000),
  proxyMode: z.enum(['system', 'custom', 'direct']), customProxy: z.string().trim().max(2048)
}).partial().strict()
