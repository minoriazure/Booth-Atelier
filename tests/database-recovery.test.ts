import { it, expect, vi, afterEach } from 'vitest'
import { Db } from '../src/main/db/database'
import { LibraryRepo } from '../src/main/db/repos'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
vi.mock('../src/main/util/log', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))
const dirs: string[] = []
afterEach(() => { vi.useRealTimers(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
async function open() {
  const dir = mkdtempSync(join(tmpdir(), 'booth-db-test-')); dirs.push(dir)
  const file = join(dir, 'library.db'), wasm = resolve('node_modules/sql.js/dist/sql-wasm.wasm')
  const db = new Db(file, wasm); await db.open(); return { db, file, wasm }
}
it('honors the five-second minimum and persists forced close', async () => {
  vi.useFakeTimers()
  const { db, file, wasm } = await open()
  const before = readFileSync(file)
  db.run("INSERT INTO settings VALUES ('test', '1')")
  await vi.advanceTimersByTimeAsync(4999)
  expect(readFileSync(file)).toEqual(before)
  await vi.advanceTimersByTimeAsync(2)
  expect(readFileSync(file)).not.toEqual(before)
  db.run("UPDATE settings SET value = '2' WHERE key = 'test'")
  db.close(); vi.useRealTimers()
  const reopen = new Db(file, wasm); await reopen.open()
  expect(reopen.get<{ value: string }>("SELECT value FROM settings WHERE key = 'test'")?.value).toBe('2')
  reopen.close()
})
it('backs up pre-upgrade bytes and migrates once', async () => {
  const { db, file, wasm } = await open()
  db.exec('ALTER TABLE metadata_snapshots DROP COLUMN snapshot_file')
  db.exec('DELETE FROM schema_migrations WHERE version >= 12'); db.close()
  const original = readFileSync(file)
  const reopen = new Db(file, wasm); await reopen.open()
  expect(readFileSync(file + '.backup-1')).toEqual(original)
  expect(reopen.all('SELECT * FROM schema_migrations WHERE version = 12')).toHaveLength(1)
  reopen.close()
})
it('scopes existing video keys to their product and preserves downloaded files on upgrade', async () => {
  const { db, file, wasm } = await open()
  db.run(`INSERT INTO item_videos (key, item_id, platform, video_id, url, embed_url, local_path, status)
    VALUES ('youtube:Example', 7, 'youtube', 'Example', 'watch', 'embed', 'items/7/videos/Example.mp4', 'downloaded')`)
  db.run('DELETE FROM schema_migrations WHERE version = 13')
  db.close()

  const reopened = new Db(file, wasm)
  await reopened.open()
  try {
    expect(new LibraryRepo(reopened).listVideosByItem(7)).toMatchObject([
      { key: '7:youtube:Example', status: 'downloaded', localPath: 'items/7/videos/Example.mp4' }
    ])
  } finally {
    reopened.close()
  }
})
it('rolls back an interrupted schema migration and leaves original bytes intact', async () => {
  const { db, file, wasm } = await open()
  db.exec('ALTER TABLE metadata_snapshots DROP COLUMN snapshot_file')
  db.exec('DELETE FROM schema_migrations WHERE version >= 12'); db.close()
  const original = readFileSync(file)
  const failing = new Db(file, wasm)
  vi.spyOn(failing as unknown as { migrate(): void }, 'migrate').mockImplementation(() => {
    failing.exec('ALTER TABLE metadata_snapshots ADD COLUMN unexpected TEXT')
    throw new Error('interrupted migration')
  })
  await expect(failing.open()).rejects.toThrow('数据库升级失败')
  expect(readFileSync(file)).toEqual(original)
})
it('keeps the last durable file when writes fail and succeeds after retry', async () => {
  const { db, file } = await open(), original = readFileSync(file)
  db.run("INSERT INTO settings VALUES ('retry', 'true')")
  mkdirSync(file + '.tmp')
  expect(() => db.flush(true)).toThrow()
  expect(readFileSync(file)).toEqual(original)
  rmSync(file + '.tmp', { recursive: true }); db.flush(true)
  expect(readFileSync(file)).not.toEqual(original); db.close()
})
it('does not replace an unreadable database with an empty one', async () => {
  const { db, file, wasm } = await open(); db.close()
  writeFileSync(file, 'corrupt source')
  await expect(new Db(file, wasm).open()).rejects.toThrow('数据库无法读取')
  expect(readFileSync(file, 'utf8')).toBe('corrupt source')
})
it('keeps all search matches, exposes lightweight history and stable ordering', async () => {
  const { db } = await open(); const repo = new LibraryRepo(db)
  db.transaction(() => { for (let i = 1; i <= 450; i++) db.run('INSERT INTO items (item_id,title) VALUES (?,?)', [i, 'same needle']) })
  expect(repo.search('needle')).toHaveLength(450)
  const first = repo.searchPage('needle', 200)
  const second = repo.searchPage('needle', 200, first.next!)
  const third = repo.searchPage('needle', 200, second.next!)
  expect(first.total).toBe(450)
  expect(first.items).toHaveLength(200)
  expect(second.items[0].itemId).toBe(201)
  expect(third.items).toHaveLength(50)
  expect(third.next).toBeNull()
  expect(repo.search('needle').map((r) => r.itemId)).toEqual(Array.from({ length: 450 }, (_, i) => i + 1))
  expect(repo.historyIndex().items).toHaveLength(450)
  expect(repo.historyIndex().descriptions).toEqual([])
  db.close()
})
