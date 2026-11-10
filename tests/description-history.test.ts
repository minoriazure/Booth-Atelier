import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Db } from '../src/main/db/database'
import { LibraryRepo } from '../src/main/db/repos'
import { Paths } from '../src/main/util/paths'
import { HistoryManager } from '../src/main/services/historyManager'
import { LibrarySyncService } from '../src/main/services/librarySyncService'
import type { LibraryCrawler } from '../src/main/booth/libraryCrawler'
import type { ItemPageParser } from '../src/main/booth/itemPageParser'
import type { ImageLocalizer } from '../src/main/services/imageLocalizer'
import type { ItemDetail } from '../src/shared/types'

vi.mock('../src/main/util/log', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))

let dir: string
let db: Db
let repo: LibraryRepo
let paths: Paths
let history: HistoryManager
let service: LibrarySyncService
let detail: ItemDetail

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
  dir = mkdtempSync(join(tmpdir(), 'booth-description-history-'))
  db = new Db(join(dir, 'test.db'), resolve('node_modules/sql.js/dist/sql-wasm.wasm'))
  await db.open()
  repo = new LibraryRepo(db)
  paths = new Paths(join(dir, 'data'), join(dir, 'downloads'))
  history = new HistoryManager(repo, paths)
  repo.upsertFromList({ itemId: 1, title: 'Product (Standard)', thumbnailUrl: '', isGift: false, downloadables: [] })
  detail = { itemId: 1, title: 'Product', descriptionHtml: '<p>Original</p>', ogImageUrl: 'https://example.com/cover.jpg', galleryUrls: [], shopName: null, filenames: [] }
  const parser = { fetch: vi.fn(async () => detail) } as unknown as ItemPageParser
  const images = { registerItemImages: vi.fn() } as unknown as ImageLocalizer
  service = new LibrarySyncService({} as LibraryCrawler, parser, repo, history, images)
})

afterEach(() => {
  db.close()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('description history', () => {
  it('saves the initial version once and appends only the new version across days', async () => {
    await service.refreshItem(1)
    const initial = repo.listSnapshotDates(1)[0]
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
    detail = { ...detail, descriptionHtml: '<p>Updated</p>' }
    expect(await service.refreshItem(1)).toEqual({ changed: true })
    const entries = repo.listSnapshotDates(1)
    expect(entries).toHaveLength(2)
    expect(entries[1]).toEqual(initial)
    expect(repo.getSnapshotById(entries[0].id)?.descriptionHtml).toBe(detail.descriptionHtml)
    expect(readFileSync(paths.descriptionPath(1), 'utf8')).toBe(detail.descriptionHtml)
    expect(readdirSync(paths.snapshotsDir(1))).toHaveLength(2)
    expect(await service.refreshItem(1)).toEqual({ changed: false })
    expect(repo.listSnapshotDates(1)).toHaveLength(2)
  })

  it('keeps the detail title when library titles include purchase variations', async () => {
    await service.refreshItem(1)
    repo.upsertFromList({ itemId: 1, title: 'Product (Standard)', thumbnailUrl: 'thumb', isGift: true, downloadables: [] })
    expect(repo.getItemDetail(1)).toMatchObject({ title: 'Product', thumbnailUrl: 'thumb', isGift: true })
    expect(await service.refreshItem(1)).toEqual({ changed: false })
    expect(repo.listSnapshotDates(1)).toHaveLength(1)
    // A genuine title change on the detail page must still be archived.
    detail = { ...detail, title: 'Renamed product' }
    expect(await service.refreshItem(1)).toEqual({ changed: true })
    expect(repo.listSnapshotDates(1).map(s => s.title)).toEqual(['Renamed product', 'Product'])
  })

  it('still updates list titles before details have been fetched', () => {
    repo.upsertFromList({ itemId: 1, title: 'New list title', thumbnailUrl: '', isGift: false, downloadables: [] })
    expect(repo.getItemTitle(1)).toBe('New list title')
  })

  it('deduplicates consecutive versions across dates while preserving a later reversion', () => {
    history.writeMetadataSnapshot({ ...detail, date: '2026-11-01' })
    history.writeMetadataSnapshot({ ...detail, date: '2026-11-10' })
    expect(repo.listSnapshotDates(1)).toHaveLength(1)
    history.writeMetadataSnapshot({ ...detail, date: '2026-11-10', descriptionHtml: '<p>New</p>' })
    history.writeMetadataSnapshot({ ...detail, date: '2026-11-10' })
    expect(repo.listSnapshotDates(1)).toHaveLength(3)
    expect(readdirSync(paths.snapshotsDir(1))).toHaveLength(3)
  })

  it('records cover-only updates even on the same day', async () => {
    await service.refreshItem(1)
    detail = { ...detail, ogImageUrl: 'https://example.com/new-cover.jpg' }
    expect(await service.refreshItem(1)).toEqual({ changed: true })
    const entries = repo.listSnapshotDates(1)
    expect(entries).toHaveLength(2)
    expect(repo.getSnapshotById(entries[0].id)?.ogImageUrl).toBe(detail.ogImageUrl)
  })

  it('does not create versions for gallery-only or normalized whitespace changes', async () => {
    await service.refreshItem(1)
    detail = { ...detail, galleryUrls: ['https://example.com/gallery.jpg'] }
    expect(await service.refreshItem(1)).toEqual({ changed: false })
    expect(repo.getItemDetail(1)?.galleryUrls).toEqual(detail.galleryUrls)
    history.writeMetadataSnapshot({ ...detail, descriptionHtml: '  <p>Original</p>\n' })
    expect(repo.listSnapshotDates(1)).toHaveLength(1)
  })

  it('retains both versions when legacy details have no snapshot yet', async () => {
    repo.updateDetail({ ...detail, metadataHash: 'legacy' })
    detail = { ...detail, descriptionHtml: '<p>New</p>' }
    await service.refreshItem(1)
    const entries = repo.listSnapshotDates(1)
    expect(entries).toHaveLength(2)
    expect(repo.getSnapshotById(entries[1].id)?.descriptionHtml).toBe('<p>Original</p>')
    expect(repo.getSnapshotById(entries[0].id)?.descriptionHtml).toBe('<p>New</p>')
  })
})
