import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { DownloadableRef } from '../src/shared/types'
import type { DeeplinkClient } from '../src/main/booth/deeplink'
import { BoothError } from '../src/main/booth/errors'
import { LibraryCrawler, parseLibraryPage, type ScopedLibraryItem } from '../src/main/booth/libraryCrawler'
import { wrapResponse } from '../src/main/booth/httpClient'
import type { ReadBoothItem } from '../src/main/booth/itemApi'
import { Db } from '../src/main/db/database'
import { LibraryRepo } from '../src/main/db/repos'
import type { DownloadManager } from '../src/main/services/downloadManager'
import { HistoryManager } from '../src/main/services/historyManager'
import { apiFileCheckToast, ItemFileUpdates } from '../src/main/services/itemFileUpdates'
import { ItemMetadataChecks } from '../src/main/services/itemMetadataChecks'
import { SettingsService } from '../src/main/services/settingsService'
import { StartupService } from '../src/main/services/startupService'
import type { AuthChecker } from '../src/main/booth/auth'
import type { LibrarySyncService } from '../src/main/services/librarySyncService'
import { UpdateCheckService } from '../src/main/services/updateCheckService'
import { Paths } from '../src/main/util/paths'

const itemId = 10
const wasm = resolve('node_modules/sql.js/dist/sql-wasm.wasm')
const first = '2026-11-18T00:00:00Z'
const later = '2026-11-19T00:00:00Z'
const file = (downloadableId: number, filename: string, variationId = 101): DownloadableRef => ({ downloadableId, filename, variationId })
const apiItem = (variants: Record<number, Array<[string, string?]>>) => ({
  name: 'Example',
  description: 'content',
  embeds: [],
  images: [],
  variations: Object.entries(variants).map(([id, files]) => ({
    id: Number(id), downloadables: files.map(([name, updated_at = first]) => ({ name, updated_at }))
  }))
})
let root: string
let db: Db
let repo: LibraryRepo
let paths: Paths

async function openDatabase(): Promise<void> {
  db = new Db(join(root, 'test.db'), wasm)
  await db.open()
  repo = new LibraryRepo(db, paths)
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'booth-item-file-updates-'))
  paths = new Paths(join(root, 'data'), join(root, 'downloads'))
  await openDatabase()
  repo.upsertFromList({ itemId, title: 'Example', thumbnailUrl: '', isGift: false,
    downloadables: [file(1, 'old.zip'), file(2, 'same.zip')] })
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

function setup() {
  const archiveCurrentFile = vi.fn()
  const isActive = vi.fn(() => false)
  const enqueueMany = vi.fn((ids: number[], _source: string) => ids.length)
  const downloads = { enqueueMany, archiveCurrentFile, isActive } as unknown as DownloadManager
  const resolveLink = vi.fn(async (id: number) => ({ dlurl: 'file:' + id, filename: repo.getDownloadable(id)!.filename }))
  const probe = vi.fn(async (_url: string) => ({ etag: 'server-etag', size: 4, lastModified: null }))
  const checker = new UpdateCheckService({ resolve: resolveLink, probe } as unknown as DeeplinkClient, repo, downloads)
  const initial = apiItem({ 101: [['old.zip'], ['same.zip']] })
  const readItem = vi.fn<ReadBoothItem>().mockResolvedValue(initial)
  const crawlItem = vi.fn(async (_id: number): Promise<ScopedLibraryItem> => ({
    purchases: [file(1, 'old.zip'), file(2, 'same.zip')], gifts: []
  }))
  const service = new ItemFileUpdates(repo, { crawlItem }, new HistoryManager(repo, paths), checker, readItem, () => false)
  return { service, readItem, crawlItem, resolveLink, probe, enqueueMany, archiveCurrentFile, isActive, checker, initial }
}

it('seeds owned variants, detects adjacent name and timestamp changes, and keeps one notice across repeated or incomplete responses', () => {
  const { service, crawlItem, enqueueMany, initial } = setup()
  service.rememberPurchases(itemId, [101])
  service.onChanged = vi.fn()
  service.observe(itemId, initial)
  service.observe(itemId, apiItem({ 101: [['same.zip'], ['old.zip']], 102: [['unowned.zip']] }))
  expect(service.list()).toEqual([])
  const changed = apiItem({ 101: [['new.zip'], ['same.zip', later]] })
  service.observe(itemId, changed)
  service.observe(itemId, changed)
  service.observe(itemId, apiItem({ 101: [['unusable.zip', 'unknown']] }))
  expect(service.list()).toMatchObject([{ itemId, pending: true, abnormal: false }])
  expect(repo.getItemFileUpdateState<{ changes: unknown[] }>(itemId)?.changes).toEqual([
    { variationId: 101, name: 'new.zip', kind: 'added' },
    { variationId: 101, name: 'same.zip', kind: 'updated' },
    { variationId: 101, name: 'old.zip', kind: 'removed' }
  ])
  expect(service.onChanged).toHaveBeenCalledTimes(1)
  expect(crawlItem).not.toHaveBeenCalled()
  expect(enqueueMany).not.toHaveBeenCalled()
  expect(repo.getDownloadable(1)?.status).toBe('remote')
})

