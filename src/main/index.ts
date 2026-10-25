import './util/userDataPath'
import { app, BrowserWindow, protocol, net, shell, dialog } from 'electron'
import { join, resolve, dirname, extname } from 'path'
import { existsSync, statSync, createReadStream } from 'fs'
import { createAppContext, type AppContext } from './appContext'
import { registerIpc } from './ipc/handlers'
import { findProtocolArg, handleProtocolUrl, focusMainWindow, BOOTH_PROTOCOL } from './protocol'
import { createLogger, onLogWritten } from './util/log'
import { resolveDataDir } from './util/dataDir'
import { cleanupLogs } from './services/logService'

const log = createLogger('main')

let mainWindow: BrowserWindow | null = null
let ctx: AppContext | null = null

// 自定义协议：image-cache://<encodeURIComponent(absPath)> → 本地图片
function registerProtocols(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'image-cache', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/opus'
}

/**
 * 本地媒体协议（图片 + 视频）：
 * image-cache://local/<encodeURIComponent(绝对路径)>
 * 视频 <video> 播放需要 Range/206；net.fetch(file://) 不透传 Range，这里用 fs 流手动切片。
 */
function setupImageProtocol(): void {
  protocol.handle('image-cache', (request): Promise<Response> => {
    try {
      const url = new URL(request.url)
      let p = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!existsSync(p) && url.hostname && url.hostname !== 'local') {
        const alt = decodeURIComponent(url.hostname)
        if (existsSync(alt)) p = alt
      }
      if (!existsSync(p)) return Promise.resolve(new Response('not found', { status: 404 }))

      const stat = statSync(p)
      if (!stat.isFile()) return Promise.resolve(new Response('not a file', { status: 404 }))
      const mime = MIME_BY_EXT[extname(p).toLowerCase()] || 'application/octet-stream'
      const range = request.headers.get('range')

      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        let start = m && m[1] ? Number(m[1]) : 0
        let end = m && m[2] ? Number(m[2]) : stat.size - 1
        if (isNaN(start) || start < 0) start = 0
        if (isNaN(end) || end >= stat.size) end = stat.size - 1
        if (start > end) {
          return Promise.resolve(new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } }))
        }
        const stream = createReadStream(p, { start, end })
        return Promise.resolve(
          new Response(stream as unknown as ReadableStream, {
            status: 206,
            headers: {
              'Content-Type': mime,
              'Content-Length': String(end - start + 1),
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
              'Accept-Ranges': 'bytes'
            }
          })
        )
      }
      const stream = createReadStream(p)
      return Promise.resolve(
        new Response(stream as unknown as ReadableStream, {
          status: 200,
          headers: { 'Content-Type': mime, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes' }
        })
      )
    } catch {
      return Promise.resolve(new Response('bad request', { status: 400 }))
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    title: 'Booth Atelier',
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 协议链接必须在本进程内处理——交给系统会唤起官方程序
    if (url.startsWith(`${BOOTH_PROTOCOL}:`)) {
      void deliverProtocolUrl(url)
      return { action: 'deny' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 页面内 <a href="booth-library-manager://..."> 直接点击（非 window.open）也要拦截
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(`${BOOTH_PROTOCOL}:`)) {
      e.preventDefault()
      void deliverProtocolUrl(url)
    }
  })

  // 注意：这里故意不加载 renderer —— 窗口先可见（深链冷启动等失焦），
  // loadMainWindow() 在 registerIpc 之后再调用（renderer 挂载即 settings:get）
}

/**
 * 加载渲染进程（必须在 registerIpc 之后调用——renderer 一挂载就 invoke settings:get，
 * 此前调用会因无 handler 卡在「加载中」）。
 * 窗口本体（createWindow）则要更早创建：深链冷启动时浏览器在等失焦。
 */
function loadMainWindow(): void {
  if (!mainWindow) return
  const hash = process.env.BOOTH_HASH
    ? `#${process.env.BOOTH_HASH}`
    : process.env.BOOTH_OPEN_ITEM
      ? `#item=${process.env.BOOTH_OPEN_ITEM}`
      : ''
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL + hash)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash: hash.slice(1) } : undefined)
  }
}

