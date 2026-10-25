import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileHistoryGroup, ItemDetailRow, ItemVideo, SnapshotDetail, SnapshotEntry } from '../../../shared/types'
import type { VideoProgressEvent } from '../../../preload/index'
import DeleteItemDialog from '../components/DeleteItemDialog'
import { buildBoothDescHtml } from '../components/boothDesc'
import { formatCapturedAt } from '../components/formatTime'
import { api } from '../api'

type ToastFn = (level: 'info' | 'warn' | 'error', message: string) => void

function formatBytes(n: number | null | undefined): string {
  if (n == null) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

/** 绝对路径 → 本地媒体 URL（与主进程协议一致） */
function toMedia(path: string): string {
  return `image-cache://local/${encodeURIComponent(path)}`
}

/** 大图放大查看器：滚轮缩放（以光标为中心）+ 鼠标拖拽平移 + 双击复位 */
function ZoomViewer({ src, onClose }: { src: string; onClose: () => void }) {
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null)
  const suppressClickRef = useRef(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 滚轮缩放：以光标位置为锚点
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = wrap.getBoundingClientRect()
      const cx = e.clientX - rect.left - rect.width / 2
      const cy = e.clientY - rect.top - rect.height / 2
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      setScale((prev) => {
        const next = Math.min(12, Math.max(0.2, prev * factor))
        const k = next / prev
        // 缩放后保持光标下像素不动：t' = c - (c - t) * k
        setTx((oldTx) => cx - (cx - oldTx) * k)
        setTy((oldTy) => cy - (cy - oldTy) * k)
        return next
      })
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => wrap.removeEventListener('wheel', onWheel)
  }, [])

  // 拖拽平移：记录是否发生过位移（>4px 视为拖拽），拖拽后的 click 不得关闭
  const onMouseDown = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('.zoom-controls')) return
    e.preventDefault()
    dragRef.current = { x: e.clientX, y: e.clientY, tx, ty, moved: false }
  }
  const onMouseMove = (e: React.MouseEvent): void => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true
    if (!d.moved) return
    setTx(d.tx + dx)
    setTy(d.ty + dy)
  }
  const endDrag = (): void => {
    const d = dragRef.current
    if (d?.moved) {
      suppressClickRef.current = true
      // 兜底：若后续 click 未派发（如拖出窗口），1s 后复位，避免吞掉下一次点击
      setTimeout(() => {
        suppressClickRef.current = false
      }, 1000)
    }
    dragRef.current = null
  }

  /** 点击是否落在图片实际包围盒内（图片 pointer-events:none，需手动判定） */
  const isOnImage = (e: React.MouseEvent): boolean => {
    const img = wrapRef.current?.querySelector('img')
    if (!img) return false
    const r = img.getBoundingClientRect()
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
  }

  // ESC 关闭；双击复位
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const reset = (): void => {
    setScale(1)
    setTx(0)
    setTy(0)
  }

  return (
    <div
      className="zoom-viewer"
      ref={wrapRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      onDoubleClick={reset}
      onClick={(e) => {
        // 拖拽结束派发的 click：吞掉，不关闭
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          return
        }
        if ((e.target as HTMLElement).closest('.zoom-controls')) return
        // 点图片上：查看用，不关闭；点图片外空白：关闭
        if (!isOnImage(e)) onClose()
      }}
    >
      <img src={src} alt="" draggable={false} style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }} />
      <div className="zoom-controls" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => setScale((v) => Math.min(12, v * 1.25))}>＋</button>
        <span className="zoom-pct">{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale((v) => Math.max(0.2, v / 1.25))}>－</button>
        <button onClick={reset}>复位</button>
        <button className="primary" onClick={onClose}>
          ✕ 关闭
        </button>
      </div>
      <div className="zoom-hint">滚轮缩放 · 拖拽平移 · 双击复位 · ESC 关闭</div>
    </div>
  )
}