it('uses API observations independently from the HTML detail checks and preserves the notice on API failure', async () => {
  const { service, readItem, initial } = setup()
  service.rememberPurchases(itemId, [101])
  const checks = new ItemMetadataChecks(repo, readItem, (id, data, seed) => service.observe(id, data, seed))
  const refresh = vi.fn().mockResolvedValue({ changed: true })
  await checks.pollOnStartup(2, refresh)
  expect(service.list()).toEqual([])
  repo.markItemMetadataChecked(itemId, Date.now() - 3 * 3_600_000)
  const changed = { ...initial, name: 'New title', variations: [{ id: 101, downloadables: null }] }
  readItem.mockResolvedValueOnce(changed)
  await checks.pollOnStartup(2, refresh)
  expect(refresh).toHaveBeenCalledTimes(2)
  expect(service.list()).toEqual([])
  service.observe(itemId, apiItem({ 101: [['new.zip']] }))
  repo.markItemMetadataChecked(itemId, Date.now() - 3 * 3_600_000)
  readItem.mockRejectedValueOnce(new BoothError('limit', 'rate_limited', 429))
  await checks.pollOnStartup(2, refresh)
  expect(service.list()).toMatchObject([{ itemId, pending: true }])
})

it('processes the actual V3 once while retiring and archiving V1, then checks the real library directly after reopening', async () => {
  const f = setup()
  f.service.rememberPurchases(itemId, [101, 102])
  f.service.observe(itemId, apiItem({ 101: [['old.zip'], ['same.zip']], 102: [['old.zip']] }))
  const changed = apiItem({ 101: [['v2.zip'], ['same.zip']], 102: [['v2.zip']] })
  f.service.observe(itemId, changed)
  f.readItem.mockResolvedValue(changed)
  f.crawlItem.mockResolvedValue({
    purchases: [file(3, 'v3.zip'), file(3, 'v3.zip', 102), file(2, 'same.zip')], gifts: []
  })
  const localPath = join(paths.rootPath, 'current', 'old.zip')
  mkdirSync(dirname(localPath), { recursive: true })
  writeFileSync(localPath, 'data')
  repo.markDownloaded(1, localPath, 4)

  const result = await f.service.checkApiUpdates()
  expect(result).toEqual({ scanned: 1, checked: 1, updated: 1, failed: 0, abnormalItemIds: [itemId] })
  expect(apiFileCheckToast(result)).toEqual({
    level: 'warn', message: '文件更新检查完成，发现 1 个更新文件 · 存在 API 异常的商品 BOOTH 号 #10'
  })
  expect(f.crawlItem).toHaveBeenCalledTimes(1)
  expect(f.enqueueMany).not.toHaveBeenCalled()
  expect(repo.listPendingIds(true)).toEqual([3])
  expect(f.resolveLink).not.toHaveBeenCalled()
  expect(repo.getDownloadable(1)).toMatchObject({ status: 'missing', localPath: null })
  expect(existsSync(localPath)).toBe(false)
  expect(db.get<{ count: number }>('SELECT count(*) AS count FROM file_history WHERE downloadable_id = 1')?.count).toBe(1)
  expect(repo.getDownloadable(3)?.filename).toBe('v3.zip')
  db.close()
  await openDatabase()
  const resumed = setup()
  expect(resumed.service.list()).toMatchObject([{ itemId, pending: false, abnormal: true }])
  resumed.service.observe(itemId, changed)
  resumed.crawlItem.mockResolvedValue({ purchases: [file(3, 'v3.zip'), file(4, 'v4.zip', 102)], gifts: [] })
  expect(await resumed.service.checkItem(itemId)).toMatchObject({ filesChecked: 1, filesUpdated: 1, downloaded: 0 })
  expect(resumed.readItem).not.toHaveBeenCalled()
  expect(resumed.resolveLink.mock.calls.map(([id]) => id)).toEqual([3])
  expect(repo.getDownloadable(4)).toMatchObject({ filename: 'v4.zip', status: 'update_available' })
})

