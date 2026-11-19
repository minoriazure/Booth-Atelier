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
import type { LibraryCrawler, ScopedLibraryItem } from '../src/main/booth/libraryCrawler'
import { HistoryManager } from '../src/main/services/historyManager'
import { ImageLocalizer } from '../src/main/services/imageLocalizer'
import { LibrarySyncService } from '../src/main/services/librarySyncService'
import { ItemMetadataChecks, itemApiMetadataHash } from '../src/main/services/itemMetadataChecks'
import type { PriceStatsService } from '../src/main/services/priceStatsService'
import { StartupService } from '../src/main/services/startupService'
import { SettingsService } from '../src/main/services/settingsService'
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
const apiImage = 'https://booth.pximg.net/example/i/8538327/11111111-2222-3333-4444-555555555555_base_resized.jpg'
const apiDetail = {
  name: 'Item',
  description: 'Text',
  embeds: ['<iframe src="https://www.youtube.com/embed/abc123XYZ"></iframe>'],
  images: [{ original: apiImage }],
  variations: []
}
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
  const firstSyncAt = repo.getSetting('firstLibrarySyncAt', null)
  expect(firstSyncAt).toBe(repo.getSetting('lastLibrarySyncAt', null))
  expect(repo.getCover(itemId)).toEqual({ url: og, kind: 'og' })
  item.downloadables = [{ downloadableId: 2, variationId: null, filename: 'new.zip' }]
  const next = page(og.replace('item', 'new'), original.replace('item', 'new'), 'Second')
  fetch.mockResolvedValue(next)
  const summary = await sync.sync()
  expect(summary).toMatchObject({ libraryChecked: 1, libraryChanged: 1, library: {
    added: 0, linksFetched: 1, linksAdded: 1, linksRemoved: 1, detailsTotal: 1, detailsChecked: 1,
    coversChanged: 1, galleriesChanged: 1, descriptionsChanged: 1
  } })
  expect(repo.getSetting('firstLibrarySyncAt', null)).toBe(firstSyncAt)
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

it('reuses only verified purchase and gift lists and preserves links on a partial card', async () => {
  const one = { downloadableId: 1, variationId: 21, filename: 'one.zip', fallbackUrl: '' }
  const two = { downloadableId: 2, variationId: 22, filename: 'two.zip', fallbackUrl: '' }
  const item: LibraryItem = { itemId, itemUrl: '', title: 'Item', thumbnailUrl: '', isGift: false, downloadables: [one, two] }
  repo.upsertFromList(item)
  let partial = true
  const crawlKind: LibraryCrawler['crawlKind'] = async (kind, _onPage, onVerifiedList) => {
    if (kind === 'gifts') {
      onVerifiedList?.([])
      return []
    }
    if (partial) return [{ ...item, downloadables: [one], downloadablesIncomplete: true }]
    const list = [{ ...item, verifiedDownloadables: [one, two] }]
    onVerifiedList?.(list)
    return list
  }
  const images = { registerItemImages: vi.fn(() => 0), checkAllImages: vi.fn(async () => undefined) }
  const fetch = vi.fn(async () => parseItemPage('<meta property="og:title" content="Item">', itemId))
  const sync = new LibrarySyncService({ crawlKind } as unknown as LibraryCrawler, { fetch } as unknown as ItemPageParser,
    repo, new HistoryManager(repo, paths), images as unknown as ImageLocalizer)
  const verified = new Map<number, ScopedLibraryItem>()
  expect((await sync.sync(verified)).library).toMatchObject({ listFailures: 1, linksRemoved: 0 })
  expect(repo.getDownloadable(2)?.status).toBe('remote')
  expect(repo.getSetting('lastLibrarySyncAt', null)).toBeNull()
  expect(verified.size).toBe(0)
  partial = false
  expect((await sync.sync(verified)).library).toMatchObject({ listFailures: 0, linksRemoved: 0 })
  expect(verified.get(itemId)).toEqual({ purchases: [one, two], gifts: [] })
})

