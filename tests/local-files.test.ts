import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Db } from '../src/main/db/database'
import { LibraryRepo } from '../src/main/db/repos'
import { Paths } from '../src/main/util/paths'
import { reconcileLocalFiles, verifyLocalFiles } from '../src/main/services/localFileReconciler'
import { storageUsage } from '../src/main/services/storageUsage'
import { fileSha256 } from '../src/main/util/fileHash'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
vi.mock('../src/main/util/log', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }), describeLink: () => '' }))
let dir: string, db: Db, repo: LibraryRepo, paths: Paths
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'booth-local-'))
  db = new Db(join(dir, 'library.db'), resolve('node_modules/sql.js/dist/sql-wasm.wasm')); await db.open()
  paths = new Paths(join(dir, 'data'), join(dir, 'downloads')); repo = new LibraryRepo(db, paths)
  repo.ensureAdhoc({ itemId: 1, downloadableId: 1, filename: 'asset.bin', variationId: null })
  paths.ensureItemDownloadDirs(1); writeFileSync(paths.currentFilePath(1, 'asset.bin'), 'abc')
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
it('does not claim files with unknown size and reconciles free items independently of remote eligibility', () => {
  expect(reconcileLocalFiles(repo, paths).recognized).toBe(0)
  db.run('UPDATE items SET is_free = 1 WHERE item_id = 1')
  db.run('UPDATE downloadables SET last_size = 3 WHERE downloadable_id = 1')
  expect(reconcileLocalFiles(repo, paths).recognized).toBe(1)
  writeFileSync(paths.currentFilePath(1, 'asset.bin'), 'modified')
  expect(reconcileLocalFiles(repo, paths).released).toBe(1)
})
it('detects same-size content corruption using a local SHA-256 rather than ETag', async () => {
  const file = paths.currentFilePath(1, 'asset.bin')
  repo.markDownloaded(1, file, 3)
  expect((await verifyLocalFiles(repo, paths)).unverified).toBe(1)
  db.run('UPDATE downloadables SET local_sha256 = ? WHERE downloadable_id = 1', [await fileSha256(file)])
  writeFileSync(file, 'xyz')
  expect(await verifyLocalFiles(repo, paths)).toMatchObject({ checked: 1, changed: 1 })
  expect(repo.getDownloadable(1)?.status).toBe('remote')
})
it('reports separate space categories without deleting anything', async () => {
  const archiveDate = '2026-11-10'
  mkdirSync(paths.historyDir(1, archiveDate), { recursive: true })
  writeFileSync(paths.historyFilePath(1, archiveDate, 'a'), 'old')
  paths.ensureItemDataDirs(1); writeFileSync(join(paths.imagesDir(1), 'image'), 'img')
  mkdirSync(join(dir, 'deleted')); writeFileSync(join(dir, 'deleted', 'a'), 'gone')
  expect(await storageUsage(paths.dataRootPath, paths.rootPath, join(dir, 'deleted'))).toMatchObject({ current: 3, history: 3, media: 3, deleted: 4, errors: 0 })
})
