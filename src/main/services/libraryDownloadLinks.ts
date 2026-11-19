import { existsSync } from 'fs'
import { basename } from 'path'
import type { LibraryRepo } from '../db/repos'
import { localDate } from '../util/filenames'
import { createLogger, describeLink } from '../util/log'
import type { HistoryManager } from './historyManager'

const log = createLogger('librarySync')

/** A complete, nonempty account library listing is required before retiring links. */
export function retireMissingDownloadLinks(
  repo: LibraryRepo, history: HistoryManager, itemId: number, keep: ReadonlySet<number>
): number[] {
  if (!keep.size) return []
  const removed: number[] = []
  for (const row of repo.listDownloadablesOfItem(itemId)) {
    if (row.status === 'missing' || keep.has(row.downloadableId)) continue
    const desc = describeLink(row)
    if (row.localPath && existsSync(row.localPath)) {
      const archived = history.archivePath(itemId, row.localPath)
      if (archived) {
        repo.addFileHistory({
          itemId,
          downloadableId: row.downloadableId,
          date: localDate(),
          archivedPath: archived,
          filename: basename(archived),
          etag: row.lastEtag,
          size: row.lastSize
        })
        log.info(`vanished link (old file archived): ${desc} → ${archived}`)
      }
    } else {
      log.info(`vanished link (no local file): ${desc}`)
    }
    repo.setStatus(row.downloadableId, 'missing')
    repo.run('UPDATE downloadables SET local_path = NULL, local_size = NULL WHERE downloadable_id = ?', [row.downloadableId])
    removed.push(row.downloadableId)
  }
  return removed
}
