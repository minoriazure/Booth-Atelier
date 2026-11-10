import { readdir, lstat } from 'fs/promises'
import { join } from 'path'

export interface StorageUsage { current: number; history: number; media: number; deleted: number; errors: number }
/** Explicit asynchronous scan. Symlinks and junctions are never followed. */
export async function storageUsage(dataRoot: string, downloadRoot: string, deletedRoot: string): Promise<StorageUsage> {
  const result: StorageUsage = { current: 0, history: 0, media: 0, deleted: 0, errors: 0 }
  const walk = async (path: string, category: 'current' | 'history' | 'media' | 'deleted'): Promise<void> => {
    try {
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) return
      if (stat.isFile()) { result[category] += stat.size; return }
      for (const name of await readdir(path)) await walk(join(path, name), category)
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') result.errors++ }
  }
  try {
    for (const item of await readdir(downloadRoot)) {
      if (!/^\d+$/.test(item)) continue
      await walk(join(downloadRoot, item, 'current'), 'current')
      await walk(join(downloadRoot, item, 'history'), 'history')
    }
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') result.errors++ }
  await walk(join(dataRoot, 'items'), 'media')
  await walk(deletedRoot, 'deleted')
  return result
}
