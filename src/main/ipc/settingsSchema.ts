import { z } from 'zod'

export const settingsPatch = z.object({
  downloadRoot: z.string().trim().min(1).max(32767),
  cookiesPath: z.string().trim().max(32767),
  autoRegisterDeepLink: z.boolean(), logRetentionDays: z.number().int().min(7).max(180),
  autoSyncLibraryOnStartup: z.boolean(), autoCheckFilesOnStartup: z.boolean(),
  autoCheckImagesOnStartup: z.boolean(), autoDownloadUpdates: z.boolean(),
  themeMode: z.enum(['dark', 'light']), themeAccent: z.string().regex(/^#[0-9a-f]{6}$/i),
  startupCheckIntervalDays: z.number().int().min(0).max(365),
  downloadConcurrency: z.number().int().min(1).max(8),
  minRequestIntervalMs: z.number().int().min(50).max(60000),
  proxyMode: z.enum(['system', 'custom', 'direct']), customProxy: z.string().trim().max(2048)
}).partial().strict()