it('seeds the API baseline on initial sync, checks details directly on subsequent syncs, and throttles startup per item', async () => {
  const item: LibraryItem = { itemId, title: 'Item', thumbnailUrl: listCover, isGift: false, downloadables: [] }
  const htmlDetail = parseItemPage('<meta property="og:title" content="Item"><section><div class="js-market-item-detail-description"><h2>Text</h2></div></section>', itemId)
  const fetch = vi.fn(async () => htmlDetail)
  const readItem = vi.fn(async () => apiDetail)
  const checks = new ItemMetadataChecks(repo, readItem)
  const prices = { refresh: vi.fn(async (_progress, read?: typeof readItem) => { await read?.(itemId) }) } as unknown as PriceStatsService
  const images = { registerItemImages: vi.fn(() => 0), checkAllImages: vi.fn(async () => undefined) }
  const sync = new LibrarySyncService(
    { crawlKind: async (kind: string) => kind === 'library' ? [item] : [] } as unknown as LibraryCrawler,
    { fetch } as unknown as ItemPageParser, repo, new HistoryManager(repo, paths), images as unknown as ImageLocalizer, prices, checks
  )

  await sync.sync()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(readItem).toHaveBeenCalledTimes(1)
  expect(repo.getItemMetadataCheck(itemId)?.hash).toBe(itemApiMetadataHash(apiDetail))
  expect(repo.getItemDetail(itemId)?.descriptionHtml).toContain('<h2>Text</h2>')
  await sync.sync()
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(readItem).toHaveBeenCalledTimes(1)

  const changed = { ...apiDetail, description: 'New description' }
  readItem.mockResolvedValue(changed)
  repo.markItemMetadataChecked(itemId, Date.now() - 3 * 3_600_000)
  expect(await sync.pollItemMetadataOnStartup(4)).toBe(false)
  expect(readItem).toHaveBeenCalledTimes(1)
  expect(await sync.pollItemMetadataOnStartup(2)).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(await sync.pollItemMetadataOnStartup(2)).toBe(false)
  expect(await sync.checkItemMetadata(itemId)).toMatchObject({ changed: false, skippedHtml: true })
  expect(fetch).toHaveBeenCalledTimes(3)
  repo.markItemMetadataChecked(itemId, Date.now() - 90 * 60_000)
  expect(await sync.pollItemMetadataOnStartup(2)).toBe(false)
  const apiCalls = readItem.mock.calls.length
  expect(await sync.pollItemMetadataOnStartup(1)).toBe(false)
  expect(readItem).toHaveBeenCalledTimes(apiCalls + 1)
})

it('falls back to HTML only for manual API failures and retries a known change after an HTML failure', async () => {
  repo.upsertFromList({ itemId, title: 'Item', thumbnailUrl: '', isGift: false, downloadables: [] })
  repo.saveItemMetadataCheckHash(itemId, itemApiMetadataHash(apiDetail))
  const readItem = vi.fn(async (_itemId: number) => apiDetail).mockRejectedValue(new Error('API down'))
  const checks = new ItemMetadataChecks(repo, readItem)
  const refreshHtml = vi.fn(async () => ({
    changed: true, titleChanged: false, coverChanged: false, galleryChanged: false, galleryAdded: 0,
    galleryRemoved: 0, descriptionChanged: true, snapshotSaved: true, imagesPending: 0
  }))
  expect(await checks.pollOnStartup(2, refreshHtml)).toBe(false)
  expect(refreshHtml).not.toHaveBeenCalled()
  await checks.pollOnStartup(2, refreshHtml)
  expect(readItem).toHaveBeenCalledTimes(1)
  expect(await checks.checkManually(itemId, refreshHtml)).toMatchObject({ changed: true })

  const changed = { ...apiDetail, name: 'New title' }
  readItem.mockResolvedValue(changed)
  refreshHtml.mockRejectedValueOnce(new Error('HTML down'))
  await expect(checks.checkManually(itemId, refreshHtml)).rejects.toThrow('HTML down')
  expect(repo.getItemMetadataCheck(itemId)?.hash).toBe(itemApiMetadataHash(apiDetail))
  await checks.checkManually(itemId, refreshHtml)
  expect(repo.getItemMetadataCheck(itemId)?.hash).toBe(itemApiMetadataHash(changed))
  expect(refreshHtml).toHaveBeenCalledTimes(3)
})

it('refreshes legacy HTML before recording an API baseline and keeps manual details outside the startup interval', async () => {
  repo.upsertFromList({ itemId, title: 'Old title', thumbnailUrl: '', isGift: false, downloadables: [] })
  repo.updateDetail({
    itemId, title: 'Old title', descriptionHtml: '<h2>Old description</h2>',
    ogImageUrl: null, galleryUrls: [], shopName: null, metadataHash: 'existing-html'
  })
  const readItem = vi.fn(async () => apiDetail)
  const checks = new ItemMetadataChecks(repo, readItem)
  const refreshHtml = vi.fn(async () => ({
    changed: true, titleChanged: true, coverChanged: false, galleryChanged: false, galleryAdded: 0,
    galleryRemoved: 0, descriptionChanged: true, snapshotSaved: true, imagesPending: 0
  }))

  refreshHtml.mockRejectedValueOnce(new Error('HTML down'))
  await expect(checks.checkManually(itemId, refreshHtml)).rejects.toThrow('HTML down')
  expect(repo.getItemMetadataCheck(itemId)).toEqual({ hash: null, hasHtml: true, checkedAt: null })
  expect(await checks.checkManually(itemId, refreshHtml)).toMatchObject({ titleChanged: true })
  expect(repo.getItemMetadataCheck(itemId)).toEqual({ hash: itemApiMetadataHash(apiDetail), hasHtml: true, checkedAt: null })

  const onItemRead = vi.fn()
  expect(await checks.pollOnStartup(2, refreshHtml, onItemRead)).toBe(false)
  expect(onItemRead).toHaveBeenCalledExactlyOnceWith(itemId, apiDetail)
  expect(refreshHtml).toHaveBeenCalledTimes(2)
  await checks.pollOnStartup(2, refreshHtml, onItemRead)
  expect(onItemRead).toHaveBeenCalledTimes(1)
})