it('preserves real links and the notice after a partial lookup and still uses real links when the public API fails', async () => {
  const f = setup()
  f.service.rememberPurchases(itemId, [101])
  f.service.observe(itemId, f.initial)
  const changed = apiItem({ 101: [['v2.zip'], ['same.zip']] })
  f.service.observe(itemId, changed)
  f.readItem.mockResolvedValue(changed)
  f.crawlItem.mockRejectedValueOnce(new BoothError('pagination incomplete', 'parse'))
  expect(await f.service.checkApiUpdates()).toMatchObject({ failed: 1, abnormalItemIds: [] })
  expect(repo.getDownloadable(1)?.status).toBe('remote')
  expect(f.service.list()).toMatchObject([{ pending: true, abnormal: false }])
  f.crawlItem.mockResolvedValue({ purchases: [file(2, 'same.zip'), file(3, 'v3.zip')], gifts: [] })
  f.readItem.mockRejectedValueOnce(new BoothError('limit', 'rate_limited', 429))
  const progress = vi.fn()
  f.service.onProgress = progress
  expect(await f.service.checkApiUpdates()).toMatchObject({ updated: 0, failed: 1, abnormalItemIds: [] })
  expect(progress.mock.calls).toEqual([
    [{ phase: 'item-api', current: 0, total: 1, label: `商品 #${itemId}` }],
    [{ phase: 'item-api', current: 0, total: 0 }]
  ])
  expect(repo.getDownloadable(3)).toBeUndefined()
  f.readItem.mockRejectedValueOnce(new BoothError('limit', 'rate_limited', 429))
  expect(await f.service.checkItem(itemId)).toMatchObject({ filesUpdated: 1, downloaded: 0 })
  expect(repo.getDownloadable(3)?.filename).toBe('v3.zip')
  expect(f.service.list()).toMatchObject([{ pending: true, abnormal: false }])
})

it('reads the API on a normal manual check and reuses that response to apply a newly detected change', async () => {
  const f = setup()
  f.service.rememberPurchases(itemId, [101])
  f.service.observe(itemId, f.initial)
  f.readItem.mockResolvedValue(apiItem({ 101: [['v2.zip'], ['same.zip']] }))
  f.crawlItem.mockResolvedValue({ purchases: [file(3, 'v2.zip'), file(2, 'same.zip')], gifts: [] })

  expect(f.service.list()).toEqual([])
  expect(await f.service.checkItem(itemId)).toMatchObject({ filesUpdated: 1, downloaded: 0, failed: 0 })
  expect(f.readItem).toHaveBeenCalledExactlyOnceWith(itemId)
  expect(f.crawlItem).toHaveBeenCalledTimes(1)
  expect(f.readItem.mock.invocationCallOrder[0]).toBeLessThan(f.crawlItem.mock.invocationCallOrder[0])
  expect(f.enqueueMany).not.toHaveBeenCalled()
  expect(repo.listPendingIds(true)).toEqual([3])
  expect(f.resolveLink).not.toHaveBeenCalled()
  expect(repo.getDownloadable(1)?.status).toBe('missing')
})

it('keeps the known-file fingerprint check on a manual API match or API failure', async () => {
  const f = setup()
  f.service.rememberPurchases(itemId, [101])
  f.service.observe(itemId, f.initial)

  expect(await f.service.checkItem(itemId)).toMatchObject({ filesChecked: 2, failed: 0 })
  expect(f.readItem.mock.invocationCallOrder[0]).toBeLessThan(f.resolveLink.mock.invocationCallOrder[0])
  expect(f.crawlItem).not.toHaveBeenCalled()

  f.readItem.mockRejectedValueOnce(new BoothError('limit', 'rate_limited', 429))
  expect(await f.service.checkItem(itemId)).toMatchObject({ filesChecked: 2, failed: 0 })
  expect(f.readItem).toHaveBeenCalledTimes(2)
  expect(f.crawlItem).not.toHaveBeenCalled()
  expect(f.service.list()).toEqual([])
})

