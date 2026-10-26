import type { DeepLinkHostPrompt } from '../../../shared/types'
import { api } from '../api'

/**
 * 深链宿主自检弹窗（应用内，与 AuthExpiredDialog 同风格；替代系统原生对话框）。
 * 必须显式选择「注册 / 不注册」——点遮罩不关闭，避免误关后下次启动反复询问。
 */
export default function DeepLinkHostDialog({
  info,
  onDecide
}: {
  info: DeepLinkHostPrompt
  onDecide: (decision: 'register' | 'decline') => void
}) {
  const decide = (d: 'register' | 'decline') => {
    void api.log.write('info', 'dialog', `deeplink host prompt: user chose ${d}`).catch(() => {})
    void api.log.write('message', 'dialog', `deeplink host prompt: user chose ${d}`).catch(() => {})
    onDecide(d)
  }
  return (
    <div className="modal-mask">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>🔗 网页下载按钮指向其它程序</h2>
        <p>
          BOOTH 网页的「DL with BOOTH Library Manager」下载按钮（booth-library-manager://）当前指向：
          <br />
          <span className="code">{info.registeredPath ?? '（未注册）'}</span>
        </p>
        <p>
          是否改为本程序？
          <br />
          <span className="code">{info.selfPath}</span>
        </p>
        <p>选择「不注册」将关闭启动时的注册检查（可在设置中重新开启）。</p>
        <div className="buttons">
          <button onClick={() => decide('decline')}>不注册</button>
          <button className="primary" onClick={() => decide('register')}>
            注册
          </button>
        </div>
      </div>
    </div>
  )
}
