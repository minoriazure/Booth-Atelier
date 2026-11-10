import { it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { allowedFile } from '../src/main/util/pathAccess'
import { settingsPatch } from '../src/main/ipc/settingsSchema'
import { byteRange } from '../src/main/util/byteRange'
import { BoothCookieJar } from '../src/main/booth/cookieJar'
vi.mock('../src/main/util/log', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
it('imports HttpOnly cookies and replaces credentials when switching files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'booth-security-')); dirs.push(dir)
  const first = join(dir, 'first.txt'), second = join(dir, 'second.txt')
  writeFileSync(first, '#HttpOnly_.booth.pm\tTRUE\t/\tTRUE\t0\tsession\tfirst')
  writeFileSync(second, '#HttpOnly_.booth.pm\tTRUE\t/\tTRUE\t0\tsession\tsecond')
  const jar = new BoothCookieJar(first); jar.load()
  expect(await jar.cookieHeader('https://booth.pm/')).toContain('session=first')
  jar.setPath(second); expect(await jar.cookieHeader('https://booth.pm/')).toContain('session=second')
  jar.stopWatch()
})
it('rejects sibling paths, directories and junction escapes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'booth-boundary-')); dirs.push(dir)
  const root = join(dir, 'root'), outside = join(dir, 'root-other'); mkdirSync(root); mkdirSync(outside)
  const file = join(outside, 'secret'); writeFileSync(file, 'safe')
  expect(() => allowedFile(file, [root])).toThrow()
  expect(() => allowedFile(root, [root])).toThrow()
  expect(allowedFile(root, [root], true)).toBeTruthy()
  symlinkSync(outside, join(root, 'escape'), 'junction')
  expect(() => allowedFile(join(root, 'escape', 'secret'), [root])).toThrow()
})
it('rejects unknown, internal and invalid settings before applying anything', () => {
  for (const patch of [{ lastGlobalCheckAt: 'x' }, { downloadRootMissing: false }, { themeAccent: 'red' }, { downloadConcurrency: 0 }, { autoDownloadUpdates: 'yes' }]) {
    expect(settingsPatch.safeParse(patch).success).toBe(false)
  }
  expect(settingsPatch.parse({ themeAccent: '#123aBc', downloadConcurrency: 3 })).toEqual({ themeAccent: '#123aBc', downloadConcurrency: 3 })
})
it('serves bounded and suffix media ranges and rejects invalid ranges', () => {
  expect(byteRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 })
  expect(byteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
  expect(byteRange('bytes=3-', 10)).toEqual({ start: 3, end: 9 })
  for (const range of ['bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=0-1,4-5', 'bytes=-']) expect(byteRange(range, 10)).toBeNull()
})
