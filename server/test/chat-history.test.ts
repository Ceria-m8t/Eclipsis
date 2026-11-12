import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, addEpisode, type DB } from '../src/db.ts'
import { chatHistory, deleteChat, splitThink, type XiaokeApi } from '../src/chat-history.ts'

let t0 = Date.parse('2026-11-10T00:00:00Z')
function ep(db: DB, actor: string, content: string, o: { kind?: string; ref?: string; meta?: any; xiaokeId?: string; channel?: string } = {}) {
  t0 += 1000
  addEpisode(db, {
    ts: new Date(t0).toISOString(), channel: o.channel || 'chat', scope: 'daily', actor, kind: o.kind || 'message',
    content, meta: o.meta, sourceRef: o.ref ?? `upstream:x:${t0}`, xiaokeId: o.xiaokeId
  })
  return (db.prepare('SELECT max(seq) AS s FROM episodes').get() as any).s as number
}

function fakeXiaoke(records: { id: string; role: string; created_at: string; content: string }[]) {
  const removed: string[] = []
  const api: XiaokeApi = {
    async remove(id) { removed.push(id) },
    async recent() { return records },
  }
  return { api, removed }
}

test('splitThink：闭合的、开头没闭合的都拆出来', () => {
  assert.deepEqual(splitThink('<think>想想</think>\n好呀'), { body: '好呀', think: '想想' })
  assert.deepEqual(splitThink('好<think>还在想'), { body: '好', think: '还在想' })
  assert.deepEqual(splitThink('没有思考'), { body: '没有思考', think: '' })
})

test('历史：她的去掉时间标记、留原文；他的拆思考；工具挂到后面那条回复上；别的频道和撤回的不出现', () => {
  const db = openDb(':memory:')
  ep(db, 'erica', '（2026-11-10 01:31）在吗\n<current_time>2026-11-10</current_time>', { ref: 'front:turn:main:T1:user', meta: { images: ['a'.repeat(64)] } })
  ep(db, 'ai', 'search_web({"q":"天气"})', { kind: 'tool_call', meta: { tool_call_id: 'C1', name: 'search_web', rid: 'R1' } })
  ep(db, 'tool', '晴', { kind: 'tool_result', meta: { tool_call_id: 'C1' } })
  ep(db, 'ai', '<think>她问天气</think>今天晴', { meta: { rid: 'R2', turn: 'T1', version: 0 } })
  ep(db, 'ai', '醒来了', { channel: 'wake' })
  const gone = ep(db, 'erica', '删掉的')
  db.prepare("UPDATE episodes SET retracted_at = 'x' WHERE seq = ?").run(gone)
  const { items, hasMore } = chatHistory(db, {})
  assert.equal(hasMore, false)
  assert.equal(items.length, 2)
  const [u, a] = items
  assert.equal(u!.role, 'user')
  assert.equal(u!.content, '在吗')
  assert.match(u!.raw!, /01:31/)
  assert.equal(u!.source, 'eclipsis')
  assert.deepEqual(u!.images, [`/api/eclipsis/blob/${'a'.repeat(64)}`])
  assert.equal(a!.content, '今天晴')
  assert.equal(a!.versions![0]!.thinking, '她问天气')
  assert.deepEqual(a!.versions![0]!.tools, [{ id: 'C1', name: 'search_web', args: '{"q":"天气"}', result: '晴' }])
  assert.equal(a!.seqs.length, 3, '删的时候工具记录一起删')
})

test('重新生成：同一个 turn 的回复归成一项的几个版本', () => {
  const db = openDb(':memory:')
  ep(db, 'erica', '讲个笑话')
  const first = ep(db, 'ai', '笑话一')
  // Kelivo 来的回复没有 turn：Eclipsis 里重新生成时用 e<seq> 当 turn
  ep(db, 'ai', '笑话二', { meta: { turn: 'e' + first, version: 1 } })
  const { items } = chatHistory(db, {})
  assert.equal(items.length, 2)
  assert.deepEqual(items[1]!.versions!.map(v => v.content), ['笑话一', '笑话二'])
  assert.equal(items[1]!.content, '笑话二')
})

