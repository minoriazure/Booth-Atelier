import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { Db } from '../src/main/db/database'
import { LibraryRepo } from '../src/main/db/repos'
import { Paths } from '../src/main/util/paths'
import { HistoryManager } from '../src/main/services/historyManager'
import { DownloadManager } from '../src/main/services/downloadManager'
import type { DeeplinkClient } from '../src/main/booth/deeplink'
import type { HttpClient } from '../src/main/booth/httpClient'
import { systemFetch } from '../src/main/booth/systemFetch'
import { preparePartial } from '../src/main/services/downloadResume'
vi.mock('../src/main/booth/systemFetch', () => ({ systemFetch: vi.fn() }))
vi.mock('../src/main/util/log', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }), describeLink: () => 'test' }))
let dir: string, db: Db, paths: Paths, repo: LibraryRepo, manager: DownloadManager
const checksum = (value: string) => createHash('sha256').update(value).digest('hex')
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'booth-transfer-'))
  db = new Db(join(dir, 'test.db'), resolve('node_modules/sql.js/dist/sql-wasm.wasm')); await db.open()
  paths = new Paths(join(dir, 'data'), join(dir, 'downloads')); paths.ensureItemDownloadDirs(1)
  repo = new LibraryRepo(db, paths); repo.ensureAdhoc({ itemId: 1, downloadableId: 1, filename: 'asset.bin', variationId: null })
  const deeplink = { resolve: async () => ({ dlurl: 'https://s.booth.pm/fake', filename: 'asset.bin' }), probe: async () => ({ etag: 'version', size: 6, lastModified: null }) }
  manager = new DownloadManager(deeplink as unknown as DeeplinkClient, {} as HttpClient, repo, new HistoryManager(repo, paths), paths)
})
afterEach(() => { manager.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks() })
function transfer(signal = new AbortController().signal) {
  return (manager as unknown as { downloadOne(job: { downloadableId: number; itemId: number; source: string }, signal: AbortSignal, label: string): Promise<{ size: number }> }).downloadOne({ downloadableId: 1, itemId: 1, source: 'manual' }, signal, 'test')
}
function seed() {
  const part = paths.currentFilePath(1, 'asset.bin') + '.part'
  preparePartial(part, { id: 1, etag: 'version', size: 6 }); writeFileSync(part, 'abc'); return part
}

it('reports only existing current and archived files for expired links', () => {
  const current = paths.currentFilePath(1, 'asset.bin')
  writeFileSync(current, 'abc')
  repo.markDownloaded(1, current, 3)
  repo.setStatus(1, 'missing')
  expect(manager.listFiles()[0]).toMatchObject({ status: 'missing', localPath: current, archivedPath: null })

  const history = new HistoryManager(repo, paths)
  const archived = history.archivePath(1, current)!
  repo.addFileHistory({ itemId: 1, downloadableId: 1, date: '2026-11-14', archivedPath: archived, filename: 'asset.bin', etag: null, size: 3 })
  expect(manager.listFiles()[0]).toMatchObject({ localPath: null, archivedPath: archived })

  rmSync(archived)
  expect(manager.listFiles()[0]).toMatchObject({ localPath: null, archivedPath: null })
})
it.each([200, 206])('handles resumed HTTP %i without duplicating bytes', async (status) => {
  const part = seed()
  vi.mocked(systemFetch).mockResolvedValue(new Response(status === 200 ? 'abcdef' : 'def', { status, headers: status === 206 ? { 'content-range': 'bytes 3-5/6' } : {} }))
  expect(await transfer()).toMatchObject({ size: 6 })
  expect(readFileSync(paths.currentFilePath(1, 'asset.bin'), 'utf8')).toBe('abcdef')
  expect(existsSync(part + '.json')).toBe(false)
})
it('rejects wrong 206 ranges before touching the existing partial', async () => {
  const part = seed()
  vi.mocked(systemFetch).mockResolvedValue(new Response('abcdef', { status: 206, headers: { 'content-range': 'bytes 0-5/6' } }))
  await expect(transfer()).rejects.toThrow('区间')
  expect(readFileSync(part, 'utf8')).toBe('abc')
})
it('discards stale range state after HTTP 416', async () => {
  const part = seed()
  vi.mocked(systemFetch).mockResolvedValue(new Response(null, { status: 416 }))
  await expect(transfer()).rejects.toThrow('范围')
  expect(existsSync(part)).toBe(false)
})
it('preserves the old current file when a transfer fails size validation', async () => {
  writeFileSync(paths.currentFilePath(1, 'asset.bin'), 'old')
  vi.mocked(systemFetch).mockResolvedValue(new Response('short'))
  await expect(transfer()).rejects.toThrow('大小校验')
  expect(readFileSync(paths.currentFilePath(1, 'asset.bin'), 'utf8')).toBe('old')
})
it('keeps queued work across authentication pause and does not duplicate it', () => {
  manager.pauseForAuth()
  expect(manager.enqueue(1, 'bulk')).toBe(true)
  expect(manager.enqueue(1, 'bulk')).toBe(false)
  expect(manager.stats).toMatchObject({ paused: true, queued: 1, active: 0 })
  expect(repo.listQueuedIds()).toEqual([1])
})
it('does not replace the current file when cancelled after receiving bytes', async () => {
  const controller = new AbortController()
  writeFileSync(paths.currentFilePath(1, 'asset.bin'), 'old')
  vi.mocked(systemFetch).mockResolvedValue(new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode('abcdef')); controller.abort(); stream.close() }
  })))
  await expect(transfer(controller.signal)).rejects.toThrow('已取消')
  expect(readFileSync(paths.currentFilePath(1, 'asset.bin'), 'utf8')).toBe('old')
})

