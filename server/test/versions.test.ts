import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, addEpisode } from '../src/db.ts'
import { dropSupersededVersions, setActiveVersion, supersededSeqs } from '../src/versions.ts'
import { chatHistory } from '../src/chat-history.ts'
import { loadRecent } from '../src/assembler/history.ts'

// 她说一句 → 他回 v0 → 她重新生成 → 他回 v1；另一轮只有一条
function seed() {
  const db = openDb(':memory:')
  const her = (ts: string, text: string, n: number) =>
    addEpisode(db, { ts, channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: text, meta: { turn: 't' + n }, sourceRef: 'u' + n })
  const his = (ts: string, text: string, n: number, version: number, ref: string) =>
    addEpisode(db, { ts, channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message', content: text, meta: { turn: 't' + n, version, rid: ref }, sourceRef: ref })
  her('2026-11-11T01:00:00.000Z', '在吗', 1)
  his('2026-11-11T01:00:30.000Z', '<think>想想</think>第一版：在。', 1, 0, 'r1a')
  his('2026-11-11T01:01:00.000Z', '第二版：在，怎么了。', 1, 1, 'r1b')
  her('2026-11-11T01:02:00.000Z', '没事', 2)
  his('2026-11-11T01:02:30.000Z', '那就好。', 2, 0, 'r2')
  return db
}

const texts = (msgs: any[]) => msgs.map(m => `${m.role}:${m.content}`)

test('历史里被她丢掉的那版不发给他；没重新生成过的不动', () => {
  const db = seed()
  assert.deepEqual([...supersededSeqs(db)], [2])
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '在吗' },
    { role: 'assistant', content: '第一版：在。' },      // 历史里思考已经被剪过了，照样认得出来
    { role: 'assistant', content: '第二版：在，怎么了。' },
    { role: 'user', content: '没事' },
    { role: 'assistant', content: '那就好。' },
  ]
  const r = dropSupersededVersions(msgs, db)
  assert.equal(r.dropped, 1)
  assert.deepEqual(texts(r.messages), ['system:sys', 'user:在吗', 'assistant:第二版：在，怎么了。', 'user:没事', 'assistant:那就好。'])
  // 没有旧版本时原样返回
  const clean = dropSupersededVersions(msgs, openDb(':memory:'))
  assert.equal(clean.dropped, 0)
  assert.equal(clean.messages, msgs)
})

test('她翻回第一版：他看到的就是第一版', () => {
  const db = seed()
  assert.deepEqual(setActiveVersion(db, 't1', 2), { ok: true, turn: 't1', seq: 2 })
  assert.deepEqual([...supersededSeqs(db)], [3])
  const r = dropSupersededVersions([
    { role: 'assistant', content: '第一版：在。' },
    { role: 'assistant', content: '第二版：在，怎么了。' },
  ], db)
  assert.deepEqual(texts(r.messages), ['assistant:第一版：在。'])
  // 翻回最后一版
  setActiveVersion(db, 't1', 3)
  assert.deepEqual([...supersededSeqs(db)], [2])
  // 不是这一轮的回复不认
  assert.throws(() => setActiveVersion(db, 't1', 5), /没有这条回复/)
  assert.throws(() => setActiveVersion(db, 't9', 2), /没有这条回复/)
})

test('两版文字一样时也只留一条；她删掉算数那条就按剩下的最后一条算', () => {
  const db = openDb(':memory:')
  const add = (seq: number, ts: string, text: string, ref: string) =>
    addEpisode(db, { ts, channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message', content: text, meta: { turn: 't1' }, sourceRef: ref })
  add(1, '2026-11-11T01:00:00.000Z', '一样的话。', 'a')
  add(2, '2026-11-11T01:01:00.000Z', '一样的话。', 'b')
  const r = dropSupersededVersions([{ role: 'user', content: '嗯' }, { role: 'assistant', content: '一样的话。' }, { role: 'assistant', content: '一样的话。' }], db)
  assert.equal(r.dropped, 1)
  assert.deepEqual(texts(r.messages), ['user:嗯', 'assistant:一样的话。'])
  // 她翻到第一条、又把它删了：按剩下的最后一条算，不会一条都不给
  setActiveVersion(db, 't1', 1)
  db.prepare("UPDATE episodes SET retracted_at = '2026-11-11T02:00:00Z' WHERE seq = 1").run()
  assert.equal(supersededSeqs(db).size, 0)
})

test('我们自己拼的历史里也只有算数那版；聊天记录接口标出算数的是第几版', () => {
  const db = seed()
  assert.deepEqual(loadRecent(db).map(r => r.content.slice(0, 5)), ['在吗', '第二版：在', '没事', '那就好。'])
  const one = chatHistory(db, {}).items.find(i => i.turn === 't1')!
  assert.equal(one.versions!.length, 2)
  assert.equal(one.active, 1)
  assert.equal(one.content, '第二版：在，怎么了。')
  setActiveVersion(db, 't1', 2)
  assert.deepEqual(loadRecent(db).map(r => r.content.slice(0, 5)), ['在吗', '<thin', '没事', '那就好。'])
  const back = chatHistory(db, {}).items.find(i => i.turn === 't1')!
  assert.equal(back.active, 0)
  assert.equal(back.content, '第一版：在。')
})
