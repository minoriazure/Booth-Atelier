import { useState } from 'react'
import { api } from '../api'

/**
 * 删除本地商品的二次确认：必须输入商品编号才可确认。
 * 仅删除本地数据库与数据目录，下载文件移入 deleted 文件夹（不直接销毁）。
 */
export default function DeleteItemDialog({
  itemId,
  title,
  busy,
  onCancel,
  onConfirm
}: {
  itemId: number
  title: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  const matched = typed.trim() === String(itemId)
  const cancel = () => {
    void api.log.write('info', 'dialog', `delete item ${itemId} dialog: cancelled`).catch(() => {})
    onCancel()
  }
  const confirm = () => {
    void api.log.write('warn', 'dialog', `delete item ${itemId} dialog: confirmed`).catch(() => {})
    onConfirm()
  }

  return (
    <div className="modal-mask" onClick={busy ? undefined : cancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>⚠ 删除本地商品</h2>
        <p>
          将删除本地数据库记录与数据目录，并把已下载的文件移入 <span className="code">deleted</span> 文件夹。
          <br />
          商品：{title}
        </p>
        <p>如果该商品仍在你的 BOOTH 库中，下次全局同步会重新同步回来。</p>
        <p>
          请输入商品编号 <span className="code">{itemId}</span> 以确认：
        </p>
        <input
          type="text"
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={String(itemId)}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matched && !busy) confirm()
          }}
        />
        <div className="buttons">
          <button onClick={cancel} disabled={busy}>
            取消
          </button>
          <button className="danger" onClick={confirm} disabled={!matched || busy}>
            {busy ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </div>
  )
}
