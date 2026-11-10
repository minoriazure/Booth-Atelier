import { ItemFilterDropdown, type ItemFilter } from '../components/ItemFilterDropdown'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import type { ItemSummary, TagInfo } from '../../../shared/types'
import { api } from '../api'
import { useImageUrl } from '../components/useImageUrl'
import { requestDerivativePriority } from '../components/derivativePriority'
import { TagBatchDialog, TagContextMenu, TagFilterDropdown, TagManageDialog } from '../components/TagWidgets'

function ItemCard({
  item,
  onOpen,
  onMenu,
  selecting,
  selected,
  onSelect
}: {
  selecting: boolean
  selected: boolean
  onSelect: () => void
  item: ItemSummary
  onOpen: (id: number) => void
  onMenu: (itemId: number, x: number, y: number) => void
}) {
  // 本地图片优先（同步时已下载到商品文件夹），未就绪时轮询本地缓存并触发后台补下
  const [visible, setVisible] = useState(false)
  const fallback = useImageUrl(!visible || item.localThumb ? null : item.thumbnailUrl)
  const thumb = item.localThumb || fallback
  const enqueued = useRef(false)
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (visible && !item.localThumb && item.thumbnailUrl && !enqueued.current) {
      enqueued.current = true
      void api.images.enqueueItem(item.itemId).catch(() => {})
    }
  }, [visible, item.localThumb, item.thumbnailUrl, item.itemId])
  // 卡片进入可视区时请求优先生成派生图（只通知一次）
  useEffect(() => {
    const el = cardRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true)
        requestDerivativePriority(item.itemId)
        io.disconnect()
      }
    }, { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [item.itemId])
  return (
    <div
      className={`card ${selected ? 'card-selected' : ''}`}
      ref={cardRef}
      onClick={() => selecting ? onSelect() : onOpen(item.itemId)}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(item.itemId, e.clientX, e.clientY)
      }}
    >
      {selecting && <label className="tag-option card-select" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" aria-label={`选择 ${item.title}`} checked={selected} onChange={onSelect} />
      </label>}
      <span className="booth-id-badge">#{item.itemId}</span>
      <div className="card-cover">
        {thumb ? (
          <img className="thumb" src={thumb} loading="lazy" alt="" />
        ) : (
          <div className="thumb placeholder">📦</div>
        )}
        {item.tags.length > 0 && (
          <div className="card-tags">
            {item.tags.map((t) => (
              <span key={t.id} className="tag-chip" title={t.name}>
                {t.name}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="body">
        <div className="title">{item.title}</div>
        <div className="shop-row">
          <div className="shop">{item.shopName || `#${item.itemId}`}</div>
          <button
            className="card-folder"
            title="打开该商品的素材文件夹（拖入 Unity 用）"
            onClick={(e) => {
              e.stopPropagation()
              void api.library.openItemDir(item.itemId)
            }}
          >
            📂
          </button>
        </div>
        <div className="badges">
          {item.isGift && <span className="badge gift">赠送</span>}
          {item.isFree && <span className="badge free">免费</span>}
          {item.status === 'missing' && <span className="badge missing">已下架</span>}
          {item.fileUpdateAvailable > 0 && <span className="badge update">有更新 · {item.fileUpdateAvailable}</span>}
          {item.fileDownloaded > 0 && (
            <span className={`badge ${item.fileDownloaded === item.fileTotal && item.fileUpdateAvailable === 0 ? 'done' : ''}`}>
              已下载 {item.fileDownloaded}/{item.fileTotal}
            </span>
          )}
          {item.fileTotal === 0 && <span className="badge">无文件</span>}
        </div>
      </div>
    </div>
  )
}

type SortKey = 'shop' | 'id'

const SORT_STORAGE_KEY = 'booth-wall-sort'
const SCALE_STORAGE_KEY = 'booth-wall-scale'
const SCALE_MIN = 50
const SCALE_MAX = 150
const SCALE_STEP = 5

function readScale(): number {
  try {
    const v = Number(localStorage.getItem(SCALE_STORAGE_KEY))
    return Number.isFinite(v) && v >= SCALE_MIN && v <= SCALE_MAX ? v : 100
  } catch {
    return 100
  }
}

function clampScale(v: number): number {
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v / SCALE_STEP) * SCALE_STEP))
}

function readSortKey(): SortKey {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY)
    return v === 'id' ? 'id' : 'shop'
  } catch {
    return 'shop'
  }
}

// 店铺名为空的商品无论哪种排序都沉底；店铺名同名时按编号升序作为次序
function compareItems(a: ItemSummary, b: ItemSummary, key: SortKey): number {
  if (key === 'id') return b.itemId - a.itemId
  const sa = a.shopName ?? ''
  const sb = b.shopName ?? ''
  if (!sa !== !sb) return sa ? -1 : 1
  return sa.localeCompare(sb, 'zh-CN') || a.itemId - b.itemId
}

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'shop', label: '店铺名' },
  { key: 'id', label: '编号' }
]

