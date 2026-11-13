import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Db } from '../src/main/db/database'
import { LibraryRepo } from '../src/main/db/repos'
import { BoothError } from '../src/main/booth/errors'
import { parseItemPage, type ItemPageParser } from '../src/main/booth/itemPageParser'
import type { HttpClient } from '../src/main/booth/httpClient'
import type { LibraryCrawler } from '../src/main/booth/libraryCrawler'
import { HistoryManager } from '../src/main/services/historyManager'
import { ImageLocalizer } from '../src/main/services/imageLocalizer'
import { LibrarySyncService } from '../src/main/services/librarySyncService'
import { StartupService } from '../src/main/services/startupService'
import type { SettingsService } from '../src/main/services/settingsService'
import type { UpdateCheckService } from '../src/main/services/updateCheckService'
import type { AuthChecker } from '../src/main/booth/auth'
import { Paths } from '../src/main/util/paths'
import type { LibraryItem } from '../src/shared/types'

const { info } = vi.hoisted(() => ({ info: vi.fn() }))
vi.mock('../src/main/util/log', () => ({
  createLogger: () => ({ info, warn() {}, error() {}, debug() {} }),
  describeLink: () => 'test link'
}))

const itemId = 8538327
const listCover = 'https://booth.pximg.net/c/300x300/item_base_resized.jpg'
const og = 'https://booth.pximg.net/c/620x620/item_base_resized.jpg'
const original = 'https://booth.pximg.net/item.png'
const wasm = resolve('node_modules/sql.js/dist/sql-wasm.wasm')
let root: string
let db: Db
let repo: LibraryRepo
let paths: Paths

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'booth-library-sync-'))
  db = new Db(join(root, 'test.db'), wasm)
  await db.open()
  paths = new Paths(join(root, 'data'), join(root, 'downloads'))
  repo = new LibraryRepo(db, paths)
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

it('fully checks recently fetched details, reports link and page changes, and falls back only on 404', async () => {
  const item: LibraryItem = { itemId, title: 'Item', thumbnailUrl: listCover, isGift: false,
    downloadables: [{ downloadableId: 1, variationId: null, filename: 'old.zip' }] }
  const crawlKind = vi.fn(async (kind: string) => kind === 'library' ? [item] : [{ ...item, isGift: true }])
  const page = (cover: string, image: string, description: string) => parseItemPage(
    '<meta property="og:title" content="Item"><meta property="og:image" content="' + cover + '">' +
    '<img class="market-item-detail-item-image" data-origin="' + image + '" src="small.jpg">' +
    '<img class="market-item-detail-item-image" data-lazy="ignored.jpg">' +
    '<section><div class="js-market-item-detail-description">' + description + '</div></section>', itemId)
  const initial = page(og, original, 'First')
  expect(initial.galleryUrls).toEqual([original])
  const fetch = vi.fn().mockResolvedValue(initial)
  const images = { registerItemImages: vi.fn(() => 0), checkAllImages: vi.fn(async () => undefined) }
  const sync = new LibrarySyncService({ crawlKind } as unknown as LibraryCrawler,
    { fetch } as unknown as ItemPageParser, repo, new HistoryManager(repo, paths), images as unknown as ImageLocalizer)
  expect((await sync.sync()).library).toMatchObject({ added: 1, linksFetched: 1, newItemLinks: 1 })
  expect(repo.getCover(itemId)).toEqual({ url: og, kind: 'og' })
  item.downloadables = [{ downloadableId: 2, variationId: null, filename: 'new.zip' }]
  const next = page(og.replace('item', 'new'), original.replace('item', 'new'), 'Second')
  fetch.mockResolvedValue(next)
  const summary = await sync.sync()
  expect(summary).toMatchObject({ libraryChecked: 1, libraryChanged: 1, library: {
    added: 0, linksFetched: 1, linksAdded: 1, linksRemoved: 1, detailsTotal: 1, detailsChecked: 1,
    coversChanged: 1, galleriesChanged: 1, descriptionsChanged: 1
  } })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(info).toHaveBeenCalledWith(expect.stringContaining('获取下载链接 1 条，更新 2 条'))
  expect(info).toHaveBeenCalledWith('#8538327 · 新增下载链接 #2')
  expect(info).toHaveBeenCalledWith('#8538327 · 封面、画廊（新增 1，移除 1）、简介变化')
  fetch.mockRejectedValueOnce(new BoothError('temporary failure', 'network'))
  expect((await sync.sync()).library).toMatchObject({ detailFailures: 1, notFound: 0 })
  expect(repo.getCover(itemId)?.url).toBe(next.ogImageUrl)
  expect(info).toHaveBeenCalledWith('#8538327 · 商品详情 · temporary failure')
  fetch.mockRejectedValueOnce(new BoothError('missing', 'not_found', 404))
  expect((await sync.sync()).library).toMatchObject({ detailFailures: 0, notFound: 1 })
  expect(repo.getCover(itemId)).toEqual({ url: listCover, kind: 'thumb' })
  expect(repo.getItemDetail(itemId)?.galleryUrls).toEqual(next.galleryUrls)
  expect(await sync.refreshItem(itemId)).toMatchObject({ changed: false })
  expect(repo.getCover(itemId)?.url).toBe(next.ogImageUrl)
})

