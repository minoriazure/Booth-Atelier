/** M4 验证：完整描述 + 视频提取 + 图片本地化 + 设置拆分 */
import { join } from 'path'
import { existsSync, readdirSync } from 'fs'
import { createAppContext } from '../src/main/appContext'

async function main() {
  const ctx = await createAppContext({
    dataDir: join(process.cwd(), '.temp/data'),
    cookiesPath: join(process.cwd(), 'booth_cookies.txt'),
    downloadRoot: join(process.cwd(), '.temp/library')
  })
  try {
    // 1) 全量强制同步（新解析器抓完整描述）
    console.log('=== 1. 强制同步（完整描述 + 视频 + 图片登记） ===')
    const s = await ctx.sync.sync(true)
    console.log('sync:', JSON.stringify(s))

    // 2) 描述完整性
    console.log('\n=== 2. 描述完整性 ===')
    let withVideo = 0, withIframe = 0, totalLen = 0
    for (const it of ctx.repo.listSummaries()) {
      const d = ctx.repo.getItemDetail(it.itemId)!
      totalLen += d.descriptionHtml.length
      const vids = ctx.repo.listVideosByItem(it.itemId)
      if (vids.length > 0) {
        withVideo++
        console.log(`  #${it.itemId} videos: ${vids.map((v) => v.key).join(', ')}`)
      }
      if (d.descriptionHtml.includes('<iframe')) withIframe++
    }
    console.log(`描述含视频商品: ${withVideo}, 含未解析 iframe: ${withIframe}, 平均长度: ${Math.round(totalLen / 39)}`)

    // 8749497 应该有 youtube 视频
    const v87 = ctx.repo.listVideosByItem(8749497)
    console.log(`8749497 videos: ${JSON.stringify(v87.map((v) => ({ key: v.key, url: v.url })))}`)
    if (v87.length === 0) throw new Error('8749497 应有 YouTube 视频但未提取到')

    // 3) 图片登记与后台下载
    console.log('\n=== 3. 图片本地化 ===')
    // 等图片队列跑一会
    for (let i = 0; i < 60; i++) {
      const st = ctx.imageLocalizer.stats
      if (st.queued === 0 && st.active === 0) break
      if (i % 6 === 0) console.log(`  queue: ${st.queued} pending, ${st.active} active`)
      await new Promise((r) => setTimeout(r, 5000))
    }
    const imgStats = ctx.db.all<{ total: number; done: number }>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done FROM item_images`
    )[0]
    console.log(`images: ${imgStats.done}/${imgStats.total} done`)
    const thumbDone = ctx.db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM item_images WHERE kind='thumb' AND status='done'`)[0]
    console.log(`thumbs done: ${thumbDone.n}/39`)
    if (thumbDone.n < 30) throw new Error('缩略图本地化数量不足')

    // 本地文件检查
    const thumb = ctx.repo.listSummaries()[0]
    if (thumb?.thumbnailUrl) {
      const local = ctx.imageLocalizer.resolveLocal(thumb.thumbnailUrl)
      console.log(`sample local thumb: ${local} exists=${local ? existsSync(local) : false}`)
      if (!local || !existsSync(local)) throw new Error('缩略图本地路径无效')
    }

    // 4) getItemDetail 组装
    console.log('\n=== 4. 详情组装 ===')
    const detail = ctx.repo.getItemDetail(8749497)!
    const localG = detail.galleryUrls.map((u) => ctx.imageLocalizer.resolveLocal(u))
    const localCount = localG.filter(Boolean).length
    console.log(`8749497 gallery: ${detail.galleryUrls.length} total, ${localCount} local`)

    // 5) 设置拆分
    console.log('\n=== 5. 设置拆分 ===')
    const settings = ctx.settings.get()
    console.log(`autoSyncLibraryOnStartup=${settings.autoSyncLibraryOnStartup}, autoCheckFilesOnStartup=${settings.autoCheckFilesOnStartup}`)

    console.log('\n✓ M4 验证通过')
  } finally {
    ctx.dispose()
  }
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
