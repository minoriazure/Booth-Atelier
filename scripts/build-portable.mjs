#!/usr/bin/env node
/**
 * 缓存型便携版打包。
 *
 * 前置：electron-vite 已构建（out/），`electron-builder --dir` 已产出 dist/win-unpacked/。
 * 流程：win-unpacked → 7z(LZMA2) → 内嵌进自研 NSIS 启动器 stub → dist/*portable.exe
 * 启动器行为见 scripts/portable-stub.nsi.in（首启解压到 %LOCALAPPDATA% 缓存，之后直启）。
 *
 * NSIS 工具链自动准备：优先复用 electron-builder 的缓存（%LOCALAPPDATA%\electron-builder\Cache\nsis），
 * 缺失时从 electron-builder-binaries 官方源下载（sha256 校验），无需手动安装 NSIS。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const productName = pkg.build.productName
const appExe = `${productName}.exe`

const unpackedDir = path.join(root, 'dist', 'win-unpacked')
const appExePath = path.join(unpackedDir, appExe)
const app7z = path.join(root, 'dist', 'app.7z')
const outExe = path.join(root, 'dist', `BoothAtelier-${version}-portable.exe`)
const templatePath = path.join(root, 'scripts', 'portable-stub.nsi.in')
const generatedNsi = path.join(root, 'dist', 'portable-stub.generated.nsi')

function fail(msg) {
  console.error(`[build-portable] ${msg}`)
  process.exit(1)
}

if (!fs.existsSync(appExePath)) {
  fail(`未找到 ${appExePath}，请先运行 electron-builder --dir`)
}
const sevenZip = require('7zip-bin').path7za
if (!fs.existsSync(sevenZip)) fail(`未找到 7za：${sevenZip}`)

// ---------- 1. 压缩 win-unpacked（内容在压缩包根，主程序 exe 在根目录） ----------
console.log('[build-portable] 7z 压缩 win-unpacked（LZMA2，需要几分钟）...')
fs.rmSync(app7z, { force: true })
execFileSync(sevenZip, ['a', '-t7z', '-m0=lzma2', '-mx=9', '-mmt=on', app7z, '.'], {
  cwd: unpackedDir,
  stdio: 'inherit'
})
const payloadHash = createHash('sha256').update(fs.readFileSync(app7z)).digest('hex')
const marker = `${version}-${payloadHash.slice(0, 12)}`
const sizeMb = (fs.statSync(app7z).size / 1024 / 1024).toFixed(1)
console.log(`[build-portable] app.7z = ${sizeMb} MB, marker = ${marker}`)

// ---------- 2. 准备 NSIS 工具链（makensis + nsis7z 插件） ----------
const NSIS_CACHE = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'nsis')
// 与 electron-builder 25 使用的版本/源完全一致，缓存目录也复用同一布局
const NSIS_TOOLS = [
  {
    dir: 'nsis-3.0.4.1',
    url: 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z',
    sha256: '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa'
  },
  {
    dir: 'nsis-resources-3.4.1',
    url: 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-resources-3.4.1/nsis-resources-3.4.1.7z',
    sha256: '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103'
  }
]

async function ensureTool({ dir, url, sha256 }) {
  const dest = path.join(NSIS_CACHE, dir)
  const markerFile = path.join(dest, '.build-portable-ready')
  if (fs.existsSync(markerFile) || fs.existsSync(path.join(dest, 'Bin', 'makensis.exe')) || fs.existsSync(path.join(dest, 'plugins'))) {
    return dest
  }
  console.log(`[build-portable] 缓存缺失，下载 ${dir} ...`)
  fs.mkdirSync(NSIS_CACHE, { recursive: true })
  const resp = await fetch(url)
  if (!resp.ok) fail(`下载失败 ${url} → HTTP ${resp.status}`)
  const archive = path.join(os.tmpdir(), `${dir}.7z`)
  const buf = Buffer.from(await resp.arrayBuffer())
  const actual = createHash('sha256').update(buf).digest('hex')
  if (actual !== sha256) fail(`SHA-256 校验失败：${dir}\n期望 ${sha256}\n实际 ${actual}`)
  fs.writeFileSync(archive, buf)
  fs.mkdirSync(dest, { recursive: true })
  execFileSync(sevenZip, ['x', '-y', `-o${dest}`, archive], { stdio: 'inherit' })
  fs.rmSync(archive, { force: true })
  fs.writeFileSync(markerFile, `${dir} verified sha256=${sha256}\n`)
  return dest
}

const nsisDir = await ensureTool(NSIS_TOOLS[0])
const resourcesDir = await ensureTool(NSIS_TOOLS[1])

const makensis = path.join(nsisDir, 'Bin', 'makensis.exe')
if (!fs.existsSync(makensis)) fail(`未找到 makensis：${makensis}`)
const nsisPluginDir = path.join(resourcesDir, 'plugins', 'x86-unicode')
if (!fs.existsSync(path.join(nsisPluginDir, 'nsis7z.dll'))) {
  fail(`未找到 nsis7z.dll：${nsisPluginDir}`)
}

// ---------- 3. 生成 NSIS 脚本（UTF-8 BOM，Unicode NSIS 要求）并编译 stub ----------
const versionX4 = `${version.split('.').map((n) => n.replace(/\D/g, '') || '0').slice(0, 4).join('.')}`
  .split('.')
  .concat(['0', '0', '0', '0'])
  .slice(0, 4)
  .join('.')

const template = fs.readFileSync(templatePath, 'utf8')
const nsi = template
  .replaceAll('@PRODUCT_NAME@', productName)
  .replaceAll('@VERSION_X4@', versionX4)
  .replaceAll('@VERSION@', version)
  .replaceAll('@APP_EXE@', appExe)
  .replaceAll('@APP_EXE_PATH@', appExePath)
  .replaceAll('@APP7Z@', app7z)
  .replaceAll('@OUT_EXE@', outExe)
  .replaceAll('@NSIS_PLUGIN_DIR@', nsisPluginDir)
  .replaceAll('@MARKER@', marker)
if (nsi.includes('@')) fail('模板占位符未全部代入，检查 portable-stub.nsi.in')
fs.mkdirSync(path.dirname(generatedNsi), { recursive: true })
fs.writeFileSync(generatedNsi, '﻿' + nsi)

console.log('[build-portable] makensis 编译启动器 stub...')
execFileSync(makensis, ['/V2', generatedNsi], { stdio: 'inherit' })

if (!fs.existsSync(outExe)) fail(`产物未生成：${outExe}`)
const outMb = (fs.statSync(outExe).size / 1024 / 1024).toFixed(1)
console.log(`[build-portable] 完成：${outExe}（${outMb} MB）`)
console.log(`[build-portable] 首启缓存目录：<exe 同级>\\app-cache\\${marker}`)

// 中间产物自动清理：win-unpacked / app.7z / 生成的 nsi / builder-debug.yml 都可由下次构建再生，
// 构建成功后即删，保持 dist/ 只剩最终产物（data/ downloads/ cookies 不受影响）。
// 需要保留中间产物排查问题时设 BOOTH_KEEP_BUILD_INTERMEDIATES=1。
if (!process.env.BOOTH_KEEP_BUILD_INTERMEDIATES) {
  const intermediates = [
    app7z,
    generatedNsi,
    path.join(root, 'dist', 'win-unpacked'),
    path.join(root, 'dist', 'builder-debug.yml')
  ]
  for (const p of intermediates) fs.rmSync(p, { recursive: true, force: true })
  console.log('[build-portable] 中间产物已清理（win-unpacked / app.7z / nsi）；保留请设 BOOTH_KEEP_BUILD_INTERMEDIATES=1')
}