it('restores a forced bulk download and updates the checksum even with the same remote fingerprint', async () => {
  const file = paths.currentFilePath(1, 'asset.bin')
  writeFileSync(file, 'oldold')
  repo.markDownloaded(1, file, 6, checksum('oldold'))
  repo.updateFingerprint(1, { etag: 'version', size: 6, lastModified: null, filename: 'asset.bin' })
  repo.ensureAdhoc({ itemId: 2, downloadableId: 2, filename: 'missing.bin', variationId: null })
  repo.setStatus(2, 'missing')
  manager.pauseAll()
  manager.enqueue(1, 'bulk')
  expect(manager.redownloadAll()).toBe(1)
  expect(repo.listQueuedDownloads()).toMatchObject([{ downloadableId: 1, source: 'manual' }])
  expect(repo.localChecksum(1)).toBe(checksum('oldold'))
  manager.dispose()

  const deeplink = {
    resolve: async () => ({ dlurl: 'https://s.booth.pm/fake', filename: 'asset.bin' }),
    probe: async () => ({ etag: 'version', size: 6, lastModified: null })
  }
  db.close()
  db = new Db(join(dir, 'test.db'), resolve('node_modules/sql.js/dist/sql-wasm.wasm'))
  await db.open()
  repo = new LibraryRepo(db, paths)
  expect(repo.listQueuedDownloads()).toMatchObject([{ downloadableId: 1, source: 'manual' }])
  manager = new DownloadManager(deeplink as unknown as DeeplinkClient, {} as HttpClient, repo, new HistoryManager(repo, paths), paths)
  seed()
  vi.mocked(systemFetch).mockResolvedValue(new Response('def', { status: 206, headers: { 'content-range': 'bytes 3-5/6' } }))
  expect(manager.restoreQueue()).toBe(1)
  await vi.waitFor(() => expect(manager.stats.active).toBe(0))
  expect(manager.listFiles().find((row) => row.downloadableId === 1)?.lastError).toBeNull()
  expect(repo.localChecksum(1)).toBe(checksum('abcdef'))
  expect(repo.listQueuedIds()).toEqual([])
  expect(readFileSync(file, 'utf8')).toBe('abcdef')
  expect(vi.mocked(systemFetch)).toHaveBeenCalledTimes(1)
})

it('keeps the current file and checksum when a bulk redownload fails', async () => {
  const file = paths.currentFilePath(1, 'asset.bin')
  writeFileSync(file, 'oldold')
  repo.markDownloaded(1, file, 6, checksum('oldold'))
  vi.mocked(systemFetch).mockResolvedValue(new Response('short'))
  expect(manager.redownloadAll()).toBe(1)
  await vi.waitFor(() => expect(manager.stats.active).toBe(0))
  expect(repo.localChecksum(1)).toBe(checksum('oldold'))
  expect(readFileSync(file, 'utf8')).toBe('oldold')
  expect(manager.listFiles()[0].failed).toBe(true)
})

it('forces all eligible files for one product only', async () => {
  repo.ensureAdhoc({ itemId: 1, downloadableId: 2, filename: 'second.bin', variationId: null })
  repo.ensureAdhoc({ itemId: 1, downloadableId: 3, filename: 'missing.bin', variationId: null })
  repo.ensureAdhoc({ itemId: 2, downloadableId: 4, filename: 'other.bin', variationId: null })
  repo.setStatus(1, 'downloaded')
  repo.setStatus(3, 'missing')
  vi.mocked(systemFetch).mockImplementation(async () => new Response(null, { status: 404 }))
  expect(manager.redownloadAll(1)).toBe(2)
  expect(repo.listQueuedDownloads()).toMatchObject([
    { downloadableId: 1, source: 'manual' },
    { downloadableId: 2, source: 'manual' }
  ])
  await vi.waitFor(() => expect(manager.stats.active).toBe(0))
})
