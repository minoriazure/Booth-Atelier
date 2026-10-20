import { useEffect, useRef, useState } from 'react'
import type { ItemSummary } from '../../../shared/types'
import { api } from '../api'
import { useImageUrl } from '../components/useImageUrl'

function ItemCard({ item, onOpen }: { item: ItemSummary; onOpen: (id: number) => void }) {
  // 本地图片优先（同步时已下载到商品文件夹），未就绪时轮询本地缓存并触发后台补下
  const fallback = useImageUrl(item.localThumb ? null : item.thumbnailUrl)
  const thumb = item.localThumb || fallback
  const enqueued = useRef(false)
  useEffect(() => {
    if (!item.localThumb && item.thumbnailUrl && !enqueued.current) {
      enqueued.current = true
      void api.images.enqueueItem(item.itemId).catch(() => {})
    }
  }, [item.localThumb, item.thumbnailUrl, item.itemId])
  return (
    <div className="card" onClick={() => onOpen(item.itemId)}>
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

export default function LibraryWallPage({
  version,
  onOpen
}: {
  version: number
  onOpen: (id: number) => void
}) {
  const [items, setItems] = useState<ItemSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'gift' | 'free' | 'undownloaded' | 'updates' | 'delisted'>('all')

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

  const filtered = (items ?? []).filter((i) => {
    if (filter === 'gift') return i.isGift
    if (filter === 'free') return i.isFree
    if (filter === 'undownloaded') return i.fileDownloaded < i.fileTotal
    if (filter === 'updates') return i.fileUpdateAvailable > 0
    if (filter === 'delisted') return i.status === 'missing'
    return true
  })

  if (!items) return <div className="empty">加载库…</div>

  return (
    <div>
      <div className="filter-row">
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">全部商品</option>
          <option value="gift">仅赠送</option>
          <option value="free">仅免费</option>
          <option value="undownloaded">未下载完</option>
          <option value="updates">有文件更新</option>
          <option value="delisted">已下架</option>
        </select>
        <span className="count">
          {filtered.length} / {items.length} 个商品
        </span>
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