it('keeps the seven-day startup gate independent of manual full sync and file checks', async () => {
  const sync = vi.fn(async () => ({ libraryChecked: 1, libraryChanged: 0, filesChecked: 0, filesUpdated: 0, downloaded: 0, failed: 0 }))
  const checkGlobal = vi.fn(async () => ({ libraryChecked: 0, libraryChanged: 0, filesChecked: 1, filesUpdated: 0, downloaded: 0, failed: 0 }))
  const settings = {
    autoSyncLibraryOnStartup: true, autoCheckFilesOnStartup: true, startupCheckIntervalDays: 7,
    lastLibrarySyncAt: new Date(Date.now() - 6 * 86_400_000).toISOString(), lastGlobalCheckAt: null as string | null
  }
  const startup = new StartupService({ check: vi.fn() } as unknown as AuthChecker,
    { sync } as unknown as LibrarySyncService, { checkGlobal } as unknown as UpdateCheckService,
    { get: () => settings } as unknown as SettingsService)
  await startup.runOnStartup()
  expect(sync).not.toHaveBeenCalled()
  expect(checkGlobal).toHaveBeenCalledTimes(1)
  settings.lastLibrarySyncAt = new Date(Date.now() - 7 * 86_400_000).toISOString()
  settings.lastGlobalCheckAt = new Date().toISOString()
  await startup.runOnStartup()
  expect(sync).toHaveBeenCalledTimes(1)
  expect(sync).toHaveBeenCalledWith()
  expect(checkGlobal).toHaveBeenCalledTimes(1)
})

it('migrates legacy image names offline and retries a failed database export without losing files', async () => {
  paths.ensureItemDataDirs(itemId)
  repo.upsertFromList({ itemId, title: 'Item', thumbnailUrl: listCover, isGift: false, downloadables: [] })
  const request = vi.fn()
  const images = new ImageLocalizer({ request } as unknown as HttpClient, repo, paths)
  const rows = [{ url: listCover, kind: 'thumb', ext: '.jpg' }, { url: og, kind: 'og', ext: '.jpg' },
    { url: original, kind: 'gallery', ext: '.png' }].map((row) => ({
      ...row, itemId, filename: createHash('sha1').update(row.url).digest('hex').slice(0, 16) + row.ext
    }))
  repo.upsertImages(rows)
  for (const row of rows) {
    writeFileSync(images.localPath(itemId, row.filename), row.url)
    writeFileSync(images.thumbPath(itemId, row.filename), 'thumb')
    writeFileSync(images.previewPath(itemId, row.filename), 'preview')
    repo.markImageDone(row.url, row.url.length)
  }
  const collision = images.localPath(itemId, 'item.png')
  writeFileSync(collision, 'different existing image')
  expect(images.resolveLocal(original)).toBe(images.localPath(itemId, rows[2].filename))
  db.flush(true)
  const save = vi.spyOn(repo, 'flushImageNames').mockImplementationOnce(() => { throw new Error('disk full') })
  await expect(images.migrateLegacyNames()).rejects.toThrow('disk full')
  expect(existsSync(images.localPath(itemId, rows[2].filename))).toBe(true)
  save.mockRestore()
  // Simulate a restart from the last durable DB, before the failed export.
  const reopened = new Db(join(root, 'test.db'), wasm)
  await reopened.open()
  const reopenedRepo = new LibraryRepo(reopened, paths)
  const restarted = new ImageLocalizer({ request } as unknown as HttpClient, reopenedRepo, paths)
  try {
    await restarted.migrateLegacyNames()
    expect(reopenedRepo.getImage(listCover)?.filename).toBe('item_base_resized-library.jpg')
    expect(reopenedRepo.getImage(og)?.filename).toBe('item_base_resized-og.jpg')
    expect(reopenedRepo.getImage(original)?.filename).toBe('item_2.png')
    expect(readFileSync(collision, 'utf8')).toBe('different existing image')
    expect(readFileSync(restarted.resolveLocal(original)!, 'utf8')).toBe(original)
    expect(readFileSync(restarted.resolveThumbLocal(original)!, 'utf8')).toBe('thumb')
    expect(restarted.resolvePreviewLocal(og)).toBe(restarted.resolveLocal(og))
    expect(existsSync(restarted.thumbPath(itemId, rows[1].filename))).toBe(false)
    expect((await restarted.checkAllImages()).derivMissing).toBe(0)
    expect(request).not.toHaveBeenCalled()
  } finally {
    images.dispose()
    restarted.dispose()
    reopened.close()
  }
})
