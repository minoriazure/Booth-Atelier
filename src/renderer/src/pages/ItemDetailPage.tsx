import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
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

const MEDIA_PREFIX = 'image-cache://local/'

/** 绝对路径 → 本地媒体 URL（与主进程协议一致） */
function toMedia(path: string): string {
  return `${MEDIA_PREFIX}${encodeURIComponent(path)}`
}

/** 本地媒体 URL → 绝对路径；非本地媒体 URL 返回 null */
function fromMedia(url: string): string | null {
  return url.startsWith(MEDIA_PREFIX) ? decodeURIComponent(url.slice(MEDIA_PREFIX.length)) : null
}

/** 左右切换的雪佛龙图标（SVG 路径以 24×24 画布中心为对称中心，保证居中） */
function ChevronIcon({ dir }: { dir: 'prev' | 'next' }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        d={dir === 'prev' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const stopProp = (e: React.SyntheticEvent): void => e.stopPropagation()

/** 大图放大查看器：滚轮缩放（以光标为中心）+ 鼠标拖拽平移 + 双击复位 + 左右竖条切换 */
function ZoomViewer({
  items,
  index,
  onIndexChange,
  onClose,
  counter
}: {
  items: string[]
  index: number
  onIndexChange: (i: number) => void
  onClose: () => void
  /** 画廊全部幻灯片中的位置（含视频），与画廊右下角计数一致 */
  counter?: { current: number; total: number }
}) {
  const src = items[index]
  const multi = items.length > 1
  const [scale, setScale] = useState(1)
  const [tx, setTx] = useState(0)
  const [ty, setTy] = useState(0)
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null)
  const suppressClickRef = useRef(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 顶部提示条 / 底部控制条：鼠标进入上下边缘区域时显示，离开后 1 秒隐藏，避免遮挡图片
  const TOP_BAND = 82
  const BOTTOM_BAND = 96
  // 上下两条共用一个显示状态：鼠标在任一激活区域内时同时显示
  const [barsOn, setBarsOn] = useState(false)
  const hideTimer = useRef<number | undefined>(undefined)
  const updateBars = (y: number): void => {
    const inBand = y <= TOP_BAND || y >= window.innerHeight - BOTTOM_BAND
    if (inBand) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = undefined
      setBarsOn(true)
    } else if (hideTimer.current === undefined) {
      hideTimer.current = window.setTimeout(() => {
        hideTimer.current = undefined
        setBarsOn(false)
      }, 1000)
    }
  }
  useEffect(() => () => window.clearTimeout(hideTimer.current), [])

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
    updateBars(e.clientY)
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

  // 切换图片时复位缩放与平移
  useEffect(() => {
    setScale(1)
    setTx(0)
    setTy(0)
  }, [src])

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

  const go = (delta: number): void => {
    onIndexChange((index + delta + items.length) % items.length)
  }

  const revealCurrent = (): void => {
    const p = fromMedia(src)
    if (p) void api.history.revealPath(p)
  }

  return (
    <div
      className="zoom-viewer"
      ref={wrapRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={() => {
        endDrag()
        window.clearTimeout(hideTimer.current)
        hideTimer.current = undefined
        setBarsOn(false)
      }}
      onDoubleClick={reset}
      onContextMenu={(e) => {
        // 控制条与左右竖条上的右键不响应，其余位置（图片、空白）右键退出
        if ((e.target as HTMLElement).closest('.zoom-controls, .zoom-nav-zone')) return
        e.preventDefault()
        onClose()
      }}
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
      {multi && (
        <button
          type="button"
          className="zoom-nav-zone prev"
          title="上一张"
          onMouseDown={stopProp}
          onDoubleClick={stopProp}
          onContextMenu={stopProp}
          onClick={(e) => {
            stopProp(e)
            go(-1)
          }}
        >
          <ChevronIcon dir="prev" />
        </button>
      )}
      <img src={src} alt="" draggable={false} style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }} />
      {multi && (
        <button
          type="button"
          className="zoom-nav-zone next"
          title="下一张"
          onMouseDown={stopProp}
          onDoubleClick={stopProp}
          onContextMenu={stopProp}
          onClick={(e) => {
            stopProp(e)
            go(1)
          }}
        >
          <ChevronIcon dir="next" />
        </button>
      )}
      <div className={`zoom-controls${barsOn ? ' show' : ''}`} onClick={stopProp} onDoubleClick={stopProp}>
        <button onClick={revealCurrent} title="在文件夹中显示此图片">打开图片位置</button>
        <button onClick={() => setScale((v) => Math.min(12, v * 1.25))}>＋</button>
        <span className="zoom-pct">{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale((v) => Math.max(0.2, v / 1.25))}>－</button>
        <button onClick={reset}>复位</button>
        <button className="primary" onClick={onClose}>
          ✕ 关闭
        </button>
      </div>
      {counter && counter.total > 1 && (
        <div className="zoom-counter">
          {counter.current} / {counter.total}
        </div>
      )}
      <div className={`zoom-hint${barsOn ? ' show' : ''}`}>
        滚轮缩放 · 拖拽平移 · 双击复位 · {multi ? '左右边缘切换 · ' : ''}右键 / ESC 关闭
      </div>
    </div>
  )
}

