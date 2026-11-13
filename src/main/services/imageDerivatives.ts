import sharp from 'sharp'
import { statSync } from 'fs'
import { mkdir, writeFile, rename } from 'fs/promises'
import { join } from 'path'

/** 缩略图目标宽度（画廊条、详情页底层占位） */
export const THUMB_WIDTH = 360
/** 预览图目标长边（详情页展示、列表卡片、商品描述） */
export const PREVIEW_LONG_EDGE = 720

/**
 * 用 sharp 从原图生成两层 JPEG（异步，libvips 线程池执行）：
 * - thumb：宽 360（不放大）
 * - preview：长边 720（不放大）
 * 已存在的层跳过；按 EXIF 方向旋转；透明通道压平为白底。
 * 支持 jpg/png/webp/gif/avif（nativeImage 不支持后三者）。
 */
export async function generateDerivatives(src: string, thumbDest: string, previewDest: string): Promise<void> {
  const thumbMissing = !fileOk(thumbDest)
  const previewMissing = !fileOk(previewDest)
  if (!thumbMissing && !previewMissing) return
  await mkdir(join(thumbDest, '..'), { recursive: true })
  await mkdir(join(previewDest, '..'), { recursive: true })

  const base = sharp(src).rotate().flatten({ background: '#ffffff' })
  if (thumbMissing) {
    const buf = await base
      .clone()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer()
    await writeAtomic(thumbDest, buf)
  }
  if (previewMissing) {
    const buf = await base
      .clone()
      .resize({ width: PREVIEW_LONG_EDGE, height: PREVIEW_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer()
    await writeAtomic(previewDest, buf)
  }
}

export function fileOk(p: string): boolean {
  const stat = statSync(p, { throwIfNoEntry: false })
  return !!stat?.isFile() && stat.size > 0
}


async function writeAtomic(dest: string, data: Buffer): Promise<void> {
  const tmp = dest + '.tmp'
  await writeFile(tmp, data)
  await rename(tmp, dest)
}
