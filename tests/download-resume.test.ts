import { it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { preparePartial, responseOffset } from '../src/main/services/downloadResume'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function partial() { const dir = mkdtempSync(join(tmpdir(), 'booth-resume-')); dirs.push(dir); return join(dir, 'asset.part') }
it('reuses only matching versioned partials after restart', () => {
  const path = partial(), identity = { id: 1, etag: 'abc', size: 6 }
  expect(preparePartial(path, identity)).toBe(0)
  writeFileSync(path, 'abc')
  expect(preparePartial(path, identity)).toBe(3)
  expect(preparePartial(path, { ...identity, etag: 'new' })).toBe(0)
  expect(existsSync(path)).toBe(false)
})
it.each([6, 7])('never promotes complete or oversized stale parts (%i)', (size) => {
  const path = partial(), identity = { id: 1, etag: 'abc', size: 6 }
  preparePartial(path, identity); writeFileSync(path, 'a'.repeat(size))
  expect(preparePartial(path, identity)).toBe(0)
  expect(existsSync(path)).toBe(false)
})
it.each([null, 'W/"weak"'])('does not resume without a strong validator (%s)', (etag) => {
  const path = partial(), identity = { id: 1, etag, size: 6 }
  preparePartial(path, identity); writeFileSync(path, 'abc')
  expect(preparePartial(path, identity)).toBe(0)
})
it('restarts on 200 and verifies every 206 range', () => {
  expect(responseOffset(200, null, 3, 6)).toBe(0)
  expect(responseOffset(206, 'bytes 3-5/6', 3, 6)).toBe(3)
  for (const range of [null, 'bytes 0-5/6', 'bytes 3-6/6', 'bytes 3-5/7']) expect(() => responseOffset(206, range, 3, 6)).toThrow()
  expect(() => responseOffset(416, null, 3, 6)).toThrow()
})
