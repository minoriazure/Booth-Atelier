import { existsSync, mkdirSync, renameSync, writeFileSync, copyFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { LibraryRepo } from '../db/repos'
import type { Paths } from '../util/paths'
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

  /** 文件历史日期列表（含当前文件下载日期，去重降序） */
  listFileDates(itemId: number): string[] {
    const rows = this.repo.listFileHistoryDates(itemId)
    const dates = new Set<string>()
    for (const r of rows) dates.add(r.archivedDate)
    return Array.from(dates).sort().reverse()
  }

  /** 描述快照日期列表（降序） */
  listDescriptionDates(itemId: number): string[] {
    return this.repo.listSnapshotDates(itemId).map((s) => s.snapshotDate)
  }

  /** 读取某日期的描述快照（≤ date 的最新） */
  readSnapshotAsOf(itemId: number, date: string): { snapshotDate: string; title: string; descriptionHtml: string; ogImageUrl: string | null } | undefined {
    const s = this.repo.getSnapshotAsOf(itemId, date)
    if (!s) return undefined
    return {
      snapshotDate: s.snapshotDate,
      title: s.title,
      descriptionHtml: s.descriptionHtml,
      ogImageUrl: s.ogImageUrl
    }
  }

  /** 某日期归档的文件列表 */
  listFilesAtDate(itemId: number, date: string): Array<{ filename: string; archivedPath: string; size: number | null }> {
    return this.repo
      .listFileHistoryDates(itemId)
      .filter((r) => r.archivedDate === date)
      .map((r) => ({ filename: r.filename, archivedPath: r.archivedPath, size: r.size }))
  }
}

function escapeComment(s: string): string {
  return s.replace(/--/g, '—').slice(0, 120)
}