// 滑块高亮块与其上的白色文字使用同一套位移（文字反向平移），切换时文字随高亮块一起滑过，不会在原地变色
function SortSlider({ value, onChange }: { value: SortKey; onChange: (v: SortKey) => void }) {
  return (
    <div className="sort-slider" role="radiogroup" aria-label="排序方式" data-value={value}>
      <div className="sort-track">
        {SORT_OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={value === o.key}
            onClick={() => onChange(o.key)}
          >
            {o.label}
          </button>
        ))}
        <div className="sort-thumb" aria-hidden="true">
          <div className="sort-thumb-text">
            {SORT_OPTIONS.map((o) => (
              <span key={o.key}>{o.label}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

const SORT_HINT: Record<SortKey, string> = {
  shop: '按店铺名 A→Z 排序',
  id: '按编号从大到小排序'
}

export default function LibraryWallPage({
  version,
  onOpen,
  scrollMemory
}: {
  version: number
  onOpen: (id: number) => void
  /** 离开资源库时由 App 记录的滚动位置；首次数据就绪后恢复 */
  scrollMemory: MutableRefObject<number>
}) {
  const [items, setItems] = useState<ItemSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ItemFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>(() => readSortKey())
  const [scale, setScale] = useState<number>(() => readScale())
  const [tags, setTags] = useState<TagInfo[]>([])
  // 标签筛选为多选，组内 OR（命中任一即可）；与状态筛选之间为 AND
  const [tagFilter, setTagFilter] = useState<number[]>([])
  const [untagged, setUntagged] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selectedItems, setSelectedItems] = useState<number[]>([])
  const [batchOpen, setBatchOpen] = useState(false)
  const tagMutationRef = useRef(0)
  const [tagRev, setTagRev] = useState(0)
  const [menu, setMenu] = useState<{ itemId: number; x: number; y: number } | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const restoredRef = useRef(false)

  useEffect(() => {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, sortKey)
    } catch {
      // 存储不可用时忽略，仅本次会话生效
    }
  }, [sortKey])

  useEffect(() => {
    try {
      localStorage.setItem(SCALE_STORAGE_KEY, String(scale))
    } catch {
      // 同上
    }
  }, [scale])

  // Ctrl+滚轮缩放卡片；需非 passive 才能阻止 Chromium 的整页缩放
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setScale((s) => clampScale(s + (e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [items === null])

  useEffect(() => {
    const onSearch = (e: Event): void => setQuery((e as CustomEvent<string>).detail)
    window.addEventListener('booth-search', onSearch)
    return () => window.removeEventListener('booth-search', onSearch)
  }, [])

  useEffect(() => {
    let cancelled = false
    const mutation = tagMutationRef.current
    void (async () => {
      const [list, tagList] = await Promise.all([
        query ? api.library.search(query) : api.library.list(),
        api.tags.list()
      ])
      if (cancelled || mutation !== tagMutationRef.current) return
      setItems(list)
      setTags(tagList)
      // 已被删除的标签从筛选中剔除
      const alive = new Set(tagList.map((t) => t.id))
      setTagFilter((prev) => prev.filter((id) => alive.has(id)))
    })()
    return () => {
      cancelled = true
    }
  }, [query, version, tagRev])

  const onItemTagsChange = (itemId: number, next: ItemSummary['tags']): void => {
    tagMutationRef.current++
    setItems((prev) => (prev ? prev.map((it) => (it.itemId === itemId ? { ...it, tags: next } : it)) : prev))
  }

  // 后台图片下载完成 → 增量替换该商品（不整页刷新）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const un = api.events.onImageReady(({ itemId }) => {
      if (timer) return // 300ms 合批
      timer = setTimeout(() => {
        timer = null
        void (async () => {
          const detail = await api.library.getItem(itemId).catch(() => null)
          if (!detail) return
          setItems((prev) =>
            prev
              ? prev.map((it) =>
                  it.itemId === itemId
                    ? { ...it, localThumb: detail.localThumb ?? it.localThumb, thumbnailUrl: detail.thumbnailUrl ?? it.thumbnailUrl }
                    : it
                )
              : prev
          )
        })()
      }, 300)
    })
    return () => {
      un()
      if (timer) clearTimeout(timer)
    }
  }, [])

  // 数据首次就绪后恢复离开前的滚动位置（需等列表渲染，否则加载态高度不足会被钳位）
  useLayoutEffect(() => {
    if (!items || restoredRef.current) return
    restoredRef.current = true
    const scroller = rootRef.current?.closest<HTMLElement>('.main')
    if (scroller && scrollMemory.current > 0) scroller.scrollTop = scrollMemory.current
  }, [items, scrollMemory])

  const filtered = (() => {
    const matched = (items ?? []).filter((i) => {
      if (filter === 'library' && (i.isFree || i.isGift)) return false
      if (filter === 'gift' && !i.isGift) return false
      if (filter === 'free' && !i.isFree) return false
      if (filter === 'undownloaded' && i.fileDownloaded >= i.fileTotal) return false
      if (filter === 'updates' && i.fileUpdateAvailable <= 0) return false
      if (filter === 'delisted' && i.status !== 'missing') return false
      if (untagged && i.tags.length > 0) return false
      if (tagFilter.length > 0 && !i.tags.some((t) => tagFilter.includes(t.id))) return false
      return true
    })
    // 分组各自排序，拼合顺序固定为：库商品 → 赠送 → 免费（同时是免费与赠送的商品归入免费组）
    const library = matched.filter((i) => !i.isFree && !i.isGift).sort((a, b) => compareItems(a, b, sortKey))
    const gift = matched.filter((i) => !i.isFree && i.isGift).sort((a, b) => compareItems(a, b, sortKey))
    const free = matched.filter((i) => i.isFree).sort((a, b) => compareItems(a, b, sortKey))
    return [...library, ...gift, ...free]
  })()

  if (!items) return <div className="empty">加载库…</div>

  return (
    <div ref={rootRef}>
      <div className="filter-row wall-toolbar">
        <div className="wall-toolbar-filters">
          <ItemFilterDropdown value={filter} onChange={setFilter} />
          <TagFilterDropdown
            tags={tags}
            untagged={untagged}
            onUntaggedChange={setUntagged}
            selected={tagFilter}
            onChange={setTagFilter}
            onManage={() => setManageOpen(true)}
          />
          <span className="count">
            {filtered.length} / {items.length} 个商品
          </span>
          <button type="button" className={selecting ? 'tag-filter-btn active' : ''}
            onClick={() => { setSelecting(!selecting); setSelectedItems([]) }}>
            {selecting ? '退出批量选择' : '批量标签'}
          </button>
        </div>
        <div className="wall-toolbar-display">
          <div className="scale-control" title="卡片大小（Ctrl+滚轮也可调整）">
            <span className="scale-label">大小</span>
            <input
              type="range"
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={SCALE_STEP}
              value={scale}
              onChange={(e) => setScale(Number(e.target.value))}
              aria-label="卡片大小"
            />
            <span className="scale-value">{scale}%</span>
          </div>
          <div className="sort-group" title={`${SORT_HINT[sortKey]}，顺序：库商品、赠送、免费`}>
            <SortSlider value={sortKey} onChange={setSortKey} />
          </div>
        </div>
      </div>
      {selecting && <div className="tag-batch-bar">
        <span>已选 {selectedItems.length} 个商品{selectedItems.some((id) => !filtered.some((i) => i.itemId === id)) ? '（含筛选隐藏项）' : ''}</span>
        <button type="button" onClick={() => setSelectedItems(filtered.map((i) => i.itemId))}>全选当前结果</button>
        <button type="button" disabled={!selectedItems.length} onClick={() => setSelectedItems([])}>清空选择</button>
        <button type="button" className="primary tag-batch-apply" disabled={!selectedItems.length} onClick={() => setBatchOpen(true)}>添加 / 移除标签…</button>
      </div>}
      {filtered.length === 0 ? (
        <div className="empty">没有匹配的商品{query ? `（搜索：${query}）` : ''}</div>
      ) : (
        <div className="wall" style={{ '--wall-scale': scale / 100 } as CSSProperties}>
          {filtered.map((i) => (
            <ItemCard key={i.itemId} item={i} selecting={selecting} selected={selectedItems.includes(i.itemId)}
              onSelect={() => setSelectedItems((prev) => prev.includes(i.itemId) ? prev.filter((id) => id !== i.itemId) : [...prev, i.itemId])} onOpen={onOpen} onMenu={(itemId, x, y) => setMenu({ itemId, x, y })} />
          ))}
        </div>
      )}
      {menu && items.some((i) => i.itemId === menu.itemId) && (
        <TagContextMenu
          key={menu.itemId}
          x={menu.x}
          y={menu.y}
          itemId={menu.itemId}
          itemTags={items.find((i) => i.itemId === menu.itemId)?.tags ?? []}
          tags={tags}
          onItemTagsChange={onItemTagsChange}
          onTagsChanged={() => setTagRev((r) => r + 1)}
          onManage={() => setManageOpen(true)}
          onClose={() => setMenu(null)}
        />
      )}
      {batchOpen && <TagBatchDialog itemIds={selectedItems} tags={tags} onItemTagsChange={onItemTagsChange}
        onChanged={() => setTagRev((r) => r + 1)} onClose={() => setBatchOpen(false)} />}
      {manageOpen && (
        <TagManageDialog tags={tags} onChanged={() => setTagRev((r) => r + 1)} onClose={() => setManageOpen(false)} />
      )}
    </div>
  )
}
