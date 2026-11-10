import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Db } from '../src/main/db/database'
import { LibraryRepo } from '../src/main/db/repos'
import { Paths } from '../src/main/util/paths'

vi.mock('../src/main/util/log', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))

let dir: string
let db: Db
let repo: LibraryRepo
let paths: Paths
const date = '2026-11-10'
const filename = '素材_2.zip'

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'booth-file-history-'))
  db = new Db(join(dir, 'test.db'), resolve('node_modules/sql.js/dist/sql-wasm.wasm'))
  await db.open()
  paths = new Paths(join(dir, 'data'), join(dir, 'portable', 'downloads'))
  repo = new LibraryRepo(db, paths)
  mkdirSync(paths.historyDir(123, date), { recursive: true })
  writeFileSync(paths.historyFilePath(123, date, filename), 'archive')
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function expectArchive(expected: string): void {
  const group = repo.listFileHistoryGroups(123)[0]
  expect(repo.listFilesAtArchive(123, group.archivedAt)[0].archivedPath).toBe(expected)
  expect(repo.listFileHistoryDates(123)[0].archivedPath).toBe(expected)
  expect(existsSync(expected)).toBe(true)
}

it('stores relative paths and resolves them after portable and download directory moves', () => {
  repo.addFileHistory({ itemId: 123, downloadableId: 456, date,
    archivedPath: paths.historyFilePath(123, date, filename), filename, etag: null, size: 7 })
  expect(db.get<{ path: string }>('SELECT archived_path AS path FROM file_history')?.path)
    .toBe(join('123', 'history', date, filename))

  renameSync(join(dir, 'portable'), join(dir, 'moved-portable'))
  paths = new Paths(join(dir, 'data'), join(dir, 'moved-portable', 'downloads'))
  repo = new LibraryRepo(db, paths)
  expectArchive(paths.historyFilePath(123, date, filename))

  const newRoot = join(dir, 'custom-downloads')
  renameSync(paths.rootPath, newRoot)
  paths.setRoot(newRoot)
  expectArchive(paths.historyFilePath(123, date, filename))
})

it('rebases legacy absolute paths using the archive name, including collision suffixes', () => {
  const oldPath = paths.historyFilePath(123, date, filename)
  db.run(`INSERT INTO file_history (item_id, downloadable_id, archived_date, archived_path, filename)
    VALUES (?, ?, ?, ?, ?)`, [123, 456, date, oldPath, 'Z:\\old\\123\\current\\素材.zip'])
  const newRoot = join(dir, 'moved-downloads')
  renameSync(paths.rootPath, newRoot)
  paths.setRoot(newRoot)
  expectArchive(paths.historyFilePath(123, date, filename))
})

it('preserves nonstandard absolute paths instead of guessing an unrelated destination', () => {
  const external = join(dir, 'external', filename)
  expect(paths.resolveArchivedLocal(123, external)).toBe(external)
  const otherItem = paths.historyFilePath(999, date, filename)
  expect(paths.resolveArchivedLocal(123, otherItem)).toBe(otherItem)
})
