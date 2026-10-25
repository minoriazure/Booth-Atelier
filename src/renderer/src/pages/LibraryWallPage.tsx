import { useEffect, useRef, useState } from 'react'
import type { ItemSummary } from '../../../shared/types'
import { api } from '../api'
import { useImageUrl } from '../components/useImageUrl'
import { requestDerivativePriority } from '../components/derivativePriority'

function ItemCard({ item, onOpen }: { item: ItemSummary; onOpen: (id: number) => void }) {
  // 本地图片优先（同步时已下载到商品文件夹），未就绪时轮询本地缓存并触发后台补下
  const fallback = useImageUrl(item.localThumb ? null : item.thumbnailUrl)
  const thumb = item.localThumb || fallback
  const enqueued = useRef(false)
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!item.localThumb && item.thumbnailUrl && !enqueued.current) {
      enqueued.current = true
      void api.images.enqueueItem(item.itemId).catch(() => {})
    }
  }, [item.localThumb, item.thumbnailUrl, item.itemId])
  // 卡片进入可视区时请求优先生成派生图（只通知一次）
  useEffect(() => {
    const el = cardRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        requestDerivativePriority(item.itemId)
        io.disconnect()
      }
    })
    io.observe(el)
    return () => io.disconnect()
  }, [item.itemId])
  return (
    <div className="card" ref={cardRef} onClick={() => onOpen(item.itemId)}>
      <span className="booth-id-badge">#{item.itemId}</span>
      {thumb ? (
        <img className="thumb" src={thumb} loading="lazy" alt="" />
      ) : (
        <div className="thumb placeholder">📦</div>
      )}
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
  onOpen
}: {
  version: number
  onOpen: (id: number) => void
}) {
  const [items, setItems] = useState<ItemSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'library' | 'gift' | 'free' | 'undownloaded' | 'updates' | 'delisted'>('all')
  const [sortKey, setSortKey] = useState<SortKey>(() => readSortKey())

  useEffect(() => {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, sortKey)
    } catch {
      // 存储不可用时忽略，仅本次会话生效
    }
  }, [sortKey])

  useEffect(() => {
    const onSearch = (e: Event): void => setQuery((e as CustomEvent<string>).detail)
    window.addEventListener('booth-search', onSearch)
    return () => window.removeEventListener('booth-search', onSearch)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = query ? await api.library.search(query) : await api.library.list()
      if (!cancelled) setItems(list)
    })()
    return () => {
      cancelled = true
    }
  }, [query, version])

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

  const filtered = (() => {
    const matched = (items ?? []).filter((i) => {
      if (filter === 'library') return !i.isFree && !i.isGift
      if (filter === 'gift') return i.isGift
      if (filter === 'free') return i.isFree
      if (filter === 'undownloaded') return i.fileDownloaded < i.fileTotal
      if (filter === 'updates') return i.fileUpdateAvailable > 0
      if (filter === 'delisted') return i.status === 'missing'
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
    <div>
      <div className="filter-row">
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">全部商品</option>
          <option value="library">仅库商品</option>
          <option value="gift">仅赠送</option>
          <option value="free">仅免费</option>
          <option value="undownloaded">未下载完</option>
          <option value="updates">有文件更新</option>
          <option value="delisted">已下架</option>
        </select>
        <span className="count">
          {filtered.length} / {items.length} 个商品
        </span>
        <div className="sort-group">
          <span className="sort-hint">
            {SORT_HINT[sortKey]}，顺序：库商品、赠送、免费
          </span>
          <SortSlider value={sortKey} onChange={setSortKey} />
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="empty">没有匹配的商品{query ? `（搜索：${query}）` : ''}</div>
      ) : (
        <div className="wall">
          {filtered.map((i) => (
            <ItemCard key={i.itemId} item={i} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  )
}
