import { join, resolve } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { BoothCookieJar } from './booth/cookieJar'
import { NodeHttpClient, type HttpClient } from './booth/httpClient'
import { RateLimiter } from './booth/rateLimiter'
import { DeeplinkClient } from './booth/deeplink'
import { LibraryCrawler } from './booth/libraryCrawler'
import { ItemPageParser } from './booth/itemPageParser'
import { AuthChecker } from './booth/auth'
import { applyProxySettings } from './booth/systemFetch'
import { Db } from './db/database'
import { LibraryRepo } from './db/repos'
import { Paths } from './util/paths'
import { SettingsService } from './services/settingsService'
import { HistoryManager } from './services/historyManager'
import { LibrarySyncService } from './services/librarySyncService'
import { UpdateCheckService } from './services/updateCheckService'
import { DownloadManager } from './services/downloadManager'
import { StartupService } from './services/startupService'
import { ImageLocalizer } from './services/imageLocalizer'
import { VideoService } from './services/videoService'
import { createLogger } from './util/log'

const log = createLogger('app')

export interface AppContext {
  jar: BoothCookieJar
  http: HttpClient
  deeplink: DeeplinkClient
  crawler: LibraryCrawler
  itemPage: ItemPageParser
  auth: AuthChecker
  db: Db
  repo: LibraryRepo
  paths: Paths
  settings: SettingsService
  history: HistoryManager
  /** 商品图片本地化（抓库时后台下载到商品 meta/images） */
  imageLocalizer: ImageLocalizer
  /** 描述内嵌视频下载（yt-dlp） */
  videos: VideoService
  sync: LibrarySyncService
  checker: UpdateCheckService
  downloads: DownloadManager
  startup: StartupService
  dispose(): void
}

export interface AppContextOptions {
  /** 数据目录（DB、图片缓存落这里）；portable 模式 = exe 同级 data */
  dataDir: string
  /** cookies 文件路径 */
  cookiesPath: string
  /** 下载根目录（空则用 dataDir/downloads 作为默认） */
  downloadRoot?: string
  /** HTTP 实现覆盖（生产可用 Electron net 实现） */
  http?: HttpClient
}

export async function createAppContext(opts: AppContextOptions): Promise<AppContext> {
  mkdirSync(opts.dataDir, { recursive: true })

  const jar = new BoothCookieJar(opts.cookiesPath)
  jar.load()

  const limiter = new RateLimiter(250, 100)
  const http = opts.http ?? new NodeHttpClient(jar, limiter)

  const deeplink = new DeeplinkClient(http)
  const crawler = new LibraryCrawler(http)
  const itemPage = new ItemPageParser(http)
  const auth = new AuthChecker(http)

  const db = new Db(join(opts.dataDir, 'library.db'), resolve(__dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm'))
  await db.open()
  const repo = new LibraryRepo(db)

  // 设置优先：用户已保存的 downloadRoot 优先于默认值（portable/首次启动才用 opts 默认）
  // 双根：数据根 = dataDir（图片/视频/快照/描述），下载根 = 素材文件（只放 booth 下载物）
  const bootPaths = new Paths(opts.dataDir, opts.downloadRoot || join(opts.dataDir, 'downloads'))
  const settings = new SettingsService(repo, bootPaths, opts.cookiesPath)
  const s0 = settings.get()
  if (!settings.hasDownloadRoot() && opts.downloadRoot) {
    settings.set({ downloadRoot: opts.downloadRoot })
  }
  const paths = new Paths(opts.dataDir, settings.get().downloadRoot)
  bootPaths.setRoot(paths.rootPath)

  const s = settings.get()
  limiter.setMinInterval(s.minRequestIntervalMs)

  // 代理三档（system/custom/direct）热应用：必须在任何网络请求（restoreQueue/auth/同步）之前生效
  try {
    await applyProxySettings(s.proxyMode, s.customProxy)
  } catch (e) {
    log.warn('apply proxy settings failed:', e)
  }

  // 启动顺序：① 文件丢失校验（downloaded 但本地被删 → 回待下载）
  try {
    const fixed = repo.validateLocalFiles((p) => existsSync(p))
    if (fixed > 0) log.info(`local file validation: ${fixed} missing → back to pending`)
  } catch (e) {
    log.warn('validateLocalFiles failed:', e)
  }

  const history = new HistoryManager(repo, paths)
  const imageLocalizer = new ImageLocalizer(http, repo, paths)
  const videos = new VideoService(repo, paths)
  const sync = new LibrarySyncService(crawler, itemPage, repo, history, imageLocalizer)
  const downloads = new DownloadManager(deeplink, http, repo, history, paths, jar)
  downloads.setConcurrency(s.downloadConcurrency)
  // ② 恢复上次退出时的排队任务（排队中不回退待下载，自动继续下载）
  try {
    downloads.restoreQueue()
  } catch (e) {
    log.warn('restoreQueue failed:', e)
  }
  const checker = new UpdateCheckService(deeplink, repo, downloads, () => settings.get().autoDownloadUpdates)
  const startup = new StartupService(auth, sync, checker, settings)

  log.info(`app context ready: data=${paths.dataRootPath} downloads=${paths.rootPath}`)

  return {
    jar,
    http,
    deeplink,
    crawler,
    itemPage,
    auth,
    db,
    repo,
    paths,
    settings,
    history,
    imageLocalizer,
    videos,
    sync,
    checker,
    downloads,
    startup,
    dispose() {
      downloads.dispose()
      imageLocalizer.dispose()
      jar.stopWatch()
      db.close()
    }
  }
}
