/**
 * M1 核心验证：端到端下载单个文件（deeplink → 签名直链 → 原子落盘）
 * 用法: npx tsx scripts/dl-one.ts <downloadable_id> [variation_id] [outDir]
 * 示例: npx tsx scripts/dl-one.ts 9535314 14611009
 */
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, readFileSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'
import { bootstrap, fatal } from './_bootstrap'
import { sanitizeFilename, localDate } from '../src/main/util/filenames'

const { deeplink } = bootstrap()

const downloadableId = Number(process.argv[2])
const variationId = process.argv[3] ? Number(process.argv[3]) : null
const outDir = resolve(__dirname, process.argv[4] || '../.temp/downloads')

if (!downloadableId) {
  console.error('用法: npx tsx scripts/dl-one.ts <downloadable_id> [variation_id] [outDir]')
  process.exit(1)
}

async function main() {
  // 1) resolve deeplink（即时，180s 过期）
  const r = await deeplink.resolve(downloadableId, variationId)
  console.log(`resolve ✓ item=${r.itemId} file=${r.filename}`)

  // 2) 指纹探测（Range GET）
  const fp = await deeplink.probe(r.dlurl)
  console.log(`probe ✓ size=${fp.size} etag=${fp.etag} lastModified=${fp.lastModified}`)

  // 3) 若本地已有且指纹一致则跳过
  const stateFile = join(outDir, '.state.json')
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf-8')) : {}
  const prev = state[downloadableId]
  const filename = sanitizeFilename(r.filename)
  const finalPath = join(outDir, filename)
  if (prev && prev.etag === fp.etag && prev.size === fp.size && existsSync(finalPath)) {
    console.log(`指纹未变化，跳过下载（已存在 ${finalPath}）`)
    return
  }

  // 4) 流式下载到 .part 再原子改名
  mkdirSync(outDir, { recursive: true })
  const partPath = finalPath + '.part'
  const res = await fetch(r.dlurl, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    redirect: 'follow'
  })
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}`)
  const ws = createWriteStream(partPath)
  let done = 0
  const reader = res.body.getReader()
  let lastLog = Date.now()
  for (;;) {
    const { done: d, value } = await reader.read()
    if (d) break
    if (value) {
      done += value.byteLength
      if (!ws.write(Buffer.from(value))) {
        await new Promise<void>((ok) => {
          ws.once('drain', () => ok())
        })
      }
      if (Date.now() - lastLog > 1000) {
        const pct = fp.size ? ((done / fp.size) * 100).toFixed(1) : '?'
        console.log(`  ${((done / 1048576)).toFixed(1)} MB (${pct}%)`)
        lastLog = Date.now()
      }
    }
  }
  await new Promise<void>((ok, err) => {
    ws.on('error', (e) => err(e))
    ws.end(() => ok())
  })
  renameSync(partPath, finalPath)

  const actual = statSync(finalPath).size
  if (fp.size != null && actual !== fp.size) {
    throw new Error(`大小不一致: 实际 ${actual} vs 预期 ${fp.size}`)
  }
  state[downloadableId] = { etag: fp.etag, size: fp.size, path: finalPath, date: localDate() }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  console.log(`下载完成 ✓ ${finalPath} (${actual} bytes)`)
}

main().catch(fatal)