it('compares API gallery IDs and video identities while detecting actual field changes', () => {
  const hash = itemApiMetadataHash(apiDetail)
  const resized = apiImage.replace('/example/', '/c/72x72/example/').replace('_base_resized.jpg', '.png')
  expect(itemApiMetadataHash({
    ...apiDetail, images: [{ resized }], embeds: ['<iframe src="https://www.youtube.com/embed/abc123XYZ?si=other"></iframe>']
  })).toBe(hash)
  expect(itemApiMetadataHash({ ...apiDetail, name: 'Another name' })).not.toBe(hash)
  expect(itemApiMetadataHash({ ...apiDetail, description: 'Another text' })).not.toBe(hash)
  expect(itemApiMetadataHash({ ...apiDetail, embeds: [] })).not.toBe(hash)
  expect(itemApiMetadataHash({ ...apiDetail, images: [] })).not.toBe(hash)
  const other = { original: apiImage.replace('11111111', '66666666') }
  expect(itemApiMetadataHash({ ...apiDetail, images: [other, ...apiDetail.images] }))
    .not.toBe(itemApiMetadataHash({ ...apiDetail, images: [...apiDetail.images, other] }))
  expect(() => parseItemPage('<meta property="og:title" content="Item"><h1>年龄确认</h1>', itemId))
    .toThrow('年龄确认页')
})

it('schedules sync, anonymous API checks and full file checks on separate startup settings', async () => {
  const verifiedItem = { purchases: [], gifts: [] }
  const sync = vi.fn(async (items?: Map<number, typeof verifiedItem>) => {
    items?.set(itemId, verifiedItem)
    return { libraryChecked: 1, libraryChanged: 0, filesChecked: 0, filesUpdated: 0, downloaded: 0, failed: 0 }
  })
  const checkGlobal = vi.fn(async () => ({ libraryChecked: 0, libraryChanged: 0, filesChecked: 1, filesUpdated: 0, downloaded: 0, failed: 0 }))
  const settings = {
    autoSyncLibraryOnStartup: true, autoCheckItemApiOnStartup: true, autoForceCheckFilesOnStartup: true,
    autoDownloadStartupApiUpdates: false, autoDownloadStartupFullCheckUpdates: true,
    startupLibrarySyncIntervalDays: 7, startupMetadataCheckIntervalHours: 1, startupFullFileCheckIntervalDays: 30,
    lastLibrarySyncAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    lastGlobalCheckAt: new Date(Date.now() - 30 * 86_400_000).toISOString()
  }
  const auth = vi.fn()
  const api = vi.fn()
  const startup = new StartupService({ check: auth } as unknown as AuthChecker,
    { sync, hasItems: () => true } as unknown as LibrarySyncService,
    { checkGlobal, flushStartupDownloads: () => 0 } as unknown as UpdateCheckService,
    { get: () => settings } as unknown as SettingsService)
  await startup.runOnStartup(api)
  expect(sync).not.toHaveBeenCalled()
  expect(checkGlobal).toHaveBeenCalledTimes(1)
  expect(checkGlobal).toHaveBeenCalledWith(true, expect.objectContaining({ resume: true }))
  expect(api).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    intervalHours: 1, canCheckLibrary: true, enqueueUpdates: undefined
  }))
  settings.lastLibrarySyncAt = new Date(Date.now() - 7 * 86_400_000).toISOString()
  settings.lastGlobalCheckAt = new Date(Date.now() - 29 * 86_400_000).toISOString()
  settings.autoCheckItemApiOnStartup = false
  await startup.runOnStartup(api)
  expect(sync).toHaveBeenCalledTimes(1)
  expect(sync).toHaveBeenCalledWith(undefined)
  expect(checkGlobal).toHaveBeenCalledTimes(1)
  expect(api).toHaveBeenCalledTimes(1)

  settings.startupLibrarySyncIntervalDays = 0
  settings.lastLibrarySyncAt = new Date().toISOString()
  settings.lastGlobalCheckAt = new Date(Date.now() - 60 * 86_400_000).toISOString()
  settings.autoForceCheckFilesOnStartup = false
  await startup.runOnStartup(api)
  expect(sync).toHaveBeenCalledTimes(2)
  expect(checkGlobal).toHaveBeenCalledTimes(1)

  settings.autoCheckItemApiOnStartup = true
  settings.autoDownloadStartupApiUpdates = true
  settings.startupMetadataCheckIntervalHours = 2
  auth.mockRejectedValueOnce(new BoothError('cookie expired', 'auth'))
  await startup.runOnStartup(api)
  expect(sync).toHaveBeenCalledTimes(2)
  expect(api).toHaveBeenCalledTimes(2)
  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({
    intervalHours: 2, canCheckLibrary: false, verifiedItems: new Map(), enqueueUpdates: expect.any(Function)
  }))
  await startup.runOnStartup(api)
  expect(api).toHaveBeenLastCalledWith(expect.objectContaining({
    intervalHours: 2, canCheckLibrary: true, verifiedItems: new Map([[itemId, verifiedItem]])
  }))
})