it('checks the actual purchase catalog when its saved links disagree with an unchanged API snapshot', async () => {
  const f = setup()
  f.service.rememberPurchases(itemId, [101])
  f.service.observe(itemId, f.initial)
  repo.upsertDownloadables(itemId, [file(3, 'v3.zip')])
  f.crawlItem.mockResolvedValue({ purchases: [file(3, 'v3.zip'), file(2, 'same.zip')], gifts: [] })

  expect(await f.service.checkItem(itemId)).toMatchObject({ libraryChecked: 1 })
  expect(f.readItem).toHaveBeenCalledTimes(1)
  expect(f.crawlItem).toHaveBeenCalledTimes(1)
  expect(repo.getDownloadable(1)?.status).toBe('missing')
  expect(f.service.list()).toMatchObject([{ itemId, pending: false, abnormal: true }])
})

it('probes only a same-name timestamp candidate, preserves a queued update, and leaves forced checking independent', async () => {
  const f = setup()
  f.service.rememberPurchases(itemId, [101])
  f.service.observe(itemId, f.initial)
  const changed = apiItem({ 101: [['old.zip'], ['same.zip', later]] })
  f.service.observe(itemId, changed)
  f.readItem.mockResolvedValue(changed)
  repo.updateFingerprint(2, { etag: 'old-etag', size: 3, lastModified: null })
  expect(await f.service.checkApiUpdates()).toEqual({ scanned: 1, checked: 1, updated: 1, failed: 0, abnormalItemIds: [] })
  expect(f.resolveLink.mock.calls.map(([id]) => id)).toEqual([2])
  expect(f.enqueueMany).not.toHaveBeenCalled()
  expect(repo.listPendingIds()).toEqual([1, 2])
  expect(repo.listPendingIds(true)).toEqual([2])
  expect(repo.getDownloadable(2)?.status).toBe('update_available')
  expect(f.service.list()).toEqual([])
  repo.addDownloadRecord({ downloadableId: 2, itemId, source: 'update', status: 'failed' })
  expect(repo.listFailedDownloadableIds()).toEqual([2])
  expect((await f.checker.checkSelected(itemId, new Set([2]))).downloaded).toBe(0)
  expect(f.enqueueMany).not.toHaveBeenCalled()
  expect((await f.checker.checkGlobal()).filesChecked).toBe(2)
  expect(f.crawlItem).toHaveBeenCalledTimes(1)
  expect(f.resolveLink.mock.calls.map(([id]) => id)).toEqual([2, 2, 1, 2])
  expect(repo.getDownloadable(2)?.status).toBe('update_available')
})

it('keeps startup API updates pending when only the startup full check can auto-download', async () => {
  const f = setup()
  f.service.rememberPurchases(itemId, [101])
  f.service.observe(itemId, f.initial)
  f.readItem.mockResolvedValue(apiItem({ 101: [['old.zip'], ['same.zip', later]] }))
  const checks = new ItemMetadataChecks(repo, f.readItem)
  repo.upsertFromList({ itemId: itemId + 1, title: 'Recent', thumbnailUrl: '', isGift: false, downloadables: [] })
  repo.markItemMetadataChecked(itemId + 1, Date.now())
  const progress = vi.fn()
  f.service.onProgress = progress
  const result = await f.service.checkApiUpdates(async (onItem, onProgress) => {
    await checks.pollOnStartup(2, vi.fn().mockResolvedValue({ changed: false }), onItem, onProgress)
  })

  expect(result).toMatchObject({ updated: 1, failed: 0 })
  expect(f.readItem).toHaveBeenCalledExactlyOnceWith(itemId)
  expect(progress.mock.calls).toEqual([
    [{ phase: 'item-api', current: 0, total: 1, label: `商品 #${itemId}` }],
    [{ phase: 'item-api', current: 0, total: 0 }]
  ])
  expect(f.crawlItem).toHaveBeenCalledTimes(1)
  expect(f.resolveLink.mock.calls.map(([id]) => id)).toEqual([2])
  expect(f.enqueueMany).not.toHaveBeenCalled()
  expect(repo.listPendingIds(true)).toEqual([2])
  expect(repo.listPendingIds()).toEqual([1, 2])

  repo.updateFingerprint(1, { etag: 'old-etag', size: 3, lastModified: null })
  expect((await f.checker.checkGlobal(true)).downloaded).toBe(1)
  expect(f.enqueueMany).toHaveBeenCalledExactlyOnceWith([1], 'update')
  expect(repo.getDownloadable(2)?.status).toBe('update_available')
})

it('counts startup API requests for items without file tracking in the completion summary', async () => {
  const f = setup()
  const checks = new ItemMetadataChecks(repo, f.readItem)
  const refresh = vi.fn().mockResolvedValue({ changed: false })
  const run = () => f.service.checkApiUpdates(async (onItem, onProgress) => {
    await checks.pollOnStartup(2, refresh, onItem, onProgress)
  })

  const result = await run()
  expect(result).toMatchObject({ scanned: 1, checked: 0, updated: 0, failed: 0 })
  expect(apiFileCheckToast(result)).toEqual({ level: 'info', message: '文件更新检查完成，发现 0 个更新文件' })
  expect(f.crawlItem).not.toHaveBeenCalled()
  expect(await run()).toMatchObject({ scanned: 0 })
})

