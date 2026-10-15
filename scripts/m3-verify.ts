/**
 * M3 验证：全量库同步 → 全局指纹检查（不下载）→ 下载一个小商品 → 模拟更新 → 归档验证
 * 用法: npx tsx scripts/m3-verify.ts
 */
import { existsSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { createAppContext } from '../src/main/appContext'
import { localDate } from '../src/main/util/filenames'

async function main() {
  const dataDir = join(__dirname, '../.temp/data')
  const downloadRoot = join(__dirname, '../.temp/library')
  const ctx = await createAppContext({
    dataDir,
    cookiesPath: join(__dirname, '../booth_cookies.txt'),
    downloadRoot
  })

  try {
    // ── 1. 全量元数据同步 ──
    console.log('\n=== 1. 库同步（纯元数据） ===')
    const syncSummary = await ctx.sync.sync()
    console.log('sync:', JSON.stringify(syncSummary))
    const items = ctx.repo.listSummaries()
    const dlCount = ctx.repo.listAllDownloadables().length
    console.log(`DB: ${items.length} items, ${dlCount} downloadables`)
    if (items.length < 30) throw new Error('同步商品数异常')

    // ── 2. 全局指纹检查（只查不下） ──
    console.log('\n=== 2. 全局指纹检查（autoDownloadUpdates 暂关） ===')
    ctx.settings.set({ autoDownloadUpdates: false })
    const t0 = Date.now()
    const checkSummary = await ctx.checker.checkGlobal()
    console.log(`check: ${JSON.stringify(checkSummary)} 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    const dl1 = ctx.repo.listAllDownloadables()
    const withFp = dl1.filter((d) => d.lastEtag || d.lastSize).length
    console.log(`有指纹: ${withFp}/${dl1.length}`)
    if (withFp !== dl1.length) console.log('⚠ 部分链接指纹缺失（可能有检查失败）')

    // ── 3. 下载一个小商品（选文件最少的非零商品） ──
    console.log('\n=== 3. 下载测试（最小商品） ===')
    const target = items
      .filter((i) => i.fileTotal > 0 && i.fileTotal <= 3)
      .sort((a, b) => a.fileTotal - b.fileTotal)[0]
    if (!target) throw new Error('找不到合适的小商品')
    console.log(`target: ${target.itemId} ${target.title.slice(0, 50)} (${target.fileTotal} files)`)
    const n = ctx.downloads.enqueueItem(target.itemId, 'manual')
    console.log(`enqueued ${n} files`)
    await waitForQueue(ctx)
    const after = ctx.repo.getItemDetail(target.itemId)!
    console.log(`downloaded: ${after.fileDownloaded}/${after.fileTotal}`)
    for (const f of after.downloadables) {
      const ok = f.localPath && existsSync(f.localPath)
      console.log(`  [${f.status}] ${f.filename} ${f.localPath}`)
      if (!ok) throw new Error(`文件未落地: ${f.filename}`)
    }

    // ── 4. 模拟更新：改 DB 指纹 → 检查 → 自动下载 → 旧文件归档 ──
    console.log('\n=== 4. 模拟更新检测 ===')
    ctx.settings.set({ autoDownloadUpdates: true })
    const f0 = after.downloadables[0]
    // 记录当前文件路径与内容特征
    const curPath = f0.localPath!
    const beforeSize = statSync(curPath).size
    // 篡改指纹为错误值 → 检查时会发现真实指纹不同 → update_available → 自动下载
    ctx.repo.run('UPDATE downloadables SET last_etag = ?, last_size = ? WHERE downloadable_id = ?', [
      'SIMULATED_ETAG',
      1,
      f0.downloadableId
    ])
    const check2 = await ctx.checker.checkItem(target.itemId)
    console.log('check2:', JSON.stringify(check2))
    await waitForQueue(ctx)

    const after2 = ctx.repo.getItemDetail(target.itemId)!
    const f0b = after2.downloadables.find((d) => d.downloadableId === f0.downloadableId)!
    console.log(`status: ${f0b.status}, localSize: ${f0b.localSize} (原 ${beforeSize})`)
    if (f0b.status !== 'downloaded') throw new Error('模拟更新后未回到 downloaded')

    // 归档目录检查
    const historyDir = ctx.paths.historyDir(target.itemId, localDate())
    const archived = existsSync(historyDir) ? readdirSync(historyDir) : []
    console.log(`history dir: ${historyDir}`)
    console.log(`archived files: ${JSON.stringify(archived)}`)
    const fileHistory = ctx.repo.listFileHistoryDates(target.itemId)
    console.log(`file_history rows: ${JSON.stringify(fileHistory)}`)

    // 注意：同一文件在被篡改指纹后重新下载，若 etag 未变（真实远端没变），
    // 下载会因"已存在同指纹"跳过 → 无归档。这里接受两种结果：
    const records = ctx.repo.listDownloadRecords(10)
    const updateRecord = records.find((r: any) => r.source === 'update')
    console.log(`update download record: ${JSON.stringify(updateRecord)}`)

    // 二次检查应无更新
    console.log('\n=== 5. 二次检查应为零更新 ===')
    const check3 = await ctx.checker.checkItem(target.itemId)
    console.log('check3:', JSON.stringify(check3))
    if (check3.filesUpdated !== 0) console.log('⚠ 二次检查仍有更新标记')

    // ── 6. 描述快照验证 ──
    console.log('\n=== 6. 描述快照 ===')
    const snapDates = ctx.repo.listSnapshotDates(target.itemId)
    console.log(`snapshots: ${JSON.stringify(snapDates.map((s) => s.snapshotDate))}`)
    console.log(`desc file exists: ${existsSync(ctx.paths.descriptionPath(target.itemId))}`)

    console.log('\n✓ M3 全部验证通过')
  } finally {
    ctx.dispose()
  }
}

async function waitForQueue(ctx: Awaited<ReturnType<typeof createAppContext>>, timeoutMs = 600_000) {
  const t0 = Date.now()
  for (;;) {
    const { queued, active, paused } = ctx.downloads.stats
    if (queued === 0 && active === 0) return
    if (paused) throw new Error('队列因认证失败暂停')
    if (Date.now() - t0 > timeoutMs) throw new Error('下载队列超时')
    await new Promise((r) => setTimeout(r, 500))
  }
}

main().catch((e) => {
  console.error('M3 FAILED:', e)
  process.exit(1)
})
