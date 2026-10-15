/** 验证 cookies 是否有效: npx tsx scripts/check-auth.ts */
import { bootstrap, fatal } from './_bootstrap'

const { crawler, jar } = bootstrap()

async function main() {
  console.log(`cookies: ${jar.filePathRef} (${jar.count} 条)`)
  const items = await crawler.crawlKind('library')
  console.log(`登录有效 ✓  购买库共 ${items.length} 个商品，${items.reduce((s, i) => s + i.downloadables.length, 0)} 个下载链接`)
}

main().catch(fatal)