it('skips the empty library startup scan and schedules the first full check from the first successful sync', async () => {
  let hasItems = false
  const settings = {
    autoSyncLibraryOnStartup: true, autoCheckItemApiOnStartup: true, autoForceCheckFilesOnStartup: true,
    startupLibrarySyncIntervalDays: 0, startupMetadataCheckIntervalHours: 2, startupFullFileCheckIntervalDays: 30,
    lastLibrarySyncAt: null as string | null, firstLibrarySyncAt: null as string | null, lastGlobalCheckAt: null
  }
  const sync = vi.fn(async () => {
    hasItems = true
    settings.lastLibrarySyncAt = new Date().toISOString()
    settings.firstLibrarySyncAt ??= settings.lastLibrarySyncAt
    return { libraryChecked: 1, libraryChanged: 0, filesChecked: 0, filesUpdated: 0, downloaded: 0, failed: 0 }
  })
  const checkGlobal = vi.fn(async () => ({ libraryChecked: 0, libraryChanged: 0, filesChecked: 1, filesUpdated: 0, downloaded: 0, failed: 0 }))
  const api = vi.fn()
  const startup = new StartupService({ check: vi.fn() } as unknown as AuthChecker,
    { sync, hasItems: () => hasItems } as unknown as LibrarySyncService,
    { checkGlobal, hasPendingGlobalCheck: false, flushStartupDownloads: () => 0 } as unknown as UpdateCheckService,
    { get: () => ({ ...settings }) } as unknown as SettingsService)

  await startup.runOnStartup(api)
  expect(sync).toHaveBeenCalledTimes(1)
  expect(api).not.toHaveBeenCalled()
  expect(checkGlobal).not.toHaveBeenCalled()
  await startup.runOnStartup(api)
  expect(api).toHaveBeenCalledTimes(1)
  expect(checkGlobal).not.toHaveBeenCalled()
  settings.firstLibrarySyncAt = new Date(Date.now() - 30 * 86_400_000).toISOString()
  await startup.runOnStartup(api)
  expect(checkGlobal).toHaveBeenCalledTimes(1)
})

it('retains old startup choices in their original tasks and gives the new schedules their own defaults', () => {
  const settings = new SettingsService(repo, paths, paths.rootPath)
  repo.setSetting('autoDownloadUpdates', true)
  expect(settings.get()).toMatchObject({
    startupLibrarySyncIntervalDays: 7,
    startupMetadataCheckIntervalHours: 2,
    startupFullFileCheckIntervalDays: 30,
    autoCheckItemApiOnStartup: true,
    autoDownloadStartupApiUpdates: false,
    autoDownloadStartupFullCheckUpdates: false
  })
  repo.setSetting('startupCheckIntervalDays', 0)
  repo.setSetting('autoCheckFilesOnStartup', false)
  repo.setSetting('startupMetadataCheckIntervalHours', 48)
  expect(settings.get()).toMatchObject({
    startupLibrarySyncIntervalDays: 0,
    startupMetadataCheckIntervalHours: 23,
    startupFullFileCheckIntervalDays: 30,
    autoCheckItemApiOnStartup: true,
    autoForceCheckFilesOnStartup: false
  })
  settings.set({ startupLibrarySyncIntervalDays: 14, startupMetadataCheckIntervalHours: 1, startupFullFileCheckIntervalDays: 60,
    autoCheckItemApiOnStartup: false, autoForceCheckFilesOnStartup: true, autoDownloadStartupApiUpdates: true })
  expect(settings.get()).toMatchObject({
    startupLibrarySyncIntervalDays: 14,
    startupMetadataCheckIntervalHours: 1,
    startupFullFileCheckIntervalDays: 60,
    autoCheckItemApiOnStartup: false,
    autoForceCheckFilesOnStartup: true,
    autoDownloadStartupApiUpdates: true,
    autoDownloadStartupFullCheckUpdates: false
  })
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
