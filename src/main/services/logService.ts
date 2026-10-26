import { promises as fsp } from 'fs'
import { join } from 'path'
import { getLogDir, createLogger } from '../util/log'
import { localDate } from '../util/filenames'
import type { LogDayInfo, LogPageResult, LogSearchHit, LogSearchResult, LogLevel } from '../../shared/types'

const log = createLogger('log')

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.log$/
/** 行首级别标记（时间戳之后的 [LEVEL]） */
const LEVEL_LINE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[(\w+)\]/
const CACHE_LIMIT = 3
const FILTER_CACHE_LIMIT = 6
const SEARCH_HIT_CAP = 2000

type DayCache = { key: string; lines: string[] }
/** 最近读取过的日文件（按 mtime+size 失效），避免翻页时反复读盘 */
const cache = new Map<string, DayCache>()
/** 按级别过滤后的行，键 = 日期|级别集合；src 为所依据的原始行数组，原始数据刷新即失效 */
const filtered = new Map<string, { src: string[]; lines: string[] }>()
/** 每天行数缓存（listDays 用，键 = 日期|级别集合） */
const countCache = new Map<string, { key: string; lines: number }>()

function levelsKey(levels: readonly LogLevel[]): string {
  return [...new Set(levels)].sort().join(',')
}

/** 只保留所选级别的行；无法识别级别的行一律保留 */
function filterByLevel(lines: string[], levels: readonly LogLevel[]): string[] {
  const set = new Set<string>(levels)
  return lines.filter((l) => {
    const m = LEVEL_LINE.exec(l)
    return !m || set.has(m[1])
  })
}

async function dayFiles(): Promise<Array<{ date: string; path: string }>> {
  let names: string[]
  try {
    names = await fsp.readdir(getLogDir())
  } catch {
    return []
  }
  return names
    .map((n) => ({ m: DAY_FILE.exec(n), n }))
    .filter((x): x is { m: RegExpExecArray; n: string } => !!x.m)
    .map((x) => ({ date: x.m[1], path: join(getLogDir(), x.n) }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/** 读取某天全部行（文件顺序 = 时间正序），带缓存 */
async function loadDay(date: string): Promise<string[]> {
  const path = join(getLogDir(), `${date}.log`)
  let st
  try {
    st = await fsp.stat(path)
  } catch {
    return []
  }
  const key = `${st.mtimeMs}:${st.size}`
  const hit = cache.get(date)
  if (hit && hit.key === key) {
    cache.delete(date)
    cache.set(date, hit) // 刷新 LRU 顺序
    return hit.lines
  }
  const text = await fsp.readFile(path, 'utf8')
  const lines = text.split('\n').filter((l) => l.length > 0)
  cache.delete(date)
  cache.set(date, { key, lines })
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value as string
    cache.delete(oldest)
  }
  return lines
}

export async function listDays(levels: readonly LogLevel[]): Promise<LogDayInfo[]> {
  const files = await dayFiles()
  const lk = levelsKey(levels)
  const out: LogDayInfo[] = []
  for (const f of files) {
    let st
    try {
      st = await fsp.stat(f.path)
    } catch {
      continue
    }
    const key = `${st.mtimeMs}:${st.size}`
    const ck = `${f.date}|${lk}`
    const hit = countCache.get(ck)
    let lines: number
    if (hit && hit.key === key) {
      lines = hit.lines
    } else {
      lines = (await loadDayFiltered(f.date, levels)).length
      countCache.set(ck, { key, lines })
    }
    out.push({ date: f.date, lines })
  }
  return out
}

/** 读取某天按级别过滤后的全部行（文件顺序 = 时间正序），带缓存 */
async function loadDayFiltered(date: string, levels: readonly LogLevel[]): Promise<string[]> {
  const raw = await loadDay(date)
  const key = `${date}|${levelsKey(levels)}`
  const hit = filtered.get(key)
  if (hit && hit.src === raw) {
    filtered.delete(key)
    filtered.set(key, hit)
    return hit.lines
  }
  const lines = filterByLevel(raw, levels)
  filtered.delete(key)
  filtered.set(key, { src: raw, lines })
  while (filtered.size > FILTER_CACHE_LIMIT) {
    const oldest = filtered.keys().next().value as string
    filtered.delete(oldest)
  }
  return lines
}

/** 清除某天的全部缓存（删除日志文件时） */
function dropDayCaches(date: string): void {
  cache.delete(date)
  for (const k of [...filtered.keys()]) if (k.startsWith(`${date}|`)) filtered.delete(k)
  for (const k of [...countCache.keys()]) if (k.startsWith(`${date}|`)) countCache.delete(k)
}


/**
 * 读取某天的一段日志。返回顺序为「最新在前」：row 0 = 当天最后一行。
 * offset/limit 按 row 计算。
 */
export async function readDay(
  date: string,
  offset: number,
  limit: number,
  levels: readonly LogLevel[]
): Promise<LogPageResult> {
  if (!DAY_FILE.test(`${date}.log`)) throw new Error(`无效的日期: ${date}`)
  const lines = await loadDayFiltered(date, levels)
  const total = lines.length
  const start = Math.max(0, Math.min(offset, total))
  const end = Math.min(total, start + Math.max(0, limit))
  const rows: string[] = []
  for (let row = start; row < end; row++) rows.push(lines[total - 1 - row])
  return { date, total, offset: start, lines: rows }
}

/**
 * 全量搜索：遍历所有日文件，大小写不敏感匹配（仅搜索所选级别）。
 * 命中按「最新日期在前」排序，每条返回 row（该天内的显示行号），可直接定位。
 */
export async function searchLogs(query: string, levels: readonly LogLevel[]): Promise<LogSearchResult> {
  const q = query.trim().toLowerCase()
  const hits: LogSearchHit[] = []
  if (!q) return { hits, truncated: false }
  let truncated = false
  for (const f of await dayFiles()) {
    const lines = await loadDayFiltered(f.date, levels)
    const total = lines.length
    for (let i = total - 1; i >= 0; i--) {
      if (lines[i].toLowerCase().includes(q)) {
        hits.push({ date: f.date, row: total - 1 - i, text: lines[i] })
        if (hits.length >= SEARCH_HIT_CAP) {
          truncated = true
          break
        }
      }
    }
    if (truncated) break
  }
  return { hits, truncated }
}

/** 删除早于保留窗口的日文件。retentionDays 含当天，例如 60 = 当天及前 59 天 */
export async function cleanupLogs(retentionDays: number): Promise<number> {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - (retentionDays - 1))
  const cutoff = localDate(cutoffDate)
  let removed = 0
  for (const f of await dayFiles()) {
    if (f.date < cutoff) {
      try {
        await fsp.unlink(f.path)
        removed++
        dropDayCaches(f.date)
      } catch (err) {
        log.warn(`delete old log failed: ${f.date}`, err)
      }
    }
  }
  if (removed > 0) log.info(`retention cleanup: removed ${removed} day file(s), keep ${retentionDays} day(s)`)
  return removed
}
