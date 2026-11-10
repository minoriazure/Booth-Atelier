import { lstat, realpath, unlink } from 'fs/promises'
import { isWithin } from '../util/pathAccess'

export interface HistoryStorageEntry { id: number; path: string | null; root: string }
export async function inspectHistoryEntries(entries: HistoryStorageEntry[], seen: Set<string>): Promise<{ fileCount: number; totalBytes: number; missingFiles: number; errors: string[] }> {
  const result = { fileCount: 0, totalBytes: 0, missingFiles: 0, errors: [] as string[] }
  for (const entry of entries) {
    try {
      if (!entry.path) { result.missingFiles++; continue }
      if (entry.path === entry.root || !isWithin(entry.root, entry.path)) throw new Error('路径不在该商品历史目录内')
      const stat = await lstat(entry.path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('不是普通历史文件')
      const canonical = await realpath(entry.path)
      if (!isWithin(await realpath(entry.root), canonical)) throw new Error('历史文件路径越界')
      if (!seen.has(canonical)) { seen.add(canonical); result.fileCount++; result.totalBytes += stat.size }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') result.missingFiles++
      else result.errors.push(e instanceof Error ? e.message : String(e))
    }
  }
  return result
}
/** Yield at each disk operation so large archives do not monopolize the main process. */
export async function removeHistoryEntries(entries: HistoryStorageEntry[], removeRecord: (id: number) => void, shouldStop = () => false): Promise<{ deletedRecords: number; deletedFiles: number; releasedBytes: number; errors: string[] }> {
  const result = { deletedRecords: 0, deletedFiles: 0, releasedBytes: 0, errors: [] as string[] }
  for (const entry of entries) {
    if (shouldStop()) { result.errors.push('已停止，未执行文件已保留'); break }
    try {
      if (entry.path) {
        if (entry.path === entry.root || !isWithin(entry.root, entry.path)) throw new Error('路径不在该商品历史目录内')
        try {
          const stat = await lstat(entry.path)
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('不是普通历史文件')
          if (!isWithin(await realpath(entry.root), await realpath(entry.path))) throw new Error('历史文件路径越界')
          await unlink(entry.path)
          result.deletedFiles++; result.releasedBytes += stat.size
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      }
      removeRecord(entry.id)
      result.deletedRecords++
    } catch (e) { result.errors.push(e instanceof Error ? e.message : String(e)) }
  }
  return result
}
