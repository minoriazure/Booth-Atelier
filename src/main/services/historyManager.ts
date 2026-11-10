import { existsSync, mkdirSync, renameSync, writeFileSync, copyFileSync, unlinkSync, realpathSync, readFileSync, readdirSync, statSync } from 'fs'
import { isAbsolute, join, relative, sep } from 'path'
import type { LibraryRepo } from '../db/repos'
import type { Paths } from '../util/paths'
import type { FileHistoryEntry, FileHistoryGroup, SnapshotDetail, SnapshotEntry, HistoryDeleteTarget, HistoryDeleteResult, HistoryDeletePreview } from '../../shared/types'
import { localDate, sanitizeFilename, withSuffix } from '../util/filenames'
import { createLogger } from '../util/log'
import { metadataContentChanged } from '../booth/itemPageParser'

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
    // 比较连续版本而非仅同日版本；封面变化也必须保留，画廊变化不单独建快照。
    const last = this.repo.getLatestSnapshot(input.itemId)
    if (last && !metadataContentChanged(last, input)) return

    this.paths.ensureItemDataDirs(input.itemId)
    const id = this.repo.addSnapshot({
      itemId: input.itemId,
      date,
      title: input.title,
      descriptionHtml: input.descriptionHtml,
      ogImageUrl: input.ogImageUrl,
      galleryUrls: input.galleryUrls
    })

    // 用数据库 ID 建立稳定的一对一关联，不再依赖同日记录数量。
    const filename = `snapshot-${id}.html`
    const file = join(this.paths.snapshotsDir(input.itemId), filename)
    const html = `<!-- booth snapshot ${date} | ${escapeComment(input.title)} -->\n${input.descriptionHtml}`
    try {
      writeFileSync(file, html, { encoding: 'utf-8', flag: 'wx' })
      this.repo.setSnapshotFile(id, filename)
    } catch (e) {
      this.repo.deleteSnapshot(id)
      log.error('snapshot write failed:', e)
      throw e
    }

    // 同步当前描述文件
    try {
      writeFileSync(this.paths.descriptionPath(input.itemId), input.descriptionHtml, 'utf-8')
    } catch (e) {
      log.error('description write failed:', e)
    }
  }

  /** 旧快照依据原始注释和完整正文认领文件，避免删记录后按日期序号误删其它版本。 */
  private resolveSnapshotFile(itemId: number, id: number): string | null {
    const snapshot = this.repo.getSnapshotById(id)
    if (!snapshot || snapshot.itemId !== itemId) return null
    const dir = this.paths.snapshotsDir(itemId)
    if (snapshot.snapshotFile !== null) {
      return snapshot.snapshotFile ? join(dir, snapshot.snapshotFile) : null
    }
    const records = this.repo.listSnapshotStorage(itemId)
    const claimed = new Set(records.map((r) => r.snapshotFile).filter(Boolean))
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => !claimed.has(f) &&
      /^\d{4}-\d{2}-\d{2}(?:-\d+)?\.html$/.test(f)) : []
    const signature = (date: string, title: string, html: string): string => JSON.stringify([date, title, html])
    const byContent = new Map<string, string[]>()
    for (const filename of files) {
      const path = join(dir, filename)
      this.assertHistoryPath(dir, path)
      const html = readFileSync(path, 'utf8')
      const match = html.match(/^<!-- booth snapshot ([\d-]+) #(\d+) \| ([^\n]*) -->\r?\n([\s\S]*)$/)
      if (!match) continue
      const key = signature(match[1], match[3], match[4])
      byContent.set(key, [...(byContent.get(key) ?? []), filename])
    }
    const groups = new Map<string, typeof records>()
    for (const record of records.filter((r) => r.snapshotFile === null)) {
      const key = signature(record.snapshotDate, escapeComment(record.title), record.descriptionHtml)
      groups.set(key, [...(groups.get(key) ?? []), record])
    }
    // 先绑定所有能够确定归属的旧文件，再判断所选版本是否缺失或存在歧义。
    for (const [key, group] of groups) {
      const matching = byContent.get(key) ?? []
      if (matching.length !== group.length) continue
      matching.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      group.forEach((r, index) => {
        this.repo.setSnapshotFile(r.id, matching[index])
        claimed.add(matching[index])
      })
    }
    const resolved = this.repo.getSnapshotById(id)!
    if (resolved.snapshotFile !== null) return join(dir, resolved.snapshotFile)
    if (files.some((f) => f.startsWith(snapshot.snapshotDate) && !claimed.has(f))) {
      throw new Error('旧说明快照文件归属不明确，无法安全同步删除')
    }
    // 历史文件已缺失，仍允许清理数据库记录。
    return null
  }

  private assertHistoryPath(root: string, path: string): void {
    const within = (base: string, target: string): boolean => {
      const rel = relative(base, target)
      return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
    }
    if (!within(root, path) || (existsSync(path) && !within(realpathSync(root), realpathSync(path)))) {
      throw new Error(`路径不在该商品的历史目录内：${path}`)
    }
  }

  private deletionEntries(kind: 'files' | 'desc', target: HistoryDeleteTarget): Array<{ id: number; path: string | null; root: string }> {
    if (kind === 'files') return this.repo.listFilesAtArchive(target.itemId, target.key).map((f) => ({
      id: f.id, path: f.archivedPath, root: join(this.paths.itemDir(target.itemId), 'history')
    }))
    const snapshot = this.repo.getSnapshotById(Number(target.key))
    if (!snapshot || snapshot.itemId !== target.itemId) return []
    return [{ id: snapshot.id, path: this.resolveSnapshotFile(target.itemId, snapshot.id), root: this.paths.snapshotsDir(target.itemId) }]
  }

  /** 以磁盘实际大小预估，仅统计所选历史文件，不统计共用的图片缓存或当前文件。 */
  previewDelete(kind: 'files' | 'desc', targets: HistoryDeleteTarget[]): HistoryDeletePreview {
    const result: HistoryDeletePreview = { fileCount: 0, totalBytes: 0, missingFiles: 0, errors: [] }
    const seen = new Set<string>()
    const seenFiles = new Set<string>()
    for (const target of targets) {
      const token = `${target.itemId}:${target.key}`
      if (seen.has(token)) continue
      seen.add(token)
      try {
        for (const entry of this.deletionEntries(kind, target)) {
          try {
            if (!entry.path) { result.missingFiles++; continue }
            this.assertHistoryPath(entry.root, entry.path)
            try {
              const stat = statSync(entry.path)
              if (!stat.isFile()) throw new Error(`不是普通文件：${entry.path}`)
              const canonical = realpathSync(entry.path)
              if (seenFiles.has(canonical)) continue
              seenFiles.add(canonical)
              result.fileCount++
              result.totalBytes += stat.size
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === 'ENOENT') result.missingFiles++
              else throw e
            }
          } catch (e) {
            result.errors.push(`#${target.itemId} ${target.key}：${e instanceof Error ? e.message : String(e)}`)
          }
        }
      } catch (e) {
        result.errors.push(`#${target.itemId} ${target.key}：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return result
  }

  /** 每个文件独立同步磁盘与记录；只保留失败记录，成功部分不因同组其它文件失败而回退。 */
  deleteHistory(kind: 'files' | 'desc', targets: HistoryDeleteTarget[]): HistoryDeleteResult {
    const result: HistoryDeleteResult = { deleted: 0, deletedRecords: 0, deletedFiles: 0, releasedBytes: 0, failedTargets: [], errors: [] }
    const seen = new Set<string>()
    for (const target of targets) {
      const token = `${target.itemId}:${target.key}`
      if (seen.has(token)) continue
      seen.add(token)
      const startErrors = result.errors.length
      const fail = (e: unknown): void => {
        const message = `#${target.itemId} ${target.key}：${e instanceof Error ? e.message : String(e)}`
        result.errors.push(message)
        log.error(`delete history failed: ${message}`)
      }
      try {
        const entries = this.deletionEntries(kind, target)
        if (!entries.length) continue
        for (const entry of entries) {
          try {
            if (entry.path) {
              this.assertHistoryPath(entry.root, entry.path)
              try {
                const stat = statSync(entry.path)
                if (!stat.isFile()) throw new Error(`不是普通文件：${entry.path}`)
                unlinkSync(entry.path)
                result.deletedFiles++
                result.releasedBytes += stat.size
                log.info(`deleted history file: kind=${kind} item=${target.itemId} path=${entry.path}`)
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
              }
            }
            if (kind === 'files') this.repo.deleteFileHistoryRecord(entry.id)
            else this.repo.deleteSnapshot(entry.id)
            result.deletedRecords++
          } catch (e) { fail(e) }
        }
        if (result.errors.length === startErrors) result.deleted++
      } catch (e) { fail(e) }
      if (result.errors.length > startErrors) result.failedTargets.push(target)
    }
    // 一批完成后统一持久化，避免成功提示先于数据库落盘。
    this.repo.flushHistory()
    return result
  }

  /** 文件历史分组（按归档秒，新的在前） */
  listFileGroups(itemId: number): FileHistoryGroup[] {
    return this.repo.listFileHistoryGroups(itemId)
  }

  /** 某次归档（同一秒）包含的文件 */
  listFilesAtArchive(itemId: number, archivedAt: string): FileHistoryEntry[] {
    return this.repo.listFilesAtArchive(itemId, archivedAt)
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
