/**
 * 日志封装：每天一个文件 <dataDir>/log/YYYY-MM-DD.log，每条日志固定一行。
 * 同时输出到控制台（开发调试用）。
 */
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { localDate } from './filenames'
import { resolveDataDir } from './dataDir'

type Logger = {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
  /** 面向用户的弹窗 / toast 内容 */
  message: (...args: unknown[]) => void
}

let logDirOverride: string | null = null
let logDirReady: string | null = null
const writeListeners = new Set<() => void>()

/** 每成功写入一行日志后回调一次（用于通知日志页实时刷新）；返回取消订阅函数 */
export function onLogWritten(cb: () => void): () => void {
  writeListeners.add(cb)
  return () => writeListeners.delete(cb)
}

/** 覆盖日志目录（测试或特殊场景用）；默认 <dataDir>/log */
export function setLogDir(dir: string): void {
  logDirOverride = dir
  logDirReady = null
}

export function getLogDir(): string {
  return logDirOverride ?? join(resolveDataDir(), 'log')
}

function ensureLogDir(): string {
  const dir = getLogDir()
  if (logDirReady !== dir) {
    mkdirSync(dir, { recursive: true })
    logDirReady = dir
  }
  return dir
}

/** 单行化：换行符转义为 \n，保证一条日志只占一行 */
function toSingleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\\n')
}

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`
  try {
    return JSON.stringify(a, (_k, val) => (val instanceof Error ? { message: val.message, stack: val.stack } : val))
  } catch {
    return String(a)
  }
}

function writeLine(level: string, scope: string, args: unknown[]): void {
  const now = new Date()
  const ts = `${localDate(now)} ${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}`
  const msg = toSingleLine(args.map(stringifyArg).join(' '))
  const line = `${ts} [${level}] [${scope}] ${msg}`
  try {
    appendFileSync(join(ensureLogDir(), `${localDate(now)}.log`), line + '\n', 'utf8')
    for (const cb of writeListeners) cb()
  } catch {
    /* 写文件失败不影响业务 */
  }
  if (level === 'ERROR') console.error(line)
  else if (level === 'WARN') console.warn(line)
  else console.log(line)
}

/** 统一的条目描述：商品号 + 标题 + 链接 ID + 文件名，用于文件/商品/更新相关日志 */
export function describeLink(t: { itemId: number; itemTitle?: string | null; downloadableId?: number; filename?: string | null }): string {
  const parts = [`item=#${t.itemId}`]
  if (t.itemTitle) parts.push(`「${t.itemTitle.slice(0, 40)}」`)
  if (t.downloadableId != null) parts.push(`link=#${t.downloadableId}`)
  if (t.filename) parts.push(`file="${t.filename}"`)
  return parts.join(' ')
}

export function createLogger(scope: string): Logger {
  return {
    info: (...a) => writeLine('INFO', scope, a),
    warn: (...a) => writeLine('WARN', scope, a),
    error: (...a) => writeLine('ERROR', scope, a),
    debug: (...a) => writeLine('DEBUG', scope, a),
    message: (...a) => writeLine('MESSAGE', scope, a)
  }
}
