import { useEffect, useRef, useState } from 'react'

const options = [
  ['all', '全部商品'], ['library', '仅库商品'], ['gift', '仅赠送'],
  ['free', '仅免费'], ['undownloaded', '未下载完'], ['updates', '有文件更新'], ['delisted', '已下架']
] as const
export type ItemFilter = typeof options[number][0]

export function ItemFilterDropdown({ value, onChange }: { value: ItemFilter; onChange: (value: ItemFilter) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus()
    const dismiss = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [open])
  return <div className="tag-filter item-filter" ref={root} onBlur={(e) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false)
  }} onKeyDown={(e) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.current?.focus() }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[(index + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus()
    }
  }}>
    <button ref={trigger} type="button" className="tag-filter-btn" aria-haspopup="listbox" aria-expanded={open}
      onClick={() => setOpen(!open)}>{options.find(([id]) => id === value)?.[1]} ▾</button>
    {open && <div className="tag-filter-panel item-filter-panel" role="listbox" aria-label="商品类型">
      {options.map(([id, name]) => <button key={id} type="button" role="option" aria-selected={value === id}
        className="item-filter-option" onClick={() => { onChange(id); setOpen(false); trigger.current?.focus() }}>
        <span>{name}</span><span aria-hidden="true">{value === id ? '✓' : ''}</span>
      </button>)}
    </div>}
  </div>
}
