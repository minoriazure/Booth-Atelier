/** M7 验证：缩略图生成 + 时间间隔设置 */
import { join } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { createAppContext } from '../src/main/appContext'

async function main() {
  const ctx = await createAppContext({
    dataDir: join(process.cwd(), '.temp/data'),
    cookiesPath: join(process.cwd(), 'booth_cookies.txt'),
    downloadRoot: join(process.cwd(), '.temp/library')
  })
  try {
    ctx.imageLocalizer.pause()
    // 1) resolveThumbLocal 触发生成（8749497 有 27 张原图）
    console.log('=== 1. 缩略图触发生成 ===')
    const d = ctx.repo.getItemDetail(8749497)!
    for (const g of d.galleryUrls.slice(0, 5)) {
      const r = ctx.imageLocalizer.resolveThumbLocal(g)
      console.log(`  → ${r?.split(/[\\/]/).slice(-2).join('/')}`)
    }
    // 等缩略图队列跑完
    await new Promise((r) => setTimeout(r, 15000))
    const thumbDir = ctx.paths.thumbsDir(8749497)
    const thumbs = existsSync(thumbDir) ? readdirSync(thumbDir) : []
    console.log(`thumb dir: ${thumbDir}`)
    console.log(`generated: ${thumbs.length} thumbs`)
    if (thumbs.length === 0) throw new Error('没有生成任何缩略图')
    // 尺寸对比
    const imgDir = ctx.paths.imagesDir(8749497)
    const orig = readdirSync(imgDir).map((f) => statSync(join(imgDir, f)).size)
    const th = thumbs.map((f) => statSync(join(thumbDir, f)).size)
    const avgOrig = Math.round(orig.reduce((a, b) => a + b, 0) / orig.length / 1024)
    const avgThumb = Math.round(th.reduce((a, b) => a + b, 0) / th.length / 1024)
    console.log(`平均大小: 原图 ${avgOrig}KB → 缩略图 ${avgThumb}KB`)

    // 2) 时间间隔设置
    console.log('\n=== 2. 时间间隔设置 ===')
    ctx.settings.set({ startupCheckIntervalDays: 7 })
    const s = ctx.settings.get()
    console.log(`startupCheckIntervalDays=${s.startupCheckIntervalDays}`)
    if (s.startupCheckIntervalDays !== 7) throw new Error('设置未持久化')

    console.log('\n✓ M7 验证通过')
  } finally {
    ctx.dispose()
  }
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