it('auto-downloads only new files and changed fingerprints confirmed by the startup API check', async () => {
  const f = setup()
  f.service.rememberPurchases(itemId, [101])
  f.service.observe(itemId, f.initial)
  f.readItem.mockResolvedValue(apiItem({ 101: [['old.zip'], ['same.zip', later], ['new.zip']] }))
  f.crawlItem.mockResolvedValue({ purchases: [file(1, 'old.zip'), file(2, 'same.zip'), file(3, 'new.zip')], gifts: [] })
  const checks = new ItemMetadataChecks(repo, f.readItem)
  const scan = async (onItem: Parameters<ItemMetadataChecks['pollOnStartup']>[2]) => {
    await checks.pollOnStartup(2, vi.fn().mockResolvedValue({ changed: false }), onItem)
  }
  const enqueue = (ids: number[]) => f.enqueueMany(ids, 'update')

  expect(await f.service.checkApiUpdates(scan, enqueue)).toMatchObject({ updated: 2, failed: 0 })
  expect(f.enqueueMany).toHaveBeenCalledExactlyOnceWith([3, 2], 'update')
  expect(repo.getDownloadable(1)?.status).toBe('remote')
  expect(await f.service.checkApiUpdates(scan, enqueue)).toMatchObject({ updated: 0 })

  repo.updateFingerprint(1, { etag: 'old-etag', size: 3, lastModified: null })
  expect(await f.checker.checkGlobal()).toMatchObject({ filesUpdated: 1, downloaded: 0 })
  expect(f.enqueueMany).toHaveBeenCalledTimes(1)
})

it('promotes a real replacement already registered by startup sync when the API lists a different file', async () => {
  const f = setup()
  f.service.rememberPurchases(itemId, [101])
  f.service.observe(itemId, f.initial)
  f.readItem.mockResolvedValue(apiItem({ 101: [['v2.zip'], ['same.zip']] }))
  const replacement = file(3, 'v3.zip')
  const unrelated = file(4, 'ordinary.zip')
  repo.setStatus(1, 'missing')
  repo.upsertDownloadables(itemId, [replacement, unrelated])
  f.service.rememberPurchases(itemId, [101], [3])
  db.close()
  await openDatabase()
  const resumed = setup()
  resumed.readItem.mockResolvedValue(await f.readItem(itemId))

  const result = await resumed.service.checkApiUpdates(
    async (onItem) => onItem(itemId, await resumed.readItem(itemId)),
    (ids) => resumed.enqueueMany(ids, 'update'),
    { verifiedItems: new Map([[itemId, { purchases: [file(2, 'same.zip'), replacement, unrelated], gifts: [] }]]) }
  )
  expect(resumed.crawlItem).not.toHaveBeenCalled()
  expect(result).toMatchObject({ updated: 1, abnormalItemIds: [itemId] })
  expect(repo.getDownloadable(3)?.status).toBe('update_available')
  expect(repo.getDownloadable(4)?.status).toBe('remote')
  expect(resumed.enqueueMany).toHaveBeenCalledExactlyOnceWith([3], 'update')
})

it.each([false, true])('reuses the startup API probe and keeps full-check eligibility tied to real fingerprint changes (%s)', async (fingerprintChanged) => {
  const f = setup()
  f.service.rememberPurchases(itemId, [101])
  f.service.observe(itemId, f.initial)
  f.readItem.mockResolvedValue(apiItem({ 101: [['old.zip'], ['same.zip', later]] }))
  if (fingerprintChanged) repo.updateFingerprint(2, { etag: 'old-etag', size: 4, lastModified: null })
  const batch = { attemptedIds: new Set<number>(), checkedIds: new Set<number>(), fingerprintUpdates: new Set<number>() }
  expect(await f.service.checkApiUpdates(undefined, undefined, { batch })).toMatchObject({ updated: 1 })
  expect(await f.checker.checkGlobal(true, { batch, resume: true })).toMatchObject({
    filesChecked: 2, filesUpdated: Number(fingerprintChanged)
  })
  expect(f.resolveLink.mock.calls.map(([id]) => id)).toEqual([2, 1])
  expect(f.checker.flushStartupDownloads(false, true)).toBe(Number(fingerprintChanged))
  expect(repo.getDownloadable(2)?.status).toBe('update_available')
})

