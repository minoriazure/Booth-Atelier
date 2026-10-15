import { useEffect, useState } from 'react'
import { api } from '../api'

export default function AuthExpiredDialog({
  message,
  onClose,
  onRetry
}: {
  message: string | null
  onClose: () => void
  onRetry: () => void
}) {
  const [path, setPath] = useState('')
  useEffect(() => {
    void api.auth.cookiesPath().then(setPath)
  }, [])

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>🔑 Cookie 已失效</h2>
        <p>{message || 'BOOTH 登录状态已过期，部分操作无法继续。'}</p>
        <p>
          请用浏览器插件重新导出 cookies 到：
          <br />
          <span className="code">{path}</span>
        </p>
        <p>保存后文件会自动热加载，无需重启本程序。</p>
        <div className="buttons">
          <button onClick={onClose}>关闭</button>
          <button className="primary" onClick={onRetry}>
            重试
          </button>
        </div>
      </div>
    </div>
  )
}