test('翻页：before + limit；after 只给新的', () => {
  const db = openDb(':memory:')
  const seqs: number[] = []
  for (let i = 0; i < 5; i++) seqs.push(ep(db, i % 2 ? 'ai' : 'erica', 'm' + i))
  const last2 = chatHistory(db, { limit: 2 })
  assert.deepEqual(last2.items.map(i => i.content), ['m3', 'm4'])
  assert.equal(last2.hasMore, true)
  const older = chatHistory(db, { before: last2.items[0]!.seq, limit: 10 })
  assert.deepEqual(older.items.map(i => i.content), ['m0', 'm1', 'm2'])
  assert.equal(older.hasMore, false)
  assert.deepEqual(chatHistory(db, { after: seqs[3] }).items.map(i => i.content), ['m4'])
})

test('删：经历表撤回 + 删 xiaoke 里对应的那条（对上号的直接删，没对上的按内容和时间找）', async () => {
  const db = openDb(':memory:')
  const u = ep(db, 'erica', '在吗', { xiaokeId: 'X1' })
  const a = ep(db, 'ai', '在呢\n想你')
  const ts = (db.prepare('SELECT ts FROM episodes WHERE seq = ?').get(a) as any).ts
  const xk = fakeXiaoke([
    { id: 'X1', role: 'user', created_at: ts, content: '在吗' },
    { id: 'X9', role: 'assistant', created_at: '2026-01-01T00:00:00Z', content: '在呢 想你' },   // 时间差太远，不是这条
    { id: 'X2', role: 'assistant', created_at: ts, content: '在呢 想你' },
  ])
  const r = await deleteChat(db, xk.api, [u, a])
  assert.deepEqual(r, { deleted: 2, xiaoke: 2 })
  assert.deepEqual(xk.removed.sort(), ['X1', 'X2'])
  assert.equal(chatHistory(db, {}).items.length, 0)
  const reasons = (db.prepare('SELECT retract_reason FROM episodes').all() as any[]).map(x => x.retract_reason)
  assert.deepEqual(reasons, ['manual', 'manual'])
})

test('删：xiaoke 删失败时经历表不动（不能这边没了他那边还记得）', async () => {
  const db = openDb(':memory:')
  const u = ep(db, 'erica', '在吗', { xiaokeId: 'X1' })
  const api: XiaokeApi = { async remove() { throw new Error('xiaoke 删除失败 HTTP 500') }, async recent() { return [] } }
  await assert.rejects(deleteChat(db, api, [u]), /500/)
  assert.equal(chatHistory(db, {}).items.length, 1)
})

test('删：没配置 xiaoke 时拒绝', async () => {
  const db = openDb(':memory:')
  const u = ep(db, 'erica', '在吗')
  await assert.rejects(deleteChat(db, null, [u]), /XIAOKE/)
})

test('Kelivo 夹带的：记忆注入那条不显示；起标题的请求连同它的回复不显示', () => {
  const db = openDb(':memory:')
  ep(db, 'erica', '以下内容由系统提供，不是用户本轮发送的内容。\n<user_profile/>')
  ep(db, 'erica', '早')
  ep(db, 'ai', '早呀')
  ep(db, 'erica', 'I will give you some dialogue content in the `<content>` block.\n…')
  ep(db, 'ai', '第43窗早安')
  ep(db, 'erica', '吃了吗')
  assert.deepEqual(chatHistory(db, {}).items.map(i => i.content), ['早', '早呀', '吃了吗'])
})

test('删：刚发的在 xiaoke 里还找不到 → 先别删，叫她过一会儿再删', async () => {
  const db = openDb(':memory:')
  addEpisode(db, { ts: new Date().toISOString(), channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: '刚发的', sourceRef: 'front:new' })
  const seq = (db.prepare('SELECT max(seq) AS s FROM episodes').get() as any).s
  await assert.rejects(deleteChat(db, fakeXiaoke([]).api, [seq]), /过一两分钟/)
  assert.equal(chatHistory(db, {}).items.length, 1)
})

