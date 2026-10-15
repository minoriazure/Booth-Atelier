/**
 * 归档修复验证：篡改指纹 → 检查 → 自动下载 → 断言旧文件进入 history/{今天}/
 * 复用已有 DB（不重新同步/全量检查）
 */
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { createAppContext } from '../src/main/appContext'
import { localDate } from '../src/main/util/filenames'

async function main() {
  const ctx = await createAppContext({
    dataDir: join(__dirname, '../.temp/data'),
    cookiesPath: join(__dirname, '../booth_cookies.txt'),
    downloadRoot: join(__dirname, '../.temp/library')
  })
  try {
    // 找一个已下载的文件
    const items = ctx.repo.listSummaries()
    const target = items.find((i) => i.fileDownloaded > 0)
    if (!target) throw new Error('没有已下载的商品，请先跑 m3-verify')
    const detail = ctx.repo.getItemDetail(target.itemId)!
    const f = detail.downloadables.find((x) => x.status === 'downloaded' && x.localPath && existsSync(x.localPath))!
    console.log(`target: item=${target.itemId} file=${f.filename}`)
    const curPath = f.localPath!
    const beforeSize = statSync(curPath).size
    const beforeMtime = statSync(curPath).mtimeMs

    // 改文件 mtime 以区分“新写入”
    const historyDir = ctx.paths.historyDir(target.itemId, localDate())
    const archivedBefore = existsSync(historyDir) ? readdirSync(historyDir) : []
    console.log(`history before: ${JSON.stringify(archivedBefore)}`)

    // 篡改指纹 → 检查 → 检测到“更新” → 自动下载
    ctx.settings.set({ autoDownloadUpdates: true })
    ctx.repo.run('UPDATE downloadables SET last_etag = ? WHERE downloadable_id = ?', ['SIMULATED_ETAG_2', f.downloadableId])
    const summary = await ctx.checker.checkItem(target.itemId)
    console.log('check:', JSON.stringify(summary))
    if (summary.filesUpdated < 1) throw new Error('未检测到模拟更新')

    // 等队列
    for (let i = 0; i < 1200; i++) {
      const st = ctx.downloads.stats
      if (st.queued === 0 && st.active === 0) break
      if (st.paused) throw new Error('队列因认证暂停')
      await new Promise((r) => setTimeout(r, 500))
    }

    // 断言
    const archivedAfter = existsSync(historyDir) ? readdirSync(historyDir) : []
    console.log(`history after: ${JSON.stringify(archivedAfter)}`)
    const newArchived = archivedAfter.filter((x) => !archivedBefore.includes(x))
    const rows = ctx.repo.listFileHistoryDates(target.itemId)
    console.log(`file_history rows: ${JSON.stringify(rows)}`)

    const ok = existsSync(curPath)
    console.log(`current file exists: ${ok} (${statSync(curPath).size} bytes, mtime changed: ${statSync(curPath).mtimeMs !== beforeMtime})`)

    if (newArchived.length === 0) {
      console.log('✗ 旧文件未归档')
      process.exit(2)
    }
    if (rows.length === 0) {
      console.log('✗ file_history 无记录')
      process.exit(3)
    }
    console.log(`✓ 归档验证通过: ${newArchived.join(', ')} → ${historyDir}`)
  } finally {
    ctx.dispose()
  }
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
