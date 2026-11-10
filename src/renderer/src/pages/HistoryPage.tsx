import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { FileHistoryEntry, ItemSummary, SnapshotDetail, HistoryDeleteTarget, HistoryDeletePreview } from '../../../shared/types'
import { api } from '../api'
import { buildBoothDescHtml } from '../components/boothDesc'
import { formatCapturedAt } from '../components/formatTime'

/** 从商品详情跳转过来时的定位请求（nonce 保证同一商品重复点击也能再次触发） */
export interface HistoryFocus {
  itemId: number
  nonce: number
}

const formatBytes = (bytes: number): string => bytes < 1024 ? `${bytes} B`
  : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB`
    : bytes < 1073741824 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1073741824).toFixed(2)} GB`

type Kind = 'files' | 'desc'
interface Option {
  key: string
  label: string
  count?: number
}

/**
 * 全局历史浏览：每个商品一个时间下拉框（精确到秒），选中后在该行下方展开内容，可收起。
 * 文件历史按归档秒分组；说明历史按快照记录。
 */
export default function HistoryPage({
  version,
  onOpen,
  focus,
  toast
}: {
  version: number
  onOpen: (id: number) => void
  focus: HistoryFocus | null
  toast: (level: 'info' | 'warn' | 'error', message: string) => void
}) {
  const [items, setItems] = useState<ItemSummary[]>([])
  const [kind, setKind] = useState<Kind>('files')
  const [fileOpts, setFileOpts] = useState<Record<number, Option[]>>({})
  const [descOpts, setDescOpts] = useState<Record<number, Option[]>>({})
  // 选中项按 `${kind}-${itemId}` 保存，空串 = 收起
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [reload, setReload] = useState(0)
  const [batchMode, setBatchMode] = useState(false)
  const [checked, setChecked] = useState<Record<number, string[]>>({})
  const [pending, setPending] = useState<HistoryDeleteTarget[] | null>(null)
  const [preview, setPreview] = useState<{ targets: HistoryDeleteTarget[]; value: HistoryDeletePreview | null; error: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [deleteProgress, setDeleteProgress] = useState({ current: 0, total: 0 })
  useEffect(() => api.history.onDeleteProgress(setDeleteProgress), [])
  const [message, setMessage] = useState('')
  const [highlightId, setHighlightId] = useState<number | null>(null)
  const rowRefs = useRef<Record<number, HTMLTableRowElement | null>>({})
  const handledNonce = useRef(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      const { items: list, files, descriptions } = await api.history.index()
      const fo: Record<number, Option[]> = {}
      const dO: Record<number, Option[]> = {}
      for (const g of files) (fo[g.itemId] ??= []).push({ key: g.archivedAt, count: g.count, label: `${formatCapturedAt(g.archivedAt)} · ${g.count} 个文件` })
      for (const s of descriptions) (dO[s.itemId] ??= []).push({ key: String(s.id), label: formatCapturedAt(s.capturedAt) })
      if (cancelled) return
      setItems(list)
      setFileOpts(fo)
      setDescOpts(dO)
    })().catch((e) => {
      if (!cancelled) setMessage(`加载历史失败：${e instanceof Error ? e.message : String(e)}`)
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => {
      cancelled = true
    }
  }, [version, reload])

  useEffect(() => {
    if (!pending) return
    let cancelled = false
    void api.history.previewDelete(kind, pending).then((value) => {
      if (!cancelled) setPreview({ targets: pending, value, error: '' })
    }).catch((e) => {
      if (!cancelled) setPreview({ targets: pending, value: null, error: `无法计算删除范围：${e instanceof Error ? e.message : String(e)}` })
    })
    return () => { cancelled = true }
  }, [kind, pending])

  // 详情页跳转：切到文件历史，仅高亮并滚动到该商品行（不自动展开，由用户自行选择时间）
  useEffect(() => {
    if (!focus || focus.nonce === handledNonce.current) return
    const opts = fileOpts[focus.itemId]
    if (!opts || opts.length === 0) return
    handledNonce.current = focus.nonce
    setKind('files')
    setBatchMode(false)
    setChecked({})
    setSelected({})
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
    setBatchMode(false)
    setSelected({})
    setChecked({})
    setMessage('')
  }

  const targets = rows.flatMap((it) => (opts[it.itemId] ?? [])
    .filter((o) => checked[it.itemId]?.includes(o.key))
    .map((o) => ({ itemId: it.itemId, key: o.key })))
  const allChecked = rows.length > 0 && rows.every((it) =>
    opts[it.itemId].every((o) => checked[it.itemId]?.includes(o.key)))
  const toggleItem = (itemId: number, value: boolean): void => {
    setChecked((prev) => ({ ...prev, [itemId]: value ? opts[itemId].map((o) => o.key) : [] }))
  }
  const confirmDelete = async (): Promise<void> => {
    if (!pending || busy || loading || preview?.targets !== pending || !preview.value) return
    setBusy(true)
    setDeleteProgress({ current: 0, total: pending.length })
    try {
      const result = await api.history.delete(kind, pending)
      const summary = `已删除 ${result.deletedRecords} 条记录、${result.deletedFiles} 个文件，释放 ${formatBytes(result.releasedBytes)}`
      if (result.errors.length) {
        const partial = result.deletedRecords > 0 || result.deletedFiles > 0
        toast(partial ? 'warn' : 'error', partial
          ? `${summary}；${result.failedTargets.length} 个历史时间有失败项，已保留勾选，可重试。`
          : `历史删除失败：${result.errors[0]}`)
      } else {
        toast('info', result.deletedRecords > 0 ? `历史删除成功：${summary}` : '所选历史已不存在，无需删除')
      }
      setMessage(`已删除 ${result.deletedRecords} 条记录、${result.deletedFiles} 个磁盘文件，释放 ${formatBytes(result.releasedBytes)}；完整删除 ${result.deleted} 个历史时间。${result.errors.length ? `\n${result.failedTargets.length} 个历史时间仍有失败项，已保留勾选，可直接重试：\n${result.errors.join('\n')}` : ''}`)
      setChecked(Object.fromEntries(result.failedTargets.map((t) => [t.itemId, result.failedTargets.filter((f) => f.itemId === t.itemId).map((f) => f.key)])))
      if (result.failedTargets.length) setBatchMode(true)
      setLoading(true)
      setSelected({})
      setReload((n) => n + 1)
      setPending(null)
    } catch (e) {
      const errorMessage = `删除失败：${e instanceof Error ? e.message : String(e)}，请重试。`
      setMessage(errorMessage)
      toast('error', errorMessage)
      setChecked(Object.fromEntries(pending.map((t) => [t.itemId, pending.filter((f) => f.itemId === t.itemId).map((f) => f.key)])))
      setBatchMode(true)
      setLoading(true)
      setReload((n) => n + 1)
      setPending(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="history-page" style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div className="panel">
        <h3>历史浏览</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="filter-row" style={{ margin: 0 }}>
            <button disabled={busy} className={kind === 'files' ? 'primary' : ''} onClick={() => switchKind('files')}>
              📁 文件版本历史
            </button>
            <button disabled={busy} className={kind === 'desc' ? 'primary' : ''} onClick={() => switchKind('desc')}>
              📝 商品说明历史
            </button>
          </div>
          <span className="count" style={{ color: 'var(--text-dim)', fontSize: 13 }}>
            {kind === 'files' ? '旧版本文件按归档时间（精确到秒）保存' : '简介/宣传图按每次更新的时间（精确到秒）保存'}（两者相互独立）
          </span>
          {rows.length > 0 && <button disabled={busy} style={{ marginLeft: 'auto' }}
            aria-pressed={batchMode} onClick={() => {
              setBatchMode((value) => !value)
              setChecked({})
            }}>{batchMode ? '退出批量删除' : '批量删除…'}</button>}
        </div>
      </div>

      {message && <div className="panel" role="status" style={{ whiteSpace: 'pre-wrap' }}>{message}</div>}
      {batchMode && rows.length > 0 && <div className="panel" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="history-check-label"><input type="checkbox" disabled={busy} checked={allChecked} ref={(el) => { if (el) el.indeterminate = targets.length > 0 && !allChecked }} onChange={(e) => {
          setChecked(e.target.checked ? Object.fromEntries(rows.map((it) => [it.itemId, opts[it.itemId].map((o) => o.key)])) : {})
        }} /> 全选全部历史</label>
        <span>已选 {new Set(targets.map((t) => t.itemId)).size} 个商品 / {targets.length} 个时间</span>
        <button className="danger" disabled={busy || loading || !targets.length} onClick={() => setPending(targets)}>删除所选历史</button>
        <button disabled={busy || loading || !targets.length} onClick={() => setChecked({})}>清空选择</button>
      </div>}

      {loading && <div className="empty" role="status">正在更新历史列表…</div>}
      {!loading && rows.length === 0 ? (
        <div className="empty">还没有任何{kind === 'files' ? '文件归档' : '说明快照'}历史</div>
      ) : (
        <div className="panel">
          <table className="file-table history-table">
            <thead>
              <tr>
                {batchMode && <th style={{ width: 70 }}>选择</th>}
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
                      {batchMode && <td><input type="checkbox" aria-label={`选择 #${it.itemId} 的全部历史`} disabled={busy}
                        checked={opts[it.itemId].every((o) => checked[it.itemId]?.includes(o.key))}
                        ref={(el) => { if (el) el.indeterminate = !!checked[it.itemId]?.length && !opts[it.itemId].every((o) => checked[it.itemId]?.includes(o.key)) }}
                        onChange={(e) => toggleItem(it.itemId, e.target.checked)} /></td>}
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
                        <select className="history-time-select" aria-label={`选择 #${it.itemId} 的历史时间`} disabled={busy} value={cur} onChange={(e) => setSel(key, e.target.value)}>
                          <option value="">选择时间…</option>
                          {opts[it.itemId].map((o) => (
                            <option key={o.key} value={o.key}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        {batchMode && <details style={{ marginTop: 8 }}>
                          <summary>勾选多个历史时间（{checked[it.itemId]?.length ?? 0}/{opts[it.itemId].length}）</summary>
                          <div style={{ maxHeight: 220, overflowY: 'auto', paddingTop: 6 }}>
                            {opts[it.itemId].map((o) => <label key={o.key} className="history-check-label history-time-check">
                              <input type="checkbox" disabled={busy} checked={checked[it.itemId]?.includes(o.key) ?? false}
                                onChange={(e) => setChecked((prev) => ({ ...prev, [it.itemId]: e.target.checked
                                  ? [...(prev[it.itemId] ?? []), o.key] : (prev[it.itemId] ?? []).filter((k) => k !== o.key) }))} /> {o.label}
                            </label>)}
                          </div>
                        </details>}
                      </td>
                    </tr>
                    {cur && (
                      <tr className="history-expand-row">
                        <td colSpan={batchMode ? 3 : 2}>
                          {kind === 'files' ? (
                            <FilesDetail key={`files-${it.itemId}-${cur}`} itemId={it.itemId} archivedAt={cur} busy={busy || loading}
                              onDelete={() => setPending([{ itemId: it.itemId, key: cur }])} onClose={() => setSel(key, '')} />
                          ) : (
                            <DescDetail key={`desc-${it.itemId}-${cur}`} snapshotId={Number(cur)} busy={busy || loading}
                              onDelete={() => setPending([{ itemId: it.itemId, key: cur }])} onClose={() => setSel(key, '')} />
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
      {pending && <div className="modal-mask">
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="history-delete-title">
          <h3 id="history-delete-title">确认删除{kind === 'files' ? '文件版本历史' : '商品说明历史'}</h3>
          <p>将删除 {new Set(pending.map((t) => t.itemId)).size} 个商品的 {pending.length} 个历史时间
            {kind === 'files' ? `，共 ${pending.reduce((n, t) => n + (fileOpts[t.itemId]?.find((o) => o.key === t.key)?.count ?? 0), 0)} 个归档文件` : ''}。</p>
          {kind === 'files' ? <p style={{ color: 'var(--error)', fontWeight: 600 }}>
            注意：将从磁盘上永久删除这些旧版本文件，不会移入回收站，无法撤销。请确认已不再需要这些文件。
          </p> : <p>将永久删除这些说明版本的数据库记录及磁盘备份文件，不进入回收站，无法撤销。</p>}
          {preview?.targets !== pending ? <p role="status">正在计算文件数量与预计释放空间…</p>
            : preview.error ? <p role="alert" style={{ color: 'var(--error)' }}>{preview.error}</p>
            : preview.value && <>
              <p>磁盘文件：{preview.value.fileCount} 个，预计释放 {formatBytes(preview.value.totalBytes)}。
                {preview.value.missingFiles > 0 && `另有 ${preview.value.missingFiles} 条记录对应的磁盘文件已缺失，将一并清理记录。`}</p>
              {preview.value.errors.length > 0 && <p style={{ color: 'var(--error)', whiteSpace: 'pre-wrap' }}>
                部分文件无法读取，将逐项尝试删除并保留失败项：{'\n'}{preview.value.errors.join('\n')}
              </p>}
            </>}
          <p>当前下载文件和商品当前说明不受影响。</p>
          <ul style={{ maxHeight: 220, overflowY: 'auto' }}>{pending.slice(0, 100).map((t) => <li key={`${t.itemId}-${t.key}`}>
            #{t.itemId} {items.find((it) => it.itemId === t.itemId)?.title} · {opts[t.itemId]?.find((o) => o.key === t.key)?.label}
          </li>)}</ul>
          {pending.length > 100 && <p>仅列出前100项，另有 {pending.length - 100} 项。</p>}
          {busy && <p role="status">正在删除 {deleteProgress.current} / {deleteProgress.total} <button onClick={() => void api.history.cancelDelete()}>停止后续删除</button></p>}
          <div className="buttons">
            <button autoFocus disabled={busy} onClick={() => setPending(null)}>取消</button>
            <button className="danger" disabled={busy || loading || preview?.targets !== pending || !preview.value} onClick={() => void confirmDelete()}>
              {busy ? '正在删除…' : '永久删除'}
            </button>
          </div>
        </div>
      </div>}
    </div>
  )
}

interface DetailActions {
  busy: boolean
  onDelete: () => void
  onClose: () => void
}

/** 某次文件归档（同一秒）的文件列表 */
function FilesDetail({ itemId, archivedAt, busy, onDelete, onClose }: { itemId: number; archivedAt: string } & DetailActions) {
  const [files, setFiles] = useState<FileHistoryEntry[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    setFiles(null)
    setError('')
    void api.history.listFilesAtArchive(itemId, archivedAt).then((value) => {
      if (!cancelled) setFiles(value)
    }).catch((e) => { if (!cancelled) setError(`加载失败：${e instanceof Error ? e.message : String(e)}`) })
    return () => { cancelled = true }
  }, [itemId, archivedAt])

  return (
    <div className="history-detail">
      <div className="history-detail-head">
        <span>{formatCapturedAt(archivedAt)} 归档的文件{files ? `（${files.length}）` : ''}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="danger" disabled={busy || !files?.length || !!error} onClick={onDelete}>删除</button>
          <button disabled={busy} onClick={onClose}>收起 ▲</button>
        </div>
      </div>
      {error ? <div className="empty" role="alert">{error}</div> : files == null ? (
        <div className="empty" style={{ padding: 12 }}>加载中…</div>
      ) : files.length === 0 ? (
        <div className="empty" style={{ padding: 12 }}>无文件</div>
      ) : (
        <table className="file-table">
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <td className="fname" title={f.archivedPath}>{f.archivedPath}</td>
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
function DescDetail({ snapshotId, busy, onDelete, onClose }: { snapshotId: number } & DetailActions) {
  const [snap, setSnap] = useState<SnapshotDetail | null | undefined>(undefined)
  const [tick, setTick] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    setSnap(undefined)
  }, [snapshotId])

  useEffect(() => {
    let cancelled = false
    setError('')
    void api.history.readSnapshot(snapshotId).then((value) => {
      if (!cancelled) setSnap(value)
    }).catch((e) => { if (!cancelled) setError(`加载失败：${e instanceof Error ? e.message : String(e)}`) })
    return () => { cancelled = true }
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
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="danger" disabled={busy || !snap || !!error} onClick={onDelete}>删除</button>
          <button disabled={busy} onClick={onClose}>收起 ▲</button>
        </div>
      </div>
      {error ? <div className="empty" role="alert">{error}</div> : snap === undefined ? (
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
