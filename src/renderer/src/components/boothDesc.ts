export interface BoothDescOptions {
  localImages: Record<string, string>
  historical?: boolean
}

/**
 * 把 BOOTH 描述 HTML 转成可渲染的形式（当前描述与历史快照共用）：
 * - 远程图片替换为本地媒体 URL
 * - 视频 iframe：当前说明与历史快照均将嵌入内容转为原始外链
 * - 清理内联事件属性与 script/style
 */
export function buildBoothDescHtml(html: string, opts: BoothDescOptions): string {
  let out = html
  for (const [remote, local] of Object.entries(opts.localImages)) {
    out = out.split(remote).join(local)
    // data-lazy / data-origin 等属性中的实体编码形式
    out = out.split(encodeEntities(remote)).join(local)
  }
  return sanitizeDesc(linkifyText(out), opts.historical ? '历史视频' : '商品视频')
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


export function encodeEntities(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/** 清理内联脚本与事件属性 */
export function sanitizeDesc(html: string, embedLabel?: string): string {
  if (!html) return ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const tags = new Set('p div span section article h1 h2 h3 h4 h5 h6 br hr strong b em i u s del small sub sup blockquote pre code ul ol li dl dt dd a img table thead tbody tfoot tr th td figure figcaption iframe'.split(' '))
  const discard = new Set('script style svg math base link meta object embed form input button textarea select template'.split(' '))
  const web = (value: string): boolean => {
    try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
  }
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase()
    if (!tags.has(tag)) {
      if (discard.has(tag)) el.remove()
      else el.replaceWith(...Array.from(el.childNodes))
      continue
    }
    if (tag === 'iframe' && embedLabel) {
      const src = el.getAttribute('src')
      if (src && web(src)) {
        const link = doc.createElement('a')
        link.className = 'history-video-link'
        link.href = src
        link.target = '_blank'
        link.rel = 'noreferrer noopener'
        link.textContent = `▶ ${embedLabel}（在浏览器中打开）`
        el.replaceWith(link)
      } else {
        el.remove()
      }
      continue
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      const value = attr.value
      const keep = ['class', 'title', 'alt'].includes(name) ||
        (name === 'data-key' && tag === 'div' && /^[\w:-]+$/.test(value)) ||
        (['width', 'height', 'colspan', 'rowspan'].includes(name) && /^\d{1,4}$/.test(value)) ||
        (name === 'href' && tag === 'a' && web(value)) ||
        (name === 'src' && tag === 'img' && (web(value) || value.startsWith('image-cache://local/'))) ||
        (name === 'src' && tag === 'iframe' && /^https:\/\/(www\.youtube\.com|www\.youtube-nocookie\.com|embed\.nicovideo\.jp|player\.vimeo\.com)\//.test(value))
      if (!keep) el.removeAttribute(attr.name)
    }
    if (tag === 'a') { el.setAttribute('rel', 'noreferrer noopener'); el.setAttribute('target', '_blank') }
    if (tag === 'iframe') {
      if (!el.hasAttribute('src')) { el.remove(); continue }
      el.setAttribute('sandbox', 'allow-scripts allow-same-origin')
      el.setAttribute('loading', 'lazy')
    }
    if (tag === 'img') el.setAttribute('loading', 'lazy')
  }
  return doc.body.innerHTML
}
