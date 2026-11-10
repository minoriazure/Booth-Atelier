import { it, expect } from 'vitest'
import sharp from 'sharp'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { generateDerivatives } from '../src/main/services/imageDerivatives'
it('creates bounded image layers without upscaling and repairs a missing layer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'booth-derivatives-'))
  try {
    const source = join(dir, 'image.png'), thumb = join(dir, 'thumb.jpg'), preview = join(dir, 'preview.jpg')
    await sharp({ create: { width: 1200, height: 1600, channels: 4, background: '#00ff0080' } }).png().toFile(source)
    await generateDerivatives(source, thumb, preview)
    expect((await sharp(thumb).metadata()).width).toBe(360)
    expect((await sharp(preview).metadata()).height).toBe(720)
    rmSync(preview); await generateDerivatives(source, thumb, preview)
    expect((await sharp(preview).metadata()).height).toBe(720)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