/** 画廊：大图 + 左右循环切换 + 缩略图条（滚动/点击跳转），仿 BOOTH 网页端 */
function Gallery({
  images,
  videos,
  onVideoPlaceholderClick
}: {
  images: Array<{ url: string; mediaUrl: string | null; previewMediaUrl: string | null; thumbMediaUrl: string | null; removed?: boolean }>
  videos: ItemVideo[]
  onVideoPlaceholderClick: () => void
}) {
  // 画廊条目：视频在前（与 BOOTH 网页一致）；未下载视频以封面占位；图片（底层 thumb 360、清晰层 preview 720、放大用原图 orig）
  const slides = useMemo(() => {
    const imgs = images.map((g) => ({
      type: 'image' as const,
      src: g.previewMediaUrl || g.mediaUrl || g.url,
      orig: g.mediaUrl || g.previewMediaUrl || null,
      thumb: g.thumbMediaUrl,
      removed: !!g.removed
    }))
    const cover = images[0] ? images[0].thumbMediaUrl || images[0].previewMediaUrl || images[0].url : null
    const vids = videos.map((v) =>
      v.status === 'downloaded' && v.localPath
        ? { type: 'video' as const, src: toMedia(v.localPath), orig: null, thumb: v.thumbMediaUrl ?? null, key: v.key, removed: false }
        : { type: 'placeholder' as const, src: cover ?? '', orig: null, thumb: cover, key: v.key, removed: false }
    )
    return [...vids, ...imgs]
  }, [images, videos])

  const [idx, setIdx] = useState(0)
  const [zoomSlide, setZoomSlide] = useState<number | null>(null)
  // 可放大的图片幻灯片（已有原图）；查看器在其间切换，并同步画廊当前幻灯片
  const zoomable = useMemo(() => {
    const out: Array<{ slide: number; src: string }> = []
    slides.forEach((s, i) => {
      if (s.type === 'image' && s.orig) out.push({ slide: i, src: s.orig })
    })
    return out
  }, [slides])
  const zoomPos = zoomSlide == null ? -1 : zoomable.findIndex((z) => z.slide === zoomSlide)
  // 首尾回绕时临时关闭过渡，避免轨道从末张反向滑过全部幻灯片
  const [instant, setInstant] = useState(false)
  const stripRef = useRef<HTMLDivElement>(null)
  const thumbRefs = useRef<Array<HTMLDivElement | null>>([])
  const videoRefs = useRef<Array<HTMLVideoElement | null>>([])
  const imgRefs = useRef<Array<HTMLImageElement | null>>([])

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
  // 以资源 key 为重置依据（而非 slides 引用），父组件重渲染不会清空已加载状态
  const slideKey = slides.map((s) => s.src).join('\n')
  useEffect(() => {
    setBroken({})
    setLoaded({})
  }, [slideKey])

  // 已缓存图片不会再次触发 onLoad，因此每次渲染按 complete 直接标记就绪
  useEffect(() => {
    const done: number[] = []
    imgRefs.current.forEach((el, i) => {
      if (el && el.complete && el.naturalWidth > 0) done.push(i)
    })
    if (done.length === 0) return
    setLoaded((prev) => {
      if (done.every((i) => prev[i])) return prev
      const next = { ...prev }
      for (const i of done) next[i] = true
      return next
    })
  })

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
          <ChevronIcon dir="prev" />
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
                  {s.type === 'placeholder' ? (
                    <button type="button" className="gallery2-video-placeholder" onClick={onVideoPlaceholderClick} title="视频未下载，点击前往视频卡片">
                      {s.thumb && <img src={s.thumb} alt="" />}
                      <span className="gallery2-video-play">▶</span>
                    </button>
                  ) : s.type === 'video' ? (
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
                          ref={(el) => {
                            imgRefs.current[i] = el
                          }}
                          className={`zoomable gallery2-full${loaded[i] ? ' loaded' : ''}`}
                          src={s.src}
                          alt=""
                          title="点击放大查看"
                          onLoad={() => setLoaded((l) => ({ ...l, [i]: true }))}
                          onError={() => setBroken((b) => ({ ...b, [i]: true }))}
                          onClick={() => loaded[i] && s.orig && setZoomSlide(i)}
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
          <ChevronIcon dir="next" />
        </button>
        <div className="gallery2-counter">
          {Math.min(idx + 1, slides.length)} / {slides.length}
        </div>
        {slides[idx]?.removed && <div className="gallery2-removed-badge">远程已移除该图片</div>}
      </div>
      {slides.length > 1 && (
        <div className="gallery2-strip-wrap">
          <button type="button" className="gallery2-strip-nav prev" onClick={() => go(idx - 1)} title="上一张" aria-label="上一张">
            <ChevronIcon dir="prev" />
          </button>
          <div className="gallery2-strip" ref={stripRef}>
            {slides.map((s, i) => (
              <div
                key={i}
                className={`gallery2-thumb ${i === idx ? 'active' : ''}${s.removed ? ' removed' : ''}`}
                ref={(el) => {
                  thumbRefs.current[i] = el
                }}
                onClick={() => go(i)}
              >
                {/* 缩略图条：视频用同目录 -thumb.jpg（缺失为纯灰底），占位为变暗封面 */}
                {s.type === 'video' ? (
                  <>
                    {s.thumb ? <img src={s.thumb} loading="lazy" alt="" /> : <span className="thumb-fallback" />}
                    <span className="thumb-video thumb-video-dim">▶</span>
                  </>
                ) : s.type === 'placeholder' ? (
                  <>
                    {s.thumb && <img className="thumb-grey" src={s.thumb} loading="lazy" alt="" />}
                    <span className="thumb-video thumb-video-dim">▶</span>
                  </>
                ) : (
                  <img src={s.thumb || s.src} loading="lazy" alt="" />
                )}
              </div>
            ))}
          </div>
          <button type="button" className="gallery2-strip-nav next" onClick={() => go(idx + 1)} title="下一张" aria-label="下一张">
            <ChevronIcon dir="next" />
          </button>
        </div>
      )}
      {zoomPos >= 0 && (
        <ZoomViewer
          items={zoomable.map((z) => z.src)}
          index={zoomPos}
          onIndexChange={(p) => {
            const slide = zoomable[p].slide
            setZoomSlide(slide)
            go(slide)
          }}
          onClose={() => setZoomSlide(null)}
          counter={{ current: Math.min((zoomSlide ?? 0) + 1, slides.length), total: slides.length }}
        />
      )}
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

  // 打开详情即登记图片（后台补下，不阻塞）并优先生成该商品的派生图
  useEffect(() => {
    void api.images.enqueueItem(itemId).catch(() => {})
    void api.images.prioritize([itemId]).catch(() => {})
  }, [itemId])

  // 单品图片检查（本地核对）：发现缺失时提示已开始补齐
  const toastRef = useRef(toast)
  toastRef.current = toast
  useEffect(() => {
    void api.images
      .checkItem(itemId)
      .then((r) => {
        if (r.redownload > 0 || r.derivMissing > 0) {
          toastRef.current('info', `该商品缺失 ${r.derivMissing} 张派生图、${r.redownload} 张原图，已开始补齐`)
        }
      })
      .catch(() => {})
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

  // 已下载但缩略图缺失：用本地视频补生成（每个视频每次进入页面只请求一次）
  const thumbAsked = useRef(new Set<string>())
  useEffect(() => {
    if (!item) return
    for (const v of item.videos) {
      if (v.status !== 'downloaded' || v.thumbMediaUrl || thumbAsked.current.has(v.key)) continue
      thumbAsked.current.add(v.key)
      void api.videos.ensureThumb(v.key).then((url) => {
        if (!url) return
        setVideoStates((prev) => ({ ...prev, [v.key]: { ...(prev[v.key] ?? v), thumbMediaUrl: url } }))
      })
    }
  }, [item])

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

  // 稳定引用：每次渲染新建数组会使画廊的 slides 变化，进而重置加载状态
  const videoListRef = useRef<HTMLDivElement>(null)
  const scrollToVideos = useCallback(() => videoListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), [])
  const galleryForShow = useMemo(
    () =>
      item
        ? item.localGallery.length
          ? item.localGallery
          : (item.galleryUrls || []).map((u) => ({ url: u, mediaUrl: null, previewMediaUrl: null, thumbMediaUrl: null }))
        : [],
    [item]
  )
  const videos = useMemo(
    () => (item ? item.videos.map((v) => ({ ...v, ...(videoStates[v.key] || {}) })) : []),
    [item, videoStates]
  )

  if (!item) return <div className="empty">加载商品…</div>

  // 描述链接：单击不跳转（避免误触离开应用），双击才交给系统浏览器打开；视频卡片内的链接不受影响
  const descLinkOf = (target: EventTarget): HTMLAnchorElement | null => {
    const a = (target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
    if (!a || a.closest('.video-slot')) return null
    return a
  }
  const onDescClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (descLinkOf(e.target)) e.preventDefault()
  }
  const onDescDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const a = descLinkOf(e.target)
    if (!a) return
    e.preventDefault()
    void api.shell.openExternal(a.href).catch(() => {})
  }


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
          <Gallery images={galleryForShow} videos={videos} onVideoPlaceholderClick={scrollToVideos} />

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
            onClick={onDescClick}
            onDoubleClick={onDescDoubleClick}
            // 处理后的描述 HTML（图片已指向本地；iframe 已替换为占位）
            dangerouslySetInnerHTML={{ __html: processedDesc }}
          />

          {/* 描述里未被占位捕获的视频（保险：全部列出一次） */}
          {videos.length > 0 && (
            <div className="section-title">商品视频（{videos.length}）</div>
          )}
          <div className="video-list" ref={videoListRef}>
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
