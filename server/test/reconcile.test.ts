import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, addEpisode, type DB } from '../src/db.ts'
import { reconcile, GRACE_MS, type XiaokeRow } from '../src/reconcile-xiaoke.ts'

const NOW = Date.parse('2026-10-27T14:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const MIN = 60_000

function ep(db: DB, o: { ago: number; actor: string; content: string; kind?: string; ref: string; meta?: any; xiaokeId?: string }) {
  addEpisode(db, {
    ts: iso(o.ago), channel: 'chat', scope: 'daily', actor: o.actor, kind: o.kind || 'message',
    content: o.content, meta: o.meta, sourceRef: o.ref, xiaokeId: o.xiaokeId
  })
}
const state = (db: DB) => db.prepare('SELECT source_ref, xiaoke_id, retract_reason FROM episodes ORDER BY seq').all() as any[]
const x = (id: string, role: string, ago: number, content: string | null): XiaokeRow => ({ id, role, created_at: iso(ago).replace('Z', '+00:00'), content })

test('关联：角色 + 内容（空白不计）+ 时间；同样的话配给时间最近的那条', () => {
  const db = openDb(':memory:')
  ep(db, { ago: 20 * MIN, actor: 'erica', content: '在吗', ref: 'u1' })
  ep(db, { ago: 20 * MIN, actor: 'ai', content: '在呢\n\n想你', ref: 'a1' })
  ep(db, { ago: 5 * MIN, actor: 'erica', content: '在吗', ref: 'u2' })
  const r = reconcile(db, [
    x('X1', 'user', 20 * MIN, '在吗'), x('X2', 'assistant', 20 * MIN, '在呢 想你'), x('X3', 'user', 5 * MIN, '在吗')
  ], NOW)
  assert.equal(r.linked, 3)
  assert.deepEqual(state(db).map(e => e.xiaoke_id), ['X1', 'X2', 'X3'])
})

test('她在 xiaoke 里删了（关联之后）：撤回，连带撤回这条回复里的工具调用和结果', () => {
  const db = openDb(':memory:')
  ep(db, { ago: 30 * MIN, actor: 'erica', content: '放歌', ref: 'u', xiaokeId: 'X1' })
  ep(db, { ago: 30 * MIN, actor: 'ai', content: '放好了', ref: 'a', xiaokeId: 'X2', meta: { rid: 'R' } })
  ep(db, { ago: 30 * MIN, actor: 'ai', kind: 'tool_call', content: 'play()', ref: 'tc', meta: { rid: 'R', tool_call_id: 'C' } })
  ep(db, { ago: 30 * MIN, actor: 'tool', kind: 'tool_result', content: 'ok', ref: 'tr', meta: { tool_call_id: 'C' } })
  const r = reconcile(db, [x('X1', 'user', 30 * MIN, '放歌')], NOW)
  assert.equal(r.retractedDeleted, 1)
  assert.equal(r.cascaded, 2)
  assert.deepEqual(state(db).map(e => e.retract_reason), [null, 'xiaoke_deleted', 'cascade', 'cascade'])
})

test('关联之前就删了 / 失败没进 xiaoke：宽限期内等着，过了才撤回', () => {
  const db = openDb(':memory:')
  ep(db, { ago: GRACE_MS + MIN, actor: 'ai', content: '被删的回复', ref: 'old' })
  ep(db, { ago: 2 * MIN, actor: 'ai', content: '刚回的', ref: 'new' })
  const r = reconcile(db, [x('X9', 'user', 60 * MIN, '别的')], NOW)
  assert.equal(r.retractedMissing, 1)
  assert.equal(r.waiting, 1)
  assert.deepEqual(state(db).map(e => e.retract_reason), ['not_in_xiaoke', null])
})

test('导入的旧记录：按 id 判断；唤醒的回复也能关联', () => {
  const db = openDb(':memory:')
  ep(db, { ago: 9 * 86_400_000, actor: 'erica', content: '很久以前', ref: 'xiaoke:X1', xiaokeId: 'X1' })
  ep(db, { ago: 9 * 86_400_000, actor: 'ai', content: '嗯', ref: 'xiaoke:X2', xiaokeId: 'X2' })
  addEpisode(db, { ts: iso(10 * MIN), channel: 'wake', scope: 'daily', actor: 'ai', kind: 'wake', content: '[NO_ACTION]', sourceRef: 'wake:r' })
  const r = reconcile(db, [x('X1', 'user', 0, null), x('W', 'assistant', 10 * MIN, '[NO_ACTION]')], NOW)
  assert.equal(r.linked, 1)
  assert.deepEqual(state(db).map(e => [e.xiaoke_id, e.retract_reason]), [['X1', null], ['X2', 'xiaoke_deleted'], ['W', null]])
})

test('导出明显不对（远少于已关联的）：不处理，报错', () => {
  const db = openDb(':memory:')
  for (let i = 0; i < 200; i++) ep(db, { ago: 86_400_000, actor: 'erica', content: `m${i}`, ref: `xiaoke:${i}`, xiaokeId: String(i) })
  assert.throws(() => reconcile(db, [x('0', 'user', 0, null)], NOW), /疑似导出失败/)
  assert.equal(state(db).filter(e => e.retract_reason).length, 0)
})

test('dry-run 不写入', () => {
  const db = openDb(':memory:')
  ep(db, { ago: 20 * MIN, actor: 'erica', content: '在吗', ref: 'u1' })
  assert.equal(reconcile(db, [x('X1', 'user', 20 * MIN, '在吗')], NOW, { dryRun: true }).linked, 1)
  assert.equal(state(db)[0].xiaoke_id, null)
})
