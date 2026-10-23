import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { FileHistoryEntry, ItemSummary, SnapshotDetail } from '../../../shared/types'
import { api } from '../api'
import { buildBoothDescHtml } from '../components/boothDesc'
import { formatCapturedAt } from '../components/formatTime'

/** 从商品详情跳转过来时的定位请求（nonce 保证同一商品重复点击也能再次触发） */
export interface HistoryFocus {
  itemId: number
  nonce: number
}

type Kind = 'files' | 'desc'
interface Option {
  key: string
  label: string
}

/**
 * 全局历史浏览：每个商品一个时间下拉框（精确到秒），选中后在该行下方展开内容，可收起。
 * 文件历史按归档秒分组；说明历史按快照记录。
 */
export default function HistoryPage({
  version,
  onOpen,
  focus
}: {
  version: number
  onOpen: (id: number) => void
  focus: HistoryFocus | null
}) {
  const [items, setItems] = useState<ItemSummary[]>([])
  const [kind, setKind] = useState<Kind>('files')
  const [fileOpts, setFileOpts] = useState<Record<number, Option[]>>({})
  const [descOpts, setDescOpts] = useState<Record<number, Option[]>>({})
  // 选中项按 `${kind}-${itemId}` 保存，空串 = 收起
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [highlightId, setHighlightId] = useState<number | null>(null)
  const rowRefs = useRef<Record<number, HTMLTableRowElement | null>>({})
  const handledNonce = useRef(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await api.library.list()
      const fo: Record<number, Option[]> = {}
      const dO: Record<number, Option[]> = {}
      for (const it of list) {
        const groups = await api.history.listFileGroups(it.itemId)
        if (groups.length) {
          fo[it.itemId] = groups.map((g) => ({ key: g.archivedAt, label: `${formatCapturedAt(g.archivedAt)} · ${g.count} 个文件` }))
        }
        const entries = await api.history.listDescriptionEntries(it.itemId)
        if (entries.length) {
          dO[it.itemId] = entries.map((s) => ({ key: String(s.id), label: formatCapturedAt(s.capturedAt) }))
        }
      }
      if (cancelled) return
      setItems(list)
      setFileOpts(fo)
      setDescOpts(dO)
    })()
    return () => {
      cancelled = true
    }
  }, [version])

  // 详情页跳转：切到文件历史，仅高亮并滚动到该商品行（不自动展开，由用户自行选择时间）
  useEffect(() => {
    if (!focus || focus.nonce === handledNonce.current) return
    const opts = fileOpts[focus.itemId]
    if (!opts || opts.length === 0) return
    handledNonce.current = focus.nonce
    setKind('files')
    setHighlightId(focus.itemId)
    requestAnimationFrame(() => {
      rowRefs.current[focus.itemId]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [focus, fileOpts])

  useEffect(() => {
    if (highlightId == null) return
    const t = window.setTimeout(() => setHighlightId(null), 2500)
    return () => window.clearTimeout(t)
  }, [highlightId])

  const opts = kind === 'files' ? fileOpts : descOpts
  const rows = items.filter((it) => (opts[it.itemId] ?? []).length > 0)
  // 同一时间只展开一个：选中新的会收起其它的，空串表示收起
  const setSel = (key: string, value: string): void => setSelected(value ? { [key]: value } : {})
  const switchKind = (k: Kind): void => {
    setKind(k)
    setSelected({})
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div className="panel">
        <h3>历史浏览</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="filter-row" style={{ margin: 0 }}>
            <button className={kind === 'files' ? 'primary' : ''} onClick={() => switchKind('files')}>
              📁 文件版本历史
            </button>
            <button className={kind === 'desc' ? 'primary' : ''} onClick={() => switchKind('desc')}>
              📝 商品说明历史
            </button>
          </div>
          <span className="count" style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            {kind === 'files' ? '旧版本文件按归档时间（精确到秒）保存' : '简介/宣传图按每次更新的时间（精确到秒）保存'}（两者相互独立）
          </span>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">还没有任何{kind === 'files' ? '文件归档' : '说明快照'}历史</div>
      ) : (
        <div className="panel">
          <table className="file-table history-table">
            <thead>
              <tr>
                <th>商品</th>
                <th style={{ width: 320 }}>历史时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((it) => {
                const key = `${kind}-${it.itemId}`
                const cur = selected[key] ?? ''
                return (
                  <Fragment key={it.itemId}>
                    <tr
                      ref={(el) => {
                        rowRefs.current[it.itemId] = el
                      }}
                      className={highlightId === it.itemId ? 'history-row-hl' : undefined}
                    >
                      <td>
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault()
                            onOpen(it.itemId)
                          }}
                          style={{ color: 'var(--accent)' }}
                        >
                          #{it.itemId} {it.title.slice(0, 60)}
                        </a>
                      </td>
                      <td>
                        <select value={cur} onChange={(e) => setSel(key, e.target.value)}>
                          <option value="">选择时间…</option>
                          {opts[it.itemId].map((o) => (
                            <option key={o.key} value={o.key}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                    {cur && (
                      <tr className="history-expand-row">
                        <td colSpan={2}>
                          {kind === 'files' ? (
                            <FilesDetail itemId={it.itemId} archivedAt={cur} onClose={() => setSel(key, '')} />
                          ) : (
                            <DescDetail snapshotId={Number(cur)} onClose={() => setSel(key, '')} />
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** 某次文件归档（同一秒）的文件列表 */
function FilesDetail({ itemId, archivedAt, onClose }: { itemId: number; archivedAt: string; onClose: () => void }) {
  const [files, setFiles] = useState<FileHistoryEntry[] | null>(null)
  useEffect(() => {
    setFiles(null)
    void api.history.listFilesAtArchive(itemId, archivedAt).then(setFiles)
  }, [itemId, archivedAt])

  return (
    <div className="history-detail">
      <div className="history-detail-head">
        <span>{formatCapturedAt(archivedAt)} 归档的文件{files ? `（${files.length}）` : ''}</span>
        <button onClick={onClose}>收起 ▲</button>
      </div>
      {files == null ? (
        <div className="empty" style={{ padding: 12 }}>加载中…</div>
      ) : files.length === 0 ? (
        <div className="empty" style={{ padding: 12 }}>无文件</div>
      ) : (
        <table className="file-table">
          <tbody>
            {files.map((f, i) => (
              <tr key={i}>
                <td className="fname">{f.filename}</td>
                <td>{f.size != null ? `${(f.size / 1048576).toFixed(1)} MB` : '-'}</td>
                <td>
                  <button onClick={() => void api.history.revealPath(f.archivedPath)}>打开位置</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** 某次描述快照：以商品描述的同款样式渲染（图片本地化，视频为链接） */
function DescDetail({ snapshotId, onClose }: { snapshotId: number; onClose: () => void }) {
  const [snap, setSnap] = useState<SnapshotDetail | null | undefined>(undefined)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    setSnap(undefined)
  }, [snapshotId])

  useEffect(() => {
    void api.history.readSnapshot(snapshotId).then(setSnap)
  }, [snapshotId, tick])

  // 快照图片下载完成后重读，把远程图片替换为本地图片
  const itemId = snap?.itemId
  useEffect(() => {
    if (itemId == null) return
    return api.events.onImageReady((e) => {
      if (e.itemId === itemId) setTick((n) => n + 1)
    })
  }, [itemId])

  const html = useMemo(
    () => (snap ? buildBoothDescHtml(snap.descriptionHtml, { localImages: snap.localImages, videos: null }) : ''),
    [snap]
  )

  return (
    <div className="history-detail">
      <div className="history-detail-head">
        <span>{snap ? `${formatCapturedAt(snap.capturedAt)} 的说明` : '加载中…'}</span>
        <button onClick={onClose}>收起 ▲</button>
      </div>
      {snap === undefined ? (
        <div className="empty" style={{ padding: 12 }}>加载中…</div>
      ) : snap === null ? (
        <div className="empty" style={{ padding: 12 }}>快照不存在</div>
      ) : (
        <>
          <div className="history-detail-title">{snap.title}</div>
          <div className="desc desc-html snapshot-desc" dangerouslySetInnerHTML={{ __html: html }} />
        </>
      )}
    </div>
  )
}
