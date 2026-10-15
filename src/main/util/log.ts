/**
 * 日志封装：Electron 环境走 electron-log（写文件），纯 Node 脚本回退到 console。
 */
type Logger = {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

function makeConsoleLogger(scope: string): Logger {
  const fmt = (level: string, args: unknown[]) =>
    `[${new Date().toISOString()}] [${level}] [${scope}] ` +
    args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')
  return {
    info: (...a) => console.log(fmt('INFO', a)),
    warn: (...a) => console.warn(fmt('WARN', a)),
    error: (...a) => console.error(fmt('ERROR', a)),
    debug: (...a) => {
      if (process.env.DEBUG) console.log(fmt('DEBUG', a))
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => (val instanceof Error ? { message: val.message, stack: val.stack } : val))
  } catch {
    return String(v)
  }
}

const isElectron = !!process.versions.electron

export function createLogger(scope: string): Logger {
  if (isElectron) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const log = require('electron-log')
      return log.scope ? log.scope(scope) : log
    } catch {
      /* fallthrough */
    }
  }
  return makeConsoleLogger(scope)
}
