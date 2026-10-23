import { existsSync, mkdirSync, renameSync, writeFileSync, copyFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { LibraryRepo } from '../db/repos'
import type { Paths } from '../util/paths'
import type { FileHistoryGroup, SnapshotDetail, SnapshotEntry } from '../../shared/types'
import { localDate, sanitizeFilename, withSuffix } from '../util/filenames'
import { createLogger } from '../util/log'

const log = createLogger('history')

/**
 * 历史管理（用户需求 #4）：
 * - 文件更新时，旧文件【移动】到 files/history/{YYYY-MM-DD}/（不复制、不删除）
 * - 商品描述/宣传图变化时写 metadata_snapshots + meta/snapshots/{date}.html
 * - 两类历史独立按日期查询（两个下拉菜单互不关联）
 */
export class HistoryManager {
  constructor(
    private repo: LibraryRepo,
    private paths: Paths
  ) {}

  /**
   * 归档旧版本文件：从 current 移动到 history/{date}/。
   * @returns 归档后的路径，无旧文件则返回 null
   */
  archivePreviousFile(itemId: number, filename: string, reason = 'update'): string | null {
    const cur = this.paths.currentFilePath(itemId, filename)
    if (!existsSync(cur)) {
      // 文件名可能已变化，按 downloadable 的 local_path 查（由调用方传入实际路径更稳妥）
      return null
    }
    const date = localDate()
    const destDir = this.paths.historyDir(itemId, date)
    mkdirSync(destDir, { recursive: true })
    let dest = join(destDir, sanitizeFilename(filename))
    let n = 2
    while (existsSync(dest)) {
      dest = join(destDir, withSuffix(sanitizeFilename(filename), n))
      n++
      if (n > 9999) break
    }
    renameSync(cur, dest)
    log.info(`archived: ${cur} → ${dest}`)
    return dest
  }

  /** 归档任意路径的旧文件（local_path 与当前文件名不一致时使用） */
  archivePath(itemId: number, oldPath: string, reason = 'update'): string | null {
    if (!oldPath || !existsSync(oldPath)) return null
    const filename = sanitizeFilename(oldPath.split(/[\\/]/).pop() || 'file')
    const date = localDate()
    const destDir = this.paths.historyDir(itemId, date)
    mkdirSync(destDir, { recursive: true })
    let dest = join(destDir, filename)
    let n = 2
    while (existsSync(dest)) {
      dest = join(destDir, withSuffix(filename, n))
      n++
      if (n > 9999) break
    }
    try {
      renameSync(oldPath, dest)
    } catch (e) {
      // 跨盘（下载根与历史目录不同盘不可能，但防御）→ 复制后删源
      log.warn('rename failed, fallback to copy:', e)
      copyFileSync(oldPath, dest)
      try {
        unlinkSync(oldPath)
      } catch {
        /* ignore */
      }
    }
    return dest
  }

  /** 写描述快照（内容有变化才写；同日多次追加 -N 后缀） */
  writeMetadataSnapshot(input: {
    itemId: number
    date?: string
    title: string
    descriptionHtml: string
    ogImageUrl: string | null
    galleryUrls: string[]
  }): void {
    const date = input.date ?? localDate()
    this.paths.ensureItemDataDirs(input.itemId)

    // 同日内容相同则跳过
    const existing = this.repo.listSnapshotDates(input.itemId).filter((s) => s.snapshotDate === date)
    if (existing.length > 0) {
      const last = this.repo.getSnapshotAsOf(input.itemId, date)
      if (last && last.title === input.title && last.descriptionHtml === input.descriptionHtml) return
    }

    this.repo.addSnapshot({
      itemId: input.itemId,
      date,
      title: input.title,
      descriptionHtml: input.descriptionHtml,
      ogImageUrl: input.ogImageUrl,
      galleryUrls: input.galleryUrls
    })

    // 落盘 HTML（含元数据头注释）
    const n = existing.length + 1
    const file = this.paths.snapshotPath(input.itemId, date, n)
    const html = `<!-- booth snapshot ${date} #${n} | ${escapeComment(input.title)} -->\n${input.descriptionHtml}`
    try {
      writeFileSync(file, html, 'utf-8')
    } catch (e) {
      log.error('snapshot write failed:', e)
    }

    // 同步当前描述文件
    try {
      writeFileSync(this.paths.descriptionPath(input.itemId), input.descriptionHtml, 'utf-8')
    } catch (e) {
      log.error('description write failed:', e)
    }
  }

  /** 文件历史分组（按归档秒，新的在前） */
  listFileGroups(itemId: number): FileHistoryGroup[] {
    return this.repo.listFileHistoryGroups(itemId)
  }

  /** 某次归档（同一秒）包含的文件 */
  listFilesAtArchive(itemId: number, archivedAt: string): Array<{ filename: string; archivedPath: string; size: number | null; archivedAt: string }> {
    return this.repo.listFilesAtArchive(itemId, archivedAt).map((r) => ({
      filename: r.filename,
      archivedPath: r.archivedPath,
      size: r.size,
      archivedAt: r.archivedAt
    }))
  }

  /** 描述快照条目（每次写入一条，新的在前） */
  listDescriptionEntries(itemId: number): SnapshotEntry[] {
    return this.repo.listSnapshotDates(itemId)
  }

  /** 读取单条描述快照（不含本地图片映射，由 IPC 层补充） */
  readSnapshot(id: number): Omit<SnapshotDetail, 'localImages'> | undefined {
    const s = this.repo.getSnapshotById(id)
    if (!s) return undefined
    return {
      id: s.id,
      itemId: s.itemId,
      snapshotDate: s.snapshotDate,
      capturedAt: s.capturedAt,
      title: s.title,
      descriptionHtml: s.descriptionHtml,
      ogImageUrl: s.ogImageUrl
    }
  }
}

function escapeComment(s: string): string {
  return s.replace(/--/g, '—').slice(0, 120)
}
