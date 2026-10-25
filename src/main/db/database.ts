import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import initSqlJs, { Database } from 'sql.js'
import { createLogger } from '../util/log'

const log = createLogger('db')

/**
 * SQLite (sql.js / WASM) 封装。
 * - 零原生编译（机器上无 VS Build Tools）
 * - 落盘策略：脏标记 + 原子写（tmp + rename），写入前防抖
 * - FTS5 全文搜索可用
 */
export class Db {
  private db!: Database
  private dirty = false
  /** 事务嵌套深度：事务内禁止落盘（export 会关闭重开连接，使事务失效） */
  private txDepth = 0
  private saveTimer: NodeJS.Timeout | null = null

  constructor(
    private filePath: string,
    private wasmPath?: string
  ) {}

  async open(): Promise<void> {
    const SQL = await initSqlJs(
      this.wasmPath
        ? { locateFile: () => this.wasmPath! }
        : undefined
    )
    if (existsSync(this.filePath)) {
      const buf = readFileSync(this.filePath)
      this.db = new SQL.Database(buf)
    } else {
      this.db = new SQL.Database()
    }
    this.migrate()
    this.scheduleSave(true)
    log.info(`db opened: ${this.filePath}`)
  }

  private migrate(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)`)
    const cur = this.db.exec('SELECT MAX(version) AS v FROM schema_migrations')
    const version = cur[0]?.values[0]?.[0] ?? 0
    if (Number(version) < 1) {
      this.db.run(MIGRATION_001)
      this.db.run(`INSERT INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'))`)
      this.markDirty()
      log.info('migrations applied: 001_init')
    }
    if (Number(version) < 2) {
      // 浏览器直下回退链接（deeplink 失败时的兜底通道，zip 包装）
      this.db.run(`ALTER TABLE downloadables ADD COLUMN fallback_url TEXT`)
      this.db.run(`INSERT INTO schema_migrations (version, applied_at) VALUES (2, datetime('now'))`)
      this.markDirty()
      log.info('migrations applied: 002_fallback_url')
    }
    if (Number(version) < 3) {
      this.db.run(MIGRATION_003)
      this.db.run(`INSERT INTO schema_migrations (version, applied_at) VALUES (3, datetime('now'))`)
      this.markDirty()
      log.info('migrations applied: 003_images_videos')
    }
    if (Number(version) < 6) {
      // 队列持久化：排队/下载中的任务重启后恢复（不回退到待下载）
      this.db.run(`ALTER TABLE downloadables ADD COLUMN queued_at TEXT`)
      this.db.run(`INSERT INTO schema_migrations (version, applied_at) VALUES (6, datetime('now'))`)
      this.markDirty()
      log.info('migrations applied: 006_queued_at')
    }
    if (Number(version) < 5) {
      // download_records 按 downloadable 查最新一条（全文件列表/重试）
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_dlrec_dlid ON download_records(downloadable_id, id)`)
      this.db.run(`INSERT INTO schema_migrations (version, applied_at) VALUES (5, datetime('now'))`)
      this.markDirty()
      log.info('migrations applied: 005_dlrec_index')
    }
    if (Number(version) < 4) {
      // 启动自动检查拆分为两个独立开关；旧键作为二者的初始值
      const legacy = this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['autoCheckOnStartup'])
      if (legacy) {
        const v = legacy.value
        for (const k of ['autoSyncLibraryOnStartup', 'autoCheckFilesOnStartup']) {
          const exists = this.get('SELECT key FROM settings WHERE key = ?', [k])
          if (!exists) this.run('INSERT INTO settings (key, value) VALUES (?, ?)', [k, v])
        }
      }
      this.db.run(`INSERT INTO schema_migrations (version, applied_at) VALUES (4, datetime('now'))`)
      this.markDirty()
      log.info('migrations applied: 004_split_startup_settings')
    }
    if (Number(version) < 7) {
      // 免费商品：深链下载时确认不在库中而建立的商品（仅通过深链下载，不参与批量/全局更新）
      this.db.run(`ALTER TABLE items ADD COLUMN is_free INTEGER NOT NULL DEFAULT 0`)
      this.db.run(`INSERT INTO schema_migrations (version, applied_at) VALUES (7, datetime('now'))`)
      this.markDirty()
      log.info('migrations applied: 007_items_is_free')
    }
    if (Number(version) < 8) {
      // 派生图（缩略图/预览图）生成失败次数：达到上限后不再自动重试，手动修复时清零
      this.db.run(`ALTER TABLE item_images ADD COLUMN derivative_attempts INTEGER NOT NULL DEFAULT 0`)
      this.db.run(`INSERT INTO schema_migrations (version, applied_at) VALUES (8, datetime('now'))`)
      this.markDirty()
      log.info('migrations applied: 008_derivative_attempts')
    }
    if (Number(version) < 9) {
      // 派生图状态持久化：启动回填只查状态而不逐个 stat；unknown 表示尚未核实
      this.db.run(`ALTER TABLE item_images ADD COLUMN thumb_status TEXT NOT NULL DEFAULT 'unknown'`)
      this.db.run(`ALTER TABLE item_images ADD COLUMN preview_status TEXT NOT NULL DEFAULT 'unknown'`)
      this.db.run(`ALTER TABLE item_images ADD COLUMN derivative_error TEXT`)
      this.db.run(`INSERT INTO schema_migrations (version, applied_at) VALUES (9, datetime('now'))`)
      this.markDirty()
      log.info('migrations applied: 009_derivative_status')
    }
  }

  exec(sql: string): void {
    this.db.run(sql)
    this.markDirty()
  }

  /** 返回多行 */
  all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params as never[])
      const rows: T[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as T)
      return rows
    } finally {
      stmt.free()
    }
  }

  /** 返回首行 */
  get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  /** INSERT/UPDATE/DELETE，返回变更行数 */
  run(sql: string, params: unknown[] = []): number {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params as never[])
      stmt.step()
      this.markDirty()
      return this.db.getRowsModified()
    } finally {
      stmt.free()
    }
  }

  /** 事务包裹（sql.js 单线程，直接 BEGIN/COMMIT） */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn()
    this.db.run('BEGIN')
    this.txDepth++
    let r: T
    try {
      r = fn()
      this.db.run('COMMIT')
    } catch (e) {
      try {
        this.db.run('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw e
    } finally {
      this.txDepth--
    }
    this.markDirty()
    return r
  }

  private lastFlushAt = 0
  private flushPending = false

  markDirty(): void {
    if (!this.dirty) this.dirtySince = Date.now()
    this.dirty = true
    if (this.txDepth === 0) this.scheduleSave(false)
  }

  /**
   * 落盘节流：防抖 2s，且两次 export 最小间隔 5s、最长 15s 强制落一次。
   * sql.js 每次 export 都在 WASM 堆分配全量副本且不归还——高频 export 会 OOM
   * （图片批量化场景实测：1000+ 次写若每次都 flush 必崩）。
   */
  private scheduleSave(force: boolean): void {
    if (force) {
      if (this.saveTimer) clearTimeout(this.saveTimer)
      this.saveTimer = null
      this.flush()
      return
    }
    if (this.flushPending) return
    const sinceLast = Date.now() - this.lastFlushAt
    const sinceDirtyStart = this.dirtySince ? Date.now() - this.dirtySince : 0
    // 距上次落盘 <5s 且脏龄 <15s → 防抖 2s 后再试
    const delay = sinceLast < 5000 && sinceDirtyStart < 15000 ? 2000 : 0
    if (delay === 0) {
      this.flush()
      return
    }
    this.flushPending = true
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flushPending = false
      this.flush()
    }, delay)
    this.saveTimer.unref?.()
  }

  private dirtySince: number | null = null

  flush(): void {
    if (!this.dirty || !this.db) return
    try {
      const data = this.db.export()
      const buf = Buffer.from(data)
      const tmp = this.filePath + '.tmp'
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(tmp, buf)
      renameSync(tmp, this.filePath)
      this.dirty = false
      this.dirtySince = null
      this.lastFlushAt = Date.now()
    } catch (e) {
      log.error('db flush failed:', e)
    }
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.flush()
    this.db?.close()
  }
}

const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS items (
  item_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  shop_name TEXT,
  thumbnail_url TEXT,
  og_image_url TEXT,
  description_html TEXT NOT NULL DEFAULT '',
  gallery_json TEXT NOT NULL DEFAULT '[]',
  item_url TEXT NOT NULL DEFAULT '',
  is_gift INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_list_at TEXT,
  last_detail_at TEXT,
  absent_count INTEGER NOT NULL DEFAULT 0,
  metadata_hash TEXT
);

CREATE TABLE IF NOT EXISTS downloadables (
  downloadable_id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  variation_id INTEGER,
  order_id INTEGER,
  last_etag TEXT,
  last_size INTEGER,
  last_modified_remote TEXT,
  last_checked_at TEXT,
  local_path TEXT,
  local_size INTEGER,
  local_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'remote',
  FOREIGN KEY (item_id) REFERENCES items(item_id)
);
CREATE INDEX IF NOT EXISTS idx_downloadables_item ON downloadables(item_id);

CREATE TABLE IF NOT EXISTS metadata_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  snapshot_date TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  title TEXT NOT NULL DEFAULT '',
  description_html TEXT NOT NULL DEFAULT '',
  og_image_url TEXT,
  gallery_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_snapshots_item_date ON metadata_snapshots(item_id, snapshot_date);

CREATE TABLE IF NOT EXISTS file_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  downloadable_id INTEGER NOT NULL,
  archived_date TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_path TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  etag TEXT,
  size INTEGER,
  reason TEXT NOT NULL DEFAULT 'update'
);
CREATE INDEX IF NOT EXISTS idx_file_history_item ON file_history(item_id, archived_date);

CREATE TABLE IF NOT EXISTS download_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  downloadable_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  bytes_total INTEGER,
  bytes_done INTEGER,
  error TEXT,
  from_path TEXT,
  to_path TEXT,
  etag_at_download TEXT,
  size_at_download INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 搜索索引表（sql.js 标准构建无 FTS5 模块，用普通表 + LIKE，
-- 几百商品规模下性能足够；title 已有索引）
CREATE TABLE IF NOT EXISTS items_search (
  item_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  shop_name TEXT,
  description_text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_items_search_title ON items_search(title);
`

const MIGRATION_003 = `
-- 商品图片本地化（抓库时直接存本地，详情/图片墙读本地路径）
CREATE TABLE IF NOT EXISTS item_images (
  url TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'gallery',
  filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  bytes INTEGER,
  updated_at TEXT,
  FOREIGN KEY (item_id) REFERENCES items(item_id)
);
CREATE INDEX IF NOT EXISTS idx_item_images_item ON item_images(item_id, kind);

-- 描述内嵌视频（yt-dlp 下载到商品 meta 目录）
CREATE TABLE IF NOT EXISTS item_videos (
  key TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  video_id TEXT NOT NULL,
  url TEXT NOT NULL,
  embed_url TEXT NOT NULL,
  local_path TEXT,
  status TEXT NOT NULL DEFAULT 'remote',
  updated_at TEXT,
  FOREIGN KEY (item_id) REFERENCES items(item_id)
);
CREATE INDEX IF NOT EXISTS idx_item_videos_item ON item_videos(item_id);
`
