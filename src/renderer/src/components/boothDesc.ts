import type { ItemVideo } from '../../../shared/types'

/** 描述渲染选项：localImages 为远程图片 URL → 本地媒体 URL；videos 为 null 时视频以链接形式呈现（历史快照） */
export interface BoothDescOptions {
  localImages: Record<string, string>
  videos: ItemVideo[] | null
}

/**
 * 把 BOOTH 描述 HTML 转成可渲染的形式（当前描述与历史快照共用）：
 * - 远程图片替换为本地媒体 URL
 * - 视频 iframe：有 videos 时替换为占位（由调用方挂载卡片），否则转为打开原链接的链接
 * - 清理内联事件属性与 script/style
 */
export function buildBoothDescHtml(html: string, opts: BoothDescOptions): string {
  let out = html
  for (const [remote, local] of Object.entries(opts.localImages)) {
    out = out.split(remote).join(local)
    // data-lazy / data-origin 等属性中的实体编码形式
    out = out.split(encodeEntities(remote)).join(local)
  }
  out = out.replace(/<iframe[^>]*src="([^"]+)"[^>]*>[\s\S]*?<\/iframe>/gi, (m, src: string) => {
    const decoded = decodeAttr(src)
    if (!opts.videos) {
      return `<a class="history-video-link" href="${encodeEntities(decoded)}" target="_blank" rel="noreferrer">▶ 历史视频（在浏览器中打开）</a>`
    }
    const v = findVideoBySrc(opts.videos, decoded)
    if (v) return `<div class="video-slot" data-key="${v.key}"></div>`
    // 未知 iframe 保留（如 booth 自家），但加安全限制
    return m.replace(/src=/, 'sandbox="allow-scripts allow-same-origin allow-popups" src=')
  })
  return sanitizeDesc(linkifyText(out))
}

const BARE_URL_RE = /https?:\/\/(?:[^\s<>"'&]|&amp;)+/g
const URL_TRAILING_RE = /(&amp;|[.,;:!?)\]）】。、])+$/i

/** 把文本中未包裹在 <a> 内的裸网址包装为链接（不改动标签与属性） */
export function linkifyText(html: string): string {
  let anchorDepth = 0
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      if (part.startsWith('<')) {
        if (/^<a[\s>]/i.test(part)) anchorDepth++
        else if (/^<\/a\s*>/i.test(part)) anchorDepth = Math.max(0, anchorDepth - 1)
        return part
      }
      if (anchorDepth > 0) return part
      return part.replace(BARE_URL_RE, (raw) => {
        const trail = raw.match(URL_TRAILING_RE)?.[0] ?? ''
        const url = raw.slice(0, raw.length - trail.length)
        if (!url) return raw
        return `<a href="${url}" rel="noreferrer">${url}</a>${trail}`
      })
    })
    .join('')
}


/** 按 src 反查视频 */
export function findVideoBySrc(videos: ItemVideo[], src: string): ItemVideo | null {
  for (const v of videos) {
    if (v.embedUrl === src || v.url === src) return v
    if (src.includes(v.videoId)) return v
  }
  return null
}

export function decodeAttr(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
}

export function encodeEntities(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/** 清理内联脚本与事件属性 */
export function sanitizeDesc(html: string): string {
  if (!html) return ''
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
}
