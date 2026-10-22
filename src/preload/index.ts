import { contextBridge, ipcRenderer } from 'electron'
import type {
  Settings,
  ItemSummary,
  ItemDetailRow,
  CheckProgressEvent,
  CheckSummary,
  RefreshItemResult,
  RemoveItemResult,
  DownloadProgressEvent,
  DownloadDoneEvent,
  DownloadSource,
  FileListRow,
  DownloadStats,
  FileHistoryEntry,
  SnapshotEntry,
  ItemVideo,
  ImageProgress,
  DeepLinkHostPrompt,
  ProxyTestResult
} from '../shared/types'

export interface VideoProgressEvent {
  key: string
  itemId: number
  progress: number
  status: 'downloading' | 'downloaded' | 'failed'
  localPath?: string
  error?: string
}

export interface BoothAPI {
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    test(): Promise<ProxyTestResult>
  }
  library: {
    list(q?: string): Promise<ItemSummary[]>
    search(q: string): Promise<ItemSummary[]>
    getItem(id: number): Promise<ItemDetailRow | null>
    sync(forceDetail?: boolean): Promise<CheckSummary>
    /** 返回本地缓存图片路径的 app:// URL */
    imageUrl(remoteUrl: string): Promise<string | null>
    imageThumbUrl(remoteUrl: string): Promise<string | null>
    openItemPage(id: number): Promise<void>
    openItemDir(id: number): Promise<string>
    refreshItem(id: number): Promise<RefreshItemResult>
    deleteItem(id: number): Promise<RemoveItemResult>
  }
  updates: {
    checkGlobal(): Promise<CheckSummary>
    checkItem(id: number): Promise<CheckSummary>
    listAvailable(): Promise<Array<Record<string, unknown>>>
  }
  downloads: {
    enqueue(ids: number[], source: DownloadSource): Promise<number>
    enqueueItem(itemId: number, source: DownloadSource): Promise<number>
    /** 开始全部：把待下载全部入队并立即开始（不动已完成/失败），返回队列统计 */
    startAll(source: DownloadSource): Promise<DownloadStats>
    /** @deprecated 语义同 startAll */
    enqueueAll(source: DownloadSource): Promise<DownloadStats>
    cancel(downloadableId: number): Promise<boolean>
    /** 立即下载：无视并发/队列直接进入下载中。probe 后返回（约 0.3~2s）；skipped=本地已是最新未下载 */
    downloadNow(downloadableId: number): Promise<'started' | 'active' | 'skipped' | 'missing'>
    stats(): Promise<DownloadStats>
    /** 全文件列表（DB 状态 + 队列/活动运行时合并） */
    list(): Promise<FileListRow[]>
    /** 用户全局暂停（保留队列，中断任务恢复后继续） */
    pauseAll(): Promise<DownloadStats>
    resumeAll(): Promise<DownloadStats>
    /** 重试全部最近失败的文件，返回入队数 */
    retryFailed(): Promise<number>
    records(limit?: number): Promise<Array<Record<string, unknown>>>
  }
  history: {
    listFileDates(itemId: number): Promise<string[]>
    listDescriptionDates(itemId: number): Promise<string[]>
    readSnapshot(itemId: number, date: string): Promise<{ snapshotDate: string; title: string; descriptionHtml: string; ogImageUrl: string | null } | null>
    listFilesAtDate(itemId: number, date: string): Promise<Array<{ filename: string; archivedPath: string; size: number | null }>>
    openPath(p: string): Promise<void>
    revealPath(p: string): Promise<void>
  }
  auth: {
    /** kind: 'auth' = Cookie 失效；'rate_limited' = 被限流（非认证问题） */
    check(): Promise<{ ok: boolean; error?: string; kind?: string }>
    cookiesPath(): Promise<string>
  }
  images: {
    enqueueItem(itemId: number): Promise<number>
  }
  videos: {
    checkYtDlp(invalidate?: boolean): Promise<{ found: boolean; path: string | null }>
    list(itemId: number): Promise<ItemVideo[]>
    download(key: string): Promise<{ ok: boolean; path?: string; error?: string }>
    reveal(path: string): Promise<void>
  }
  dialog: {
    chooseDir(): Promise<string | null>
    chooseFile(): Promise<string | null>
  }
  protocol: {
    /** 深链宿主自检：需要询问时返回弹窗载荷，否则 null */
    hostStatus(): Promise<DeepLinkHostPrompt | null>
    /** 用户对应用内弹窗的决定：register=注册为本程序；decline=不注册并关闭检查开关 */
    hostDecision(decision: 'register' | 'decline'): Promise<{ registered: boolean; autoRegister: boolean }>
  }
  system: {
    /** 系统代理状态（如 "HTTP 127.0.0.1:7890" / "DIRECT"），下载会自动遵循 */
    proxyInfo(): Promise<string | null>
    /** Windows 系统代理地址（未开启或仅 PAC 时为 null），用于自定义代理的默认填充 */
    windowsProxy(): Promise<string | null>
  }
  events: {
    onLibraryUpdated(cb: (summary: CheckSummary) => void): () => void
    onCheckProgress(cb: (e: CheckProgressEvent) => void): () => void
    onDownloadProgress(cb: (e: DownloadProgressEvent) => void): () => void
    onDownloadDone(cb: (e: DownloadDoneEvent) => void): () => void
    onDownloadError(cb: (e: { downloadableId: number; itemId: number; filename: string; error: string; auth: boolean }) => void): () => void
    onQueueChanged(cb: (stats: DownloadStats) => void): () => void
    onAuthExpired(cb: (message: string) => void): () => void
    /** cookies 文件内容真实变化（补放/覆盖/删除）——renderer 收到后自动重查登录状态 */
    onCookiesReloaded(cb: () => void): () => void
    onToast(cb: (e: { level: 'info' | 'warn' | 'error'; message: string }) => void): () => void
    onImageReady(cb: (e: { itemId: number; url: string }) => void): () => void
    onImageProgress(cb: (e: ImageProgress) => void): () => void
    onVideoProgress(cb: (e: VideoProgressEvent) => void): () => void
  }
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: BoothAPI = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    test: () => ipcRenderer.invoke('settings:test')
  },
  library: {
    list: (q) => ipcRenderer.invoke('library:list', q),
    search: (q) => ipcRenderer.invoke('library:search', q),
    getItem: (id) => ipcRenderer.invoke('library:getItem', id),
    sync: (forceDetail) => ipcRenderer.invoke('library:sync', forceDetail ?? false),
    imageUrl: (remoteUrl) => ipcRenderer.invoke('library:imageUrl', remoteUrl),
    imageThumbUrl: (remoteUrl) => ipcRenderer.invoke('library:imageThumbUrl', remoteUrl),
    openItemPage: (id) => ipcRenderer.invoke('library:openItemPage', id),
    openItemDir: (id) => ipcRenderer.invoke('library:openItemDir', id),
    refreshItem: (id) => ipcRenderer.invoke('library:refreshItem', id),
    deleteItem: (id) => ipcRenderer.invoke('library:deleteItem', id)
  },
  updates: {
    checkGlobal: () => ipcRenderer.invoke('updates:checkGlobal'),
    checkItem: (id) => ipcRenderer.invoke('updates:checkItem', id),
    listAvailable: () => ipcRenderer.invoke('updates:listAvailable')
  },
  downloads: {
    enqueue: (ids, source) => ipcRenderer.invoke('downloads:enqueue', ids, source),
    enqueueItem: (itemId, source) => ipcRenderer.invoke('downloads:enqueueItem', itemId, source),
    startAll: (source) => ipcRenderer.invoke('downloads:startAll', source),
    enqueueAll: (source) => ipcRenderer.invoke('downloads:startAll', source),
    cancel: (id) => ipcRenderer.invoke('downloads:cancel', id),
    downloadNow: (id) => ipcRenderer.invoke('downloads:downloadNow', id),
    stats: () => ipcRenderer.invoke('downloads:stats'),
    list: () => ipcRenderer.invoke('downloads:list'),
    pauseAll: () => ipcRenderer.invoke('downloads:pauseAll'),
    resumeAll: () => ipcRenderer.invoke('downloads:resumeAll'),
    retryFailed: () => ipcRenderer.invoke('downloads:retryFailed'),
    records: (limit) => ipcRenderer.invoke('downloads:records', limit)
  },
  history: {
    listFileDates: (id) => ipcRenderer.invoke('history:listFileDates', id),
    listDescriptionDates: (id) => ipcRenderer.invoke('history:listDescriptionDates', id),
    readSnapshot: (id, date) => ipcRenderer.invoke('history:readSnapshot', id, date),
    listFilesAtDate: (id, date) => ipcRenderer.invoke('history:listFilesAtDate', id, date),
    openPath: (p) => ipcRenderer.invoke('history:openPath', p),
    revealPath: (p) => ipcRenderer.invoke('history:revealPath', p)
  },
  auth: {
    check: () => ipcRenderer.invoke('auth:check'),
    cookiesPath: () => ipcRenderer.invoke('auth:cookiesPath')
  },
  images: {
    enqueueItem: (itemId) => ipcRenderer.invoke('images:enqueueItem', itemId)
  },
  videos: {
    checkYtDlp: (invalidate) => ipcRenderer.invoke('videos:checkYtDlp', invalidate ?? false),
    list: (itemId) => ipcRenderer.invoke('videos:list', itemId),
    download: (key) => ipcRenderer.invoke('videos:download', key),
    reveal: (path) => ipcRenderer.invoke('videos:reveal', path)
  },
  dialog: {
    chooseDir: () => ipcRenderer.invoke('dialog:chooseDir'),
    chooseFile: () => ipcRenderer.invoke('dialog:chooseFile')
  },
  protocol: {
    hostStatus: () => ipcRenderer.invoke('protocol:hostStatus'),
    hostDecision: (decision) => ipcRenderer.invoke('protocol:hostDecision', decision)
  },
  system: {
    proxyInfo: () => ipcRenderer.invoke('system:proxyInfo'),
    windowsProxy: () => ipcRenderer.invoke('system:windowsProxy')
  },
  events: {
    onLibraryUpdated: (cb) => subscribe('event:libraryUpdated', cb),
    onCheckProgress: (cb) => subscribe('event:checkProgress', cb),
    onDownloadProgress: (cb) => subscribe('event:downloadProgress', cb),
    onDownloadDone: (cb) => subscribe('event:downloadDone', cb),
    onDownloadError: (cb) => subscribe('event:downloadError', cb),
    onQueueChanged: (cb) => subscribe('event:queueChanged', cb),
    onAuthExpired: (cb) => subscribe('event:authExpired', cb),
    onCookiesReloaded: (cb) => subscribe('event:cookiesReloaded', cb),
    onToast: (cb) => subscribe('event:toast', cb),
    onImageReady: (cb) => subscribe('event:imageReady', cb),
    onImageProgress: (cb) => subscribe('event:imageProgress', cb),
    onVideoProgress: (cb) => subscribe('event:videoProgress', cb)
  }
}

contextBridge.exposeInMainWorld('boothAPI', api)
