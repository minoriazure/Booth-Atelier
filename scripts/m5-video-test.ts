/** M5 验证：yt-dlp 视频下载 + 协议解析 */
import { join } from 'path'
import { existsSync, statSync, readdirSync } from 'fs'
import { createAppContext } from '../src/main/appContext'
import { parseItemImportUrl, parseItemImportUrl as parse } from '../src/main/protocol'

async function main() {
  // 1) 协议 URL 解析（构造真实格式）
  console.log('=== 1. 协议 URL 解析 ===')
  const sample =
    'booth-library-manager://item-import?dlurl=https%3A%2F%2Fs6.booth.pm%2F15cc881b-a9a5-4bc0-9452-03d16e55fb89%2Ff%2F8749497%2F9535314%2F_test.zip%3FX-Amz-Expires%3D180&downloadable_filename=_test.zip&item_id=8749497&order_id=86808700&variation_id=14611009'
  const p = parse(sample)
  console.log(JSON.stringify(p))
  const f0 = p?.files[0]
  if (!p || p.itemId !== 8749497 || f0?.downloadableId !== 9535314 || p.variationId !== 14611009) {
    throw new Error('协议解析错误')
  }
  console.log('✓ 协议解析正确（item-import?dlurl= 形态）')

  // 形态 B：网页端 import?item_id=&dlurls[]=
  const sampleWeb =
    'booth-library-manager://import?item_id=8749497&order_id=86808700&variation_id=14611009' +
    '&dlurls[]=https%3A%2F%2Fs6.booth.pm%2Fuuid%2Ff%2F8749497%2F9535314%2F_a.zip%3FX-Amz-Expires%3D180' +
    '&dlurls[]=https%3A%2F%2Fs6.booth.pm%2Fuuid%2Ff%2F8749497%2F9535315%2F_b.zip%3FX-Amz-Expires%3D180' +
    '&filenames%5B%5D=_a.zip&filenames%5B%5D=_b.zip'
  const pw = parseItemImportUrl(sampleWeb)
  console.log(JSON.stringify(pw))
  if (
    !pw ||
    pw.itemId !== 8749497 ||
    pw.files.length !== 2 ||
    pw.files[0].downloadableId !== 9535314 ||
    pw.files[1].downloadableId !== 9535315 ||
    pw.files[1].filename !== '_b.zip'
  ) {
    throw new Error('协议解析错误（web import 形态）')
  }
  console.log('✓ 协议解析正确（import?dlurls[]= 形态，多文件按索引配对）')

  // 2) yt-dlp 检测 + 真实下载一个视频
  const ctx = await createAppContext({
    dataDir: join(process.cwd(), '.temp/data'),
    cookiesPath: join(process.cwd(), 'booth_cookies.txt'),
    downloadRoot: join(process.cwd(), '.temp/library')
  })
  try {
    ctx.imageLocalizer.pause()
    console.log('\n=== 2. yt-dlp 检测 ===')
    const y = await ctx.videos.checkYtDlp(true)
    console.log('yt-dlp found:', y)

    // 找一个未下载的视频
    const vids = ctx.db.all<{ key: string; item_id: number; video_id: string; url: string; status: string }>(
      `SELECT key, item_id, video_id, url, status FROM item_videos WHERE status != 'downloaded' LIMIT 3`
    )
    if (vids.length === 0) throw new Error('没有可下载的视频')
    const target = vids[0]
    console.log(`\n=== 3. 下载视频 ${target.key} (${target.url}) ===`)
    ctx.videos.onProgress = (e) => {
      if (e.progress % 25 === 0 || e.status !== 'downloading') console.log(`  progress: ${e.progress}% ${e.status}`)
    }
    const r = await ctx.videos.download(target.key)
    console.log('result:', JSON.stringify(r))
    if (!r.ok || !r.path || !existsSync(r.path)) throw new Error('视频下载失败: ' + r.error)
    console.log(`✓ 视频下载成功: ${r.path} (${statSync(r.path).size} bytes)`)

    // 3) 目录结构检查
    console.log('\n=== 4. 商品目录结构 ===')
    const itemDir = join(process.cwd(), '.temp/library', String(target.item_id))
    const walk = (dir: string, prefix = ''): void => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        console.log(`  ${prefix}${f.name}${f.isDirectory() ? '/' : ''}`)
        if (f.isDirectory() && prefix.length < 4) walk(join(dir, f.name), prefix + '  ')
      }
    }
    walk(itemDir)

    console.log('\n✓ M5 验证通过')
  } finally {
    ctx.dispose()
  }
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
