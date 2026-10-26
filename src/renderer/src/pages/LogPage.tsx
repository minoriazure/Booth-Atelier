import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../api'
import type { LogDayInfo, LogLevel, LogSearchHit } from '../../../shared/types'
import { DEFAULT_LOG_VIEW_LEVELS, LOG_LEVELS } from '../../../shared/types'

/** 每行固定高度（虚拟列表依赖它计算位置） */
const ROW_H = 20
/** 每个分块的行数：按块读取、按块卸载 */
const CHUNK = 200
/** 内存中最多保留的分块数（LRU），超出的远离视口的块被卸载 */
const CHUNK_CAP = 24
/** 视口上下额外渲染的行数 */
const OVERSCAN = 12

/** 每天的起始行号前缀和（前 open 天）：starts[i] = 第 i 天标题行的行号 */
function buildStarts(days: LogDayInfo[], open: number): number[] {
  const s = [0]
  for (let i = 0; i < open; i++) s.push(s[i] + 1 + days[i].lines)
  return s
}

/** 在 starts（每天的起始行号前缀和）中查找行 r 所属的天下标 */
function findDay(starts: number[], n: number, r: number): number {
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= r) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 行首的级别标记，例如 `2026-10-26 10:41:57.010 [WARN] [scope] ...` */
const LEVEL_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[(INFO|WARN|ERROR|DEBUG|MESSAGE)\]/

function levelClass(text: string): string {
  const m = LEVEL_RE.exec(text)
  return m ? ` log-lv-${m[1].toLowerCase()}` : ''
}

function chunkKey(date: string, chunk: number): string {
  return `${date}#${chunk}`
}

function highlight(text: string, q: string): ReactNode {
  if (!q) return text
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const parts: ReactNode[] = []
  let i = 0
  let idx = lower.indexOf(needle, i)
  while (idx !== -1) {
    if (idx > i) parts.push(text.slice(i, idx))
    parts.push(<mark key={idx}>{text.slice(idx, idx + needle.length)}</mark>)
    i = idx + needle.length
    idx = lower.indexOf(needle, i)
  }
  if (i < text.length) parts.push(text.slice(i))
  return parts
}

