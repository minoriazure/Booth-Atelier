import { useEffect, useState } from 'react'
import type { ItemSummary } from '../../../shared/types'
import { api } from '../api'

/**
 * 全局历史浏览：按日期聚合（文件归档 + 说明快照两个独立标签）。
 */
export default function HistoryPage({ version, onOpen }: { version: number; onOpen: (id: number) => void }) {
  const [items, setItems] = useState<ItemSummary[]>([])
  const [kind, setKind] = useState<'files' | 'desc'>('files')
  const [selected, setSelected] = useState<{ itemId: number; date: string } | null>(null)
  const [files, setFiles] = useState<Array<{ filename: string; archivedPath: string; size: number | null }>>([])
  const [snapshot, setSnapshot] = useState<{ snapshotDate: string; title: string; descriptionHtml: string } | null>(null)
  // 每商品的日期列表缓存
  const [datesByItem, setDatesByItem] = useState<Record<number, string[]>>({})

  useEffect(() => {
    void api.library.list().then(setItems)
    setDatesByItem({})
    setSelected(null)
  }, [version, kind])

  useEffect(() => {
    if (!selected) return
    void (async () => {
      if (kind === 'files') {
        setFiles(await api.history.listFilesAtDate(selected.itemId, selected.date))
        setSnapshot(null)
      } else {
        setSnapshot(await api.history.readSnapshot(selected.itemId, selected.date))
        setFiles([])
      }
    })()
  }, [selected, kind])

  const loadDates = async (itemId: number): Promise<void> => {
    const dates = kind === 'files' ? await api.history.listFileDates(itemId) : await api.history.listDescriptionDates(itemId)
    setDatesByItem((m) => ({ ...m, [itemId]: dates }))
  }

  // 只显示有历史的候选：预加载全部日期（几十个商品，可接受）
  useEffect(() => {
    void (async () => {
      const map: Record<number, string[]> = {}
      for (const it of items) {
        const dates = kind === 'files' ? await api.history.listFileDates(it.itemId) : await api.history.listDescriptionDates(it.itemId)
        if (dates.length > 0) map[it.itemId] = dates
      }
      setDatesByItem(map)
    })()
  }, [items, kind])

  const withHistory = items.filter((i) => (datesByItem[i.itemId] ?? []).length > 0)

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div className="panel">
        <h3>历史浏览</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="filter-row" style={{ margin: 0 }}>
            <button className={kind === 'files' ? 'primary' : ''} onClick={() => { setKind('files'); setSelected(null) }}>
              📁 文件版本历史
            </button>
            <button className={kind === 'desc' ? 'primary' : ''} onClick={() => { setKind('desc'); setSelected(null) }}>
              📝 商品说明历史
            </button>
          </div>
          <span className="count" style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            {kind === 'files' ? '旧版本文件按归档日期保存' : '简介/宣传图按快照日期保存'}（两者相互独立）
          </span>
        </div>
      </div>

      {withHistory.length === 0 ? (
        <div className="empty">还没有任何{kind === 'files' ? '文件归档' : '说明快照'}历史</div>
      ) : (
        <div className="panel">
          <table className="file-table">
            <thead>
              <tr>
                <th>商品</th>
                <th>可查看日期</th>
              </tr>
            </thead>
            <tbody>
              {withHistory.map((it) => (
                <tr key={it.itemId}>
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
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {(datesByItem[it.itemId] ?? []).map((d) => (
                        <button
                          key={d}
                          className={selected?.itemId === it.itemId && selected.date === d ? 'primary' : ''}
                          onClick={() => setSelected({ itemId: it.itemId, date: d })}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && kind === 'files' && (
        <div className="panel">
          <h3>
            #{selected.itemId} 在 {selected.date} 归档的文件（{files.length}）
          </h3>
          {files.length === 0 ? (
            <div className="empty" style={{ padding: 16 }}>
              无文件
            </div>
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
      )}

      {selected && kind === 'desc' && snapshot && (
        <div className="panel">
          <h3>
            #{selected.itemId} 的说明快照（快照日期 {snapshot.snapshotDate}）
          </h3>
          <div className="snapshot-view">
            <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 8 }}>{snapshot.title}</div>
            <div dangerouslySetInnerHTML={{ __html: snapshot.descriptionHtml }} />
          </div>
        </div>
      )}
    </div>
  )
}
