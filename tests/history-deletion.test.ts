import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Db } from '../src/main/db/database'
import { LibraryRepo } from '../src/main/db/repos'
import { Paths } from '../src/main/util/paths'
import { HistoryManager } from '../src/main/services/historyManager'

vi.mock('../src/main/util/log', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))
let dir: string
let db: Db
let repo: LibraryRepo
let paths: Paths
let history: HistoryManager

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'booth-history-delete-'))
  db = new Db(join(dir, 'test.db'), resolve('node_modules/sql.js/dist/sql-wasm.wasm'))
  await db.open()
  paths = new Paths(join(dir, 'data'), join(dir, 'downloads'))
  repo = new LibraryRepo(db, paths)
  history = new HistoryManager(repo, paths)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function archive(itemId: number, date: string, filename = 'asset.zip') {
  const path = paths.historyFilePath(itemId, date, filename)
  mkdirSync(paths.historyDir(itemId, date), { recursive: true })
  writeFileSync(path, 'old')
  repo.addFileHistory({ itemId, downloadableId: itemId, date, archivedPath: path, filename, etag: null, size: 3 })
  db.run('UPDATE file_history SET archived_at = ? WHERE item_id = ? AND archived_date = ?', [`${date} 12:00:00`, itemId, date])
  return { path, target: { itemId, key: `${date} 12:00:00` } }
}

it('replays an interrupted durable deletion and clears its marker', () => {
  const a = archive(1, '2026-11-01')
  repo.setSetting('pendingHistoryDeletion', { kind: 'files', targets: [a.target], dataRoot: paths.dataRootPath, downloadRoot: paths.rootPath })
  db.flush(true)
  rmSync(a.path) // interruption after unlink, before deleting the DB row
  history.recoverDeletion()
  expect(repo.listFileHistoryGroups(1)).toEqual([])
  expect(repo.getSetting('pendingHistoryDeletion', 'missing')).toBeNull()
})

it('does not replay a deletion against a different storage root', () => {
  const a = archive(1, '2026-11-01')
  repo.setSetting('pendingHistoryDeletion', { kind: 'files', targets: [a.target], dataRoot: paths.dataRootPath, downloadRoot: 'different' })
  history.recoverDeletion()
  expect(existsSync(a.path)).toBe(true)
})
it('reopens and recovers when DB persistence fails after unlink', async () => {
  const a = archive(1, '2026-11-01')
  const original = db.flush.bind(db)
  let forced = 0
  const spy = vi.spyOn(db, 'flush').mockImplementation((force) => {
    if (force && ++forced === 2) throw new Error('disk full after unlink')
    original(force)
  })
  expect(() => history.deleteHistory('files', [a.target])).toThrow('disk full')
  expect(existsSync(a.path)).toBe(false)
  spy.mockRestore()
  const reopened = new Db(join(dir, 'test.db'), resolve('node_modules/sql.js/dist/sql-wasm.wasm'))
  await reopened.open()
  try {
    const restoredRepo = new LibraryRepo(reopened, paths)
    expect(restoredRepo.listFileHistoryGroups(1)).toHaveLength(1)
    new HistoryManager(restoredRepo, paths).recoverDeletion()
    expect(restoredRepo.listFileHistoryGroups(1)).toEqual([])
  } finally { reopened.close() }
})

it('stops only unexecuted batch targets and reports progress', async () => {
  const a = archive(1, '2026-11-01'), b = archive(2, '2026-11-02')
  history.onDeleteProgress = () => history.cancelDeletion()
  const result = await history.deleteBatch('files', [a.target, b.target])
  expect(result.deleted).toBe(1)
  expect(result.failedTargets).toEqual([b.target])
  expect(existsSync(b.path)).toBe(true)
})

it('deletes multiple dates across items from disk and DB while preserving unselected and current files', () => {
  const a = archive(1, '2026-11-01')
  const b = archive(1, '2026-11-02')
  const c = archive(2, '2026-11-03')
  const keep = archive(1, '2026-11-04')
  paths.ensureItemDownloadDirs(1)
  const current = paths.currentFilePath(1, 'asset.zip')
  writeFileSync(current, 'current')
  expect(history.deleteHistory('files', [a.target, b.target, c.target, a.target])).toMatchObject({ deleted: 3, errors: [] })
  for (const entry of [a, b, c]) expect(existsSync(entry.path)).toBe(false)
  expect(repo.listFileHistoryGroups(1)).toHaveLength(1)
  expect(repo.listFileHistoryGroups(2)).toEqual([])
  expect(existsSync(keep.path)).toBe(true)
  expect(readFileSync(current, 'utf8')).toBe('current')
})

