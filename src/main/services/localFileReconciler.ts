import { existsSync, statSync } from 'fs'
import type { LibraryRepo } from '../db/repos'
import type { Paths } from '../util/paths'
import { createLogger, describeLink } from '../util/log'
import { fileSha256 } from '../util/fileHash'
import { stat } from 'fs/promises'

const log = createLogger('reconcile')

export interface ReconcileResult {
  /** 下载根不存在（如外接盘未挂载）时整体跳过，不改动任何记录 */
  skipped: boolean
  /** 本次识别为已下载的条目数 */
  recognized: number
  /** 本次因本地文件缺失而回到待下载的条目数（保留远端指纹） */
  released: number
}

/**
 * 按磁盘布局对账下载状态：{downloadRoot}/{itemId}/current/{filename} 存在且大小与远端指纹一致 → downloaded。
 * 只读文件系统并更新 DB，不删除、不移动任何文件；根目录缺失时直接跳过，避免误判为「全部丢失」。
 */
export function reconcileLocalFiles(repo: LibraryRepo, paths: Paths): ReconcileResult {
  const result: ReconcileResult = { skipped: false, recognized: 0, released: 0 }
  if (!existsSync(paths.rootPath)) {
    result.skipped = true
    log.warn(`download root missing, skip: ${paths.rootPath}`)
    return result
  }

  for (const r of repo.listLocalDownloadables()) {
    const desc = describeLink(r)
    const file = paths.currentFilePath(r.itemId, r.filename)
    if (existsSync(file)) {
      if (r.status !== 'remote' && r.status !== 'downloaded') continue
      const size = statSync(file).size
      // 远端指纹大小与本地不一致：视为旧版本或不完整文件，不认领，交给下载流程处理
      if (r.lastSize != null && r.lastSize !== size) {
        if (r.status === 'downloaded') { repo.releaseMissingLocal(r.downloadableId); result.released++ }
        log.info(`size mismatch, not recognized: ${desc} local=${size} remote=${r.lastSize}`)
        continue
      }
      if (r.lastSize === null) continue
      repo.markDownloaded(r.downloadableId, file, size)
      if (r.status === 'remote') {
        result.recognized++
        log.info(`recognized local file: ${desc} size=${size}`)
      }
    } else if (r.status === 'downloaded') {
      repo.releaseMissingLocal(r.downloadableId)
      result.released++
      log.info(`local file missing, released to remote: ${desc} expected=${file}`)
    }
  }
  return result
}

/** Explicit, streaming verification; never treats remote ETags as content hashes. */
export async function verifyLocalFiles(repo: LibraryRepo, paths: Paths): Promise<{ checked: number; unverified: number; changed: number; errors: number }> {
  const result = { checked: 0, unverified: 0, changed: 0, errors: 0 }
  for (const row of repo.listLocalDownloadables().filter((r) => r.status === 'downloaded')) {
    const expected = repo.localChecksum(row.downloadableId)
    if (!expected) { result.unverified++; continue }
    try {
      const file = paths.currentFilePath(row.itemId, row.filename)
      const before = await stat(file)
      const actual = await fileSha256(file)
      const after = await stat(file)
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size ||
          repo.localChecksum(row.downloadableId) !== expected || repo.getDownloadable(row.downloadableId)?.status !== 'downloaded') {
        result.unverified++; continue
      }
      result.checked++
      if (actual !== expected) { repo.releaseMissingLocal(row.downloadableId); result.changed++ }
    } catch { result.errors++ }
  }
  return result
}
