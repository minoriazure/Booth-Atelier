/**
 * 共享类型定义（主进程 / 预加载 / 渲染进程通用）
 */

/** 列表页上的一个下载链接（商品内的单个文件） */
export interface DownloadableRef {
  downloadableId: number
  variationId: number | null
  filename: string
  /** 浏览器直下链接（zip 包装），deeplink 失败时的回退通道 */
  fallbackUrl: string
}

/** 库列表页解析出的商品条目 */
export interface LibraryItem {
  itemId: number
  title: string
  itemUrl: string
  thumbnailUrl: string
  isGift: boolean
  downloadables: DownloadableRef[]
}

/** deeplink 解析结果（签名直链，180 秒过期，绝不入库） */
export interface DeeplinkResult {
  dlurl: string
  filename: string
  itemId: number
  orderId: number | null
  variationId: number | null
}

/** 远端文件指纹 */
export interface Fingerprint {
  /** 去引号后的 ETag */
  etag: string | null
  /** 文件总字节数（从 Content-Range 解析） */
  size: number | null
  lastModified: string | null
  contentType: string | null
}

/** 详情页解析结果 */
export interface ItemDetail {
  itemId: number
  title: string
  descriptionHtml: string
  ogImageUrl: string | null
  /** 描述容器内的宣传图 URL 列表 */
  galleryUrls: string[]
  shopName: string | null
  filenames: string[]
}

export type DownloadSource = 'initial' | 'bulk' | 'manual' | 'update' | 'deeplink'
export type DownloadStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'skipped'
export type ItemStatus = 'active' | 'missing'
export type DownloadableStatus = 'remote' | 'downloaded' | 'update_available' | 'missing'

export interface ItemSummary {
  itemId: number
  title: string
  shopName: string | null
  thumbnailUrl: string | null
  /** 本地缩略图的 media URL（已下载时非空） */
  localThumb: string | null
  isGift: boolean
  /** 深链确认不在库中而建立的免费商品（仅深链下载，不参与全局/批量更新） */
  isFree: boolean
  status: ItemStatus
  fileTotal: number
  fileDownloaded: number
  fileUpdateAvailable: number
}

export interface ItemDetailRow extends ItemSummary {
  itemUrl: string
  ogImageUrl: string | null
  descriptionHtml: string
  galleryUrls: string[]
  /** 画廊图片的本地 media URL（已下载部分）：mediaUrl = 原图（仅放大与回退）；previewMediaUrl = 720 长边预览（展示）；thumbMediaUrl = 360 缩略图（底层占位）；removed = 远程画廊已移除（本地仍保留） */
  localGallery: Array<{ url: string; mediaUrl: string | null; previewMediaUrl: string | null; thumbMediaUrl: string | null; removed?: boolean }>
  videos: ItemVideo[]
  downloadables: DownloadableFileRow[]
}

export interface DownloadableFileRow {
  downloadableId: number
  itemId: number
  filename: string
  variationId: number | null
  status: DownloadableStatus
  localPath: string | null
  localSize: number | null
  lastSize: number | null
  lastEtag: string | null
  lastCheckedAt: string | null
}

export interface DownloadProgressEvent {
  downloadableId: number
  itemId: number
  filename: string
  bytesDone: number
  bytesTotal: number
}

export interface DownloadDoneEvent {
  downloadableId: number
  itemId: number
  filename: string
  path: string
  source: DownloadSource
  archivedPath?: string | null
}

export interface CheckProgressEvent {
  phase: 'library' | 'files' | 'download'
  current: number
  total: number
  label?: string
}

export interface CheckSummary {
  libraryChecked: number
  libraryChanged: number
  filesChecked: number
  filesUpdated: number
  downloaded: number
  failed: number
}

/** 单商品刷新结果（只更新商品页数据） */
export interface RefreshItemResult {
  changed: boolean
}

