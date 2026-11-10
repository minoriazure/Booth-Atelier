import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: {}
}))
vi.mock('../src/main/util/log', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { extractPageTitle, isLibraryPageHtml } from '../src/main/booth/auth'
import { BoothCookieJar } from '../src/main/booth/cookieJar'

describe('login page detection (language independent whitelist)', () => {
  const page = (title: string) => `<html><head><title>${title}</title></head><body></body></html>`

  it('accepts English and Japanese library titles', () => {
    expect(isLibraryPageHtml(page('Library - BOOTH'))).toBe(true)
    expect(isLibraryPageHtml(page('ライブラリ - BOOTH'))).toBe(true)
  })

  it('rejects login page titles', () => {
    expect(isLibraryPageHtml(page('Sign in - BOOTH'))).toBe(false)
    expect(isLibraryPageHtml(page('ログイン - BOOTH'))).toBe(false)
  })

  it('rejects empty or title-less pages', () => {
    expect(isLibraryPageHtml('')).toBe(false)
    expect(isLibraryPageHtml('<html><body>no title</body></html>')).toBe(false)
  })

  it('extractPageTitle trims whitespace and returns empty string when missing', () => {
    expect(extractPageTitle('<title>  Library - BOOTH \n</title>')).toBe('Library - BOOTH')
    expect(extractPageTitle('<body></body>')).toBe('')
  })
})

describe('BoothCookieJar Netscape parsing', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cookiejar-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads cookies and builds a header for booth.pm URLs', async () => {
    const file = join(dir, 'booth_cookies.txt')
    const future = Math.floor(Date.now() / 1000) + 3600
    writeFileSync(
      file,
      [
        '# Netscape HTTP Cookie File',
        `.booth.pm\tTRUE\t/\tTRUE\t${future}\t_plaza_session\tabc123`,
        `accounts.booth.pm\tFALSE\t/\tFALSE\t0\tsession_flag\txyz`,
        ''
      ].join('\n')
    )
    const jar = new BoothCookieJar(file)
    jar.load()
    expect(jar.count).toBe(2)
    const header = await jar.cookieHeader('https://accounts.booth.pm/library?page=1')
    expect(header).toContain('_plaza_session=abc123')
    expect(header).toContain('session_flag=xyz')
  })

  it('skips malformed lines and empty values', () => {
    const file = join(dir, 'booth_cookies.txt')
    writeFileSync(file, ['short\tline', `.booth.pm\tTRUE\t/\tTRUE\t0\tempty\t`, ''].join('\n'))
    const jar = new BoothCookieJar(file)
    jar.load()
    expect(jar.count).toBe(0)
  })

  it('degrades to empty jar when file is missing', () => {
    const jar = new BoothCookieJar(join(dir, 'missing.txt'))
    jar.load()
    expect(jar.count).toBe(0)
  })

  it('strips #HttpOnly_ prefix and keeps the cookie', async () => {
    const file = join(dir, 'booth_cookies.txt')
    writeFileSync(file, '#HttpOnly_.booth.pm\tTRUE\t/\tTRUE\t0\tsession\tfake')
    const jar = new BoothCookieJar(file)
    jar.load()
    expect(await jar.cookieHeader('https://booth.pm/')).toContain('session=fake')
  })
})
