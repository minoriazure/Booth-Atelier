import { ipcMain, shell, dialog, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { z } from 'zod'
import type { AppContext } from '../appContext'
import { isAuthError } from '../booth/errors'
import { applyProxySettings, normalizeProxyRules, readWindowsSystemProxy, resolveSystemProxy, systemFetch } from '../booth/systemFetch'
import { checkDeepLinkHost, registerProtocol } from '../protocol'
import { createLogger } from '../util/log'
import { listDays, readDay, searchLogs, cleanupLogs } from '../services/logService'
import type { ProxyTestResult } from '../../shared/types'

const log = createLogger('ipc')

/** 绝对路径 → 渲染层可用的 media URL */
function mediaUrl(absPath: string): string {
  return `image-cache://local/${encodeURIComponent(absPath)}`
}
function tryMedia(absPath: string | null): string | null {
  return absPath ? mediaUrl(absPath) : null
}

/**
 * 历史快照中的远程图片：登记为 desc 图片后台下载，返回已就绪的映射。
 * 未下载完成的不在映射中，渲染层保留远程 URL，图片就绪事件到达后重新读取。
 */
function localizeSnapshotImages(ctx: AppContext, itemId: number, html: string): Record<string, string> {
  const urls = new Set<string>()
  for (const m of html.matchAll(/<img\b[^>]*?\ssrc="(https?:\/\/[^"]+)"/gi)) urls.add(m[1])
  if (urls.size === 0) return {}
  ctx.imageLocalizer.registerItemImages(itemId, Array.from(urls, (url) => ({ url, kind: 'desc' })))
  const map: Record<string, string> = {}
  for (const u of urls) {
    const local = ctx.imageLocalizer.resolvePreviewLocal(u)
    if (local) map[u] = mediaUrl(local)
  }
  return map
}

/** 注册全部 IPC 通道；所有入参 Zod 校验 */
export function registerIpc(ctx: AppContext, getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown): void => {
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }

  // 渲染层直接拿数据；错误以异常抛出（preload 类型化）
  const handle = <T extends unknown[], R>(name: string, fn: (...args: T) => Promise<R> | R) => {
    ipcMain.handle(name, async (_e, ...args) => {
      try {
        return await fn(...(args as T))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const auth = isAuthError(err)
        log.error(`${name} failed: ${msg}`)
        if (auth) send('event:authExpired', msg)
        throw new Error(auth ? `[认证] ${msg}` : msg)
      }
    })
  }

  const q = z.string()
  const id = z.number().int().positive()

  // ── settings ──
  handle('settings:get', () => ctx.settings.get())
  handle('settings:set', async (patch: unknown) => {
    const p = z.record(z.string(), z.unknown()).parse(patch) as Record<string, unknown>
    if (p.proxyMode !== undefined && !['system', 'custom', 'direct'].includes(String(p.proxyMode))) {
      throw new Error(`无效的代理模式: ${String(p.proxyMode)}`)
    }
    if (p.customProxy !== undefined) {
      const effectiveMode = p.proxyMode ?? ctx.settings.get().proxyMode
      const v = String(p.customProxy ?? '').trim()
      p.customProxy = v
      if (effectiveMode === 'custom' && v && !normalizeProxyRules(v)) {
        throw new Error('自定义代理地址无效，请输入例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080')
      }
    }
    if (p.autoRegisterDeepLink !== undefined && typeof p.autoRegisterDeepLink !== 'boolean') {
      throw new Error('autoRegisterDeepLink 必须是布尔值')
    }
    // cookiesPath = 覆盖项：非空时文件必须真实存在（启动时同样「存在才覆盖」，保持一致）
    if (p.cookiesPath !== undefined) {
      const v = String(p.cookiesPath ?? '').trim()
      p.cookiesPath = v
      if (v && !existsSync(v)) throw new Error(`Cookie 文件不存在: ${v}`)
    }
    if ('logRetentionDays' in p) {
      const v = Number(p.logRetentionDays)
      if (!Number.isInteger(v) || v < 7 || v > 180) throw new Error('日志保留天数必须是 7–180 之间的整数')
      p.logRetentionDays = v
    }
    const next = ctx.settings.set(p as never)
    log.info(`settings saved: ${Object.keys(p).join(', ') || '(none)'}`)
    if ('logRetentionDays' in p) {
      log.info(`log retention changed to ${next.logRetentionDays} day(s)`)
      void cleanupLogs(next.logRetentionDays)
    }
    // 代理设置变更：立即热应用（无需重启），随后 UI 刷新 proxyInfo 即可看到新值
    if ('proxyMode' in p || 'customProxy' in p) {
      await applyProxySettings(next.proxyMode, next.customProxy)
    }
    // cookies 路径变更：立即热应用（空 = 清除覆盖 → 回默认查找链）
    if ('cookiesPath' in p) {
      ctx.jar.setPath(String(next.cookiesPath || '').trim() || ctx.defaultCookiesPath)
      log.info(`cookies path applied: ${ctx.jar.filePathRef}`)
    }
    // 下载根变更：按新目录重新识别已下载文件（目录不存在时自动跳过，不改动记录）
    if ('downloadRoot' in p) {
      const r = ctx.reconcileLocal()
      log.info(`download root changed, reconcile: skipped=${r.skipped} recognized=${r.recognized} released=${r.released}`)
    }
    return next
  })
  // ── log ──
  handle('log:listDays', () => listDays())
  handle('log:readDay', (date: unknown, offset: unknown, limit: unknown) =>
    readDay(q.parse(date), z.number().int().min(0).parse(offset), z.number().int().min(1).max(1000).parse(limit))
  )
  handle('log:search', (query: unknown) => searchLogs(q.max(200).parse(query)))
  const rendererLog = createLogger('renderer')
  /** 渲染层日志（toast / 错误边界等）写入同一套日志文件 */
  handle('log:write', (level: unknown, scope: unknown, message: unknown) => {
    const lv = z.enum(['info', 'warn', 'error']).parse(level)
    const sc = q.max(64).parse(scope)
    const msg = q.max(4000).parse(message)
    rendererLog[lv](`[${sc}] ${msg}`)
  })

  const withLocalThumbs = <T extends { itemId: number; thumbnailUrl: string | null }>(
    rows: T[]
  ): Array<T & { localThumb: string | null }> =>
    rows.map((r) => ({
      ...r,
      localThumb: r.thumbnailUrl ? tryMedia(ctx.imageLocalizer.resolvePreviewLocal(r.thumbnailUrl)) : null
    }))
  handle('library:list', (query?: unknown) =>
    withLocalThumbs(typeof query === 'string' && query ? ctx.repo.search(query) : ctx.repo.listSummaries())
  )
  handle('library:search', (query: unknown) => withLocalThumbs(ctx.repo.search(q.parse(query))))
  handle('library:getItem', (itemId: unknown) => {
    const rid = id.parse(itemId)
    const detail = ctx.repo.getItemDetail(rid)
    if (!detail) return null
    detail.localThumb = detail.thumbnailUrl ? tryMedia(ctx.imageLocalizer.resolvePreviewLocal(detail.thumbnailUrl)) : null
    detail.localGallery = detail.galleryUrls.map((u) => ({
      url: u,
      mediaUrl: tryMedia(ctx.imageLocalizer.resolveLocalFor(rid, u)),
      previewMediaUrl: tryMedia(ctx.imageLocalizer.resolvePreviewLocal(u)),
      thumbMediaUrl: tryMedia(ctx.imageLocalizer.resolveThumbLocal(u))
    }))
    ctx.videos.validateLocal(rid)
    detail.videos = ctx.repo.listVideosByItem(rid).map((v) => ({
      key: v.key,
      platform: v.platform as never,
      videoId: v.videoId,
      url: v.url,
      embedUrl: v.embedUrl,
      localPath: v.localPath,
      status: v.status as never,
      progress: v.status === 'downloaded' ? 100 : 0,
      error: null
    }))
    return detail
  })
  handle('library:sync', async (force?: unknown) => {
    const summary = await ctx.sync.sync(force === true)
    send('event:libraryUpdated', summary)
    return summary
  })
  handle('library:refreshItem', async (itemId: unknown) => {
    const rid = id.parse(itemId)
    if (!ctx.repo.getItemDetail(rid)) throw new Error('本地不存在该商品')
    return ctx.sync.refreshItem(rid)
  })
  handle('library:deleteItem', async (itemId: unknown) => {
    const rid = id.parse(itemId)
    return ctx.removal.remove(rid)
  })
  handle('library:imageUrl', (remoteUrl: unknown) => {
    const u = q.parse(remoteUrl)
    // 列表卡片等展示位：preview/ 长边 720（未生成回退原图）
    const local = ctx.imageLocalizer.resolvePreviewLocal(u)
    return local ? mediaUrl(local) : null
  })

  // 缩略图优先（已生成返回 thumb，未生成返回原图并后台生成）
  handle('library:imageThumbUrl', (remoteUrl: unknown) => {
    const u = q.parse(remoteUrl)
    const local = ctx.imageLocalizer.resolveThumbLocal(u)
    return local ? mediaUrl(local) : null
  })

  // 商品图片：登记 + 后台下载（无需确认）
  handle('images:enqueueItem', (itemId: unknown) => {
    const rid = id.parse(itemId)
    const detail = ctx.repo.getItemDetail(rid)
    if (!detail) return 0
    const list: Array<{ url: string; kind: string }> = []
    if (detail.thumbnailUrl) list.push({ url: detail.thumbnailUrl, kind: 'thumb' })
    if (detail.ogImageUrl) list.push({ url: detail.ogImageUrl, kind: 'og' })
    for (const u of detail.galleryUrls) list.push({ url: u, kind: 'gallery' })
    ctx.imageLocalizer.registerItemImages(rid, list)
    return list.length
  })

  // 手动修复：清零派生图失败计数，完整对账原图与缩略图/预览图（缺失则重下/重生成）
  handle('images:repair', async () => {
    const r = await ctx.imageLocalizer.repairDerivatives()
    log.info(`manual image repair: reset ${r.reset}, checked ${r.checked}, redownload ${r.redownload}, derivative marked ${r.derivMarked}`)
    return { resetCount: r.reset, checked: r.checked, redownload: r.redownload, derivMarked: r.derivMarked }
  })

  // 可见商品优先生成派生图（卡片进入可视区 / 打开详情时调用，单次最多 50 个）
  handle('images:prioritize', (itemIds: unknown) => {
    const ids = z.array(id).max(50).parse(itemIds)
    for (const itemId of ids) ctx.imageLocalizer.prioritizeItem(itemId)
    return ids.length
  })

  // 商品详情页单品检查：本地核对缺失的原图/派生图，发现缺失即补齐
  handle('images:checkItem', async (itemId: unknown) => {
    const iid = id.parse(itemId)
    const r = await ctx.imageLocalizer.checkItem(iid)
    if (r.redownload > 0 || r.derivMissing > 0) {
      log.info(`item image check #${iid}: checked ${r.checked}, redownload ${r.redownload}, derivative missing ${r.derivMissing}`)
    }
    return r
  })

  // ── 视频（yt-dlp） ──
  handle('videos:checkYtDlp', async (invalidate?: unknown) => {
    const p = await ctx.videos.checkYtDlp(invalidate === true)
    return { found: !!p, path: p }
  })
  handle('videos:list', (itemId: unknown) => ctx.repo.listVideosByItem(id.parse(itemId)))
  handle('videos:download', async (key?: unknown) => ctx.videos.download(q.parse(key)))
  handle('videos:reveal', (p?: unknown) => shell.showItemInFolder(q.parse(p)))
  handle('library:openItemPage', (itemId: unknown) => {
    shell.openExternal(`https://booth.pm/zh-cn/items/${id.parse(itemId)}`)
  })

  // 打开该商品的下载目录（素材文件所在处，拖 Unity 用）
  handle('library:openItemDir', (itemId: unknown) => {
    const rid = id.parse(itemId)
    const dir = ctx.paths.currentDir(rid)
    ctx.paths.ensureDir(dir)
    return shell.openPath(dir)
  })

  // ── updates ──
  handle('updates:checkGlobal', async () => {
    const summary = await ctx.checker.checkGlobal()
    send('event:libraryUpdated', summary)
    return summary
  })
  handle('updates:checkItem', async (itemId: unknown) => {
    const summary = await ctx.checker.checkItem(id.parse(itemId))
    send('event:libraryUpdated', summary)
    return summary
  })
  handle('updates:listAvailable', () => ctx.repo.listUpdatesAvailable())

  // ── downloads ──
  handle('downloads:enqueue', (ids: unknown, source: unknown) => {
    const arr = z.array(id).parse(ids)
    const src = z.enum(['initial', 'bulk', 'manual', 'update']).parse(source)
    return ctx.downloads.enqueueMany(arr, src)
  })
  handle('downloads:enqueueItem', (itemId: unknown, source: unknown) => {
    const src = z.enum(['initial', 'bulk', 'manual', 'update']).parse(source)
    return ctx.downloads.enqueueItem(id.parse(itemId), src)
  })
  handle('downloads:startAll', (source: unknown) => {
    const src = z.enum(['initial', 'bulk', 'manual', 'update']).parse(source)
    ctx.downloads.startAll(src)
    return ctx.downloads.stats // 返回统计（queued/active），UI 需要
  })
  // 兼容旧名：语义同 startAll
  handle('downloads:enqueueAll', (source: unknown) => {
    const src = z.enum(['initial', 'bulk', 'manual', 'update']).parse(source)
    ctx.downloads.startAll(src)
    return ctx.downloads.stats
  })
  handle('downloads:cancel', (dlId: unknown) => ctx.downloads.cancel(id.parse(dlId)))
  handle('downloads:downloadNow', (dlId: unknown) => ctx.downloads.downloadNow(id.parse(dlId), 'manual'))
  handle('downloads:stats', () => ctx.downloads.stats)
  handle('downloads:list', () => ctx.downloads.listFiles())
  handle('downloads:pauseAll', () => {
    ctx.downloads.pauseAll()
    return ctx.downloads.stats
  })
  handle('downloads:resumeAll', () => {
    ctx.downloads.resumeAll()
    return ctx.downloads.stats
  })
  handle('downloads:retryFailed', () => ctx.downloads.retryFailed())
  handle('downloads:records', (limit?: unknown) => ctx.repo.listDownloadRecords(typeof limit === 'number' ? limit : 100))

  // ── history ──
  handle('history:listFileGroups', (itemId: unknown) => ctx.history.listFileGroups(id.parse(itemId)))
  handle('history:listFilesAtArchive', (itemId: unknown, archivedAt: unknown) =>
    ctx.history.listFilesAtArchive(id.parse(itemId), q.parse(archivedAt))
  )
  handle('history:listDescriptionEntries', (itemId: unknown) => ctx.history.listDescriptionEntries(id.parse(itemId)))
  handle('history:readSnapshot', (snapshotId: unknown) => {
    const s = ctx.history.readSnapshot(id.parse(snapshotId))
    if (!s) return null
    return { ...s, localImages: localizeSnapshotImages(ctx, s.itemId, s.descriptionHtml) }
  })
  handle('history:openPath', (p: unknown) => shell.openPath(q.parse(p)))
  handle('history:revealPath', (p: unknown) => shell.showItemInFolder(q.parse(p)))

  // ── 系统代理状态（设置页展示；下载实际走 Chromium 栈自动应用） ──
  handle('system:proxyInfo', async () => {
    return resolveSystemProxy()
  })
  handle('system:windowsProxy', () => readWindowsSystemProxy())

  // ── 代理连通性测试（经当前生效代理访问 BOOTH 首页） ──
  handle('settings:test', async (): Promise<ProxyTestResult> => {
    const started = Date.now()
    try {
      const res = await systemFetch('https://booth.pm/', {
        method: 'GET',
        signal: AbortSignal.timeout(15_000)
      })
      void res.body?.cancel().catch(() => undefined)
      const latencyMs = Date.now() - started
      const ok = res.status >= 200 && res.status < 400
      return {
        ok,
        status: res.status,
        latencyMs,
        message: ok ? `连接成功（HTTP ${res.status}，${latencyMs} ms）` : `BOOTH 返回 HTTP ${res.status}`
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, status: null, latencyMs: Date.now() - started, message: `连接失败：${message}` }
    }
  })

  // ── dialog ──
  handle('dialog:chooseDir', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择下载根目录'
    })
    const picked = r.canceled ? null : r.filePaths[0] ?? null
    log.info(`choose download dir: ${picked ?? '(cancelled)'}`)
    return picked
  })
  handle('dialog:chooseFile', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: '选择 Cookie 文件（Netscape 格式）'
    })
    const picked = r.canceled ? null : r.filePaths[0] ?? null
    log.info(`choose cookie file: ${picked ?? '(cancelled)'}`)
    return picked
  })

  // ── protocol（深链宿主自检：应用内弹窗，独立于 cookies）──
  handle('protocol:hostStatus', () =>
    checkDeepLinkHost(() => ctx.settings.get().autoRegisterDeepLink === true)
  )
  handle('protocol:hostDecision', (decision: unknown) => {
    const d = z.enum(['register', 'decline']).parse(decision)
    if (d === 'register') {
      registerProtocol()
      log.info('deep link host: registered after user confirm')
      return { registered: true, autoRegister: true }
    }
    ctx.settings.set({ autoRegisterDeepLink: false })
    log.info('deep link host: declined by user, autoRegisterDeepLink → false')
    return { registered: false, autoRegister: false }
  })

  // ── auth ──
  handle('auth:check', async () => {
    try {
      await ctx.auth.check()
      // 认证有效 → 自动恢复被认证暂停的下载队列（恢复途径）
      ctx.downloads.resumeAfterAuth()
      return { ok: true, error: undefined, kind: undefined }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        // rate_limited ≠ 认证失效：前端据此只弹 toast 不弹 Cookie 弹窗
        kind: e && typeof e === 'object' && 'kind' in e ? (e as { kind: string }).kind : undefined
      }
    }
  })
  handle('auth:cookiesPath', () => ctx.jar.filePathRef)

  // ── 状态转发 ──
  ctx.sync.onProgress = (e) => send('event:checkProgress', e)
  ctx.checker.onProgress = (e) => send('event:checkProgress', e)
  ctx.downloads.onProgress = (e) => send('event:downloadProgress', e)
  ctx.downloads.onDone = (e) => send('event:downloadDone', e)
  ctx.downloads.onError = (e) => send('event:downloadError', e)
  ctx.downloads.onQueueChanged = () => send('event:queueChanged', ctx.downloads.stats)
  ctx.imageLocalizer.onImageDone = (itemId, url) => send('event:imageReady', { itemId, url })
  ctx.imageLocalizer.onProgress = (e) => send('event:imageProgress', e)
  ctx.imageLocalizer.onDerivativeProgress = (e) => send('event:derivativeProgress', e)
  ctx.imageLocalizer.onReconcileProgress = (e) => send('event:reconcileProgress', e)
  ctx.videos.onProgress = (e) => send('event:videoProgress', e)

  log.info('ipc registered')
}
