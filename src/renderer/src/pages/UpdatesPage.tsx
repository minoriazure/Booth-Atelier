import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { DownloadStats, FileListRow } from '../../../shared/types'
import { api } from '../api'

type ToastFn = (level: 'info' | 'warn' | 'error', message: string) => void

function formatBytes(n: number | null | undefined): string {
  if (n == null) return '-'
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`
  return `${(n / 1073741824).toFixed(2)} GB`
}

/** 运行时视图状态（DB 状态 + 队列/活动合并后的 UI 态） */
type ViewStatus = 'downloading' | 'queued' | 'failed' | 'update' | 'remote' | 'downloaded' | 'missing'

function viewStatusOf(r: FileListRow): ViewStatus {
  if (r.active) return 'downloading'
  if (r.inQueue) return 'queued'
  if (r.failed && r.status !== 'downloaded') return 'failed'
  if (r.status === 'missing') return 'missing'
  if (r.status === 'downloaded') return 'downloaded'
  if (r.status === 'update_available') return 'update'
  return 'remote'
}

/** 是否属于「待下载」桶（remote/update，不含排队/失败/已完成/失效） */
function isPendingBucket(vs: ViewStatus): boolean {
  return vs === 'remote' || vs === 'update'
}

const STATUS_META: Record<ViewStatus, { label: string; cls: string }> = {
  downloading: { label: '下载中', cls: 'update' },
  queued: { label: '排队中', cls: 'queued' },
  failed: { label: '失败', cls: 'missing' },
  update: { label: '待下载·更新', cls: 'pending-update' },
  remote: { label: '待下载', cls: 'pending' },
  downloaded: { label: '已完成', cls: 'done' },
  missing: { label: '已失效', cls: 'missing' }
}

const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待下载' },
  { key: 'queued', label: '排队中' },
  { key: 'active', label: '下载中' },
  { key: 'failed', label: '失败' },
  { key: 'downloaded', label: '已完成' }
]

/**
 * 表格列定义（资源管理器式拖拽调宽）：
 * - pct = 默认宽度占表格容器宽度的百分比（合计 100，全部默认时正好填满、无横向滚动条）
 * - min = 最小像素宽度（状态列需容纳「待下载·更新」不换行）
 * - 用户拖过的宽度存 localStorage，双击分隔线恢复默认
 */
const COLS: Array<{ key: string; label: string; cls: string; pct: number; min: number }> = [
  { key: 'item', label: '商品', cls: 'dl-th-item', pct: 28, min: 120 },
  { key: 'file', label: '文件', cls: 'dl-th-file', pct: 28, min: 160 },
  { key: 'size', label: '大小', cls: 'dl-th-size', pct: 8, min: 64 },
  { key: 'status', label: '状态', cls: 'dl-th-status', pct: 10, min: 100 },
  { key: 'progress', label: '进度', cls: 'dl-th-progress', pct: 12, min: 140 },
  { key: 'action', label: '操作', cls: 'dl-th-action', pct: 14, min: 110 }
]
/* v2：百分比默认值上线后换新键，避免旧版保存的像素宽度覆盖新默认 */
const LS_COL_KEY = 'booth-dl-colwidths-v2'
type ColWidths = Record<string, number>

function loadColWidths(): ColWidths {
  try {
    const raw = localStorage.getItem(LS_COL_KEY)
    if (raw) return JSON.parse(raw) as ColWidths
  } catch {
    /* ignore */
  }
  return {}
}

/** 单行进度条（下载中显示字节，排队/失败等无进度） */
function RowProgress({ id, progressMap, status }: { id: number; progressMap: Map<number, { done: number; total: number }>; status: ViewStatus }) {
  const p = progressMap.get(id)
  if (status === 'downloading' && p && p.total > 0) {
    const pct = Math.min(100, (p.done / p.total) * 100)
    return (
      <div className="dl-row-progress">
        <div className="progressbar">
          <div style={{ width: `${pct}%` }} />
        </div>
        <span className="dl-row-pct">{pct.toFixed(1)}%</span>
        <span className="dl-row-bytes">
          {formatBytes(p.done)} / {formatBytes(p.total)}
        </span>
      </div>
    )
  }
  if (status === 'downloading') {
    return (
      <div className="dl-row-progress">
        <div className="progressbar indeterminate">
          <div />
        </div>
        <span className="dl-row-pct">…</span>
      </div>
    )
  }
  return null
}

export default function UpdatesPage({
  version,
  toast,
  onRunCheck
}: {
  version: number
  toast: ToastFn
  onRunCheck: () => void
}) {
  const [rows, setRows] = useState<FileListRow[]>([])
  const [stats, setStats] = useState<DownloadStats>({ queued: 0, active: 0, paused: false, userPaused: false })
  const [progressMap, setProgressMap] = useState<Map<number, { done: number; total: number }>>(new Map())
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const lastLoadRef = useRef(0)

  // ── 列宽拖拽（Windows 资源管理器语义） ──
  // 关键：每一列都是显式像素宽（无 auto 吸收），拖动分界线 = 只改分界线左侧那一列的宽度，
  // 左边缘固定、右边缘跟随鼠标，其余列（尤其右侧）整体刚性平移，总宽变化用横向滚动条承接。
  const wrapRef = useRef<HTMLDivElement>(null)
  const [colWidths, setColWidths] = useState<ColWidths>(() => loadColWidths())
  /** 表格容器可用宽度（不含边框与滚动条），默认列宽按它的百分比计算 */
  const [winWidth, setWinWidth] = useState(0)
  const [resizing, setResizing] = useState(false)
  const dragRef = useRef<{ key: string; startX: number; startW: number } | null>(null)
  const widthsRef = useRef(colWidths)
  widthsRef.current = colWidths

  const widthOf = (key: string): number => {
    const saved = colWidths[key]
    if (saved != null) return saved
    const col = COLS.find((c) => c.key === key)
    if (!col) return 100
    return Math.max(col.min, Math.round((winWidth * col.pct) / 100))
  }

  useLayoutEffect(() => {
    const calc = (): void => {
      const el = wrapRef.current
      if (el) setWinWidth(el.clientWidth)
    }
    calc()
    window.addEventListener('resize', calc)
    return () => window.removeEventListener('resize', calc)
  }, [])

  const saveColWidths = (w: ColWidths): void => {
    try {
      localStorage.setItem(LS_COL_KEY, JSON.stringify(w))
    } catch {
      /* ignore */
    }
  }

  const startResize = (key: string, e: ReactMouseEvent): void => {
    const th = (e.target as HTMLElement).closest('th')
    if (!th) return
    dragRef.current = { key, startX: e.clientX, startW: th.getBoundingClientRect().width }
    setResizing(true)
    e.preventDefault()
  }

  const resetCol = (key: string): void => {
    setColWidths((prev) => {
      const next = { ...prev }
      delete next[key]
      saveColWidths(next)
      return next
    })
  }

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      const min = COLS.find((c) => c.key === d.key)?.min ?? 64
      const w = Math.max(min, Math.round(d.startW + (e.clientX - d.startX)))
      setColWidths((prev) => (prev[d.key] === w ? prev : { ...prev, [d.key]: w }))
    }
    const onUp = (): void => {
      dragRef.current = null
      setResizing(false)
      saveColWidths(widthsRef.current)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resizing])

  const load = useCallback(async () => {
    lastLoadRef.current = Date.now()
    const [list, st] = await Promise.all([api.downloads.list(), api.downloads.stats()])
    setRows(list)
    setStats(st)
  }, [])

  useEffect(() => {
    void load()
  }, [load, version])

  // 队列/状态变化 → 节流刷新行状态（避免高频重载）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const throttled = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        void load()
      }, 400)
    }
    const unQueue = api.events.onQueueChanged((st) => {
      setStats(st)
      throttled()
    })
    const unDone = api.events.onDownloadDone((e) => {
      setProgressMap((m) => {
        const n = new Map(m)
        n.delete(e.downloadableId)
        return n
      })
      throttled()
    })
    const unErr = api.events.onDownloadError((e) => {
      setProgressMap((m) => {
        const n = new Map(m)
        n.delete(e.downloadableId)
        return n
      })
      throttled()
    })
    // 下载进度：仅行内更新，不整表刷新
    const unProg = api.events.onDownloadProgress((e) => {
      setProgressMap((m) => {
        const n = new Map(m)
        n.set(e.downloadableId, { done: e.bytesDone, total: e.bytesTotal })
        return n
      })
    })
    return () => {
      if (timer) clearTimeout(timer)
      unQueue()
      unDone()
      unErr()
      unProg()
    }
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      const vs = viewStatusOf(r)
      if (filter === 'pending' && !isPendingBucket(vs)) return false
      if (filter === 'queued' && vs !== 'queued') return false
      if (filter === 'active' && vs !== 'downloading') return false
      if (filter === 'failed' && vs !== 'failed') return false
      if (filter === 'downloaded' && vs !== 'downloaded') return false
      if (q && !r.filename.toLowerCase().includes(q) && !r.itemTitle.toLowerCase().includes(q) && !String(r.itemId).includes(q)) {
        return false
      }
      return true
    })
  }, [rows, filter, query])

  const counts = useMemo(() => {
    const c = { all: rows.length, pending: 0, queued: 0, active: 0, failed: 0, downloaded: 0 }
    for (const r of rows) {
      const vs = viewStatusOf(r)
      if (isPendingBucket(vs)) c.pending++
      if (vs === 'queued') c.queued++
      if (vs === 'downloading') c.active++
      if (vs === 'failed') c.failed++
      if (vs === 'downloaded') c.downloaded++
    }
    return c
  }, [rows])

  const doPauseToggle = async (): Promise<void> => {
    setBusy(true)
    try {
      const st = await api.downloads.pauseAll()
      setStats(st)
      toast('info', '已暂停全部下载（任务保留，点「开始下载」恢复）')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const doRetryFailed = async (): Promise<void> => {
    setBusy(true)
    try {
      const n = await api.downloads.retryFailed()
      toast('info', n > 0 ? `已重新加入队列：${n} 个失败文件` : '没有失败的文件')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const rowAction = async (r: FileListRow, vs: ViewStatus): Promise<void> => {
    if (vs === 'downloading' || vs === 'queued') {
      await api.downloads.cancel(r.downloadableId)
    } else if (vs === 'failed') {
      await api.downloads.enqueue([r.downloadableId], 'manual')
      toast('info', `已重新加入队列：${r.filename}`)
    } else if (vs === 'downloaded') {
      await api.downloads.enqueue([r.downloadableId], 'manual')
      toast('info', `已重新下载：${r.filename}`)
    } else if (vs === 'remote' || vs === 'update') {
      await api.downloads.enqueue([r.downloadableId], vs === 'update' ? 'update' : 'manual')
    }
    await load()
  }

  /** 立即下载：无视并发与队列顺序，直接进入下载中 */
  const doDownloadNow = async (r: FileListRow): Promise<void> => {
    const res = await api.downloads.downloadNow(r.downloadableId)
    if (res === 'started') toast('info', `立即下载：${r.filename}`)
    else if (res === 'active') toast('info', '该文件已在下载中')
    else if (res === 'skipped') toast('info', `已是最新：${r.filename}`) // manual 实际不可达，保类型完整
    else toast('error', '无法开始下载（链接不存在）')
    await load()
  }

  return (
    <div className="dl-page">
      <div className="panel">
        <div className="dl-toolbar">
          <button onClick={onRunCheck}>🔍 检查全局更新</button>
          <button
            className="primary"
            disabled={busy || (counts.pending === 0 && stats.queued === 0 && !stats.userPaused && !stats.paused)}
            onClick={async () => {
              const st = await api.downloads.startAll('bulk')
              toast(
                'info',
                st.queued + st.active > 0
                  ? `已开始：队列共 ${st.queued + st.active} 项（按顺序自动下载）`
                  : '没有待下载的文件（全部已下载或已在队列中）'
              )
              await load()
            }}
            title="把所有待下载文件加入队列并开始按顺序下载（已完成/失败不受影响；从暂停恢复也用它）"
          >
            ▶ 开始全部{counts.pending > 0 ? `（${counts.pending}）` : ''}
          </button>
          <button disabled={busy || (stats.active === 0 && stats.queued === 0)} onClick={() => void doPauseToggle()} title="暂停队列（排队保留，恢复后续传）">
            ⏸ 暂停
          </button>
          <button disabled={busy || counts.failed === 0} onClick={() => void doRetryFailed()} title="把所有失败的文件重新加入队列">
            ↻ 重试失败（{counts.failed}）
          </button>
          <div className="spacer" />
          <input
            type="search"
            className="dl-search"
            placeholder="搜索文件名 / 商品名 / 编号…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="dl-stats">
          共 {rows.length} 个文件 · 待下载 {counts.pending} · 排队中 {counts.queued} · 下载中 {counts.active} · 失败 {counts.failed} · 已完成 {counts.downloaded}
          {stats.userPaused && <span className="badge update">已暂停（可点开始恢复）</span>}
          {stats.paused && <span className="badge missing">认证暂停（检查通过后自动恢复）</span>}
        </div>
        <div className="dl-filters">
          {FILTERS.map((f) => (
            <button key={f.key} className={`dl-filter ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)}>
              {f.label}
              <span className="dl-filter-count">{counts[f.key as keyof typeof counts]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="dl-table-wrap" ref={wrapRef}>
        <table
          className={`dl-table ${resizing ? 'resizing' : ''}`}
          style={{ width: COLS.reduce((s, c) => s + widthOf(c.key), 0) }}
        >
          <colgroup>
            {COLS.map((c) => (
              <col key={c.key} style={{ width: widthOf(c.key) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} className={c.cls} style={{ width: widthOf(c.key) }}>
                  {c.label}
                  <div
                    className={`col-resize ${resizing && dragRef.current?.key === c.key ? 'active' : ''}`}
                    onMouseDown={(e) => startResize(c.key, e)}
                    onDoubleClick={() => resetCol(c.key)}
                    title="拖动调整列宽（左侧列固定只动右缘，右侧整体平移）；双击恢复默认"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const vs = viewStatusOf(r)
              const meta = STATUS_META[vs]
              return (
                <tr key={r.downloadableId} className={`dl-row dl-row-${vs}`}>
                  <td className="dl-cell-item" title={`#${r.itemId} ${r.itemTitle}`}>
                    <span className="dl-item-id">#{r.itemId}</span>
                    <span className="dl-item-name">{r.itemTitle}</span>
                  </td>
                  <td className="dl-cell-file fname" title={r.filename}>
                    {r.filename}
                  </td>
                  <td className="dl-cell-size">{formatBytes(r.localSize ?? r.lastSize)}</td>
                  <td className="dl-cell-status">
                    <span className={`badge ${meta.cls}`} title={vs === 'failed' ? String(r.lastError ?? '') : ''}>
                      {meta.label}
                    </span>
                  </td>
                  <td className="dl-cell-progress">
                    <RowProgress id={r.downloadableId} progressMap={progressMap} status={vs} />
                  </td>
                  <td className="dl-cell-action">
                    <div className="actions-inner">
                      {vs === 'queued' && (
                        <button
                          className="mini-btn"
                          onClick={() => void doDownloadNow(r)}
                          title="跳过队列与并发限制，立即开始下载"
                        >
                          立即下载
                        </button>
                      )}
                      {vs === 'downloading' || vs === 'queued' ? (
                        <button className="mini-btn" onClick={() => void rowAction(r, vs)}>
                          取消
                        </button>
                      ) : vs === 'missing' ? (
                        <span className="dl-na">—</span>
                      ) : (
                        <button className="mini-btn" onClick={() => void rowAction(r, vs)}>
                          {vs === 'failed' ? '↻ 重试' : vs === 'downloaded' ? '重新下载' : vs === 'update' ? '下载更新' : '下载'}
                        </button>
                      )}
                      {r.localPath && (
                        <button className="mini-btn" onClick={() => void api.history.revealPath(r.localPath!)} title={r.localPath}>
                          位置
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <div className="empty" style={{ padding: 30 }}>
                    没有匹配的文件
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