test('醒来：发给她的几条归成一项，标上醒来、挂上念头和用过的工具；只留了念头的单独一项（silent）', () => {
  const db = openDb(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS wake_opportunities (id TEXT PRIMARY KEY, tools_used TEXT)')
  db.prepare('INSERT INTO wake_opportunities(id, tools_used) VALUES (?, ?)').run('W1', JSON.stringify(['open_town', 'career']))
  ep(db, 'erica', '晚安')
  ep(db, 'ai', '花园的水浇了。', { ref: 'wake:msg:W1', meta: { wake_id: 'W1' } })
  ep(db, 'ai', '嘴巴好点没有。', { ref: 'wake:msg:W1:2', meta: { wake_id: 'W1' } })
  ep(db, 'ai', '等她醒。', { kind: 'note', channel: 'wake', ref: 'wake:trace:W1', meta: { wake_id: 'W1' } })
  ep(db, 'ai', '今天不吵她。', { kind: 'note', channel: 'wake', ref: 'wake:trace:W2', meta: { wake_id: 'W2' } })
  const { items } = chatHistory(db, {})
  assert.equal(items.length, 3)
  const w = items[1]!
  assert.equal(w.source, 'wake')
  assert.equal(w.content, '花园的水浇了。\n\n嘴巴好点没有。')
  assert.deepEqual(w.wake, { id: 'W1', tools: ['open_town', 'career'], silent: false, trace: '等她醒。' })
  assert.equal(w.seqs.length, 3, '删的时候念头一起删')
  assert.equal(items[2]!.wake!.silent, true)
  assert.equal(items[2]!.wake!.trace, '今天不吵她。')
})

test('他已读不回：认出 [NO_REPLY]；他学着写她的心声格式时剥掉', () => {
  const db = openDb(':memory:')
  ep(db, 'erica', '哼\n\n〔她心里想的，没说出口：快来哄我〕')
  ep(db, 'ai', '<think>她在闹别扭，先晾一会儿</think>[NO_REPLY]')
  ep(db, 'erica', '……')
  ep(db, 'ai', '好了好了。\n\n〔她心里想的，没说出口：学她〕')
  const { items } = chatHistory(db, {})
  assert.equal(items[1]!.noReply, true)
  assert.equal(items[1]!.versions![0]!.thinking, '她在闹别扭，先晾一会儿')
  assert.equal(items[3]!.content, '好了好了。')
  assert.ok(!items[3]!.noReply)
  assert.match(items[0]!.content, /〔她心里想的，没说出口：快来哄我〕/, '她那条原样给前端，前端自己拆')
})

test('负数 seq（从 Kelivo 补回的最早几天）：往上翻能翻到，顺序在第 1 条前面，能删', async () => {
  const db = openDb(':memory:')
  const ins = db.prepare(`INSERT INTO episodes (seq, ts, channel, scope, actor, kind, content, source_ref) VALUES (?, ?, 'chat', 'daily', ?, 'message', ?, ?)`)
  ins.run(-2, '2026-09-25T05:00:00.000Z', 'erica', '最早那句', 'kelivo:a')
  ins.run(-1, '2026-09-25T05:00:10.000Z', 'ai', '最早的回复', 'kelivo:b')
  const one = ep(db, 'erica', '时间线第一条')
  const first = chatHistory(db, { limit: 1 })
  assert.equal(first.items[0]!.content, '时间线第一条')
  assert.equal(first.hasMore, true)
  const older = chatHistory(db, { before: one, limit: 5 })
  assert.deepEqual(older.items.map(i => i.content), ['最早那句', '最早的回复'])
  const oldest = chatHistory(db, { before: -1, limit: 5 })
  assert.deepEqual(oldest.items.map(i => i.content), ['最早那句'])
  assert.equal(oldest.hasMore, false)
  assert.equal(chatHistory(db, { after: -1 }).items.length, 1, 'after 只给更新的')
  const r = await deleteChat(db, null, [-2], { xiaokeHasNewMessages: false })
  assert.equal(r.deleted, 1)
})