it('keeps API changes pending without querying the purchase library when startup authentication fails', async () => {
  const f = setup()
  f.service.rememberPurchases(itemId, [101])
  f.service.observe(itemId, f.initial)
  f.readItem.mockResolvedValue(apiItem({ 101: [['new.zip'], ['same.zip']] }))
  expect(await f.service.checkApiUpdates(undefined, undefined, { canCheckLibrary: false })).toMatchObject({ scanned: 1, checked: 0, failed: 1 })
  expect(f.crawlItem).not.toHaveBeenCalled()
  expect(f.service.list()).toMatchObject([{ itemId, pending: true, abnormal: false }])
})

it('leaves a failed shared API probe for the next full-check attempt', async () => {
  const f = setup()
  f.service.rememberPurchases(itemId, [101])
  f.service.observe(itemId, f.initial)
  f.readItem.mockResolvedValue(apiItem({ 101: [['old.zip'], ['same.zip', later]] }))
  repo.updateFingerprint(2, { etag: 'old-etag', size: 4, lastModified: null })
  f.probe.mockRejectedValueOnce(new BoothError('network', 'network'))
  const batch = { attemptedIds: new Set<number>(), checkedIds: new Set<number>(), fingerprintUpdates: new Set<number>() }
  expect(await f.service.checkApiUpdates(undefined, undefined, { batch })).toMatchObject({ failed: 1 })
  expect(await f.checker.checkGlobal(false, { batch })).toMatchObject({ filesChecked: 1, filesRemaining: 1, failed: 1 })
  expect(f.resolveLink.mock.calls.map(([id]) => id)).toEqual([2, 1])
  db.close()
  await openDatabase()
  const resumed = setup()
  resumed.readItem.mockResolvedValue(await f.readItem(itemId))
  expect(await resumed.checker.checkGlobal(false, { resume: true })).toMatchObject({ filesChecked: 1, filesRemaining: 0, filesUpdated: 1 })
  expect(resumed.resolveLink.mock.calls.map(([id]) => id)).toEqual([2])
  expect(resumed.enqueueMany).not.toHaveBeenCalled()
  expect(await resumed.service.checkApiUpdates(undefined, (ids) => resumed.checker.deferStartupDownloads('api', ids)))
    .toMatchObject({ updated: 1, failed: 0 })
  expect(resumed.checker.flushStartupDownloads(true, false)).toBe(1)
  expect(resumed.enqueueMany).toHaveBeenCalledExactlyOnceWith([2], 'update')
  expect(resumed.archiveCurrentFile).toHaveBeenCalledExactlyOnceWith(2)
  expect(await resumed.service.checkApiUpdates()).toMatchObject({ updated: 0 })
})

it('preserves the old fingerprint when the purchase library fails before the first API probe', async () => {
  const f = setup()
  f.service.rememberPurchases(itemId, [101])
  f.service.observe(itemId, f.initial)
  f.readItem.mockResolvedValue(apiItem({ 101: [['old.zip'], ['same.zip', later]] }))
  repo.updateFingerprint(2, { etag: 'old-etag', size: 4, lastModified: null })
  f.crawlItem.mockRejectedValueOnce(new BoothError('purchase library unavailable', 'network'))
  expect(await f.service.checkApiUpdates()).toMatchObject({ checked: 0, updated: 0, failed: 1 })
  expect(f.probe).not.toHaveBeenCalled()
  expect(await f.checker.checkGlobal()).toMatchObject({ filesUpdated: 1, downloaded: 0 })
  expect(f.archiveCurrentFile).toHaveBeenCalledExactlyOnceWith(2)
  db.close()
  await openDatabase()

  const resumed = setup()
  resumed.readItem.mockResolvedValue(await f.readItem(itemId))
  expect(await resumed.service.checkApiUpdates(undefined, (ids) => resumed.checker.deferStartupDownloads('api', ids)))
    .toMatchObject({ updated: 1, failed: 0 })
  expect(resumed.checker.flushStartupDownloads(true, false)).toBe(1)
  expect(resumed.enqueueMany).toHaveBeenCalledExactlyOnceWith([2], 'update')
  expect(resumed.archiveCurrentFile).not.toHaveBeenCalled()
})

