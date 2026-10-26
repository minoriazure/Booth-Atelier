import { useEffect, useState } from 'react'
import { api } from '../api'

/**
 * Cookie 失效提示（无重试按钮——cookies 文件补放/覆盖后会触发自动重查登录状态，
 * 恢复有效时本弹窗自动关闭；这里只需告诉用户把文件放哪）。
 */
export default function AuthExpiredDialog({
  message,
  onClose
}: {
  message: string | null
  onClose: () => void
}) {
  const [path, setPath] = useState('')
  useEffect(() => {
    void api.log.write('warn', 'dialog', `auth expired dialog shown: ${message ?? ''}`).catch(() => {})
    void api.log.write('message', 'dialog', `auth expired dialog shown: ${message ?? ''}`).catch(() => {})
    void api.auth.cookiesPath().then(setPath)
  }, [])

  const close = () => {
    void api.log.write('info', 'dialog', 'auth expired dialog closed by user').catch(() => {})
    void api.log.write('message', 'dialog', 'auth expired dialog closed by user').catch(() => {})
    onClose()
  }

  return (
    <div className="modal-mask" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>🔑 Cookie 已失效</h2>
        <p>{message || 'BOOTH 登录状态已过期，部分操作无法继续。'}</p>
        <p>
          请用浏览器插件重新导出 cookies 到：
          <br />
          <span className="code">{path}</span>
        </p>
        <p>把文件放回该路径即可，程序会自动识别并恢复登录状态，无需任何操作。</p>
        <div className="buttons">
          <button className="primary" onClick={close}>
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