it('resolves relative archive paths after moving the download directory', () => {
  const a = archive(1, '2026-11-01')
  const moved = join(dir, 'moved')
  renameSync(paths.rootPath, moved)
  paths.setRoot(moved)
  expect(history.deleteHistory('files', [a.target])).toMatchObject({ deleted: 1, errors: [] })
  expect(existsSync(paths.historyFilePath(1, '2026-11-01', 'asset.zip'))).toBe(false)
})

it('clears missing file records and makes repeated deletion harmless', () => {
  const a = archive(1, '2026-11-01')
  rmSync(a.path)
  expect(history.deleteHistory('files', [a.target])).toMatchObject({ deleted: 1, errors: [] })
  expect(history.deleteHistory('files', [a.target])).toMatchObject({ deleted: 0, errors: [] })
})

it('retains failed groups for retry while completing independent groups', () => {
  const a = archive(1, '2026-11-01')
  const b = archive(2, '2026-11-02')
  rmSync(a.path)
  mkdirSync(a.path) // unlink must fail rather than recursively removing this directory.
  const result = history.deleteHistory('files', [a.target, b.target])
  expect(result.deleted).toBe(1)
  expect(result.errors).toHaveLength(1)
  expect(repo.listFileHistoryGroups(1)).toHaveLength(1)
  expect(repo.listFileHistoryGroups(2)).toEqual([])
  rmSync(a.path, { recursive: true })
  expect(history.deleteHistory('files', [a.target])).toMatchObject({ deleted: 1, errors: [] })
})

it('rejects paths outside the item history directory without touching the file', () => {
  const a = archive(1, '2026-11-01')
  const outside = join(dir, 'outside.zip')
  writeFileSync(outside, 'safe')
  db.run('UPDATE file_history SET archived_path = ? WHERE item_id = ?', [outside, 1])
  expect(history.deleteHistory('files', [a.target]).errors).toHaveLength(1)
  expect(readFileSync(outside, 'utf8')).toBe('safe')
  expect(repo.listFileHistoryGroups(1)).toHaveLength(1)
})

it('deletes selected description versions across items without altering current descriptions', () => {
  const write = (itemId: number, html: string) => history.writeMetadataSnapshot({ itemId, date: '2026-11-10', title: 'Title', descriptionHtml: html, ogImageUrl: null, galleryUrls: [] })
  write(1, 'first')
  write(1, 'second')
  write(1, 'current')
  write(2, 'other')
  const versions = repo.listSnapshotDates(1)
  const other = repo.listSnapshotDates(2)[0]
  const targets = [versions[1], versions[2]].map((s) => ({ itemId: 1, key: String(s.id) }))
  expect(history.deleteHistory('desc', [...targets, { itemId: 2, key: String(other.id) }])).toMatchObject({ deleted: 3, errors: [] })
  expect(repo.listSnapshotDates(1).map((s) => s.id)).toEqual([versions[0].id])
  expect(repo.listSnapshotDates(2)).toEqual([])
  expect(readFileSync(paths.descriptionPath(1), 'utf8')).toBe('current')
  const keepPath = join(paths.snapshotsDir(1), repo.getSnapshotById(versions[0].id)!.snapshotFile!)
  expect(existsSync(join(paths.snapshotsDir(1), `snapshot-${versions[1].id}.html`))).toBe(false)
  expect(existsSync(join(paths.snapshotsDir(1), `snapshot-${versions[2].id}.html`))).toBe(false)
  expect(existsSync(join(paths.snapshotsDir(2), `snapshot-${other.id}.html`))).toBe(false)
  write(1, 'next')
  expect(readFileSync(keepPath, 'utf8')).toContain('current')
  expect(repo.listSnapshotDates(1)).toHaveLength(2)
})

