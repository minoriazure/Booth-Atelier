import { app, BrowserWindow } from 'electron'
import { readdirSync } from 'fs'
import { join } from 'path'
import { createLogger } from './util/log'

const log = createLogger('protocol')

export const BOOTH_PROTOCOL = 'booth-library-manager'

/** 深链中的单个下载文件 */
export interface ProtocolImportFile {
  dlurl: string
  filename: string
  /** 从 dlurl 路径 /f/{itemId}/{downloadableId}/ 提取 */
  downloadableId: number | null
  itemId: number
}

/**
 * booth-library-manager:// 深链（两种形态，见 DEEP-LINK.md §3）：
 * - A（网页端按钮 / 购买下载页）：
 *   booth-library-manager://import?item_id=&order_id=&variation_id=&dlurls[]=&filenames[]=
 * - B（/downloadables/{id}/deeplink 端点302）：
 *   booth-library-manager://item-import?dlurl=&downloadable_filename=&item_id=&order_id=
 */
export interface ProtocolImport {
  itemId: number
  orderId: number | null
  variationId: number | null
  files: ProtocolImportFile[]
}

/** 从预签名直链提取 id 与文件名：https://s6.booth.pm/{uuid}/f/{item_id}/{downloadable_id}/{filename}?X-Amz-... */
function idsFromDlurl(dlurl: string): { itemId: number; downloadableId: number | null; filename: string } {
  try {
    const p = new URL(dlurl).pathname
    const m = /\/f\/(\d+)\/(\d+)\/(.+)$/.exec(p)
    if (m) {
      let filename = ''
      try {
        filename = decodeURIComponent(m[3])
      } catch {
        filename = m[3]
      }
      return { itemId: Number(m[1]), downloadableId: Number(m[2]), filename }
    }
  } catch {
    /* ignore */
  }
  return { itemId: 0, downloadableId: null, filename: '' }
}

export function parseItemImportUrl(raw: string): ProtocolImport | null {
  if (!raw.startsWith(`${BOOTH_PROTOCOL}:`)) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const q = u.searchParams
  const orderId = q.get('order_id') ? Number(q.get('order_id')) : null
  const variationId = q.get('variation_id') ? Number(q.get('variation_id')) : null
  let itemId = Number(q.get('item_id') || 0)

  // 形态 A：import?item_id=...&dlurls[]=...&filenames[]=...（参数名可能 percent 编码成 dlurls%5B%5D，
  // URL 解码后 searchParams 统一为 'dlurls[]'；getAll 天然支持重复键，按索引与 filenames 配对）
  const dlurls = q.getAll('dlurls[]').length > 0 ? q.getAll('dlurls[]') : q.getAll('dlurls')
  if (dlurls.length > 0) {
    if (!itemId) itemId = idsFromDlurl(dlurls[0]).itemId
    if (!itemId) return null
    const names = q.getAll('filenames[]').length > 0 ? q.getAll('filenames[]') : q.getAll('filenames')
    const files = dlurls.map((dl, i) => {
      const fromPath = idsFromDlurl(dl)
      return {
        dlurl: dl,
        filename: names[i] || fromPath.filename,
        downloadableId: fromPath.downloadableId,
        itemId: fromPath.itemId || itemId
      }
    })
    return { itemId, orderId, variationId, files }
  }

  // 形态 B：item-import?dlurl=...
  const single = q.get('dlurl')
  if (single) {
    const fromPath = idsFromDlurl(single)
    if (!itemId) itemId = fromPath.itemId
    if (!itemId || !fromPath.downloadableId) return null
    return {
      itemId,
      orderId,
      variationId,
      files: [
        {
          dlurl: single,
          filename: q.get('downloadable_filename') || fromPath.filename,
          downloadableId: fromPath.downloadableId,
          itemId
        }
      ]
    }
  }
  return null
}

/**
 * 把 booth-library-manager:// 注册为本程序处理（覆盖官方注册）。
 * - portable：注册缓存型 stub（PORTABLE_EXECUTABLE_DIR 下的 BoothAtelier-*-portable.exe），
 *   固定路径永不消失，stub 负责从 exe 同级 app-cache\ 启动主程序并转发参数
 * - 仅打包版注册；dev 下注册 electron.exe 会劫持系统且开发时行为混乱
 * - HKCU\Software\Classes 优先级高于 HKLM，可覆盖官方的机器级注册
 */
export function registerProtocol(): void {
  if (!app.isPackaged) {
    log.info('dev mode: skip protocol registration')
    return
  }
  let launcher = process.execPath
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir) {
    try {
      // 目录里可能同时存在 portable 启动器、NSIS 安装包（Setup）、卸载器等——
      // 必须挑 portable 启动器本身：安装包被当协议宿主会拉起安装向导而不是程序（实测踩坑）
      const exes = readdirSync(portableDir).filter(
        (f) => /\.exe$/i.test(f) && !/unins|setup|install/i.test(f)
      )
      const portableExe = exes.find((f) => /portable/i.test(f)) ?? exes[0]
      if (portableExe) launcher = join(portableDir, portableExe)
      log.info(`portable launcher candidates=${JSON.stringify(exes)} → ${launcher}`)
    } catch (e) {
      log.warn('portable launcher detect failed:', e)
    }
  }
  try {
    const ok = app.setAsDefaultProtocolClient(BOOTH_PROTOCOL, launcher, [])
    log.info(`register ${BOOTH_PROTOCOL}:// → ${launcher} (ok=${ok})`)
  } catch (e) {
    log.error('protocol register failed:', e)
  }
}