it.each(['current-etag', 'stale-etag'])('keeps a file downloaded during a probe when the probe returns %s', async (etag) => {
  const f = setup()
  const path = paths.currentFilePath(itemId, 'old.zip')
  mkdirSync(dirname(path), { recursive: true })
  repo.updateFingerprint(1, { etag: 'old-etag', size: 4, lastModified: null })
  f.probe.mockImplementationOnce(async () => {
    writeFileSync(path, 'new!')
    repo.markDownloaded(1, path, 4)
    repo.updateFingerprint(1, { etag: 'current-etag', size: 4, lastModified: null })
    return { etag, size: 4, lastModified: null }
  })

  expect(await f.checker.checkGlobal()).toMatchObject({
    filesUpdated: 0, filesRemaining: etag === 'stale-etag' ? 1 : 0
  })
  expect(f.archiveCurrentFile).not.toHaveBeenCalled()
  expect(repo.getDownloadable(1)).toMatchObject({ status: 'downloaded', lastEtag: 'current-etag', localPath: path })
  expect(existsSync(path)).toBe(true)
})

it('defers an update probe while its download is still active', async () => {
  const f = setup()
  repo.updateFingerprint(1, { etag: 'old-etag', size: 4, lastModified: null })
  f.isActive.mockImplementation((id: number = 0) => id === 1)
  expect(await f.checker.checkGlobal()).toMatchObject({ filesRemaining: 1, filesUpdated: 0 })
  expect(repo.getDownloadable(1)).toMatchObject({ lastEtag: 'old-etag', status: 'remote' })
  expect(f.archiveCurrentFile).not.toHaveBeenCalled()
})

it('restores confirmed automatic downloads after a full startup check loses authentication', async () => {
  const makeStartup = (checker: UpdateCheckService) => new StartupService(
    { check: async () => ({ ok: true }) } as unknown as AuthChecker,
    { hasItems: () => true } as unknown as LibrarySyncService,
    checker,
    new SettingsService(repo, paths, paths.rootPath)
  )
  new SettingsService(repo, paths, paths.rootPath).set({
    autoSyncLibraryOnStartup: false, autoCheckItemApiOnStartup: false, autoDownloadStartupFullCheckUpdates: true,
    firstLibrarySyncAt: '2020-01-01T00:00:00Z'
  })
  for (const id of [1, 2]) repo.updateFingerprint(id, { etag: 'old-etag', size: 4, lastModified: null })
  const f = setup()
  f.resolveLink.mockImplementationOnce(async () => ({ dlurl: '1', filename: 'old.zip' }))
    .mockRejectedValueOnce(new BoothError('expired', 'auth', 401))
  expect(await makeStartup(f.checker).runOnStartup()).toMatchObject({ authOk: false })
  expect(f.enqueueMany).not.toHaveBeenCalled()
  expect(repo.getDownloadable(1)?.status).toBe('update_available')
  db.close()
  await openDatabase()
  const resumed = setup()
  expect(await makeStartup(resumed.checker).runOnStartup()).toMatchObject({ authOk: true, summary: { downloaded: 2 } })
  expect(resumed.resolveLink.mock.calls.map(([id]) => id)).toEqual([2])
  expect(resumed.enqueueMany).toHaveBeenCalledExactlyOnceWith([1, 2], 'update')
  await makeStartup(resumed.checker).runOnStartup()
  expect(resumed.enqueueMany).toHaveBeenCalledTimes(1)
})

it('re-enables the API only after each owned variant can be matched without ambiguous names', async () => {
  const f = setup()
  f.service.rememberPurchases(itemId, [101, 102])
  f.service.observe(itemId, apiItem({ 101: [['old.zip']], 102: [['same.zip']] }))
  const changed = apiItem({ 101: [['pending.zip']], 102: [['same.zip']] })
  f.service.observe(itemId, changed)
  f.readItem.mockResolvedValue(changed)
  f.crawlItem.mockResolvedValue({ purchases: [file(1, 'old.zip'), file(2, 'same.zip', 102)], gifts: [] })
  await f.service.checkApiUpdates()
  expect(f.service.list()).toMatchObject([{ abnormal: true }])
  f.crawlItem.mockResolvedValue({ purchases: [file(3, 'pending.zip'), file(4, 'same.zip', 102), file(2, 'same.zip', 102)], gifts: [] })
  expect(await f.service.retryApi(itemId)).toBe(false)
  f.readItem.mockResolvedValueOnce(apiItem({ 101: [['pending.zip']] }))
  expect(await f.service.retryApi(itemId)).toBe(false)
  f.crawlItem.mockResolvedValue({ purchases: [file(3, 'pending.zip'), file(4, 'same.zip', 102)], gifts: [] })
  expect(await f.service.retryApi(itemId)).toBe(true)
  f.service.observe(itemId, changed)
  expect(f.service.list()).toEqual([])
})