/** 单商品本地删除结果 */
export interface RemoveItemResult {
  /** 下载文件被移入 deleted 的目标目录（无下载文件时为 null） */
  archivedTo: string | null
  /** 非致命问题提示（DB 已删除，但文件操作失败） */
  warnings: string[]
}

/** 应用内深链宿主询问弹窗的载荷（主进程 checkDeepLinkHost 产出，renderer 弹窗消费） */
export interface DeepLinkHostPrompt {
  /** 当前 HKCU 注册指向的可执行文件（null = 未注册） */
  registeredPath: string | null
  /** 本副本的启动器路径 */
  selfPath: string
}

export interface Settings {
  /** 下载根绝对路径（运行时解析：默认值随 exe 所在位置变化） */
  downloadRoot: string
  /** 已设置的下载根目录当前不存在（如外接盘未挂载）；此时下载不会回退到默认目录 */
  downloadRootMissing: boolean
  /**
   * Cookie 文件覆盖路径（'' = 未指定，走默认查找链：exe 同级 → cwd → exe 目录 → appPath → userData）。
   * 指定后每次启动以该路径为准认证；路径必须真实存在才能保存。
   */
  cookiesPath: string
  /** 启动时检查 booth-library-manager:// 深链注册是否指向本程序，指向其它副本时询问是否注册 */
  autoRegisterDeepLink: boolean
  /** 日志保留天数（含当天），范围 7–180，默认 60；超出的日志文件启动时与修改设置后自动删除 */
  logRetentionDays: number
  /** 启动时自动同步商品库（元数据/简介/宣传图） */
  autoSyncLibraryOnStartup: boolean
  /** 启动时自动检查文件更新 */
  autoCheckFilesOnStartup: boolean
  /** 启动时检查并修复图片（补下未完成的原图、补齐缩略图/预览图）；不受 startupCheckIntervalDays 限制 */
  autoCheckImagesOnStartup: boolean
  /** 主题模式 */
  themeMode: 'dark' | 'light'
  /** 全局主题色（accent，hex） */
  themeAccent: string
  /** 启动自动检查的最小间隔（天）。0 = 禁用间隔，每次启动都检查 */
  startupCheckIntervalDays: number
  autoDownloadUpdates: boolean
  downloadConcurrency: number
  minRequestIntervalMs: number
  /** 代理模式：system=跟随 Windows 系统代理（默认，Chrome 同款监听系统设置变化）；custom=自定义代理；direct=直连 */
  proxyMode: 'system' | 'custom' | 'direct'
  /** 自定义代理地址（proxyMode=custom 时生效），如 http://127.0.0.1:7890 / socks5://127.0.0.1:1080 */
  customProxy: string
  lastLibrarySyncAt: string | null
  lastGlobalCheckAt: string | null
}

