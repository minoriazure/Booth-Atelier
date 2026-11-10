import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { TAG_LIMITS, type TagInfo, type TagRef } from '../../../shared/types'
import { api } from '../api'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function TagFilterDropdown({
  tags,
  selected,
  onChange,
  onManage,
  untagged,
  onUntaggedChange
}: {
  untagged: boolean
  onUntaggedChange: (value: boolean) => void
  tags: TagInfo[]
  selected: number[]
  onChange: (ids: number[]) => void
  onManage: () => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = (id: number): void => {
    onUntaggedChange(false)
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  return (
    <div className="tag-filter" ref={rootRef}>
      <button
        type="button"
        className={`tag-filter-btn ${selected.length > 0 || untagged ? 'active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        标签{untagged ? '（无标签）' : selected.length > 0 ? `（${selected.length}）` : ''} ▾
      </button>
      {open && (
        <div className="tag-filter-panel">
          <label className="tag-option">
            <input type="checkbox" checked={untagged} onChange={() => { onChange([]); onUntaggedChange(!untagged) }} />
            <span>无标签</span>
          </label>
          {tags.length === 0 ? (
            <div className="tag-empty">暂无标签，右键商品可新建</div>
          ) : (
            <div className="tag-filter-list">
              {tags.map((t) => (
                <label key={t.id} className="tag-option">
                  <input type="checkbox" checked={selected.includes(t.id)} onChange={() => toggle(t.id)} />
                  <span className="tag-name">{t.name}</span>
                </label>
              ))}
            </div>
          )}
          <div className="tag-filter-foot">
            <button type="button" disabled={selected.length === 0 && !untagged} onClick={() => { onChange([]); onUntaggedChange(false) }}>
              清空
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onManage()
              }}
            >
              管理标签…
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function TagContextMenu({
  x,
  y,
  itemId,
  itemTags,
  tags,
  onItemTagsChange,
  onTagsChanged,
  onManage,
  onClose
}: {
  x: number
  y: number
  itemId: number
  itemTags: TagRef[]
  tags: TagInfo[]
  onItemTagsChange: (itemId: number, tags: TagRef[]) => void
  onTagsChanged: () => void
  onManage: () => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  const lastChoiceRef = useRef<number | null>(null)
  const visibleTags = tags.filter((t) => t.name.toLowerCase().includes(draft.trim().toLowerCase()))
  const full = itemTags.length >= TAG_LIMITS.perItem
  useEffect(() => {
    if (!busy) inputRef.current?.focus()
  }, [busy])
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onWheel = (e: WheelEvent): void => {
      // 保留菜单内标签列表的滚动；页面或其他区域滚动时收起右键菜单。
      if (!(e.target as Element | null)?.closest('.tag-menu-list')) onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    document.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('wheel', onWheel)
    }
  }, [onClose])

  const [position, setPosition] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const place = (): void => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      setPosition({
        left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
        top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [x, y, err, full, visibleTags.length])

  const assigned = new Set(itemTags.map((t) => t.id))

  const save = async (ids: number[]): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const next = await api.tags.setItemTags(itemId, ids)
      onItemTagsChange(itemId, next)
      onTagsChanged()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (tag: TagInfo): void => {
    if (busy) return
    if (assigned.has(tag.id)) {
      void save(itemTags.filter((t) => t.id !== tag.id).map((t) => t.id))
      return
    }
    if (itemTags.length >= TAG_LIMITS.perItem) {
      setErr(`单个商品最多 ${TAG_LIMITS.perItem} 个 tag`)
      return
    }
    void save([...itemTags.map((t) => t.id), tag.id])
  }

  // 新建：若同名 tag 已存在则直接划分到该商品，不重复创建
  const create = async (): Promise<void> => {
    const name = draft.trim()
    if (!name || busy) return
    const existing = tags.find((t) => t.name.toLowerCase() === name.toLowerCase())
    if (!existing && tags.length >= TAG_LIMITS.total) {
      setErr(`tag 总数已达上限（${TAG_LIMITS.total}）`)
      return
    }
    if (!existing && itemTags.length >= TAG_LIMITS.perItem) {
      setErr(`单个商品最多 ${TAG_LIMITS.perItem} 个 tag`)
      return
    }
    if (existing && assigned.has(existing.id)) {
      setErr('该商品已有此 tag')
      return
    }
    if (existing && itemTags.length >= TAG_LIMITS.perItem) {
      setErr(`单个商品最多 ${TAG_LIMITS.perItem} 个 tag`)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const target = existing ?? (await api.tags.create(name))
      const next = await api.tags.setItemTags(itemId, [...itemTags.map((t) => t.id), target.id])
      onItemTagsChange(itemId, next)
      setDraft('')
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
      onTagsChanged()
    }
  }

  const onDraftKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Tab' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const choices = visibleTags.filter((t) => assigned.has(t.id) || !full)
      if (e.key !== 'Tab') e.preventDefault()
      if (!choices.length) return
      e.preventDefault()
      const index = visibleTags.findIndex((t) => t.id === (activeId ?? lastChoiceRef.current))
      const backwards = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)
      const step = backwards ? -1 : 1
      let nextIndex = index < 0 ? (backwards ? 0 : -1) : index
      let next = choices[0]
      for (let i = 0; i < visibleTags.length; i++) {
        nextIndex = (nextIndex + step + visibleTags.length) % visibleTags.length
        const candidate = visibleTags[nextIndex]
        if (assigned.has(candidate.id) || !full) { next = candidate; break }
      }
      lastChoiceRef.current = next.id
      setActiveId(next.id)
      rootRef.current?.querySelector(`[data-tag-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    if (e.key === 'Enter' || (e.key === ' ' && activeId !== null)) {
      e.preventDefault()
      if (busy) return
      const target = visibleTags.find((t) => t.id === activeId)
      if (target) { toggle(target); setActiveId(null) }
      else void create()
    }
  }

  return (
    <div className="tag-menu" ref={rootRef} style={position} onContextMenu={(e) => e.preventDefault()}>
      <div className="tag-menu-head">
        <span>
          标签 · 本商品 {itemTags.length}/{TAG_LIMITS.perItem}
        </span>
        <span className="tag-menu-total">
          全局 {tags.length}/{TAG_LIMITS.total}
        </span>
      </div>
      <div className="tag-menu-list">
        {tags.length === 0 && <div className="tag-empty">暂无标签</div>}
        {visibleTags.map((t) => (
          <label key={t.id} data-tag-id={t.id} className={`tag-option ${activeId === t.id ? 'tag-option-active' : ''}`}>
            <input type="checkbox" checked={assigned.has(t.id)} disabled={busy || (full && !assigned.has(t.id))} tabIndex={-1} onChange={() => toggle(t)} />
            <span className="tag-name">{t.name}</span>
          </label>
        ))}
      </div>
      {full && <div className="tag-empty">已选 8/8，可取消后更换</div>}
      {visibleTags.length === 0 && draft && <div className="tag-empty">无匹配标签，回车新建</div>}
      <input
        ref={inputRef}
        autoFocus
        className="tag-menu-input"
        type="text"
        placeholder="输入过滤 · Tab/↑↓选择 · 回车/空格确认"
        value={draft}
        maxLength={64}
        disabled={busy}
        onChange={(e) => { setDraft(e.target.value); setActiveId(null) }}
        onKeyDown={onDraftKey}
      />
      {err && <div className="tag-menu-err">{err}</div>}
      <div className="tag-menu-foot">
        <button
          type="button"
          onClick={() => {
            onClose()
            onManage()
          }}
        >
          管理标签…
        </button>
      </div>
    </div>
  )
}

export function TagManageDialog({
  tags,
  onChanged,
  onClose
}: {
  tags: TagInfo[]
  onChanged: () => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>, after?: () => void): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      after?.()
      onChanged()
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const saveRename = (): void => {
    if (!editing) return
    const { id, name } = editing
    void run(() => api.tags.rename(id, name), () => setEditing(null))
  }

  return (
    <div className="modal-mask" onClick={busy ? undefined : onClose}>
      <div className="modal tag-manage" onClick={(e) => e.stopPropagation()}>
        <h2>管理标签</h2>
        <p>
          共 {tags.length} / {TAG_LIMITS.total} 个标签。删除标签会将其从所有商品上移除。
        </p>
        {tags.length === 0 && <div className="tag-empty">暂无标签，右键商品可新建</div>}
        <div className="tag-manage-list">
          {tags.map((t) => (
            <div key={t.id} className="tag-manage-row">
              {editing?.id === t.id ? (
                <input
                  type="text"
                  autoFocus
                  maxLength={64}
                  value={editing.name}
                  disabled={busy}
                  onChange={(e) => setEditing({ id: t.id, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveRename()
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <span className="tag-name">{t.name}</span>
              )}
              <span className="tag-count">{t.itemCount} 个商品</span>
              {editing?.id === t.id ? (
                <>
                  <button type="button" disabled={busy} onClick={saveRename}>
                    保存
                  </button>
                  <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                    取消
                  </button>
                </>
              ) : confirmId === t.id ? (
                <>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => void run(() => api.tags.delete(t.id), () => setConfirmId(null))}
                  >
                    确认删除
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirmId(null)}>
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button type="button" disabled={busy} onClick={() => setEditing({ id: t.id, name: t.name })}>
                    改名
                  </button>
                  <button type="button" className="danger" disabled={busy} onClick={() => setConfirmId(t.id)}>
                    删除
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
        {err && <div className="tag-menu-err">{err}</div>}
        <div className="buttons">
          <button type="button" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}


export function TagBatchDialog({ itemIds, tags, onItemTagsChange, onChanged, onClose }: {
  itemIds: number[]
  tags: TagInfo[]
  onItemTagsChange: (itemId: number, tags: TagRef[]) => void
  onChanged: () => void
  onClose: () => void
}) {
  const [selected, setSelected] = useState<number[]>([])
  const [mode, setMode] = useState<'add' | 'remove'>('add')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const apply = async (): Promise<void> => {
    if (busy || !selected.length) return
    setBusy(true)
    setResult(null)
    let changed = 0
    let unchanged = 0
    const failures: string[] = []
    try {
      const result = await api.tags.bulk(itemIds, selected, mode)
      for (const item of result.changed) onItemTagsChange(item.itemId, item.tags)
      changed = result.changed.length
      unchanged = result.unchanged
      failures.push(...result.failures)
      setResult(`完成：修改 ${changed} 个，无需修改 ${unchanged} 个，跳过或失败 ${failures.length} 个。` + (failures.length ? '\n' + failures.join('\n') : ''))
    } catch (e) {
      setResult(`批量操作失败：${errText(e)}`)
    } finally {
      setBusy(false)
      onChanged()
    }
  }
  return (
    <div className="modal-mask" onClick={busy ? undefined : onClose}>
      <div className="modal tag-manage" onClick={(e) => e.stopPropagation()}>
        <h2>批量标签 · {itemIds.length} 个商品</h2>
        <p>保留其他标签；添加后超过单商品上限的商品会跳过。</p>
        <select aria-label="批量操作" value={mode} disabled={busy} onChange={(e) => { setMode(e.target.value as typeof mode); setResult(null) }}>
          <option value="add">添加标签</option><option value="remove">移除标签</option>
        </select>
        <div className="tag-manage-list">
          {!tags.length && <div className="tag-empty">暂无标签，请先在商品右键菜单中新建。</div>}
          {tags.map((t) => <label key={t.id} className="tag-option">
            <input type="checkbox" checked={selected.includes(t.id)} disabled={busy}
              onChange={() => { setSelected((prev) => prev.includes(t.id) ? prev.filter((id) => id !== t.id) : [...prev, t.id]); setResult(null) }} />
            <span className="tag-name">{t.name}</span>
          </label>)}
        </div>
        {result && <div className="tag-batch-result" role="status">{result}</div>}
        <div className="buttons">
          <button type="button" disabled={busy || !selected.length} onClick={() => void apply()}>{busy ? '处理中…' : '应用'}</button>
          <button type="button" disabled={busy} onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