it('only accepts complete server-filtered pages and follows their scoped pagination', async () => {
  const origin = 'https://accounts.booth.pm'
  const page = (path: string, number: number, cards: string, next = '') =>
    `<html><head><title>Library - BOOTH</title></head><body><main>
      <div id="js-library-search-data" data-search-url="${origin + path}" data-search-params='{"q":"Example","page":${number}}'></div>
      ${cards}${next}</main></body></html>`
  const row = (id: number, variationId = 101) => `<div class="text-14">example.zip</div><div class="mt-8">
    <button data-href="https://booth.pm/downloadables/${id}"></button>
    <button data-dropdown-items='[{"deeplinkDownloadableUrl":"https://booth.pm/downloadables/${id}/deeplink?client=booth-library-manager&amp;variation_id=${variationId}"}]'></button>
    </div>`
  const card = (product: number, files: string) => `<div class="bg-white"><div><a href="https://booth.pm/items/${product}"><img class="l-library-item-thumbnail"></a></div>
    <div>${files}</div></div>`
  const replies = new Map([
    ['/library?q=Example&page=1', page('/library', 1, card(20, row(99)), '<a rel="next" href="/library?q=Example&amp;page=2">Next</a>')],
    ['/library?q=Example&page=2', page('/library', 2, card(itemId, row(1)))],
    ['/library/gifts?q=Example&page=1', page('/library/gifts', 1, '')]
  ])
  const request = vi.fn(async (uri: string) => {
    const url = new URL(uri)
    return wrapResponse(new Response(replies.get(url.pathname + url.search) ?? '', { status: 200 }))
  })
  const crawler = new LibraryCrawler({ request })
  expect(await crawler.crawlItem(itemId, 'Example')).toMatchObject({ purchases: [file(1, 'example.zip')], gifts: [] })
  expect(request).toHaveBeenCalledTimes(3)
  const next = '<a rel="next" href="/library?q=Example&amp;page=2">Next</a>'
  replies.set('/library?q=Example&page=1', page('/library', 1, card(itemId, row(1)), next))
  replies.set('/library?q=Example&page=2', page('/library', 2, ''))
  await expect(crawler.crawlItem(itemId, 'Example')).rejects.toThrow('下一页')
  replies.set('/library?q=Example&page=2', page('/library', 2, card(20, row(99))))
  expect(await crawler.crawlItem(itemId, 'Example')).toMatchObject({ purchases: [file(1, 'example.zip')] })
  const partial = row(1) + row(2).replace('data-href=', 'data-url=')
  replies.set('/library?q=Example&page=2', page('/library', 2, card(itemId, partial)))
  await expect(crawler.crawlItem(itemId, 'Example')).rejects.toThrow('不完整')
  replies.set('/library?q=Example&page=2', page('/library', 2, card(itemId, row(1))).replace('</html>', ''))
  await expect(crawler.crawlItem(itemId, 'Example')).rejects.toThrow('不完整')

  const repeatedCards = page('/library', 1, card(itemId, row(1)) + card(itemId, row(2, 102) + row(1, 102)))
  expect(parseLibraryPage(repeatedCards, false)).toMatchObject([{
    itemId, purchasedVariationIds: [101, 102], downloadables: [file(1, 'example.zip'), file(2, 'example.zip', 102)]
  }])
  const unfiltered = (html: string) => html.replace('"q":"Example",', '')
  replies.set('/library?page=1', unfiltered(repeatedCards))
  replies.set('/library?page=2', unfiltered(page('/library', 2, '')))
  const verify = vi.fn()
  await crawler.crawlKind('library', undefined, verify)
  expect(verify).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({
    verifiedDownloadables: [expect.objectContaining(file(1, 'example.zip')),
      expect.objectContaining(file(2, 'example.zip', 102)), expect.objectContaining(file(1, 'example.zip', 102))]
  })])
  verify.mockClear()
  replies.set('/library?page=1', unfiltered(page('/library', 1, card(itemId, partial))))
  await crawler.crawlKind('library', undefined, verify)
  expect(verify).not.toHaveBeenCalled()
  replies.set('/library?page=1', unfiltered(page('/library', 1, card(itemId, row(1)), '<a rel="next" href="/library?page=2">Next</a>')))
  await expect(crawler.crawlKind('library', undefined, verify)).rejects.toThrow('下一页')
  expect(verify).not.toHaveBeenCalled()
})