/** 代理连通性测试结果（访问 BOOTH 首页） */
/** 日志级别（行首标记 `[LEVEL]`）；MESSAGE = 面向用户的弹窗 / toast */
export const LOG_LEVELS = ['INFO', 'WARN', 'ERROR', 'DEBUG', 'MESSAGE'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** 日志页默认显示的级别 */
export const DEFAULT_LOG_VIEW_LEVELS: LogLevel[] = ['MESSAGE', 'WARN', 'ERROR']

/** 日志文件（每天一个）的元信息 */
export interface LogDayInfo {
  /** YYYY-MM-DD */
  date: string
  /** 当天行数（每条日志一行，等于换行符数） */
  lines: number
}

/** 某天日志的一段（row 0 = 当天最后一行，即最新在前） */
export interface LogPageResult {
  date: string
  /** 当天总行数 */
  total: number
  /** 本段起始 row */
  offset: number
  lines: string[]
}

export interface LogSearchHit {
  date: string
  /** 该天内的显示行号（与 readDay 的 row 一致） */
  row: number
  text: string
}

export interface LogSearchResult {
  hits: LogSearchHit[]
  /** 命中数超过上限被截断 */
  truncated: boolean
}

export interface ProxyTestResult {
  ok: boolean
  status: number | null
  latencyMs: number
  message: string
}

/** 描述中的内嵌视频 */
export type VideoPlatform = 'youtube' | 'nicovideo' | 'vimeo' | 'other'

export interface ItemVideo {
  /** platform:videoId */
  key: string
  platform: VideoPlatform
  videoId: string
  /** 原始页面 URL（yt-dlp 输入） */
  url: string
  embedUrl: string
  /** 本地已下载的文件绝对路径 */
  localPath: string | null
  /** 视频封面缩略图（与视频同目录 {base}-thumb.jpg）的渲染层地址；缺失为 null */
  thumbMediaUrl?: string | null
  status: 'remote' | 'downloading' | 'downloaded' | 'failed'
  progress: number
  error?: string | null
}

/** 商品图片本地化记录 */
export type ImageKind = 'thumb' | 'og' | 'gallery' | 'desc'
export type ImageStatus = 'pending' | 'done' | 'failed'

export interface ItemImage {
  url: string
  itemId: number
  kind: ImageKind
  filename: string
  status: ImageStatus
}

export interface FileHistoryEntry {
  archivedDate: string
  /** 归档时间 UTC，格式 YYYY-MM-DD HH:MM:SS（SQLite datetime('now')） */
  archivedAt: string
  archivedPath: string
  filename: string
  size: number | null
}

/** 文件历史的一条可选项：同一秒归档的文件归为一组 */
export interface FileHistoryGroup {
  archivedAt: string
  count: number
}

export interface SnapshotEntry {
  id: number
  snapshotDate: string
  /** 快照时间 UTC，格式 YYYY-MM-DD HH:MM:SS */
  capturedAt: string
  title: string
}

export interface SnapshotDetail extends SnapshotEntry {
  itemId: number
  descriptionHtml: string
  ogImageUrl: string | null
  /** 快照 HTML 中远程图片 URL → 已本地化的 media URL（未下载完成的不在其中） */
  localImages: Record<string, string>
}

/** 图片下载进度（会话累计） */
export interface ImageProgress {
  done: number
  total: number
  active: number
  queued: number
}

/** 派生图（缩略图/预览图）生成进度（当前批次） */
export interface DerivativeProgress {
  done: number
  total: number
  failed: number
}

/** 图片对账进度（检查原图与派生图文件） */
export interface ReconcileProgress {
  checked: number
  total: number
  done: boolean
}

/** 图片对账结果 */
export interface ReconcileResult {
  checked: number
  /** 原图缺失、已退回待下载的条数 */
  redownload: number
  /** 派生图状态发生变化、需要重新核实/补齐的条数 */
  derivMarked: number
  /** 其中确认缺失派生图文件的条数（用于提示用户） */
  derivMissing: number
}

/** 全量图片检查结果（含中断遗留的 pending/failed 行的重新入队数） */
export interface CheckAllImagesResult extends ReconcileResult {
  /** 扫描到的 pending/failed 行数 */
  pendingScanned: number
  /** 本次真正入队下载的条数 */
  pendingQueued: number
}

/** 全文件列表行（更新与下载页，qBittorrent 风格） */
export interface FileListRow {
  downloadableId: number
  itemId: number
  itemTitle: string
  filename: string
  /** DB 状态：remote | downloaded | update_available | missing */
  status: DownloadableStatus
  localPath: string | null
  localSize: number | null
  lastSize: number | null
  /** 是否在下载队列中 */
  inQueue: boolean
  /** 是否正在下载 */
  active: boolean
  /** 最近一次下载是否失败（基于 download_records 最新一条） */
  failed: boolean
  lastError: string | null
}

/** 下载队列统计（含用户级暂停） */
export interface DownloadStats {
  queued: number
  active: number
  /** 认证失败导致的暂停 */
  paused: boolean
  /** 用户手动全局暂停 */
  userPaused: boolean
}