it('does not delete a description snapshot belonging to another item', () => {
  history.writeMetadataSnapshot({ itemId: 2, title: 'Keep', descriptionHtml: 'safe', ogImageUrl: null, galleryUrls: [] })
  const snapshot = repo.listSnapshotDates(2)[0]
  expect(history.deleteHistory('desc', [{ itemId: 1, key: String(snapshot.id) }])).toMatchObject({ deleted: 0, errors: [] })
  expect(repo.getSnapshotById(snapshot.id)).toBeDefined()
})


it('removes successful file records immediately when another file in the same time group fails', () => {
  const good = archive(1, '2026-11-01', 'a.zip')
  const bad = archive(1, '2026-11-01', 'b.zip')
  rmSync(bad.path)
  mkdirSync(bad.path)
  const result = history.deleteHistory('files', [good.target])
  expect(result).toMatchObject({ deleted: 0, deletedRecords: 1, deletedFiles: 1, releasedBytes: 3, failedTargets: [good.target] })
  expect(existsSync(good.path)).toBe(false)
  expect(repo.listFilesAtArchive(1, good.target.key).map((f) => f.archivedPath)).toEqual([bad.path])
  expect(repo.listFileHistoryGroups(1)[0].count).toBe(1)
  rmSync(bad.path, { recursive: true })
  expect(history.deleteHistory('files', [bad.target])).toMatchObject({ deleted: 1, deletedRecords: 1, deletedFiles: 0, failedTargets: [] })
})

it('estimates actual disk space, deduplicates targets, and counts already missing files', () => {
  const a = archive(1, '2026-11-01')
  const b = archive(2, '2026-11-02')
  rmSync(b.path)
  writeFileSync(a.path, 'actual-content')
  expect(history.previewDelete('files', [a.target, a.target, b.target])).toEqual({ fileCount: 1, totalBytes: 14, missingFiles: 1, errors: [] })
  expect(history.deleteHistory('files', [a.target, b.target])).toMatchObject({ deletedFiles: 1, releasedBytes: 14, deletedRecords: 2 })
})

it('retains a description record if its backup cannot be deleted and retries it independently', () => {
  history.writeMetadataSnapshot({ itemId: 1, title: 'Title', descriptionHtml: 'current', ogImageUrl: null, galleryUrls: [] })
  const snapshot = repo.listSnapshotDates(1)[0]
  const backup = join(paths.snapshotsDir(1), repo.getSnapshotById(snapshot.id)!.snapshotFile!)
  const bytes = readFileSync(backup).length
  const target = { itemId: 1, key: String(snapshot.id) }
  expect(history.previewDelete('desc', [target])).toEqual({ fileCount: 1, totalBytes: bytes, missingFiles: 0, errors: [] })
  rmSync(backup)
  mkdirSync(backup)
  const failed = history.deleteHistory('desc', [target])
  expect(failed).toMatchObject({ deletedRecords: 0, failedTargets: [target] })
  expect(repo.getSnapshotById(snapshot.id)).toBeDefined()
  rmSync(backup, { recursive: true })
  writeFileSync(backup, 'backup')
  expect(history.deleteHistory('desc', [target])).toMatchObject({ deleted: 1, deletedFiles: 1, releasedBytes: 6, failedTargets: [] })
  expect(existsSync(backup)).toBe(false)
  expect(readFileSync(paths.descriptionPath(1), 'utf8')).toBe('current')
})

function legacySnapshot(html: string, n: number): number {
  const date = '2026-11-10'
  paths.ensureItemDataDirs(1)
  const id = repo.addSnapshot({ itemId: 1, date, title: 'Legacy', descriptionHtml: html, ogImageUrl: null, galleryUrls: [] })
  writeFileSync(paths.snapshotPath(1, date, n), `<!-- booth snapshot ${date} #${n} | Legacy -->\n${html}`)
  return id
}