/** 从 argv / open-url 提取协议 URL */
export function findProtocolArg(argv: string[]): string | null {
  for (const a of argv) {
    if (a.startsWith(`${BOOTH_PROTOCOL}://`)) return a
  }
  return null
}

/**
 * 协议链接处理入口（顺序遵循 DEEP-LINK.md §6）：
 * ① 第一行抢前台 —— 页面在等浏览器失焦，重活一律延后；
 * ② 解析两种形态 → 确保 DB 行存在（未同步的先建占位）→ downloadNow 直接进下载中
 *    （模拟原版：不排队、不等并发槽）。
 * dlurl 只用于提取 id（180s 过期），实际下载由 DownloadManager 按 downloadableId 重新 resolve。
 */
export async function handleProtocolUrl(
  raw: string,
  deps: {
    repo: import('./db/repos').LibraryRepo
    downloads: import('./services/downloadManager').DownloadManager
    emit: (channel: string, payload: unknown) => void
    focusWindow: () => void
  }
): Promise<void> {
  const { repo, downloads, emit, focusWindow } = deps
  // ① 同步抢焦点（第一行，纯本地）—— 网络再差，浏览器失焦这步不受任何影响
  focusWindow()
  log.info(`deep link received: ${raw.split('?')[0]} (uptime ${Math.round(process.uptime() * 1000)}ms)`)

  // ② 解析与下载延后到下一微任务：焦点路径绝不被任何解析/IO/网络拖慢
  await Promise.resolve()
  await parseAndStart(raw, deps)
}

async function parseAndStart(
  raw: string,
  deps: {
    repo: import('./db/repos').LibraryRepo
    downloads: import('./services/downloadManager').DownloadManager
    emit: (channel: string, payload: unknown) => void
    focusWindow: () => void
  }
): Promise<void> {
  const { repo, downloads, emit } = deps
  const parsed = parseItemImportUrl(raw)
  if (!parsed) {
    log.warn('unrecognized protocol url:', raw.slice(0, 160))
    emit('event:toast', { level: 'error', message: '无法识别的下载链接（缺少 dlurls/item_id）' })
    return
  }
  log.info(`protocol import: item=${parsed.itemId} files=${parsed.files.length}`)

  try {
    let started = 0
    let alreadyActive = 0
    let skipped = 0
    for (const f of parsed.files) {
      if (!f.downloadableId) {
        skipped++
        continue
      }
      // 未同步过的商品/链接：建占位行，之后同步会补全元数据
      repo.ensureAdhoc({
        itemId: f.itemId || parsed.itemId,
        downloadableId: f.downloadableId,
        filename: f.filename,
        variationId: parsed.variationId
      })
      const r = downloads.downloadNow(f.downloadableId, 'manual')
      if (r === 'started') started++
      else if (r === 'active') alreadyActive++
      else skipped++
    }
    const label = parsed.files[0]?.filename || `#${parsed.files[0]?.downloadableId ?? '?'}`
    if (started > 0) {
      emit('event:toast', {
        level: 'info',
        message:
          started === 1
            ? `已开始直接下载：${label}（商品 #${parsed.itemId}）`
            : `已开始直接下载：${started} 个文件（商品 #${parsed.itemId}，跳过队列）`
      })
    } else if (alreadyActive > 0) {
      emit('event:toast', { level: 'info', message: '文件已在下载中' })
    } else {
      emit('event:toast', { level: 'error', message: '无法解析该下载链接（缺少 downloadable id）' })
    }
    if (started > 0 || alreadyActive > 0) {
      emit('event:libraryUpdated', { libraryChecked: 0, libraryChanged: 0, filesChecked: 0, filesUpdated: 0, downloaded: 0, failed: 0 })
    }
    log.info(`protocol import done: started=${started} active=${alreadyActive} skipped=${skipped}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error('protocol import failed:', msg)
    emit('event:toast', { level: 'error', message: `接收下载失败：${msg}` })
  }
}

/**
 * 把窗口带到前台（DEEP-LINK.md §6 组合拳）：
 * Windows 前台锁会让普通 focus() 静默失败 → show + focus + moveTop +
 * 短暂置顶抖动 + 任务栏闪烁兜底，确保页面的 blur 检测在超时窗口内通过。
 */
export function focusMainWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  try {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.moveTop()
    win.setAlwaysOnTop(true)
    win.flashFrame(true)
    setTimeout(() => {
      try {
        if (!win.isDestroyed()) {
          win.setAlwaysOnTop(false)
          win.flashFrame(false)
        }
      } catch {
        /* 窗口可能已关闭 */
      }
    }, 200)
  } catch (e) {
    log.warn('focusMainWindow failed:', e)
  }
}
