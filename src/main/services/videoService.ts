import { spawn, execFile } from 'child_process'
import { existsSync, readdirSync, statSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { LibraryRepo } from '../db/repos'
import type { Paths } from '../util/paths'
import { sanitizeFilename } from '../util/filenames'
import { resolveSystemProxy } from '../booth/systemFetch'
import { createLogger } from '../util/log'
import { generateVideoThumb, videoThumbPath } from './videoThumb'

const log = createLogger('videoService')

export interface VideoProgressEvent {
  key: string
  itemId: number
  progress: number // 0-100
  status: 'downloading' | 'downloaded' | 'failed'
  localPath?: string
  error?: string
}

/**
 * 描述内嵌视频下载（用户需求 #2）：
 * - yt-dlp 下载到 {root}/{itemId}/meta/videos/
 * - 先检测 yt-dlp 是否存在（PATH），不存在 → 发事件让 UI 弹提示
 * - 下载成功后 DB 记 local_path，详情页直接嵌本地 <video>
 */
export class VideoService {
  onProgress: ((e: VideoProgressEvent) => void) | null = null
  private ytDlpCache: { checked: boolean; path: string | null } = { checked: false, path: null }
  private active = new Set<string>()
  /** 进行中的缩略图生成任务（按视频文件路径去重，下载完成与详情页补生成可能并发） */
  private thumbJobs = new Map<string, Promise<string | null>>()

  constructor(
    private repo: LibraryRepo,
    private paths: Paths
  ) {}

  /** 检测 yt-dlp（结果缓存；可用 invalidate 重查） */
  checkYtDlp(invalidate = false): Promise<string | null> {
    if (!invalidate && this.ytDlpCache.checked) return Promise.resolve(this.ytDlpCache.path)
    return new Promise((resolve) => {
      // Windows 下 yt-dlp 可能是 .exe/.cmd；execFile 走 PATH 查找
      execFile('yt-dlp', ['--version'], { timeout: 10_000, shell: process.platform === 'win32' }, (err, stdout) => {
        if (err) {
          log.warn('yt-dlp not found:', err.message)
          this.ytDlpCache = { checked: true, path: null }
        } else {
          const v = stdout.trim().split('\n').pop()
          log.info(`yt-dlp found: ${v}`)
          this.ytDlpCache = { checked: true, path: 'yt-dlp' }
        }
        resolve(this.ytDlpCache.path)
      })
    })
  }

  isDownloading(key: string): boolean {
    return this.active.has(key)
  }

  /**
   * yt-dlp 的 --proxy 参数：跟随本程序当前生效代理（设置页三档 system/custom/direct，
   * resolveProxy 反映 setProxy 后的实际值）。DIRECT / 未知 → 不加参数。
   */
  private async resolveProxyArgs(): Promise<string[]> {
    try {
      const raw = await resolveSystemProxy()
      if (!raw || raw === 'DIRECT') return []
      // Chromium 可能返回回退链 "PROXY a:p; SOCKS5 b:p"，取第一个；格式 "PROXY 127.0.0.1:10808"
      const first = raw.split(';')[0].trim()
      const m = /^(PROXY|HTTP|HTTPS|SOCKS5|SOCKS4|SOCKS)\s+(\S+)$/i.exec(first)
      if (!m) return []
      const schemeMap: Record<string, string> = {
        PROXY: 'http',
        HTTP: 'http',
        HTTPS: 'https',
        SOCKS5: 'socks5',
        SOCKS4: 'socks4',
        SOCKS: 'socks5'
      }
      const url = `${schemeMap[m[1].toUpperCase()] || 'http'}://${m[2]}`
      log.info(`yt-dlp proxy: ${url}`)
      return ['--proxy', url]
    } catch {
      return []
    }
  }

  /** 下载单个视频（同一 key 并发去重） */
  async download(key: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    const videos = this.repo.listVideosByItem(this.findItemOfVideo(key))
    const v = videos.find((x) => x.key === key)
    if (!v) return { ok: false, error: '视频不存在' }
    if (this.active.has(key)) return { ok: false, error: '正在下载中' }

    const itemId = this.findItemOfVideo(key)
    const title = this.repo.getItemTitle(itemId)
    const vdesc = `item=#${itemId}${title ? `「${title}」` : ''} video=${v.videoId}`

    const ytdlp = await this.checkYtDlp()
    if (!ytdlp) {
      const error = '未检测到 yt-dlp，请安装并加入 PATH（pip install yt-dlp）'
      this.repo.setVideoStatus(key, 'failed')
      this.onProgress?.({ key, itemId, progress: 0, status: 'failed', error })
      log.warn(`video failed (yt-dlp missing): ${vdesc}`)
      return { ok: false, error }
    }

    const dir = this.paths.videosDir(itemId)
    mkdirSafe(dir)
    // yt-dlp 输出模板：{videoId}.%(ext)s
    const outTpl = join(dir, sanitizeFilename(`${v.videoId}.%(ext)s`))
    const finalBase = join(dir, sanitizeFilename(v.videoId))

    this.active.add(key)
    this.repo.setVideoStatus(key, 'downloading')
    const itemId2 = itemId
    this.onProgress?.({ key, itemId, progress: 0, status: 'downloading' })
    const proxyArgs = await this.resolveProxyArgs()

    return new Promise((resolve) => {
      const args = [
        ...proxyArgs,
        '--no-playlist',
        '--newline',
        '--no-warnings',
        '-o', outTpl,
        v.url
      ]
      log.info(`yt-dlp download: ${vdesc} url=${v.url} → ${dir}`)
      const child = spawn('yt-dlp', args, { shell: process.platform === 'win32' })
      let lastPct = -1
      let stderrTail = ''

      const onLine = (line: string): void => {
        // [download]  42.1% of 10.50MiB ...
        const m = /\[\s*download\s*\]\s+(\d+(?:\.\d+)?)%/.exec(line)
        if (m) {
          const pct = Math.floor(Number(m[1]))
          if (pct !== lastPct) {
            lastPct = pct
            this.onProgress?.({ key, itemId: itemId2, progress: pct, status: 'downloading' })
          }
        }
      }

      let buf = ''
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString('utf-8')
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, idx))
          buf = buf.slice(idx + 1)
        }
      })
      child.stderr.on('data', (d: Buffer) => {
        stderrTail = (stderrTail + d.toString('utf-8')).slice(-2000)
      })

      child.on('error', (err) => {
        this.active.delete(key)
        this.repo.setVideoStatus(key, 'failed')
        this.onProgress?.({ key, itemId: itemId2, progress: 0, status: 'failed', error: err.message })
        log.warn(`video failed (spawn): ${vdesc}: ${err.message}`)
        resolve({ ok: false, error: err.message })
      })

      child.on('close', (code) => {
        this.active.delete(key)
        if (code !== 0) {
          const error = stderrTail.split('\n').filter(Boolean).pop() || `yt-dlp 退出码 ${code}`
          this.repo.setVideoStatus(key, 'failed')
          this.onProgress?.({ key, itemId: itemId2, progress: 0, status: 'failed', error })
          log.warn(`video failed (exit ${code}): ${vdesc}: ${error}`)
          resolve({ ok: false, error })
          return
        }
        // 找到产物文件（mp4/webm/mkv…）
        const file = findDownloaded(dir, finalBase)
        if (!file) {
          this.repo.setVideoStatus(key, 'failed')
          this.onProgress?.({ key, itemId: itemId2, progress: 0, status: 'failed', error: '下载完成但未找到输出文件' })
          log.warn(`video failed (no output file): ${vdesc} dir=${dir}`)
          resolve({ ok: false, error: '未找到输出文件' })
          return
        }
        this.repo.setVideoStatus(key, 'downloaded', file)
        void this.ensureThumbFor(file)
        this.onProgress?.({ key, itemId: itemId2, progress: 100, status: 'downloaded', localPath: file })
        log.info(`video done: ${vdesc} file=${file} (${statSync(file).size} bytes)`)
        resolve({ ok: true, path: file })
      })
    })
  }

  /** 已下载视频的缩略图：已存在直接返回，缺失则从本地视频重新生成；未下载返回 null */
  async ensureThumb(key: string): Promise<string | null> {
    const itemId = this.findItemOfVideo(key)
    const v = this.repo.listVideosByItem(itemId).find((x) => x.key === key)
    if (!v || v.status !== 'downloaded' || !v.localPath || !existsSync(v.localPath)) return null
    return this.ensureThumbFor(v.localPath)
  }

  private ensureThumbFor(videoFile: string): Promise<string | null> {
    const thumb = videoThumbPath(videoFile)
    if (existsSync(thumb)) return Promise.resolve(thumb)
    const running = this.thumbJobs.get(videoFile)
    if (running) return running
    const job = generateVideoThumb(videoFile).finally(() => this.thumbJobs.delete(videoFile))
    this.thumbJobs.set(videoFile, job)
    return job
  }

  /** key → itemId 反查（DB 里 video 行有 item_id，但列表接口没带；直接查） */
  private findItemOfVideo(key: string): number {
    const row = this.repo['db'].get<{ item_id: number }>('SELECT item_id FROM item_videos WHERE key = ?', [key])
    return row?.item_id ?? 0
  }

  /** 详情页拉取时：若 local_path 指向的文件已不存在（被移动），标记回 remote */
  validateLocal(itemId: number): void {
    for (const v of this.repo.listVideosByItem(itemId)) {
      if (v.status === 'downloaded' && (!v.localPath || !existsSync(v.localPath))) {
        // 文件可能就在约定目录里（videoId.*），尝试重新发现
        const dir = this.paths.videosDir(itemId)
        const found = existsSync(dir) ? findDownloaded(dir, join(dir, v.videoId)) : null
        if (found) {
          this.repo.setVideoStatus(v.key, 'downloaded', found)
        } else {
          this.repo.setVideoStatus(v.key, 'remote')
        }
      }
    }
  }
}

function findDownloaded(dir: string, baseNoExt: string): string | null {
  if (!existsSync(dir)) return null
  const wanted = baseNoExt.replace(/\.[^.]+$/, '').split(/[\\/]/).pop()
  try {
    const files = readdirSync(dir)
    const hit = files.find((f) => f.startsWith(String(wanted)) && /\.(mp4|webm|mkv|mov|flv|avi|m4a|mp3|opus|ogg)$/i.test(f))
    return hit ? join(dir, hit) : null
  } catch {
    return null
  }
}

function mkdirSafe(dir: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('fs').mkdirSync(dir, { recursive: true })
}
