import { Component, type ErrorInfo, type ReactNode } from 'react'
import { api } from '../api'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** 最外层兜底：渲染期异常只记日志并显示提示，不让整个界面白屏 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const stack = error.stack ?? error.message
    void api.log.write('error', 'render', `${stack} | component: ${info.componentStack ?? ''}`).catch(() => {})
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div style={{ padding: 24 }}>
          <h2>界面出现错误</h2>
          <p>{this.state.error.message}</p>
          <p>详情已写入日志（设置 → 日志）。可尝试刷新界面或重启应用。</p>
        </div>
      )
    }
    return this.props.children
  }
}