it('binds legacy snapshots by full content, deletes only selected backups, and keeps mappings after data moves', () => {
  const old = legacySnapshot('old', 1)
  const middle = legacySnapshot('middle', 2)
  const keep = legacySnapshot('latest', 3)
  // A previous DB-only deletion left the first HTML file orphaned.
  repo.deleteSnapshot(old)
  const target = { itemId: 1, key: String(middle) }
  expect(history.deleteHistory('desc', [target])).toMatchObject({ deleted: 1, deletedFiles: 1, failedTargets: [] })
  expect(existsSync(paths.snapshotPath(1, '2026-11-10', 2))).toBe(false)
  expect(existsSync(paths.snapshotPath(1, '2026-11-10', 1))).toBe(true)
  expect(repo.getSnapshotById(keep)?.snapshotFile).toBe('2026-11-10-3.html')
  const moved = join(dir, 'moved-data')
  renameSync(paths.dataRootPath, moved)
  paths = new Paths(moved, paths.rootPath)
  history = new HistoryManager(repo, paths)
  expect(history.deleteHistory('desc', [{ itemId: 1, key: String(keep) }])).toMatchObject({ deletedFiles: 1 })
  expect(existsSync(paths.snapshotPath(1, '2026-11-10', 3))).toBe(false)
})

it('refuses ambiguous legacy backups instead of guessing which version to delete', () => {
  const old = legacySnapshot('same content', 1)
  const keep = legacySnapshot('same content', 2)
  repo.deleteSnapshot(old)
  const result = history.deleteHistory('desc', [{ itemId: 1, key: String(keep) }])
  expect(result).toMatchObject({ deletedRecords: 0, deletedFiles: 0, failedTargets: [{ itemId: 1, key: String(keep) }] })
  expect(result.errors[0]).toContain('归属不明确')
  expect(existsSync(paths.snapshotPath(1, '2026-11-10', 1))).toBe(true)
  expect(existsSync(paths.snapshotPath(1, '2026-11-10', 2))).toBe(true)
})

it('cleans a description record when its known backup is already missing', () => {
  history.writeMetadataSnapshot({ itemId: 1, title: 'Title', descriptionHtml: 'current', ogImageUrl: null, galleryUrls: [] })
  const snapshot = repo.listSnapshotDates(1)[0]
  rmSync(join(paths.snapshotsDir(1), repo.getSnapshotById(snapshot.id)!.snapshotFile!))
  const target = { itemId: 1, key: String(snapshot.id) }
  expect(history.previewDelete('desc', [target])).toEqual({ fileCount: 0, totalBytes: 0, missingFiles: 1, errors: [] })
  expect(history.deleteHistory('desc', [target])).toMatchObject({ deleted: 1, deletedRecords: 1, deletedFiles: 0 })
  expect(repo.getSnapshotById(snapshot.id)).toBeUndefined()
})


it('migrates a legacy database and persists synchronized deletion across reopen', async () => {
  const id = legacySnapshot('legacy migration', 1)
  db.exec('ALTER TABLE metadata_snapshots DROP COLUMN snapshot_file')
  db.exec('DELETE FROM schema_migrations WHERE version >= 12')
  db.close()
  db = new Db(join(dir, 'test.db'), resolve('node_modules/sql.js/dist/sql-wasm.wasm'))
  await db.open()
  repo = new LibraryRepo(db, paths)
  history = new HistoryManager(repo, paths)
  expect(repo.getSnapshotById(id)?.snapshotFile).toBeNull()
  const target = { itemId: 1, key: String(id) }
  expect(history.previewDelete('desc', [target])).toMatchObject({ fileCount: 1, errors: [] })
  expect(history.deleteHistory('desc', [target])).toMatchObject({ deletedFiles: 1, deletedRecords: 1, errors: [] })
  // Open a second DB from disk before closing the first: success must already be durable.
  const reopened = new Db(join(dir, 'test.db'), resolve('node_modules/sql.js/dist/sql-wasm.wasm'))
  await reopened.open()
  try {
    expect(new LibraryRepo(reopened, paths).getSnapshotById(id)).toBeUndefined()
    expect(existsSync(paths.snapshotPath(1, '2026-11-10', 1))).toBe(false)
  } finally { reopened.close() }
})

it('does not report success when persisting the database fails', () => {
  const a = archive(1, '2026-11-01')
  const flush = vi.spyOn(db, 'flush').mockImplementation(() => { throw new Error('disk full') })
  try {
    expect(() => history.deleteHistory('files', [a.target])).toThrow('disk full')
    expect(flush).toHaveBeenCalledWith(true)
  } finally { flush.mockRestore() }
})
