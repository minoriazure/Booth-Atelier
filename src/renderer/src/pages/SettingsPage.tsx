import { useEffect, useState } from 'react'
import type { Settings } from '../../../shared/types'
import { api } from '../api'

type ToastFn = (level: 'info' | 'warn' | 'error', message: string) => void

/** 设置页：全局下载根目录、cookies 路径、开关、并发/频率 */
export default function SettingsPage({
  settings,
  onSettings,
  toast,
  onAuthCheck
}: {
  settings: Settings
  onSettings: (s: Settings) => void
  toast: ToastFn
  onAuthCheck: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [proxyInfo, setProxyInfo] = useState<string | null>(null)
  const [customProxyInput, setCustomProxyInput] = useState(settings.customProxy)
  /** Cookie 路径输入框草稿；初始/同步自「当前生效路径」（无覆盖时 = 默认链路径） */
  const [cookiesPathInput, setCookiesPathInput] = useState(settings.cookiesPath)
  /** 「未改动」基准 = 当前生效路径（jar 实际指向），用于区分「仅检测」与「应用并检测」 */
  const [cleanPath, setCleanPath] = useState(settings.cookiesPath)

  const refreshProxy = (): void => {
    void api.system.proxyInfo().then(setProxyInfo).catch(() => setProxyInfo(null))
  }
  /** 从主进程拉当前生效路径（无覆盖时 = 默认链解析结果），同步输入框与基准 */
  const refreshCookiesDisplay = (): void => {
    void api.auth
      .cookiesPath()
      .then((p) => {
        setCleanPath(p)
        setCookiesPathInput(p)
      })
      .catch(() => {})
  }
  useEffect(() => {
    refreshProxy()
    refreshCookiesDisplay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const patch = async (p: Partial<Settings>): Promise<boolean> => {
    setSaving(true)
    try {
      const s = await api.settings.set(p)
      onSettings(s)
      if (p.downloadRoot !== undefined) toast('info', '下载目录已更新（已下载文件不会移动）')
      if ('proxyMode' in p || 'customProxy' in p) refreshProxy()
      if ('cookiesPath' in p) {
        refreshCookiesDisplay()
        toast('info', p.cookiesPath ? 'Cookie 路径已应用' : '已恢复默认路径查找')
      }
      return true
    } catch (e) {
      toast('error', `保存失败：${e instanceof Error ? e.message : e}`)
      return false
    } finally {
      setSaving(false)
    }
  }

  /**
   * 「检测登录状态」（回车同）：
   * - 路径与当前生效一致（或空输入且本就无覆盖）→ 仅检查；
   * - 有改动 → 先应用（写设置，路径须存在）再检查；空输入 = 恢复默认查找。
   */
  const applyCookiesPathAndCheck = (): void => {
    const v = cookiesPathInput.trim()
    if (v === cleanPath || (v === '' && !settings.cookiesPath)) {
      onAuthCheck()
      return
    }
    void patch({ cookiesPath: v }).then((ok) => {
      if (ok) onAuthCheck()
    })
  }

  const saveCustomProxy = (): void => {
    const v = customProxyInput.trim()
    if (v === settings.customProxy) return
    if (v && !isValidProxyAddr(v)) {
      toast('error', '代理地址格式无效（示例：http://127.0.0.1:7890、socks5://127.0.0.1:1080、127.0.0.1:7890）')
      return
    }
    void patch({ customProxy: v })
  }

  return (
    <div style={{ maxWidth: 780, margin: '0 auto' }}>
      <div className="panel">
        <h3>存储</h3>
        <div className="setting-row">
          <div className="label">下载根目录</div>
          <div className="value">
            <span className="path-text" title={settings.downloadRoot}>
              {settings.downloadRoot}
            </span>
            <button onClick={() => void chooseDir((p) => patch({ downloadRoot: p }), toast)}>更改…</button>
            <button onClick={() => void api.history.openPath(settings.downloadRoot)}>打开</button>
          </div>
        </div>
        <div className="setting-row">
          <div className="label">Cookie 文件</div>
          <div className="value">
            <input
              type="text"
              style={{ width: 340 }}
              value={cookiesPathInput}
              placeholder="Cookie 文件路径…"
              title="当前生效的 Cookie 文件路径；改后点「检测登录状态」或回车应用并检测"
              onChange={(e) => setCookiesPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyCookiesPathAndCheck()
              }}
            />
            <button onClick={applyCookiesPathAndCheck}>检测登录状态</button>
            <button
              onClick={() =>
                void api.dialog.chooseFile().then((p) => {
                  if (p) void patch({ cookiesPath: p }).then((ok) => ok && onAuthCheck())
                })
              }
            >
              选择文件…
            </button>
            <button
              onClick={() => void patch({ cookiesPath: '' }).then((ok) => ok && onAuthCheck())}
              disabled={!settings.cookiesPath}
              title="清除指定路径，回到默认查找（exe 同级优先）"
            >
              恢复默认
            </button>
            <span className="hint">
              输入框显示当前生效的 Cookie 文件路径（未指定时为默认查找结果，exe 同级优先）。点「检测登录状态」（或回车）：
              路径有改动会先应用再检测（须真实存在），与当前一致则仅检测。「选择文件… / 恢复默认」立即生效并自动检测。
              文件被替换后自动热加载，无需重启。
            </span>
          </div>
        </div>
        <div className="setting-row">
          <div className="label">代理模式</div>
          <div className="value">
            <button
              className={settings.proxyMode === 'system' ? 'primary' : ''}
              onClick={() => void patch({ proxyMode: 'system' })}
              title="跟随 Windows 系统代理（与 Chrome 相同），系统里改了自动生效"
            >
              🌐 系统代理
            </button>
            <button
              className={settings.proxyMode === 'custom' ? 'primary' : ''}
              onClick={() => void patch({ proxyMode: 'custom' })}
              title="手动指定代理地址，不依赖系统设置"
            >
              ⚙ 自定义
            </button>
            <button
              className={settings.proxyMode === 'direct' ? 'primary' : ''}
              onClick={() => void patch({ proxyMode: 'direct' })}
              title="不使用任何代理，直连 BOOTH"
            >
              ⛔ 直连
            </button>
            {settings.proxyMode === 'custom' && (
              <input
                type="text"
                style={{ width: 250 }}
                value={customProxyInput}
                placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
                onChange={(e) => setCustomProxyInput(e.target.value)}
                onBlur={saveCustomProxy}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveCustomProxy()
                }}
              />
            )}
          </div>
        </div>
        <div className="setting-row">
          <div className="label">当前生效代理</div>
          <div className="value">
            <span className="path-text" title="对本程序全部网络请求生效（下载/同步/检查）">
              {proxyInfo ?? '未检测到'}
            </span>
            <button onClick={refreshProxy}>刷新</button>
            <span className="hint">
              {settings.proxyMode === 'system'
                ? '跟随 Windows 系统代理设置（与 Chrome 相同，系统里修改后自动生效，无需重启）'
                : settings.proxyMode === 'custom'
                  ? '使用上方自定义地址；切换后立即生效，无需重启'
                  : '不使用代理，直连 BOOTH（切换后立即生效，无需重启）'}
            </span>
          </div>
        </div>
        <div className="setting-row">
          <div />
          <div className="value">
            <span className="hint">
              Cookie 过期时用浏览器插件重新导出并覆盖上述文件即可，程序会自动热加载。目录结构：
              <code> {"{下载根目录}/{商品编号}/files/current|history/{日期}}"} </code>
            </span>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>深链协议</h3>
        <div className="setting-row">
          <div className="label">启动时检查深链注册</div>
          <div className="value">
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.autoRegisterDeepLink}
                onChange={(e) => void patch({ autoRegisterDeepLink: e.target.checked })}
              />
              <span className="slider" />
            </label>
            <span className="hint">
              开启时，启动检查网页「DL with BOOTH Library Manager」按钮（booth-library-manager:// 深链）是否指向本程序；指向其它副本时询问是否注册。选择「不注册」会自动关闭本开关。
            </span>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>更新与下载</h3>
        <div className="setting-row">
          <div className="label">启动时同步商品库</div>
          <div className="value">
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.autoSyncLibraryOnStartup}
                onChange={(e) => void patch({ autoSyncLibraryOnStartup: e.target.checked })}
              />
              <span className="slider" />
            </label>
            <span className="hint">拉取商品简介/宣传图/新购入商品（图片后台自动下载）</span>
          </div>
        </div>
        <div className="setting-row">
          <div className="label">启动时检查文件更新</div>
          <div className="value">
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.autoCheckFilesOnStartup}
                onChange={(e) => void patch({ autoCheckFilesOnStartup: e.target.checked })}
              />
              <span className="slider" />
            </label>
            <span className="hint">检查所有下载链接的文件版本，发现更新自动下载</span>
          </div>
        </div>
        <div className="setting-row">
          <div className="label">检测到更新自动下载</div>
          <div className="value">
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.autoDownloadUpdates}
                onChange={(e) => void patch({ autoDownloadUpdates: e.target.checked })}
              />
              <span className="slider" />
            </label>
            <span className="hint">关闭后只标记更新，由你手动确认下载</span>
          </div>
        </div>
        <div className="setting-row">
          <div className="label">启动检查最小间隔</div>
          <div className="value">
            <input
              type="text"
              style={{ width: 70 }}
              value={settings.startupCheckIntervalDays}
              onChange={(e) => {
                const v = Math.max(0, Math.min(365, Math.floor(Number(e.target.value) || 0)))
                void patch({ startupCheckIntervalDays: v })
              }}
            />
            <span className="hint">
              天。距上次全局检查不足该间隔时跳过（0 = 每次启动都检查）。不影响手动检查；商品库与文件检查各自独立按上次全局时间判断
            </span>
          </div>
        </div>
        <div className="setting-row">
          <div className="label">并发下载数</div>
          <div className="value">
            <input
              type="text"
              style={{ width: 70 }}
              value={settings.downloadConcurrency}
              onChange={(e) => {
                const v = Math.max(1, Math.min(8, Number(e.target.value) || 1))
                void patch({ downloadConcurrency: v })
              }}
            />
            <span className="hint">1–8，默认 3</span>
          </div>
        </div>
        <div className="setting-row">
          <div className="label">请求最小间隔</div>
          <div className="value">
            <input
              type="text"
              style={{ width: 90 }}
              value={settings.minRequestIntervalMs}
              onChange={(e) => {
                const v = Math.max(100, Math.min(5000, Number(e.target.value) || 250))
                void patch({ minRequestIntervalMs: v })
              }}
            />
            <span className="hint">毫秒，默认 250（对 BOOTH 的礼貌间隔）</span>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>外观</h3>
        <div className="setting-row">
          <div className="label">主题模式</div>
          <div className="value">
            <button
              className={settings.themeMode === 'dark' ? 'primary' : ''}
              onClick={() => void patch({ themeMode: 'dark' })}
            >
              🌙 深色
            </button>
            <button
              className={settings.themeMode === 'light' ? 'primary' : ''}
              onClick={() => void patch({ themeMode: 'light' })}
            >
              ☀ 浅色
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div className="label">主题颜色</div>
          <div className="value">
            {THEME_COLORS.map((c) => (
              <button
                key={c}
                className={`theme-swatch ${settings.themeAccent.toLowerCase() === c.toLowerCase() ? 'active' : ''}`}
                style={{ background: c }}
                title={c}
                onClick={() => void patch({ themeAccent: c })}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>状态</h3>
        <div className="setting-row">
          <div className="label">上次库同步</div>
          <div className="value">{settings.lastLibrarySyncAt ? formatTime(settings.lastLibrarySyncAt) : '从未'}</div>
        </div>
        <div className="setting-row">
          <div className="label">上次全局检查</div>
          <div className="value">{settings.lastGlobalCheckAt ? formatTime(settings.lastGlobalCheckAt) : '从未'}</div>
        </div>
      </div>

      {saving && <div style={{ color: 'var(--text-dim)', fontSize: 12, textAlign: 'right' }}>保存中…</div>}
    </div>
  )
}

/** 可选主题色 */
const THEME_COLORS = ['#4c8dff', '#38c793', '#a78bfa', '#f472b6', '#fb923c', '#facc15', '#f87171', '#94a3b8']

async function chooseDir(cb: (path: string) => void, _toast: ToastFn): Promise<void> {
  const p = await api.dialog.chooseDir()
  if (p) cb(p)
}

/** 与主进程 normalizeProxyRules 一致的轻量校验：协议头可选的 host:port */
function isValidProxyAddr(v: string): boolean {
  return /^(?:(?:https?|socks5?|socks4a?):\/\/)?(?:[a-z0-9.-]+|\[[0-9a-f:]+\]):\d{1,5}$/i.test(v)
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}
