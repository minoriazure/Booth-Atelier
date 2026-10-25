import { useCallback, useEffect, useState } from 'react'
import type { CheckProgressEvent, CheckSummary, DeepLinkHostPrompt, ReconcileProgress, Settings } from '../../shared/types'
import { api } from './api'
import LibraryWallPage from './pages/LibraryWallPage'
import ItemDetailPage from './pages/ItemDetailPage'
import UpdatesPage from './pages/UpdatesPage'
import HistoryPage, { type HistoryFocus } from './pages/HistoryPage'
import SettingsPage from './pages/SettingsPage'
import LogPage from './pages/LogPage'
import AuthExpiredDialog from './components/AuthExpiredDialog'
import DeepLinkHostDialog from './components/DeepLinkHostDialog'
import BackToTop from './components/BackToTop'

type Tab = 'library' | 'updates' | 'history' | 'settings' | 'log'

interface Toast {
  id: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    const m = /tab=(\w+)/.exec(window.location.hash)
    const t = m?.[1]
    return t === 'updates' || t === 'history' || t === 'settings' || t === 'log' ? t : 'library'
  })
  const [detailId, setDetailId] = useState<number | null>(() => {
    const m = /item=(\d+)/.exec(window.location.hash)
    return m ? Number(m[1]) : null
  })
  const [settings, setSettings] = useState<Settings | null>(null)
  const [authOk, setAuthOk] = useState<boolean | null>(null)
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [progress, setProgress] = useState<CheckProgressEvent | null>(null)
  const [libraryVersion, setLibraryVersion] = useState(0) // 变化时触发子页面刷新
  /** 最近一次完成的确认（底栏最下行，状态确认用） */
  const [lastCompleted, setLastCompleted] = useState<string | null>(null)
  const [imgProgress, setImgProgress] = useState<{ done: number; total: number; active: number; queued: number } | null>(null)
  const [derivProgress, setDerivProgress] = useState<{ done: number; total: number; failed: number } | null>(null)
  const [reconcileProgress, setReconcileProgress] = useState<ReconcileProgress | null>(null)
  /** 深链宿主自检弹窗（指向其它副本时询问，独立于 cookies） */
  const [hostPrompt, setHostPrompt] = useState<DeepLinkHostPrompt | null>(null)

  const pushToast = useCallback((level: Toast['level'], message: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, level, message }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000)
    void api.log.write(level, 'toast', message).catch(() => {})
  }, [])

  /** 统一处理 auth.check 结果：限流只提示（不弹 Cookie 弹窗），真失效才置红 */
  const applyAuthResult = useCallback(
    (r: { ok: boolean; error?: string; kind?: string }, opts?: { silent?: boolean }) => {
      if (r.ok) {
        setAuthOk(true)
        setAuthMessage(null)
        return
      }
      if (r.kind === 'rate_limited') {
        // 被 BOOTH 限流 ≠ Cookie 失效：不弹认证弹窗，状态点保持不变
        if (!opts?.silent) pushToast('warn', 'BOOTH 访问受限（限流），请稍后再试，无需重新导出 Cookie')
        return
      }
      setAuthOk(false)
      setAuthMessage(r.error ?? '登录状态已失效')
    },
    [pushToast]
  )

  /** 交互式登录检查（设置页「检测登录状态」与 cookies 变化自动重查共用）：过程与结果都有 toast */
  const runAuthCheck = useCallback(async () => {
    pushToast('info', '正在检查登录状态…')
    const r = await api.auth.check()
    applyAuthResult(r, { silent: true })
    if (r.ok) pushToast('info', '✓ 登录有效')
    else if (r.kind === 'rate_limited') pushToast('warn', 'BOOTH 访问受限（限流），稍后再试')
    else pushToast('error', r.error ?? 'Cookie 无效')
  }, [pushToast, applyAuthResult])

  // 初始加载
  useEffect(() => {
    void api.settings.get().then(setSettings)
    void api.auth.check().then((r) => applyAuthResult(r))
    // 深链宿主自检（本地操作，无需等待 settings）：需要询问时弹应用内弹窗
    void api.protocol
      .hostStatus()
      .then((r) => {
        if (r) setHostPrompt(r)
      })
      .catch(() => {})
  }, [applyAuthResult])

  /** 深链弹窗决定：register=注册为本程序；decline=不注册并自动关检查开关 */
  const decideHost = useCallback(
    async (decision: 'register' | 'decline') => {
      setHostPrompt(null)
      try {
        const r = await api.protocol.hostDecision(decision)
        if (r.registered) pushToast('info', '已将网页下载按钮（深链）注册为本程序')
        else pushToast('info', '已关闭深链注册检查（可在设置中重新开启）')
        // 同步 autoRegisterDeepLink（decline 时主进程已写库）
        void api.settings.get().then(setSettings)
      } catch (e) {
        pushToast('error', `操作失败：${e instanceof Error ? e.message : e}`)
      }
    },
    [pushToast]
  )

  // 主题应用：data-theme + accent 变量
  useEffect(() => {
    if (!settings) return
    document.documentElement.dataset.theme = settings.themeMode
    document.documentElement.style.setProperty('--accent', settings.themeAccent)
    document.documentElement.style.setProperty(
      '--accent-soft',
      settings.themeMode === 'light'
        ? `color-mix(in srgb, ${settings.themeAccent} 12%, transparent)`
        : `color-mix(in srgb, ${settings.themeAccent} 15%, transparent)`
    )
  }, [settings])

  // 事件订阅
  useEffect(() => {
    const unsubs = [
      api.events.onLibraryUpdated((summary) => {
        setLastCompleted(
          `✓ 检查完成：${summary.filesChecked} 链接 / ${summary.filesUpdated} 更新 / ${summary.libraryChanged} 元数据变更`
        )
        setLibraryVersion((v) => v + 1)
        setProgress(null)
      }),
      api.events.onCheckProgress((e) => {
        // 下载进度不进底栏（更新与下载页有行内进度），只处理检查/同步
        if (e.phase !== 'download') setProgress(e)
      }),
      api.events.onDownloadDone(() => setLibraryVersion((v) => v + 1)),
      api.events.onDownloadError((e) => {
        pushToast(e.auth ? 'error' : 'warn', `下载失败：${e.filename} — ${e.error}`)
      }),
      api.events.onAuthExpired((msg) => {
        setAuthOk(false)
        setAuthMessage(msg)
      }),
      // cookies 文件内容真实变化（补放/覆盖/删除）→ 自动重查登录状态，刷新右上角状态/失效弹窗
      api.events.onCookiesReloaded(() => {
        void runAuthCheck()
      }),
      api.events.onToast((t) => pushToast(t.level, t.message)),
      api.events.onImageProgress((e) => {
        setImgProgress((prev) => {
          // 完成瞬间写入状态确认（活跃行随即消失）
          if (prev && prev.total > 0 && prev.done < prev.total && e.total > 0 && e.done >= e.total) {
            setLastCompleted(`✓ 图片 ${e.total} 张已就绪`)
          }
          return e
        })
      }),
      api.events.onDerivativeProgress((e) => {
        setDerivProgress((prev) => {
          if (prev && prev.total > 0 && prev.done < prev.total && e.total > 0 && e.done >= e.total) {
            setLastCompleted(`✓ 缩略图 ${e.total} 张已生成${e.failed > 0 ? `（失败 ${e.failed}）` : ''}`)
          }
          return e
        })
      }),
      api.events.onReconcileProgress((e) => {
        setReconcileProgress(e.done ? null : e)
        if (e.done) setLastCompleted(`✓ 图片检查完成（${e.checked} 张）`)
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [pushToast, runAuthCheck])

  const openDetail = useCallback((id: number) => {
    setDetailId(id)
  }, [])

  const [historyFocus, setHistoryFocus] = useState<HistoryFocus | null>(null)
  const openHistoryFor = useCallback((itemId: number) => {
    setHistoryFocus({ itemId, nonce: Date.now() })
    setTab('history')
  }, [])
  // 定位请求只在本次进入历史页时生效，离开后清空，避免下次进入又高亮
  useEffect(() => {
    if (tab !== 'history') setHistoryFocus(null)
  }, [tab])

  const runCheck = useCallback(
    async (fn: () => Promise<CheckSummary>, label: string) => {
      try {
        const s = await fn()
        setLastCompleted(
          `✓ ${label}完成：检查 ${s.filesChecked} 链接，发现 ${s.filesUpdated} 个更新${s.libraryChanged ? `，${s.libraryChanged} 个商品元数据变更` : ''}`
        )
        setLibraryVersion((v) => v + 1)
        pushToast(
          'info',
          `${label}完成：检查 ${s.filesChecked} 个链接，发现 ${s.filesUpdated} 个更新，下载 ${s.downloaded} 个${s.failed ? `，失败 ${s.failed}` : ''}`
        )
        setAuthOk(true)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.startsWith('[认证]')) {
          setAuthOk(false)
          setAuthMessage(msg.replace(/^\[认证\]\s*/, ''))
          pushToast('error', `${label}失败：${msg.replace(/^\[认证\]\s*/, '')}`)
        } else if (msg.includes('403') || msg.includes('限流')) {
          // 限流不是认证问题：只提示，稍后手动重试
          pushToast('warn', `${label}被 BOOTH 限流中断，稍后再试即可（无需重新导出 Cookie）`)
        } else {
          pushToast('error', `${label}失败：${msg}`)
        }
      } finally {
        setProgress(null)
      }
    },
    [pushToast]
  )

  const doSync = useCallback(() => runCheck(() => api.library.sync(), '库同步'), [runCheck])
  const doCheckGlobal = useCallback(() => runCheck(() => api.updates.checkGlobal(), '全局更新检查'), [runCheck])

  if (!settings) return <div className="empty">加载中…</div>

  return (
    <div className="app">
      <div className="toolbar">
        <div className="logo">
          Booth <span>Atelier</span>
        </div>
        <button onClick={doSync} disabled={progress !== null} title="拉取商品库最新信息（简介、宣传图、新增商品）">
          同步库
        </button>
        <button onClick={doCheckGlobal} disabled={progress !== null} title="检查所有商品所有下载链接的文件更新，发现即自动下载">
          检查全部更新
        </button>
        <button
          className="primary"
          onClick={async () => {
            const st = await api.downloads.startAll('bulk')
            pushToast(
              'info',
              st.queued + st.active > 0 ? `已开始：队列共 ${st.queued + st.active} 项（按顺序自动下载）` : '没有待下载的文件（全部已下载或已在队列中）'
            )
          }}
          title="把所有待下载文件加入队列并开始按顺序下载（已完成/失败不受影响）"
        >
          ▶ 开始全部
        </button>
        <div className="spacer" />
        <input
          className="search"
          type="search"
          placeholder="搜索商品名 / 店铺 / 描述…"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setDetailId(null)
              setTab('library')
              window.dispatchEvent(new CustomEvent('booth-search', { detail: (e.target as HTMLInputElement).value }))
            }
          }}
        />
        <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          <span className={`status-dot ${authOk ? 'ok' : authOk === false ? 'bad' : ''}`} />
          {authOk ? '已登录' : authOk === false ? 'Cookie 失效' : '检查中'}
        </span>
      </div>

      <div className="nav">
        <button className={tab === 'library' && detailId === null ? 'active' : ''} onClick={() => { setTab('library'); setDetailId(null) }}>
          资源库
        </button>
        <button className={tab === 'updates' ? 'active' : ''} onClick={() => setTab('updates')}>
          更新与下载
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          历史
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          设置
        </button>
        <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
          日志
        </button>
      </div>

      <div className="main">
        {tab === 'library' &&
          (detailId === null ? (
            <LibraryWallPage version={libraryVersion} onOpen={openDetail} />
          ) : (
            <ItemDetailPage
              itemId={detailId}
              version={libraryVersion}
              onBack={() => setDetailId(null)}
              onChanged={() => setLibraryVersion((v) => v + 1)}
              toast={pushToast}
              onOpenHistory={openHistoryFor}
            />
          ))}
        {tab === 'updates' && <UpdatesPage version={libraryVersion} toast={pushToast} onRunCheck={doCheckGlobal} />}
        {tab === 'history' && <HistoryPage version={libraryVersion} onOpen={openDetail} focus={historyFocus} />}
        {tab === 'settings' && (
          <SettingsPage
            settings={settings}
            onSettings={setSettings}
            toast={pushToast}
            onAuthCheck={() => void runAuthCheck()}
          />
        )}
        {tab === 'log' && <LogPage />}
        {tab === 'library' && <BackToTop />}
      </div>

      <div className="statusbar-stack">
        {/* 活跃进度：每种一行，同时出现时向上堆叠；完成即整行消失 */}
        {progress && (
          <div className="status-line active">
            <span className="status-label">
              {progress.phase === 'library' ? '📦 同步商品库' : '🔍 检查文件更新'}
              {progress.label ? `：${progress.label}` : ''}
            </span>
            {progress.total > 0 && (
              <>
                <div className="progressbar">
                  <div style={{ width: `${Math.min(100, (progress.current / progress.total) * 100)}%` }} />
                </div>
                <span className="status-num">
                  {progress.current}/{progress.total}
                </span>
              </>
            )}
          </div>
        )}
        {imgProgress && imgProgress.total > 0 && imgProgress.done < imgProgress.total && (
          <div className="status-line active">
            <span className="status-label">🖼 图片下载</span>
            <div className="progressbar img-progress">
              <div style={{ width: `${Math.min(100, (imgProgress.done / imgProgress.total) * 100)}%` }} />
            </div>
            <span className="status-num">
              {imgProgress.done}/{imgProgress.total}
            </span>
          </div>
        )}
        {derivProgress && derivProgress.total > 0 && derivProgress.done < derivProgress.total && (
          <div className="status-line active">
            <span className="status-label">🧩 缩略图生成</span>
            <div className="progressbar img-progress">
              <div style={{ width: `${Math.min(100, (derivProgress.done / derivProgress.total) * 100)}%` }} />
            </div>
            <span className="status-num">
              {derivProgress.done}/{derivProgress.total}
            </span>
          </div>
        )}
        {reconcileProgress && reconcileProgress.total > 0 && reconcileProgress.checked < reconcileProgress.total && (
          <div className="status-line active">
            <span className="status-label">🔍 检查图片</span>
            <div className="progressbar img-progress">
              <div style={{ width: `${Math.min(100, (reconcileProgress.checked / reconcileProgress.total) * 100)}%` }} />
            </div>
            <span className="status-num">
              {reconcileProgress.checked}/{reconcileProgress.total}
            </span>
          </div>
        )}
        {/* 最底行：已完成的状态确认 */}
        <div className="status-line bottom">
          <span className="status-done">{lastCompleted}</span>
          <span className="status-path">{settings.downloadRoot}</span>
        </div>
      </div>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.message}
          </div>
        ))}
      </div>

      {authOk === false && authMessage !== null && (
        <AuthExpiredDialog message={authMessage} onClose={() => setAuthMessage(null)} />
      )}

      {hostPrompt && <DeepLinkHostDialog info={hostPrompt} onDecide={(d) => void decideHost(d)} />}
    </div>
  )
}
