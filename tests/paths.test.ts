import { describe, expect, it } from 'vitest'
import { join, resolve } from 'path'
import { Paths, fromStoredPath, toStoredPath } from '../src/main/util/paths'

const base = resolve('C:/BoothTest/app')

describe('toStoredPath / fromStoredPath', () => {
  it('stores paths inside base as relative', () => {
    const abs = join(base, 'downloads', '123', 'current', 'a.zip')
    const stored = toStoredPath(base, abs)
    expect(stored).toBe(join('downloads', '123', 'current', 'a.zip'))
    expect(fromStoredPath(base, stored)).toBe(abs)
  })

  it('keeps absolute path when outside base', () => {
    const outside = resolve('D:/elsewhere/x.zip')
    expect(toStoredPath(base, outside)).toBe(outside)
  })

  it('does not treat sibling prefix as inside base', () => {
    const sibling = resolve('C:/BoothTest/app-other/x.zip')
    expect(toStoredPath(base, sibling)).toBe(sibling)
  })

  it('returns "." for base itself', () => {
    expect(toStoredPath(base, base)).toBe('.')
  })

  it('resolves legacy absolute stored values unchanged', () => {
    const legacy = resolve('E:/old/downloads/9')
    expect(fromStoredPath(base, legacy)).toBe(legacy)
  })
})

describe('Paths settings and local file encoding', () => {
  const dataRoot = join(base, 'data')
  const downloadRoot = join(base, 'downloads')

  it('encodes a download root inside baseDir as relative and decodes back', () => {
    const p = new Paths(dataRoot, downloadRoot, base)
    expect(p.encodeRootSetting(downloadRoot)).toBe('downloads')
    expect(p.decodeRootSetting('downloads')).toBe(downloadRoot)
  })

  it('keeps custom absolute download root absolute when outside baseDir', () => {
    const custom = resolve('F:/Unity/Assets')
    const p = new Paths(dataRoot, downloadRoot, base)
    expect(p.encodeRootSetting(custom)).toBe(custom)
  })

  it('stores local files relative to download root, video relative to data root', () => {
    const p = new Paths(dataRoot, downloadRoot, base)
    const file = join(downloadRoot, '42', 'current', 'x.unitypackage')
    expect(p.toStoredLocal(file)).toBe(join('42', 'current', 'x.unitypackage'))
    expect(p.resolveLocal(p.toStoredLocal(file))).toBe(file)

    const video = join(dataRoot, 'items', '42', 'videos', 'v.mp4')
    expect(p.toStoredDataLocal(video)).toBe(join('items', '42', 'videos', 'v.mp4'))
    expect(p.resolveDataLocal(p.toStoredDataLocal(video))).toBe(video)
  })
})