let pendingProtocolUrl: string | null = null
let protocolReady = false

/** 协议 URL 统一入口：第一行抢焦点（无论 ctx 是否就绪），解析/下载一律延后 */
async function deliverProtocolUrl(raw: string): Promise<void> {
  focusMainWindow(mainWindow) // 纯本地操作，网络好坏无影响；解析在下面才开始
  if (!ctx || !protocolReady) {
    pendingProtocolUrl = raw
    return
  }
  await handleProtocolUrl(raw, {
    repo: ctx.repo,
    downloads: ctx.downloads,
    sync: ctx.sync,
    emit: (ch, payload) => {
      const w = mainWindow
      if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) {
        try {
          w.webContents.send(ch, payload)
        } catch {
          /* closing */
        }
      }
    },
    focusWindow: () => focusMainWindow(mainWindow)
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  registerProtocols()

  app.on('second-instance', (_e, argv) => {
    // 先抢前台再干别的 —— 页面在等浏览器失焦，慢一步就报「应用打开异常」
    focusMainWindow(mainWindow)
    const url = findProtocolArg(argv)
    if (url) {
      log.info('deep link received (second-instance)')
      void deliverProtocolUrl(url)
    }
  })

  process.on('uncaughtException', (e) => {
    log.error('uncaught exception:', e instanceof Error ? (e.stack ?? e.message) : String(e))
  })
  process.on('unhandledRejection', (e) => {
    log.error('unhandled rejection:', e instanceof Error ? (e.stack ?? e.message) : String(e))
  })

  app.whenReady().then(async () => {
    try {
      await bootApp()
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
      log.error('boot failed:', msg)
      try {
        const { writeFileSync } = await import('fs')
        writeFileSync(join(app.getPath('userData'), 'boot-error.log'), String(msg), 'utf-8')
      } catch {
        /* ignore */
      }
      log.error('showing boot error dialog')
      dialog.showErrorBox('启动失败', `应用初始化失败：\n${msg}`)
      app.quit()
    }
  })

  async function bootApp(): Promise<void> {
    setupImageProtocol()

    // 深链冷启动优化：窗口最先可见（不加载 renderer），
    // DB/队列/网络等重活全部排在它后面 —— 浏览器只要窗口失焦就判成功。
    createWindow()
    log.info(`window created (uptime ${Math.round(process.uptime() * 1000)}ms)`)

    // 深链冷启动：argv 带 URL 时【立刻】抢前台（不等 DB/IPC/解析），解析投递延后
    let coldArg = findProtocolArg(process.argv) ?? pendingProtocolUrl
    pendingProtocolUrl = null
    if (coldArg) {
      log.info(`deep link received (cold-start argv, uptime ${Math.round(process.uptime() * 1000)}ms)`)
      focusMainWindow(mainWindow) // 第一时间让浏览器失焦——网络再差这步也是纯本地操作
    }

    // portable 模式：所有工作文件（DB/图片/默认下载）都在 exe 同级目录，整体打包即可带走。
    // 非 portable（dev / 安装版）：沿用 userData。
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
    const exeDir = portableDir ?? dirname(app.getPath('exe'))
    const dataDir = resolveDataDir()
    const cookiesPath = resolveDefaultCookiesPath()
    // 默认下载根：portable → exe 同级 downloads/；否则 dataDir/downloads
    const defaultRoot = portableDir ? resolve(portableDir, 'downloads') : join(dataDir, 'downloads')
    const downloadRoot = process.env.BOOTH_DOWNLOAD_ROOT || defaultRoot

    try {
      ctx = await createAppContext({
        dataDir,
        cookiesPath,
        downloadRoot: downloadRoot || undefined,
        baseDir: portableDir ?? null,
        deletedRoot: resolve(exeDir, 'deleted')
      })
    } catch (e) {
      log.error('app context init failed:', e)
      app.whenReady().then(() => {
        // 仍然打开窗口展示错误
      })
      throw e
    }

    void cleanupLogs(ctx.settings.get().logRetentionDays)
    log.info(`app started v${app.getVersion()} portable=${!!portableDir} dataDir=${dataDir}`)

    ctx.jar.watch(() => {
      // jar 内容真实变化（补放/覆盖/删除）→ 通知 renderer 自动重查登录状态并刷新右上角状态
      log.info('cookies hot-reloaded → notify renderer to re-check auth')
      const w = mainWindow
      if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) {
        try {
          w.webContents.send('event:cookiesReloaded')
        } catch {
          /* closing */
        }
      }
    })

    registerIpc(ctx, () => mainWindow)
    // renderer 只能在 ipc 就绪后加载（挂载即 settings:get）；协议投递也从这里开始放行
    protocolReady = true
    loadMainWindow()

    // 焦点已抢过；解析与下载延后到此（renderer 也已挂载，能收到 toast）
    coldArg = coldArg ?? pendingProtocolUrl
    pendingProtocolUrl = null
    if (coldArg) {
      const url = coldArg
      setTimeout(() => void deliverProtocolUrl(url), 150)
    }

    // 后台补齐存量图片的缩略图（异步 sharp 单并发，不卡 UI；新图在下载完成时已即时生成；原图缺失的会重新下载）
    const backfillCtx = ctx
    setTimeout(() => {
      try {
        backfillCtx.imageLocalizer.startThumbBackfill()
      } catch (e) {
        log.warn('thumb backfill failed:', e)
      }
    }, 3000)

    // 测试辅助：BOOTH_SCREENSHOT=path → 页面加载完成后截图
    if (process.env.BOOTH_SCREENSHOT && mainWindow) {
      const shotPath = process.env.BOOTH_SCREENSHOT
      const delay = Number(process.env.BOOTH_SCREENSHOT_DELAY || 6000)
      // 测试辅助：BOOTH_ENQUEUE=1 → 全部入队（enqueueAll 同步返回数量）
      if (process.env.BOOTH_ENQUEUE) {
        setTimeout(() => {
          const n = ctx?.downloads.startAll('bulk') ?? 0
          log.info(`enqueued ${n} files`)
        }, 1500)
      }
      // 测试辅助：点击大图打开放大器
      if (process.env.BOOTH_CLICK_ZOOM) {
        setTimeout(() => {
          const w = mainWindow
          if (w && !w.isDestroyed()) {
            void w.webContents
              .executeJavaScript(`document.querySelector('img.zoomable')?.click(); true`)
              .catch(() => {})
          }
        }, Math.max(500, delay - 2500))
      }
      // 测试辅助：打开放大器后模拟「按下→拖动→抬起→click」，验证不关闭
      if (process.env.BOOTH_SIM_DRAG) {
        setTimeout(() => {
          const w = mainWindow
          if (w && !w.isDestroyed()) {
            void w.webContents
              .executeJavaScript(`(() => {
                const v = document.querySelector('.zoom-viewer')
                if (!v) return 'no-viewer'
                const opts = { bubbles: true, clientX: 700, clientY: 400 }
                v.dispatchEvent(new MouseEvent('mousedown', opts))
                v.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 760, clientY: 430 }))
                v.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 820, clientY: 460 }))
                v.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 820, clientY: 460 }))
                v.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 820, clientY: 460 }))
                return document.querySelector('.zoom-viewer') ? 'STILL-OPEN' : 'CLOSED-BUG'
              })()`)
              .then((r) => {
                log.info('sim-drag result:', r)
                // 800ms 后复查：若此时关闭，说明有异步路径在关
                setTimeout(() => {
                  const w2 = mainWindow
                  if (w2 && !w2.isDestroyed()) {
                    void w2.webContents
                      .executeJavaScript(`document.querySelector('.zoom-viewer') ? 'STILL-OPEN' : 'CLOSED-LATER'`)
                      .then((r2) => log.info('sim-drag recheck:', r2))
                      .catch(() => {})
                  }
                }, 800)
              })
              .catch((e) => log.warn('sim-drag failed:', e))
          }
        }, Math.max(500, delay - 1500))
      }
      // 测试辅助：提前 1.2s 滚动，给合成器留重绘时间
      if (process.env.BOOTH_SCROLL_VIDEO) {
        setTimeout(() => {
          const w = mainWindow
          if (w && !w.isDestroyed()) {
            void w.webContents
              .executeJavaScript(`(() => {
                const el = document.querySelector('.video-slot:not(:empty), .video-list .video-card')
                const main = document.querySelector('.main')
                if (el && main) { main.scrollTop = el.getBoundingClientRect().top + main.scrollTop - 120; return main.scrollTop }
                return -1
              })()`)
              .then((r) => log.info('scroll-to-video scrollTop:', r))
              .catch((e) => log.warn('scroll failed:', e))
          }
        }, Math.max(500, delay - 1200))
      }
      // 测试辅助：BOOTH_SCREENSHOT 时顺带打印表格列宽诊断
      setTimeout(() => {
        const w = mainWindow
        if (w && !w.isDestroyed()) {
          void w.webContents
            .executeJavaScript(`(() => {
              const wrap = document.querySelector('.dl-table-wrap')
              const table = document.querySelector('.dl-table')
              const cols = table ? Array.from(table.querySelectorAll('col')).map(c => c.style.width) : []
              return JSON.stringify({ wrapW: wrap?.clientWidth, tableW: table?.getBoundingClientRect().width, cols, vw: window.innerWidth })
            })()`)
            .then((r) => log.info('col-metrics:', r))
            .catch(() => {})
        }
      }, Math.max(600, delay - 300))
      setTimeout(() => {
        const w = mainWindow
        if (w && !w.isDestroyed()) {
          w.webContents.capturePage().then((image) => {
            void import('fs').then((fs) => {
              fs.writeFileSync(shotPath, image.toPNG())
              log.info(`screenshot saved: ${shotPath}`)
              app.quit()
            })
          })
        }
      }, delay)
    }

    // 启动自动检查
    const emit = (channel: string, payload: unknown): void => {
      const w = mainWindow
      if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) {
        try {
          w.webContents.send(channel, payload)
        } catch {
          /* window closing */
        }
      }
    }
    ctx.startup.onProgress = (e) => emit('event:checkProgress', e)
    ctx.startup.onAuthExpired = (msg) => emit('event:authExpired', msg)
    // 日志实时推送：合并 300ms 内的多次写入，避免日志密集时频繁刷新
    let logPushTimer: NodeJS.Timeout | null = null
    onLogWritten(() => {
      if (logPushTimer) return
      logPushTimer = setTimeout(() => {
        logPushTimer = null
        emit('event:logAppended', undefined)
      }, 300)
    })
    // 测试辅助：BOOTH_NO_STARTUP=1 跳过启动同步/检查（截图验证 UI 用）
    if (process.env.BOOTH_NO_STARTUP) {
      log.info('BOOTH_NO_STARTUP set, skip startup sync')
      return
    }
    void ctx.startup.runOnStartup().then((result) => {
      if (result.authOk && result.summary) {
        emit('event:libraryUpdated', result.summary)
        emit('event:toast', {
          level: 'info',
          message: `启动检查完成：${result.summary.libraryChecked} 个商品，${result.summary.filesChecked} 个链接，${result.summary.filesUpdated} 个更新`
        })
      } else if (result.authError) {
        log.warn('startup auth:', result.authError)
      }
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
        if (ctx && protocolReady) loadMainWindow()
      }
    })
  }

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    log.info('app quitting')
    ctx?.dispose()
  })
}

function resolveDefaultCookiesPath(): string {
  // portable：缓存型 NSIS stub 启动时设置 PORTABLE_EXECUTABLE_DIR = stub 所在目录（exe 原始位置），
  // 程序文件在 exe 同级 app-cache\，数据/cookies 始终在 exe 同级
  const candidates = [
    process.env.PORTABLE_EXECUTABLE_DIR && resolve(process.env.PORTABLE_EXECUTABLE_DIR, 'booth_cookies.txt'),
    resolve(process.cwd(), 'booth_cookies.txt'),
    resolve(dirname(app.getPath('exe')), 'booth_cookies.txt'),
    resolve(app.getAppPath(), 'booth_cookies.txt'),
    join(app.getPath('userData'), 'booth_cookies.txt')
  ].filter((x): x is string => !!x)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}
