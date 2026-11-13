import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Db } from '../src/main/db/database'
import { LibraryRepo } from '../src/main/db/repos'
import { setLogDir } from '../src/main/util/log'
import sharp from 'sharp'
import { generateDerivatives } from '../src/main/services/imageDerivatives'
import { LibrarySyncService } from '../src/main/services/librarySyncService'
import { HistoryManager } from '../src/main/services/historyManager'
import { Paths } from '../src/main/util/paths'
import { metadataHashOf, type ItemPageParser } from '../src/main/booth/itemPageParser'
import type { LibraryCrawler } from '../src/main/booth/libraryCrawler'
import type { ImageLocalizer } from '../src/main/services/imageLocalizer'

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'booth-benchmark-'))
  setLogDir(join(dir, 'logs'))
  try {
    for (const size of [100, 1000, 5000]) {
      const db = new Db(join(dir, `${size}.db`), resolve('node_modules/sql.js/dist/sql-wasm.wasm'))
      await db.open()
      const repo = new LibraryRepo(db)
      const detail = (id: number) => ({ itemId: id, title: `Asset ${id} needle`, shopName: `Shop ${id % 100}`, descriptionHtml: '<p>benchmark</p>', ogImageUrl: null, galleryUrls: [], filenames: [], videos: [] })
      const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable()
      await new Promise((done) => setTimeout(done, 20))
      const start = performance.now()
      db.transaction(() => {
        for (let i = 1; i <= size; i++) {
          db.run('INSERT INTO items (item_id,title,shop_name,description_html,metadata_hash) VALUES (?,?,?,?,?)', [i, `Asset ${i} needle`, `Shop ${i % 100}`, '<p>benchmark</p>', metadataHashOf(detail(i))])
          db.run('INSERT INTO metadata_snapshots (item_id,snapshot_date,title,description_html) VALUES (?,?,?,?)', [i, '2026-11-10', `Asset ${i}`, '<p>benchmark</p>'])
        }
      })
      const seedMs = performance.now() - start
      const searches: number[] = []
      for (let i = 0; i < 12; i++) { const t = performance.now(); repo.search('needle'); searches.push(performance.now() - t); await new Promise<void>((done) => setImmediate(done)) }
      const t = performance.now(); const index = repo.historyIndex(); const historyMs = performance.now() - t
      const f = performance.now(); db.flush(true); const flushMs = performance.now() - f
      const crawler = { crawlKind: async (kind: string) => kind === 'gifts' ? [] : Array.from({ length: size }, (_, i) => ({ itemId: i + 1, title: `Asset ${i + 1} needle`, thumbnailUrl: '', isGift: false, downloadables: [] })) } as unknown as LibraryCrawler
      const sync = new LibrarySyncService(crawler, { fetch: async (id: number) => detail(id) } as unknown as ItemPageParser, repo,
        new HistoryManager(repo, new Paths(join(dir, 'data'), join(dir, 'downloads'))), { checkAllImages: async () => ({}) } as ImageLocalizer)
      const syncStart = performance.now(); await sync.sync(); const offlineSyncMs = performance.now() - syncStart
      await new Promise((done) => setTimeout(done, 20)); loop.disable()
      console.log(JSON.stringify({ size, seedMs, offlineSyncMs, searchP95Ms: searches.sort((a, b) => a - b)[Math.ceil(searches.length * .95) - 1], historyMs, historyPayloadBytes: Buffer.byteLength(JSON.stringify(index)), flushMs, eventLoopMaxMs: loop.max / 1e6, rssMB: process.memoryUsage().rss / 1048576,
        queryPlan: db.all('EXPLAIN QUERY PLAN SELECT item_id FROM items WHERE title LIKE ?', ['%needle%']) }))
      db.close()
    }
    const source = join(dir, 'source.png')
    await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#446688' } }).png().toFile(source)
    const imageStart = performance.now()
    const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable()
    for (let i = 0; i < 30; i++) await generateDerivatives(source, join(dir, 'thumb', `${i}.jpg`), join(dir, 'preview', `${i}.jpg`))
    loop.disable()
    console.log(JSON.stringify({ imageCount: 30, imagesPerSecond: 30000 / (performance.now() - imageStart), eventLoopMaxMs: loop.max / 1e6, rssMB: process.memoryUsage().rss / 1048576 }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
void main()
