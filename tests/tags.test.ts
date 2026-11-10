import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Db } from '../src/main/db/database'
import { LibraryRepo } from '../src/main/db/repos'

vi.mock('../src/main/util/log', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }))

let db: Db
let repo: LibraryRepo
let dir: string
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'booth-tags-'))
  db = new Db(join(dir, 'test.db'), resolve('node_modules/sql.js/dist/sql-wasm.wasm'))
  await db.open()
  repo = new LibraryRepo(db)
  db.run('INSERT INTO items (item_id, title) VALUES (1, ?)', ['Test'])
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('tag persistence and validation', () => {
  it('enforces the global limit without modifying existing tags', () => {
    for (let i = 0; i < 32; i++) repo.createTag(`tag ${i}`)
    expect(() => repo.createTag('extra')).toThrow('上限')
    expect(repo.listTags()).toHaveLength(32)
  })
  it('rejects empty, overlong and case-insensitive duplicate names on create and rename', () => {
    expect(() => repo.createTag('  ')).toThrow()
    expect(() => repo.createTag('x'.repeat(65))).toThrow('64')
    const first = repo.createTag('  ÄBC  ')
    expect(first.name).toBe('ÄBC')
    expect(() => repo.createTag('äbc')).toThrow('已存在')
    const second = repo.createTag('Other')
    expect(() => repo.renameTag(second.id, 'äbc')).toThrow('已存在')
    expect(() => repo.renameTag(first.id, 'x'.repeat(65))).toThrow('64')
    expect(repo.renameTag(first.id, 'äbc').name).toBe('äbc')
  })
  it('rejects excess and invalid associations atomically, and deduplicates IDs', () => {
    const ids = Array.from({ length: 9 }, (_, i) => repo.createTag(`t${i}`).id)
    repo.setItemTags(1, ids.slice(0, 8))
    expect(() => repo.setItemTags(1, ids)).toThrow('最多 8')
    expect(() => repo.setItemTags(1, [ids[0], 99999])).toThrow('不存在')
    expect(repo.getItemDetail(1)?.tags).toHaveLength(8)
    expect(() => repo.setItemTags(999, [ids[0]])).toThrow('不存在')
    expect(repo.setItemTags(1, [ids[0], ids[0]])).toHaveLength(1)
    expect(repo.listSummaries()[0].tags).toHaveLength(1)
  })
  it('removes associations on tag or item deletion and keeps counts correct', () => {
    const a = repo.createTag('a')
    const b = repo.createTag('b')
    repo.setItemTags(1, [a.id, b.id])
    expect(repo.listTags().map((t) => t.itemCount)).toEqual([1, 1])
    repo.deleteTag(a.id)
    expect(repo.getItemDetail(1)?.tags.map((t) => t.id)).toEqual([b.id])
    repo.deleteItemRows(1)
    expect(repo.listTags()[0].itemCount).toBe(0)
    expect(db.all('SELECT * FROM item_tags')).toHaveLength(0)
  })
  it('keeps tags across reopening and does not reapply migration 11', async () => {
    const tag = repo.createTag('saved')
    repo.setItemTags(1, [tag.id])
    db.close()
    db = new Db(join(dir, 'test.db'), resolve('node_modules/sql.js/dist/sql-wasm.wasm'))
    await db.open()
    repo = new LibraryRepo(db)
    expect(repo.getItemDetail(1)?.tags).toEqual([tag])
    expect(db.all('SELECT * FROM schema_migrations WHERE version = 11')).toHaveLength(1)
  })
})
