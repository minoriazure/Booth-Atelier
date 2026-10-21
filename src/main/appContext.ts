import { dirname, join, resolve } from 'path'
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
import { ItemRemovalService } from './services/itemRemovalService'
import { reconcileLocalFiles, type ReconcileResult } from './services/localFileReconciler'
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
  /** 单商品本地删除（DB + 数据目录 + 下载文件移入 deleted） */
  removal: ItemRemovalService
  startup: StartupService
  /** 默认查找链解析出的 cookies 路径（settings 未指定覆盖时生效；清空覆盖后回到它） */
  defaultCookiesPath: string
  /** 按磁盘重新识别下载文件（修改下载目录后调用） */
  reconcileLocal: () => ReconcileResult
  dispose(): void
}

export interface AppContextOptions {
  /** 数据目录（DB、图片缓存落这里）；portable 模式 = exe 同级 data */
  dataDir: string
  /** cookies 默认查找链解析出的路径（settings.cookiesPath 覆盖项为空时生效） */
  cookiesPath: string
  /** 默认下载根目录（未设置用户目录时使用，不落库）；缺省为 dataDir/downloads */
  downloadRoot?: string
  /** portable 模式下 exe 所在目录：用于把下载根存为相对路径，整目录搬家后仍可用；非 portable 传 null/缺省 */
  baseDir?: string | null
  /** HTTP 实现覆盖（生产可用 Electron net 实现） */
  http?: HttpClient
  /** 已删除商品的下载文件归档根（应位于 exe 同级）；缺省为 exe 同级 deleted */
  deletedRoot?: string
}

export async function createAppContext(opts: AppContextOptions): Promise<AppContext> {
  mkdirSync(opts.dataDir, { recursive: true })

  // DB 先行：settings.cookiesPath 覆盖项决定 jar 的实际路径，必须先能读设置
  const db = new Db(join(opts.dataDir, 'library.db'), resolve(__dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm'))
  await db.open()

  // 双根：数据根 = dataDir（图片/视频/快照/描述），下载根 = 素材文件（只放 booth 下载物）
  // 全局只用这一个 Paths 实例：设置变更 setRoot 后，下载/仓储立即生效，无需重启
  const defaultRoot = opts.downloadRoot || join(opts.dataDir, 'downloads')
  const paths = new Paths(opts.dataDir, defaultRoot, opts.baseDir ?? null)
  const repo = new LibraryRepo(db, paths)
  // 未设置用户下载目录时，默认根随 exe 位置变化（不落库）；用户设置过则按存储值还原
  const settings = new SettingsService(repo, paths, defaultRoot)
  paths.setRoot(settings.get().downloadRoot)

  // cookies 路径：设置覆盖项（settings.cookiesPath）非空且文件真实存在 → 以它为准；
  // 否则回默认查找链（opts.cookiesPath，portable = exe 同级优先）。
  // 覆盖路径消失（被删/被移走）时自动回退并告警，绝不静默用错文件。
  const override = settings.get().cookiesPath.trim()
  let effectiveCookiesPath = opts.cookiesPath
  if (override) {
    if (existsSync(override)) {
      effectiveCookiesPath = override
      log.info(`cookies path override in effect: ${override}`)
    } else {
      log.warn(`cookies path override missing on disk, fallback to default: ${override}`)
    }
  }

  const jar = new BoothCookieJar(effectiveCookiesPath)
  jar.load()

  const limiter = new RateLimiter(250, 100)
  const http = opts.http ?? new NodeHttpClient(jar, limiter)

  const deeplink = new DeeplinkClient(http)
  const crawler = new LibraryCrawler(http)
  const itemPage = new ItemPageParser(http)
  const auth = new AuthChecker(http)

  const s = settings.get()
  limiter.setMinInterval(s.minRequestIntervalMs)

  // 代理三档（system/custom/direct）热应用：必须在任何网络请求（restoreQueue/auth/同步）之前生效
  try {
    await applyProxySettings(s.proxyMode, s.customProxy)
  } catch (e) {
    log.warn('apply proxy settings failed:', e)
  }

  // 启动顺序：① 本地文件对账（根目录存在时识别已下载文件；缺失的已下载文件回待下载但保留远端指纹；根不存在则跳过）
  try {
    const r = reconcileLocalFiles(repo, paths)
    if (r.skipped) log.warn(`download root missing, reconcile skipped: ${paths.rootPath}`)
    else log.info(`local file reconcile: recognized=${r.recognized} released=${r.released}`)
  } catch (e) {
    log.warn('reconcileLocalFiles failed:', e)
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
  const removal = new ItemRemovalService(
    repo,
    paths,
    downloads,
    imageLocalizer,
    videos,
    opts.deletedRoot ?? join(dirname(process.execPath), 'deleted')
  )

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
    removal,
    startup,
    defaultCookiesPath: opts.cookiesPath,
    reconcileLocal: () => reconcileLocalFiles(repo, paths),
    dispose() {
      downloads.dispose()
      imageLocalizer.dispose()
      jar.stopWatch()
      db.close()
    }
  }
}
