import { join } from 'path'
import { existsSync } from 'fs'

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/**
 * Windows 文件名清洗：非法字符、控制字符、保留名、尾部点/空格、长度截断。
 * 保留扩展名的情况下按 UTF-8 字节截到 ~200。
 */
export function sanitizeFilename(name: string): string {
  let s = (name || '').trim()
  // 路径分隔符与非法字符
  s = s.replace(/[<>:"/\|?*]/g, '_')
  // 控制字符
  s = s.replace(new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']', 'g'), '')
  // 去掉尾部点/空格（Windows 不允许）
  s = s.replace(/[. ]+$/, '')
  if (!s) s = 'file'
  // 保留名（如 CON.zip 的主名也保留处理）
  const base = s.split('.')[0]
  if (RESERVED.test(base)) s = '_' + s
  // 长度截断（保留扩展名）
  const maxBytes = 200
  if (Buffer.byteLength(s, 'utf-8') > maxBytes) {
    const dot = s.lastIndexOf('.')
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : ''
    let out = ext ? s.slice(0, dot) : s
    while (Buffer.byteLength(out + ext, 'utf-8') > maxBytes && out.length > 1) {
      out = out.slice(0, -1)
    }
    s = out + ext
  }
  if (!s) s = 'file'
  return s
}

/** 同目录文件名冲突时追加 _2 _3 后缀（不破坏扩展名） */
export function withSuffix(name: string, n: number): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return `${name}_${n}`
  return `${name.slice(0, dot)}_${n}${name.slice(dot)}`
}

export function uniquePath(dir: string, filename: string): string {
  let candidate = join(dir, filename)
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(dir, withSuffix(filename, n))
    n++
    if (n > 9999) break
  }
  return candidate
}

/** 当地本地日期 YYYY-MM-DD */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
