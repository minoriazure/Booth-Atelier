import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: {}
}))
vi.mock('../src/main/util/log', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { parseItemImportUrl } from '../src/main/protocol'
import { parseItemImportLocation } from '../src/main/booth/deeplink'

const S3 = 'https://s6.booth.pm/abc-uuid/f/1234/5678/My%20Asset_v2.unitypackage?X-Amz-Expires=180&X-Amz-Signature=sig'

describe('parseItemImportUrl', () => {
  it('rejects non-protocol strings', () => {
    expect(parseItemImportUrl('https://booth.pm/x')).toBeNull()
  })

  it('parses form A (import with dlurls[] and filenames[])', () => {
    const raw =
      `booth-library-manager://import?item_id=1234&order_id=9&variation_id=77` +
      `&dlurls%5B%5D=${encodeURIComponent(S3)}&filenames%5B%5D=${encodeURIComponent('My Asset_v2.unitypackage')}`
    const r = parseItemImportUrl(raw)
    expect(r).not.toBeNull()
    expect(r!.itemId).toBe(1234)
    expect(r!.orderId).toBe(9)
    expect(r!.variationId).toBe(77)
    expect(r!.files).toHaveLength(1)
    expect(r!.files[0].filename).toBe('My Asset_v2.unitypackage')
    expect(r!.files[0].downloadableId).toBe(5678)
    expect(r!.files[0].itemId).toBe(1234)
  })

  it('falls back to filename from dlurl path when filenames[] is missing', () => {
    const raw = `booth-library-manager://import?item_id=1234&dlurls[]=${encodeURIComponent(S3)}`
    const r = parseItemImportUrl(raw)
    expect(r!.files[0].filename).toBe('My Asset_v2.unitypackage')
  })

  it('pairs multiple dlurls with filenames by index', () => {
    const second = 'https://s6.booth.pm/u/f/1234/5679/second.zip?X-Amz-Signature=s2'
    const raw =
      `booth-library-manager://import?item_id=1234` +
      `&dlurls[]=${encodeURIComponent(S3)}&dlurls[]=${encodeURIComponent(second)}` +
      `&filenames[]=a.unitypackage&filenames[]=b.zip`
    const r = parseItemImportUrl(raw)!
    expect(r.files.map((f) => [f.downloadableId, f.filename])).toEqual([
      [5678, 'a.unitypackage'],
      [5679, 'b.zip']
    ])
  })

  it('parses form B (item-import with single dlurl)', () => {
    const raw =
      `booth-library-manager://item-import?dlurl=${encodeURIComponent(S3)}` +
      `&downloadable_filename=${encodeURIComponent('Named.zip')}&item_id=1234&order_id=3`
    const r = parseItemImportUrl(raw)!
    expect(r.itemId).toBe(1234)
    expect(r.orderId).toBe(3)
    expect(r.files[0].filename).toBe('Named.zip')
    expect(r.files[0].downloadableId).toBe(5678)
  })

  it('returns null when item id cannot be determined', () => {
    expect(parseItemImportUrl('booth-library-manager://import?dlurls[]=https%3A%2F%2Fexample.com%2Fx')).toBeNull()
  })
})

describe('parseItemImportLocation (deeplink 302 Location)', () => {
  it('extracts dlurl, filename, ids', () => {
    const loc =
      `booth-library-manager://item-import?dlurl=${encodeURIComponent(S3)}` +
      `&downloadable_filename=Named.zip&item_id=1234&order_id=3&variation_id=77`
    expect(parseItemImportLocation(loc, 5678)).toEqual({
      dlurl: S3,
      filename: 'Named.zip',
      itemId: 1234,
      orderId: 3,
      variationId: 77
    })
  })

  it('uses fallback filename when downloadable_filename is absent', () => {
    const loc = `booth-library-manager://item-import?dlurl=${encodeURIComponent(S3)}&item_id=1234`
    expect(parseItemImportLocation(loc, 5678).filename).toBe('downloadable_5678')
  })

  it('throws on wrong protocol', () => {
    expect(() => parseItemImportLocation('https://booth.pm/x?dlurl=a', 1)).toThrow(/非预期的协议/)
  })

  it('throws when dlurl is missing', () => {
    expect(() => parseItemImportLocation('booth-library-manager://item-import?item_id=1', 1)).toThrow(/缺少 dlurl/)
  })
})
