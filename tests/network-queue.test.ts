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
  const resolve = vi.fn(async () => { throw new BoothError('limited', 'rate_limited', 429) })
  const targets = Array.from({ length: 10 }, (_, i) => ({ downloadableId: i + 1, itemId: 1, itemTitle: '', filename: 'a', variationId: null, status: 'remote', lastEtag: null, lastSize: null }))
  const repo = { listAllDownloadables: () => targets, setSetting: vi.fn() } as unknown as LibraryRepo
  const service = new UpdateCheckService({ resolve } as unknown as DeeplinkClient, repo, {} as DownloadManager, () => false)
  const promise = service.checkGlobal()
  await vi.runAllTimersAsync()
  expect(await promise).toMatchObject({ failed: 5 })
  expect(resolve).toHaveBeenCalledTimes(5)
  expect(service.isRunning).toBe(false)
})
it('propagates authentication failures and releases the check lock for retry', async () => {
  const resolve = vi.fn(async () => { throw new BoothError('expired', 'auth', 401) })
  const repo = { listAllDownloadables: () => [{ downloadableId: 1, itemId: 1 }] } as unknown as LibraryRepo
  const service = new UpdateCheckService({ resolve } as unknown as DeeplinkClient, repo, {} as DownloadManager, () => false)
  await expect(service.checkGlobal()).rejects.toMatchObject({ kind: 'auth' })
  expect(service.isRunning).toBe(false)
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
