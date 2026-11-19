import { it, expect, vi, afterEach } from 'vitest'
import { BoothError } from '../src/main/booth/errors'
import { UpdateCheckService } from '../src/main/services/updateCheckService'
import { DeeplinkClient } from '../src/main/booth/deeplink'
import { RateLimiter } from '../src/main/booth/rateLimiter'
import type { LibraryRepo } from '../src/main/db/repos'
import type { DownloadManager } from '../src/main/services/downloadManager'
import type { HttpClient } from '../src/main/booth/httpClient'
vi.mock('../src/main/util/log', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }), describeLink: () => '' }))
afterEach(() => { vi.useRealTimers() })
it('stops after five consecutive rate limits without misclassifying them as authentication', async () => {
  vi.useFakeTimers()
  const resolve = vi.fn(async (id: number) => {
    if (id !== 1) throw new BoothError('limited', 'rate_limited', 429)
    return { dlurl: String(id), filename: 'a' }
  })
  const probe = vi.fn(async () => ({ etag: 'etag', size: 5, lastModified: null }))
  const targets = Array.from({ length: 10 }, (_, i) => ({ downloadableId: i + 1, itemId: 1, itemTitle: '', filename: 'a', variationId: null, status: 'remote', lastEtag: null, lastSize: null }))
  const settings = new Map<string, unknown>()
  const repo = {
    listAllDownloadables: () => targets,
    getDownloadable: (id: number) => targets.find((target) => target.downloadableId === id),
    getSetting: (key: string, fallback: unknown) => settings.get(key) ?? fallback,
    setSetting: (key: string, value: unknown) => settings.set(key, value),
    updateFingerprint: vi.fn()
  } as unknown as LibraryRepo
  const downloads = { isActive: () => false } as DownloadManager
  const service = new UpdateCheckService({ resolve, probe } as unknown as DeeplinkClient, repo, downloads)
  const promise = service.checkGlobal()
  await vi.runAllTimersAsync()
  expect(await promise).toMatchObject({ failed: 5 })
  expect(resolve).toHaveBeenCalledTimes(6)
  expect(service.isRunning).toBe(false)
  expect(settings.get('pendingGlobalFileCheckIds')).toEqual(targets.slice(1).map((target) => target.downloadableId))
  expect(settings.get('lastGlobalCheckAt')).toBeUndefined()
  expect(settings.get('lastGlobalCheckAttemptAt')).toBeDefined()
  resolve.mockClear()
  resolve.mockImplementation(async (id) => ({ dlurl: String(id), filename: 'a' }))
  const restarted = new UpdateCheckService({ resolve, probe } as unknown as DeeplinkClient, repo, downloads)
  expect(await restarted.checkGlobal(false, { resume: true })).toMatchObject({ filesChecked: 9, failed: 0 })
  expect(resolve.mock.calls.map(([id]) => id)).toEqual(targets.slice(1).map((target) => target.downloadableId))
  expect(restarted.hasPendingGlobalCheck).toBe(false)
  expect(settings.get('lastGlobalCheckAt')).toBeDefined()
})
it('propagates authentication failures and releases the check lock for retry', async () => {
  const resolve = vi.fn(async () => { throw new BoothError('expired', 'auth', 401) })
  const repo = {
    listAllDownloadables: () => [{ downloadableId: 1, itemId: 1 }],
    getSetting: (_key: string, fallback: unknown) => fallback, setSetting: vi.fn()
  } as unknown as LibraryRepo
  const service = new UpdateCheckService({ resolve } as unknown as DeeplinkClient, repo, {} as DownloadManager)
  await expect(service.checkGlobal()).rejects.toMatchObject({ kind: 'auth' })
  expect(service.isRunning).toBe(false)
})

it('re-resolves a missing signed object once and leaves link retirement to purchase-library reconciliation', async () => {
  const resolve = vi.fn(async () => ({ dlurl: 'signed', filename: 'a' }))
  const probe = vi.fn().mockRejectedValue(new BoothError('missing object', 'not_found', 404))
  const setStatus = vi.fn()
  const repo = { isFreeItem: () => false, listDownloadablesOfItem: () => [{ downloadableId: 1, itemId: 1, itemTitle: '', filename: 'a' }], setStatus } as unknown as LibraryRepo
  const service = new UpdateCheckService({ resolve, probe } as unknown as DeeplinkClient, repo, {} as DownloadManager)
  expect(await service.checkItem(1)).toMatchObject({ failed: 1, filesUpdated: 0 })
  expect(resolve).toHaveBeenCalledTimes(2)
  expect(setStatus).not.toHaveBeenCalled()
})
it('serializes rate-limited requests rather than permitting concurrent bypass', async () => {
  vi.useFakeTimers(); const limiter = new RateLimiter(250, 0)
  const times: number[] = []
  const jobs = Promise.all([1, 2, 3].map(async () => { await limiter.wait(); times.push(Date.now()) }))
  await vi.runAllTimersAsync(); await jobs
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(250)
  expect(times[2] - times[1]).toBeGreaterThanOrEqual(250)
})
it('preserves weak ETags so partial downloads cannot use them for If-Range', async () => {
  const http = { request: async () => ({ status: 206, headers: new Headers({ etag: 'W/"weak"', 'content-range': 'bytes 0-0/6' }), body: async () => new ArrayBuffer(1) }) } as unknown as HttpClient
  expect((await new DeeplinkClient(http).probe('https://s.booth.pm/fake')).etag).toBe('W/"weak"')
})