export default function LogPage() {
  const [days, setDays] = useState<LogDayInfo[]>([])
  /** 已展开（参与布局）的天数：默认只有最新一天，滚动到底才继续拼接 */
  const [openCount, setOpenCount] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  const [tick, setTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [dayMenuOpen, setDayMenuOpen] = useState(false)
  /** 当前显示的日志级别（多选，主进程按此过滤） */
  const [levels, setLevels] = useState<LogLevel[]>(DEFAULT_LOG_VIEW_LEVELS)

  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [hits, setHits] = useState<LogSearchHit[]>([])
  const [hitTruncated, setHitTruncated] = useState(false)
  const [hitIdx, setHitIdx] = useState(-1)
  const [searching, setSearching] = useState(false)
  const [curHit, setCurHit] = useState<LogSearchHit | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const cacheRef = useRef(new Map<string, string[]>())
  const inflightRef = useRef(new Set<string>())
  const pendingScrollRef = useRef<number | null>(null)
  /** 与渲染状态同步的引用，供实时刷新在回调里读取最新值 */
  const daysRef = useRef<LogDayInfo[]>([])
  const openRef = useRef(0)
  const busyRef = useRef(false)
  const againRef = useRef(false)
  /** 级别选择的同步引用；viewVerRef 每次切换级别自增，用于丢弃旧级别的在途读取结果 */
  const levelsRef = useRef<LogLevel[]>(DEFAULT_LOG_VIEW_LEVELS)
  const viewVerRef = useRef(0)

  /** 每天的起始行号前缀和：starts[i] = 第 i 天标题行的行号 */
  const starts = useMemo(() => {
    const s = [0]
    for (let i = 0; i < openCount; i++) s.push(s[i] + 1 + days[i].lines)
    return s
  }, [days, openCount])
  const totalRows = starts[openCount] ?? 0

  /**
   * 重新读取日期列表并应用。位置按「文件行」锚定：新日志只追加在文件末尾，
   * 视口顶部内容保持不动；停在最顶部时则直接看到最新一行。
   */
  const refreshLive = useCallback(async (): Promise<void> => {
    if (busyRef.current) {
      againRef.current = true
      return
    }
    busyRef.current = true
    try {
      const list = await api.log.listDays(levelsRef.current)
      const prev = daysRef.current
      const prevOpen = openRef.current
      const scrollTop = scrollRef.current?.scrollTop ?? 0
      const prevStarts = buildStarts(prev, prevOpen)

      let anchor: { date: string; fileLine: number; off: number } | null = null
      if (prevOpen > 0) {
        const r = Math.min(Math.floor(scrollTop / ROW_H), prevStarts[prevOpen] - 1)
        const d = findDay(prevStarts, prevOpen, r)
        const local = r - prevStarts[d]
        anchor = {
          date: prev[d].date,
          fileLine: local === 0 ? -1 : prev[d].lines - local,
          off: scrollTop - r * ROW_H
        }
      }

      // 行数变化的天：其行号整体后移，旧分块作废；记录增量用于平移搜索命中行号
      const prevMap = new Map(prev.map((d) => [d.date, d.lines]))
      const nextMap = new Map(list.map((d) => [d.date, d.lines]))
      const deltas = new Map<string, number>()
      for (const date of new Set([...prevMap.keys(), ...nextMap.keys()])) {
        const old = prevMap.get(date)
        const cur = nextMap.get(date)
        if (old === cur) continue
        const prefix = `${date}#`
        for (const k of cacheRef.current.keys()) if (k.startsWith(prefix)) cacheRef.current.delete(k)
        deltas.set(date, (cur ?? 0) - (old ?? 0))
      }

      let open = list.length === 0 ? 0 : Math.max(1, prevOpen)
      let scroll = 0
      if (anchor) {
        const a = anchor
        const di = list.findIndex((d) => d.date === a.date)
        if (di >= 0) {
          open = Math.max(open, di + 1)
          const st = buildStarts(list, open)
          const row = a.fileLine < 0 ? st[di] : st[di] + (list[di].lines - a.fileLine)
          scroll = row * ROW_H + a.off
        }
      }

      if (deltas.size > 0) {
        const shift = <T extends { date: string; row: number }>(h: T): T => ({
          ...h,
          row: h.row + (deltas.get(h.date) ?? 0)
        })
        setHits((hs) => hs.map(shift))
        setCurHit((c) => (c ? shift(c) : c))
      }

      daysRef.current = list
      openRef.current = open
      pendingScrollRef.current = scroll
      setDays(list)
      setOpenCount(open)
      setError(null)
      setTick((t) => t + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      busyRef.current = false
      if (againRef.current) {
        againRef.current = false
        void refreshLive()
      }
    }
  }, [])

  useEffect(() => {
    void refreshLive()
  }, [refreshLive])

  // 主进程写入日志后推送通知，页面实时刷新；卸载时取消订阅
  useEffect(() => api.log.onAppended(() => void refreshLive()), [refreshLive])

  useLayoutEffect(() => {
    daysRef.current = days
    openRef.current = openCount
  }, [days, openCount])

  // 视口高度跟随窗口变化
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const sync = (): void => setViewH(el.clientHeight)
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

  // 应用待定的滚动位置（跳转日期 / 搜索定位）；布局变化后同步执行
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pendingScrollRef.current !== null) {
      el.scrollTop = pendingScrollRef.current
      pendingScrollRef.current = null
      setScrollTop(el.scrollTop)
    }
  })

  /** 视口内需要的分块：按需读取，并把它们标记为最近使用 */
  useEffect(() => {
    if (openCount === 0 || totalRows === 0) return
    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
    const last = Math.min(totalRows - 1, Math.floor((scrollTop + viewH) / ROW_H) + OVERSCAN)
    const need = new Map<string, { date: string; chunk: number; total: number }>()
    for (let r = first; r <= last; r++) {
      const d = findDay(starts, openCount, r)
      const local = r - starts[d]
      if (local === 0) continue
      const chunk = Math.floor((local - 1) / CHUNK)
      const date = days[d].date
      need.set(chunkKey(date, chunk), { date, chunk, total: days[d].lines })
    }
    const cache = cacheRef.current
    for (const k of need.keys()) {
      const v = cache.get(k)
      if (v) {
        cache.delete(k)
        cache.set(k, v)
      }
    }
    for (const [k, v] of need) {
      if (cache.has(k) || inflightRef.current.has(k)) continue
      inflightRef.current.add(k)
      const ver = viewVerRef.current
      api.log
        .readDay(v.date, v.chunk * CHUNK, CHUNK, levelsRef.current)
        .then((res) => {
          // 级别已切换：丢弃旧结果，并触发按新级别重新读取
          if (ver !== viewVerRef.current) {
            setTick((t) => t + 1)
            return
          }
          // 读取期间日志又有新增（行号已变）则不缓存旧数据，直接重新同步
          const cur = daysRef.current.find((d) => d.date === v.date)?.lines
          if (res.total !== cur) {
            void refreshLive()
            return
          }
          cache.set(k, res.lines)
          setTick((t) => t + 1)
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => inflightRef.current.delete(k))
    }
    // 卸载远离视口的分块，控制内存
    for (const k of cache.keys()) {
      if (cache.size <= CHUNK_CAP) break
      if (!need.has(k)) cache.delete(k)
    }
  }, [scrollTop, viewH, openCount, days, starts, totalRows, tick])

  const openNextDay = useCallback(() => {
    setOpenCount((c) => Math.min(c + 1, days.length))
  }, [days.length])

  // 内容不足以滚动时（onScroll 不会触发），自动继续拼接更早的一天
  useEffect(() => {
    const el = scrollRef.current
    if (!el || openCount >= days.length) return
    if (el.scrollHeight - el.clientHeight < 80) openNextDay()
  }, [openCount, days.length, totalRows, viewH, openNextDay])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    setScrollTop(el.scrollTop)
    setViewH(el.clientHeight)
    // 滚动到底才继续拼接更早一天的日志（不一次性全量加载）
    if (openCount < days.length && el.scrollTop + el.clientHeight >= el.scrollHeight - 80) openNextDay()
  }

  /** 把某天的标题行滚到视口上方；必要时展开到该天 */
  const scrollToDay = (i: number): void => {
    let target = 0
    for (let j = 0; j < i; j++) target += 1 + days[j].lines
    pendingScrollRef.current = target * ROW_H
    setOpenCount((c) => Math.max(c, i + 1))
    setDayMenuOpen(false)
    // 同一位置（已展开）时 layout effect 不会重跑，这里直接应用
    const el = scrollRef.current
    if (el && i < openCount) {
      el.scrollTop = pendingScrollRef.current
      pendingScrollRef.current = null
      setScrollTop(el.scrollTop)
    }
  }

  const gotoHit = (idx: number, list: LogSearchHit[]): void => {
    const hit = list[idx]
    if (!hit) return
    const di = days.findIndex((d) => d.date === hit.date)
    if (di < 0) return
    let dayStart = 0
    for (let j = 0; j < di; j++) dayStart += 1 + days[j].lines
    const rowTop = (dayStart + 1 + hit.row) * ROW_H
    pendingScrollRef.current = Math.max(0, rowTop - viewH / 3)
    setOpenCount((c) => Math.max(c, di + 1))
    setCurHit(hit)
    setHitIdx(idx)
    const el = scrollRef.current
    if (el && di < openCount) {
      el.scrollTop = pendingScrollRef.current
      pendingScrollRef.current = null
      setScrollTop(el.scrollTop)
    }
  }

  const runSearch = async (): Promise<void> => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    try {
      const r = await api.log.search(q, levelsRef.current)
      setHits(r.hits)
      setHitTruncated(r.truncated)
      setActiveQuery(q)
      if (r.hits.length > 0) gotoHit(0, r.hits)
      else {
        setHitIdx(-1)
        setCurHit(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearching(false)
    }
  }

  const stepHit = (delta: number): void => {
    if (hits.length === 0) return
    const next = (hitIdx + delta + hits.length) % hits.length
    gotoHit(next, hits)
  }

  const clearSearch = (): void => {
    setQuery('')
    setActiveQuery('')
    setHits([])
    setHitIdx(-1)
    setCurHit(null)
  }

  /** 切换某个级别的显示：清空缓存与搜索，从最新一天重新加载 */
  const toggleLevel = (lv: LogLevel): void => {
    const next = LOG_LEVELS.filter((x) => (x === lv ? !levels.includes(x) : levels.includes(x)))
    levelsRef.current = next
    viewVerRef.current++
    setLevels(next)
    cacheRef.current.clear()
    inflightRef.current.clear()
    clearSearch()
    pendingScrollRef.current = null
    daysRef.current = []
    openRef.current = 0
    setDays([])
    setOpenCount(0)
    setScrollTop(0)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    void refreshLive()
  }

  // 当前视口顶部所在的日期，用于下拉框显示
  const topDay = useMemo(() => {
    if (openCount === 0) return null
    const r = Math.floor(scrollTop / ROW_H)
    return days[findDay(starts, openCount, Math.min(r, totalRows - 1))]?.date ?? null
  }, [days, openCount, scrollTop, starts, totalRows])

  // 渲染可见行
  const rows: ReactNode[] = []
  if (openCount > 0 && totalRows > 0) {
    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
    const last = Math.min(totalRows - 1, Math.floor((scrollTop + viewH) / ROW_H) + OVERSCAN)
    const cache = cacheRef.current
    for (let r = first; r <= last; r++) {
      const d = findDay(starts, openCount, r)
      const date = days[d].date
      const local = r - starts[d]
      let cls = 'log-row'
      let content: ReactNode = ''
      if (local === 0) {
        cls += ' log-day-head'
        content = `—— ${date}（共 ${days[d].lines} 行）——`
      } else {
        const L = local - 1
        const chunk = Math.floor(L / CHUNK)
        const text = cache.get(chunkKey(date, chunk))?.[L - chunk * CHUNK]
        if (text !== undefined) {
          const isCur = curHit !== null && curHit.date === date && curHit.row === L
          cls += levelClass(text)
          if (isCur) cls += ' log-row-cur'
          content = activeQuery ? highlight(text, activeQuery) : text
        }
      }
      rows.push(
        <div key={r} className={cls} style={{ top: r * ROW_H }}>
          {content}
        </div>
      )
    }
  }

  const nextDay = openCount < days.length ? days[openCount] : null

  return (
    <div className="log-page">
      <div className="log-toolbar">
        <div className="log-daypick">
          <button className="log-daybtn" onClick={() => setDayMenuOpen((v) => !v)} disabled={days.length === 0}>
            {topDay ?? '无日志'} ▾
          </button>
          {dayMenuOpen && (
            <>
              <div className="log-daymask" onClick={() => setDayMenuOpen(false)} />
              <div className="log-daymenu">
                {days.map((d, i) => (
                  <button key={d.date} className={d.date === topDay ? 'active' : ''} onClick={() => scrollToDay(i)}>
                    <span>{d.date}</span>
                    <span className="log-daycount">{d.lines} 行</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="log-levels">
          {LOG_LEVELS.map((lv) => (
            <label key={lv} className={`log-chip log-chip-${lv.toLowerCase()}${levels.includes(lv) ? ' is-on' : ''}`}>

              <input type="checkbox" checked={levels.includes(lv)} onChange={() => toggleLevel(lv)} />
              {lv}
            </label>
          ))}
        </div>
        <input
          type="search"
          className="log-search"
          placeholder="搜索全部日志…（回车）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch()
          }}
        />
        <button onClick={() => void runSearch()} disabled={searching || !query.trim()}>
          {searching ? '搜索中…' : '搜索'}
        </button>
        {activeQuery && (
          <>
            <button onClick={() => stepHit(-1)} disabled={hits.length === 0}>
              上一条
            </button>
            <button onClick={() => stepHit(1)} disabled={hits.length === 0}>
              下一条
            </button>
            <span className="log-hitcount">
              {hits.length === 0 ? '无匹配' : `${hitIdx + 1} / ${hits.length}${hitTruncated ? '（已截断）' : ''}`}
            </span>
            <button onClick={clearSearch}>清除</button>
          </>
        )}
        <button className="log-refresh" onClick={() => void refreshLive()}>
          刷新
        </button>
      </div>

      {error && <div className="log-banner log-banner-error">{error}</div>}

      <div className="log-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="log-inner" style={{ height: totalRows * ROW_H }}>
          {rows}
        </div>
        {days.length === 0 && <div className="log-empty">暂无日志文件（data\log 目录为空）</div>}
        {nextDay && (
          <div className="log-more">
            <button onClick={openNextDay}>加载更早的日志（{nextDay.date}，{nextDay.lines} 行）</button>
          </div>
        )}
      </div>
    </div>
  )
}
