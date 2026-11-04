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

test('导入的旧记录：按 id 判断；Wake/Leto 经历不参与对账（它们不经 xiaoke）', () => {
  const db = openDb(':memory:')
  ep(db, { ago: 9 * 86_400_000, actor: 'erica', content: '很久以前', ref: 'xiaoke:X1', xiaokeId: 'X1' })
  ep(db, { ago: 9 * 86_400_000, actor: 'ai', content: '嗯', ref: 'xiaoke:X2', xiaokeId: 'X2' })
  // Wake 自主消息：我们后端自己写的、不经 xiaoke，不该被对账撤回
  addEpisode(db, { ts: iso(10 * MIN), channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message', content: '到家没', sourceRef: 'wake:msg:r1' })
  // Leto 群聊回复：同理不该被对账碰
  addEpisode(db, { ts: iso(11 * MIN), channel: 'group', scope: 'group', actor: 'ai', kind: 'message', content: '收到', sourceRef: 'leto:reply:xiaoke:t1' })
  const r = reconcile(db, [x('X1', 'user', 0, null)], NOW)
  assert.equal(r.linked, 0, 'wake/leto 不参与关联')
  // X2 之前关联过、现在导出里没了 → xiaoke_deleted；wake/leto 两条保持 retracted_at=NULL
  const st = state(db)
  const wake = st.find(e => e.source_ref === 'wake:msg:r1')
  const leto = st.find(e => e.source_ref === 'leto:reply:xiaoke:t1')
  assert.equal(wake.retract_reason, null, 'wake 消息不被撤回')
  assert.equal(leto.retract_reason, null, 'leto 回复不被撤回')
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