/** 画廊：大图 + 左右循环切换 + 缩略图条（滚动/点击跳转），仿 BOOTH 网页端 */
function Gallery({
  images,
  videos
}: {
  images: Array<{ url: string; mediaUrl: string | null; previewMediaUrl: string | null; thumbMediaUrl: string | null }>
  videos: ItemVideo[]
}) {
  // 画廊条目：图片（底层 thumb 360、清晰层 preview 720、放大用原图 orig）+ 已下载视频
  const slides = useMemo(() => {
    const imgs = images.map((g) => ({
      type: 'image' as const,
      src: g.previewMediaUrl || g.mediaUrl || g.url,
      orig: g.mediaUrl || g.url,
      thumb: g.thumbMediaUrl
    }))
    const vids = videos
      .filter((v) => v.status === 'downloaded' && v.localPath)
      .map((v) => ({ type: 'video' as const, src: toMedia(v.localPath!), orig: null, thumb: null, key: v.key }))
    return [...imgs, ...vids]
  }, [images, videos])

  const [idx, setIdx] = useState(0)
  const [zoomSrc, setZoomSrc] = useState<string | null>(null)
  // 首尾回绕时临时关闭过渡，避免轨道从末张反向滑过全部幻灯片
  const [instant, setInstant] = useState(false)
  const stripRef = useRef<HTMLDivElement>(null)
  const thumbRefs = useRef<Array<HTMLDivElement | null>>([])
  const videoRefs = useRef<Array<HTMLVideoElement | null>>([])

  useEffect(() => {
    if (idx >= slides.length) setIdx(0)
  }, [slides.length, idx])

  // 离开视频幻灯片时暂停播放
  useEffect(() => {
    videoRefs.current.forEach((v, i) => {
      if (v && i !== idx) v.pause()
    })
  }, [idx])

  useEffect(() => {
    if (!instant) return
    const id = requestAnimationFrame(() => setInstant(false))
    return () => cancelAnimationFrame(id)
  }, [instant])

  const [broken, setBroken] = useState<Record<number, boolean>>({})
  // 清晰层（preview）是否已加载完成（用于淡入）；离开「当前 ± 1」窗口后剪枝
  const [loaded, setLoaded] = useState<Record<number, boolean>>({})
  useEffect(() => {
    setBroken({})
    setLoaded({})
  }, [slides])

  useEffect(() => {
    setLoaded((prev) => {
      const next: Record<number, boolean> = {}
      for (const k of Object.keys(prev)) {
        const i = Number(k)
        const d = Math.abs(i - idx)
        if (Math.min(d, slides.length - d) <= 1) next[i] = true
      }
      return next
    })
  }, [idx, slides.length])

  const go = (next: number): void => {
    const len = slides.length
    if (len === 0) return
    const n = ((next % len) + len) % len
    const wrapped = len > 2 && ((idx === len - 1 && n === 0) || (idx === 0 && n === len - 1))
    if (wrapped) setInstant(true)
    setIdx(n)
    thumbRefs.current[n]?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }

  if (slides.length === 0) return null

  /** 与当前幻灯片的环形距离；仅相邻幻灯片挂载真实资源，其余不加载 */
  const distance = (i: number): number => {
    const d = Math.abs(i - idx)
    return Math.min(d, slides.length - d)
  }

  return (
    <div className="gallery2">
      <div className="gallery2-stage">
        <button className="gallery2-nav prev" onClick={() => go(idx - 1)} title="上一张" disabled={slides.length < 2}>
          ‹
        </button>
        <div className="gallery2-image">
          <div
            className={`gallery2-track${instant ? ' no-anim' : ''}`}
            style={{ transform: `translateX(-${idx * 100}%)` }}
          >
            {slides.map((s, i) => {
              const near = distance(i) <= 1
              return (
                <div key={i} className="gallery2-slide" aria-hidden={i !== idx}>
                  {s.type === 'video' ? (
                    near && (
                      <video
                        ref={(el) => {
                          videoRefs.current[i] = el
                        }}
                        className="gallery2-video"
                        src={s.src}
                        controls
                        preload="metadata"
                      />
                    )
                  ) : broken[i] ? (
                    <div className="gallery2-placeholder">🖼 图片加载中…</div>
                  ) : (
                    <div className="gallery2-img-box">
                      {/* 底层：thumb 360 与清晰层同尺寸铺满，立即可见 */}
                      {s.thumb && <img className="gallery2-underlay" src={s.thumb} alt="" />}
                      {near && (
                        <img
                          className={`zoomable gallery2-full${loaded[i] ? ' loaded' : ''}`}
                          src={s.src}
                          alt=""
                          title="点击放大查看"
                          onLoad={() => setLoaded((l) => ({ ...l, [i]: true }))}
                          onError={() => setBroken((b) => ({ ...b, [i]: true }))}
                          onClick={() => loaded[i] && s.orig && setZoomSrc(s.orig)}
                        />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        <button className="gallery2-nav next" onClick={() => go(idx + 1)} title="下一张" disabled={slides.length < 2}>
          ›
        </button>
        <div className="gallery2-counter">
          {Math.min(idx + 1, slides.length)} / {slides.length}
        </div>
      </div>
      {slides.length > 1 && (
        <div className="gallery2-strip" ref={stripRef}>
          {slides.map((s, i) => (
            <div
              key={i}
              className={`gallery2-thumb ${i === idx ? 'active' : ''}`}
              ref={(el) => {
                thumbRefs.current[i] = el
              }}
              onClick={() => go(i)}
            >
              {/* 缩略图条：thumb 360，缺失时回退 preview 720 */}
              {s.type === 'video' ? <span className="thumb-video">▶</span> : <img src={s.thumb || s.src} loading="lazy" alt="" />}
            </div>
          ))}
        </div>
      )}
      {zoomSrc && <ZoomViewer src={zoomSrc} onClose={() => setZoomSrc(null)} />}
    </div>
  )
}

/** 描述中的视频卡片（替换 iframe 渲染） */
function VideoCard({
  video,
  onDownload,
  downloading
}: {
  video: ItemVideo
  onDownload: (key: string) => void
  downloading: boolean
}) {
  const platformName = { youtube: 'YouTube', nicovideo: 'NicoNico', vimeo: 'Vimeo', other: '视频' }[video.platform]
  if (video.status === 'downloaded' && video.localPath) {
    return (
      <div className="video-card">
        <video className="video-card-player" src={toMedia(video.localPath)} controls preload="metadata" />
        <div className="video-card-bar">
          <span className="video-card-tag">已本地化 · {platformName}</span>
          <button className="mini-btn" onClick={() => void api.videos.reveal(video.localPath!)}>
            打开位置
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="video-card">
      <div className="video-card-info">
        <span className="video-card-tag">▶ {platformName}</span>
        <span className="video-card-id">{video.videoId}</span>
      </div>
      <div className="video-card-actions">
        <button className="mini-btn primary" disabled={downloading} onClick={() => onDownload(video.key)}>
          {downloading ? `下载中 ${video.progress}%` : '⬇ 下载视频'}
        </button>
        <a className="mini-btn" href={video.url} target="_blank" rel="noreferrer">
          在线观看 ↗
        </a>
      </div>
      {downloading && (
        <div className="progressbar" style={{ marginTop: 8 }}>
          <div style={{ width: `${video.progress}%` }} />
        </div>
      )}
      {video.status === 'failed' && video.error && <div className="video-card-error">{video.error}</div>}
    </div>
  )
}

export default function ItemDetailPage({
  itemId,
  version,
  onBack,
  onChanged,
  onOpenHistory,
  toast
}: {
  itemId: number
  version: number
  onBack: () => void
  onChanged: () => void
  onOpenHistory: (itemId: number) => void
  toast: ToastFn
}) {
  const [item, setItem] = useState<ItemDetailRow | null>(null)
  const [checking, setChecking] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [downloading, setDownloading] = useState<number[]>([])
  const [videoStates, setVideoStates] = useState<Record<string, ItemVideo>>({})
  const [ytDlpOk, setYtDlpOk] = useState<boolean | null>(null)

  // 说明历史：下拉选择快照（null = 当前描述）
  const [descEntries, setDescEntries] = useState<SnapshotEntry[]>([])
  const [descSnapId, setDescSnapId] = useState<number | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotDetail | null>(null)
  // 文件历史只需判断是否存在（决定跳转按钮是否可用）
  const [fileGroups, setFileGroups] = useState<FileHistoryGroup[]>([])
  // 图片就绪后递增，用于重新读取快照的本地图片映射
  const [imageTick, setImageTick] = useState(0)

  const load = useCallback(async () => {
    const d = await api.library.getItem(itemId)
    setItem(d)
    if (d) {
      const map: Record<string, ItemVideo> = {}
      for (const v of d.videos) map[v.key] = v
      setVideoStates(map)
    }
    setDescEntries(await api.history.listDescriptionEntries(itemId))
    setFileGroups(await api.history.listFileGroups(itemId))
  }, [itemId])

  useEffect(() => {
    void load()
  }, [load, version])

  // 切换到不同商品时回到顶部（图片就绪触发的重载不回顶）
  useEffect(() => {
    document.querySelector('.main')?.scrollTo({ top: 0 })
    setDescSnapId(null)
  }, [itemId])

  // 打开详情即登记图片（后台补下，不阻塞）
  useEffect(() => {
    void api.images.enqueueItem(itemId).catch(() => {})
  }, [itemId])

  // 图片就绪 → 刷新本地画廊映射与历史快照图片
  useEffect(() => {
    const un = api.events.onImageReady((e) => {
      if (e.itemId === itemId) {
        void load()
        setImageTick((n) => n + 1)
      }
    })
    return un
  }, [itemId, load])

  // 视频进度
  useEffect(() => {
    const un = api.events.onVideoProgress((e: VideoProgressEvent) => {
      setVideoStates((prev) => {
        const cur = prev[e.key]
        if (!cur) return prev
        return {
          ...prev,
          [e.key]: {
            ...cur,
            status: e.status === 'downloaded' ? 'downloaded' : e.status === 'failed' ? 'failed' : 'downloading',
            progress: e.progress,
            localPath: e.localPath ?? cur.localPath,
            error: e.error ?? null
          }
        }
      })
      if (e.status === 'downloaded') {
        toast('info', '视频下载完成')
        void load()
        onChanged()
      } else if (e.status === 'failed') {
        toast('error', `视频下载失败：${e.error ?? '未知错误'}`)
      }
    })
    return un
  }, [load, onChanged, toast])

  // yt-dlp 检测（懒：只在有视频时查一次）
  useEffect(() => {
    if (item && item.videos.length > 0 && ytDlpOk === null) {
      void api.videos.checkYtDlp().then((r) => setYtDlpOk(r.found))
    }
  }, [item, ytDlpOk])

  useEffect(() => {
    if (descSnapId == null) {
      setSnapshot(null)
      return
    }
    void api.history.readSnapshot(descSnapId).then(setSnapshot)
  }, [descSnapId, imageTick])

  const doCheck = async (): Promise<void> => {
    setChecking(true)
    try {
      const s = await api.updates.checkItem(itemId)
      toast('info', `检查完成：${s.filesChecked} 个链接，${s.filesUpdated} 个有更新${s.downloaded ? `，已自动下载 ${s.downloaded} 个` : ''}`)
      await load()
      onChanged()
    } catch (e) {
      toast('error', `检查失败：${e instanceof Error ? e.message : e}`)
    } finally {
      setChecking(false)
    }
  }

  // 只刷新本商品的商店页数据（不抓列表、不下载文件）
  const doRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const r = await api.library.refreshItem(itemId)
      toast('info', r.changed ? '商品页已更新（元数据有变化，已保存旧版本快照）' : '商品页已检查，没有变化')
      await load()
      onChanged()
    } catch (e) {
      toast('error', `刷新失败：${e instanceof Error ? e.message : e}`)
    } finally {
      setRefreshing(false)
    }
  }

  const doDelete = async (): Promise<void> => {
    setDeleting(true)
    try {
      const r = await api.library.deleteItem(itemId)
      toast('info', `已删除本地商品 #${itemId}${r.archivedTo ? '，下载文件已移入 deleted 文件夹' : ''}`)
      for (const w of r.warnings) toast('warn', w)
      setShowDelete(false)
      onChanged()
      onBack()
    } catch (e) {
      toast('error', `删除失败：${e instanceof Error ? e.message : e}`)
    } finally {
      setDeleting(false)
    }
  }

  const doDownloadItem = async (): Promise<void> => {
    const n = await api.downloads.enqueueItem(itemId, 'bulk')
    toast('info', n > 0 ? `已加入队列：${n} 个文件` : '没有需要下载的文件')
  }

  const doDownloadOne = async (downloadableId: number): Promise<void> => {
    setDownloading((d) => [...d, downloadableId])
    try {
      await api.downloads.enqueue([downloadableId], 'manual')
      toast('info', '已加入下载队列')
    } finally {
      setDownloading((d) => d.filter((x) => x !== downloadableId))
    }
  }

  const doDownloadVideo = async (key: string): Promise<void> => {
    if (ytDlpOk === false) {
      const r = await api.videos.checkYtDlp(true)
      if (!r.found) {
        toast('error', '未检测到 yt-dlp，请先安装并加入 PATH（pip install yt-dlp）')
        setYtDlpOk(false)
        return
      }
      setYtDlpOk(true)
    }
    setVideoStates((prev) => ({ ...prev, [key]: { ...prev[key], status: 'downloading', progress: 0, error: null } }))
    const r = await api.videos.download(key)
    if (!r.ok) {
      setVideoStates((prev) => ({ ...prev, [key]: { ...prev[key], status: 'failed', error: r.error ?? '下载失败' } }))
      toast('error', `视频下载失败：${r.error ?? '未知错误'}`)
    }
  }

  /** 描述 HTML：选中历史版本时渲染快照（链接形式视频），否则渲染当前描述（视频占位由下方卡片挂载） */
  const processedDesc = useMemo(() => {
    if (!item) return ''
    if (snapshot) {
      return buildBoothDescHtml(snapshot.descriptionHtml, { localImages: snapshot.localImages, videos: null })
    }
    const localImages: Record<string, string> = {}
    for (const g of item.localGallery) {
      if (g.previewMediaUrl) localImages[g.url] = g.previewMediaUrl
    }
    return buildBoothDescHtml(item.descriptionHtml, { localImages, videos: item.videos })
  }, [item, snapshot])

  // 渲染后把占位 div 替换成视频卡片：用 ref 收集 slot，React Portal 式渲染
  const sideRef = useRef<HTMLElement>(null)
  const sideFilesRef = useRef<HTMLDivElement>(null)
  const descRef = useRef<HTMLDivElement>(null)
  const [descRendered, setDescRendered] = useState(0)
  useEffect(() => {
    setDescRendered((n) => n + 1)
  }, [processedDesc])

  useEffect(() => {
    const root = descRef.current
    if (!root || !item) return
    const slots = root.querySelectorAll<HTMLElement>('.video-slot[data-key]')
    slots.forEach((slot) => {
      const key = slot.getAttribute('data-key')!
      const v = videoStates[key] || item.videos.find((x) => x.key === key)
      if (!v) return
      slot.innerHTML = ''
      const holder = document.createElement('div')
      slot.appendChild(holder)
      // 用轻量 DOM 渲染卡片（避免为占位引入 portal 树）
      renderVideoCardDom(holder, v, videoStates[key]?.progress ?? v.progress, videoStates[key]?.status ?? v.status, (k) => {
        void doDownloadVideo(k)
      })
    })
  }, [processedDesc, videoStates, item, descRendered])

  // 让右侧文件列表恰好适配滚动区可视高度（状态栏行数变化时同步更新）
  useEffect(() => {
    const aside = sideRef.current
    const list = sideFilesRef.current
    const main = aside?.closest<HTMLElement>('.main')
    if (!aside || !list || !main) return
    const fit = () => {
      const chrome = aside.offsetHeight - list.offsetHeight
      list.style.maxHeight = `${Math.max(160, main.clientHeight - 24 - chrome)}px`
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(main)
    ro.observe(aside)
    return () => ro.disconnect()
  }, [item])

  if (!item) return <div className="empty">加载商品…</div>

  const galleryForShow = item.localGallery.length ? item.localGallery : (item.galleryUrls || []).map((u) => ({ url: u, mediaUrl: null, previewMediaUrl: null, thumbMediaUrl: null }))
  const videos = item.videos.map((v) => ({ ...v, ...(videoStates[v.key] || {}) }))

  return (
    <div className="detail2">
      <div className="detail2-top">
        <button className="back" onClick={onBack}>
          ← 返回资源库
        </button>
        <h1>{item.title}</h1>
        <div className="meta">
          <span>{item.shopName || '未知店铺'}</span>
          <span>商品编号 #{item.itemId}</span>
          {item.isGift && <span className="badge gift">赠送</span>}
          {item.isFree && <span className="badge free">免费</span>}
          <a href="#" onClick={(e) => { e.preventDefault(); void api.library.openItemPage(itemId) }} style={{ color: 'var(--accent)' }}>
            在 BOOTH 打开 ↗
          </a>
        </div>
        <div className="detail2-actions">
          <button onClick={() => void doRefresh()} disabled={refreshing || deleting}>
            {refreshing ? '刷新中…' : '🔄 检查当前商品页面更新'}
          </button>
          <button className="danger-solid" onClick={() => setShowDelete(true)} disabled={refreshing || deleting}>
            🗑 删除当前商品
          </button>
        </div>
        {showDelete && (
          <DeleteItemDialog
            itemId={itemId}
            title={item.title}
            busy={deleting}
            onCancel={() => setShowDelete(false)}
            onConfirm={() => void doDelete()}
          />
        )}
      </div>

      <div className="detail2-grid">
        {/* ── 左列：画廊 + 描述 ── */}
        <div className="detail2-main">
          <Gallery images={galleryForShow} videos={videos} />

          {videos.length > 0 && ytDlpOk === false && (
            <div className="panel warn-panel">
              ⚠ 未检测到 yt-dlp，视频无法本地化。安装：<code>pip install yt-dlp</code> 并确保加入 PATH。
            </div>
          )}

          <div className="history-row desc-version-row">
            <label>📝 说明版本：</label>
            <select value={descSnapId ?? ''} onChange={(e) => setDescSnapId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">当前描述</option>
              {descEntries.map((s) => (
                <option key={s.id} value={s.id}>{formatCapturedAt(s.capturedAt)}</option>
              ))}
            </select>
            {descSnapId != null && snapshot && (
              <span className="desc-version-hint">正在查看 {formatCapturedAt(snapshot.capturedAt)} 的说明（视频以链接显示）</span>
            )}
          </div>

          <div
            className="desc desc-html"
            ref={descRef}
            // 处理后的描述 HTML（图片已指向本地；iframe 已替换为占位）
            dangerouslySetInnerHTML={{ __html: processedDesc }}
          />

          {/* 描述里未被占位捕获的视频（保险：全部列出一次） */}
          {videos.length > 0 && (
            <div className="section-title">商品视频（{videos.length}）</div>
          )}
          <div className="video-list">
            {videos.map((v) => (
              <VideoCard key={v.key} video={v} onDownload={(k) => void doDownloadVideo(k)} downloading={videoStates[v.key]?.status === 'downloading'} />
            ))}
          </div>
        </div>

        {/* ── 右列：文件下载管理侧栏 ── */}
        <aside className="detail2-side" ref={sideRef}>
          <button
            className="history-jump-btn"
            disabled={fileGroups.length === 0}
            onClick={() => onOpenHistory(itemId)}
            title={fileGroups.length === 0 ? '该商品暂无文件历史' : '在历史页查看该商品的文件历史'}
          >
            📁 查看文件历史{fileGroups.length > 0 && `（${fileGroups.length}）`}
          </button>
          <div className="side-card">
            <div className="side-card-title">
              文件下载
              <button
                className="mini-btn"
                style={{ marginLeft: 'auto' }}
                onClick={() => void api.library.openItemDir(itemId)}
                title="打开该商品的素材文件夹（拖入 Unity 用）"
              >
                📂 打开文件夹
              </button>
            </div>
            <div className="side-stats">
              <span>{item.fileDownloaded} / {item.fileTotal} 已下载</span>
              {item.fileUpdateAvailable > 0 && <span className="badge update">{item.fileUpdateAvailable} 个待更新</span>}
            </div>
            <div className="side-actions">
              <button onClick={() => void doCheck()} disabled={checking}>
                {checking ? '检查中…' : '🔍 检查全部链接'}
              </button>
              <button className="primary" onClick={() => void doDownloadItem()}>
                ⬇ 下载全部文件
              </button>
            </div>

            <div className="side-files" ref={sideFilesRef}>
              {item.downloadables.map((f) => (
                <div className="side-file" key={f.downloadableId}>
                  <div className="side-file-name" title={f.filename}>{f.filename}</div>
                  <div className="side-file-meta">
                    <span>{formatBytes(f.localSize ?? f.lastSize)}</span>
                    {f.status === 'downloaded' && <span className="badge done">已下载</span>}
                    {f.status === 'update_available' && <span className="badge update">有更新</span>}
                    {f.status === 'remote' && <span className="badge">未下载</span>}
                    {f.status === 'missing' && <span className="badge missing">已失效</span>}
                  </div>
                  <div className="side-file-actions">
                    <button
                      className="mini-btn"
                      disabled={downloading.includes(f.downloadableId) || f.status === 'missing'}
                      onClick={() => void doDownloadOne(f.downloadableId)}
                    >
                      {f.status === 'downloaded' ? '重新下载' : f.status === 'update_available' ? '下载更新' : '下载'}
                    </button>
                    {f.localPath && (
                      <button className="mini-btn" onClick={() => void api.history.revealPath(f.localPath!)}>位置</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

/** 视频占位 → DOM 卡片（下载进度实时更新） */
function renderVideoCardDom(
  holder: HTMLElement,
  v: ItemVideo,
  progress: number,
  status: string,
  onDownload: (key: string) => void
): void {
  if (status === 'downloaded' && v.localPath) {
    holder.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = 'video-card'
    const video = document.createElement('video')
    video.className = 'video-card-player'
    video.src = toMedia(v.localPath)
    video.controls = true
    video.preload = 'metadata'
    wrap.appendChild(video)
    const bar = document.createElement('div')
    bar.className = 'video-card-bar'
    bar.innerHTML = `<span class="video-card-tag">已本地化 · ${v.platform}</span>`
    wrap.appendChild(bar)
    holder.appendChild(wrap)
    return
  }
  holder.innerHTML = ''
  const card = document.createElement('div')
  card.className = 'video-card'
  const platformName = { youtube: 'YouTube', nicovideo: 'NicoNico', vimeo: 'Vimeo', other: '视频' }[v.platform] || '视频'
  card.innerHTML = `
    <div class="video-card-info">
      <span class="video-card-tag">▶ ${platformName}</span>
      <span class="video-card-id">${escapeHtml(v.videoId)}</span>
    </div>
    <div class="video-card-actions">
      <button class="mini-btn primary" ${status === 'downloading' ? 'disabled' : ''}>
        ${status === 'downloading' ? `下载中 ${progress}%` : status === 'failed' ? '重试下载' : '⬇ 下载视频'}
      </button>
      <a class="mini-btn" href="${escapeHtml(v.url)}" target="_blank" rel="noreferrer">在线观看 ↗</a>
    </div>
    ${status === 'downloading' ? `<div class="progressbar" style="margin-top:8px"><div style="width:${progress}%"></div></div>` : ''}
    ${status === 'failed' && v.error ? `<div class="video-card-error">${escapeHtml(v.error)}</div>` : ''}
  `
  card.querySelector('button')?.addEventListener('click', () => onDownload(v.key))
  holder.appendChild(card)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
