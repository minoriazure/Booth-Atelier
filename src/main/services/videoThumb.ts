import { BrowserWindow, nativeImage } from 'electron'
import { writeFileSync } from 'fs'
import { createLogger } from '../util/log'

const log = createLogger('videoThumb')

const MAX_EDGE = 480
const TIMEOUT_MS = 20_000

/** 视频缩略图与视频同目录同名：{videoBase}-thumb.jpg */
export function videoThumbPath(videoPath: string): string {
  return videoPath.replace(/\.[^./\\]+$/, '') + '-thumb.jpg'
}

/**
 * 从本地视频截取封面，不依赖 ffmpeg：
 * 1. 隐藏窗口里用 Chromium 的 <video> 解码（webm/mp4 等）→ 取约 1 秒处一帧 → canvas 输出 JPEG；
 * 2. 失败时回退系统原生缩略图（Windows Shell / macOS QuickLook）；
 * 两者都失败返回 null，渲染层回退纯灰。
 */
export async function generateVideoThumb(videoPath: string): Promise<string | null> {
  const out = videoThumbPath(videoPath)
  try {
    const jpeg = await captureFrameWithChromium(videoPath)
    writeFileSync(out, jpeg)
    log.info(`thumbnail created (chromium): ${out}`)
    return out
  } catch (err) {
    log.warn(`chromium thumbnail failed: ${videoPath}: ${(err as Error).message}`)
  }
  try {
    const img = await nativeImage.createThumbnailFromPath(videoPath, { width: MAX_EDGE, height: MAX_EDGE })
    if (img.isEmpty()) return null
    writeFileSync(out, img.toJPEG(85))
    log.info(`thumbnail created (shell): ${out}`)
    return out
  } catch (err) {
    log.warn(`shell thumbnail failed: ${videoPath}: ${(err as Error).message}`)
    return null
  }
}

/** 视频源走 image-cache 协议（与渲染层播放同源），主进程隐藏窗口里解码取帧 */
async function captureFrameWithChromium(videoPath: string): Promise<Buffer> {
  const src = `image-cache://local/${encodeURIComponent(videoPath)}`
  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 360,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  try {
    await win.loadURL('data:text/html;charset=utf-8,<!doctype html><html><body></body></html>')
    const script = `new Promise((resolve, reject) => {
      const MAX = ${MAX_EDGE}
      const v = document.createElement('video')
      v.muted = true
      v.preload = 'auto'
      v.crossOrigin = 'anonymous'
      let target = 0
      const draw = () => {
        try {
          const w = v.videoWidth, h = v.videoHeight
          if (!w || !h) return reject(new Error('no frame size'))
          const s = Math.min(1, MAX / Math.max(w, h))
          const c = document.createElement('canvas')
          c.width = Math.round(w * s)
          c.height = Math.round(h * s)
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height)
          resolve(c.toDataURL('image/jpeg', 0.85))
        } catch (e) { reject(e) }
      }
      v.onerror = () => reject(new Error('video error ' + (v.error ? v.error.code : '?')))
      v.onloadedmetadata = () => {
        const d = isFinite(v.duration) ? v.duration : 0
        target = d > 0 ? Math.min(1, d / 10) : 0
        if (target > 0) v.currentTime = target
      }
      v.onloadeddata = () => { if (target === 0) draw() }
      v.onseeked = draw
      v.src = ${JSON.stringify(src)}
    })`
    const dataUrl = await withTimeout(win.webContents.executeJavaScript(script) as Promise<string>, TIMEOUT_MS)
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms)
  })
  return Promise.race([p, guard]).finally(() => clearTimeout(timer))
}
