/** 全量抓取库列表（购买+赠送）并 dump JSON: npx tsx scripts/crawl-library.ts [out.json] */
import { writeFileSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { bootstrap, fatal } from './_bootstrap'

const { crawler } = bootstrap()
const out = resolve(__dirname, process.argv[2] || '../.temp/library-dump.json')

async function main() {
  const t0 = Date.now()
  const items = await crawler.crawlAll((kind, page, count) => {
    console.log(`[${kind}] page ${page}: ${count} 项`)
  })
  const files = items.reduce((s, i) => s + i.downloadables.length, 0)
  console.log(`\n共 ${items.length} 商品 / ${files} 下载链接，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  // 抽样校验
  const multi = items.filter((i) => i.downloadables.length > 3)
  console.log(`多文件商品: ${multi.length} 个（示例 ${multi.slice(0, 3).map((i) => `${i.itemId}(${i.downloadables.length})`).join(', ')}）`)
  const noVar = items.flatMap((i) => i.downloadables).filter((d) => d.variationId == null)
  console.log(`缺 variation_id 的链接: ${noVar.length}`)
  const noName = items.flatMap((i) => i.downloadables).filter((d) => !d.filename)
  console.log(`缺文件名的链接: ${noName.length}`)

  const dir = resolve(out, '..')
  mkdirSync(dir, { recursive: true })
  writeFileSync(out, JSON.stringify(items, null, 2), 'utf-8')
  console.log(`dump → ${out}`)
}

main().catch(fatal)
