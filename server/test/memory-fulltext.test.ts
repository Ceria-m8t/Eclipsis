import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import { syncFulltext, searchFulltext, fulltextStats, tokenize, around, ensureFulltextSchema, contains } from '../src/memory/fulltext.ts'

function say(db: DB, bjTime: string, actor: string, content: string, o: { seq?: number; channel?: string } = {}) {
  const ts = new Date(Date.parse(`${bjTime}+08:00`)).toISOString()
  if (o.seq !== undefined) {
    db.prepare(`INSERT INTO episodes (seq, ts, channel, scope, actor, kind, content) VALUES (?, ?, ?, 'daily', ?, 'message', ?)`)
      .run(o.seq, ts, o.channel ?? 'chat', actor, content)
  } else {
    db.prepare(`INSERT INTO episodes (ts, channel, scope, actor, kind, content) VALUES (?, ?, 'daily', ?, 'message', ?)`)
      .run(ts, o.channel ?? 'chat', actor, content)
  }
}

function seed(): DB {
  const db = openDb(':memory:')
  ensureFulltextSchema(db)
  say(db, '2026-09-25T18:00:00', 'erica', '老公我想吃枇杷', { seq: -2 })       // 补回来的最早四天：seq 是负的
  say(db, '2026-09-25T18:01:00', 'ai', '<think>她想吃枇杷</think>买给你', { seq: -1 })
  say(db, '2026-10-03T16:00:00', 'erica', '我妈中午把我叫醒了')
  say(db, '2026-10-03T16:01:00', 'ai', '那你头疼吗')
  say(db, '2026-11-01T12:00:00', 'erica', '枇杷和海鲜哪个好吃')
  say(db, '2026-11-01T12:01:00', 'ai', '群里的', { channel: 'group' })
  return db
}

test('切词：段内两字一组 + 整个的英文数字词；跨标点不拼；单个汉字也留', () => {
  assert.deepEqual(tokenize('我妈'), ['我妈'])
  assert.deepEqual(tokenize('我妈 妈妈'), ['我妈', '妈妈'], '跨段不拼，不会造出「妈妈妈」')
  assert.ok(tokenize('Ombre Brain 18110').includes('ombre'))
  assert.ok(tokenize('Ombre Brain 18110').includes('18110'))
  assert.deepEqual(tokenize('嗯'), ['嗯'])
  assert.ok(tokenize('10月3日').includes('3日'), '日期不整串去掉：她可能就要搜日期')
})

test('全库搜：两个字的词也搜得到；最早四天（负 seq）也在；念头不算；群聊不算', () => {
  const db = seed()
  const r = syncFulltext(db)
  assert.equal(r.indexed, 5, '群聊那条不索引')
  const pipa = searchFulltext(db, '枇杷')
  assert.equal(pipa.total, 2, '两个字的词搜得到（SQLite 自带的切法搜不到，所以我们自己切）')
  assert.deepEqual(pipa.hits.map(h => h.day), ['2026-11-01', '2026-09-25'], '新的在前')
  assert.equal(pipa.hits[1]!.seq, -2, '补回来的最早四天也搜得到')
  assert.equal(searchFulltext(db, '枇杷', { who: 'her' }).total, 2)
  assert.equal(searchFulltext(db, '枇杷', { who: 'him' }).total, 0, '他那句只在念头里说过枇杷，不算')
  assert.equal(searchFulltext(db, '我妈').total, 1)
  assert.equal(searchFulltext(db, '群里').total, 0, '群聊不进原话')
  assert.equal(searchFulltext(db, '  ').total, 0)
})

test('不要假命中：标点两边的字不许拼起来算命中', () => {
  // 「我妈，妈妈很好」去掉标点会变成「我妈妈妈很好」，看着像有「妈妈妈」——原文里没有
  assert.equal(contains('我妈，妈妈很好', '妈妈妈'), false)
  assert.equal(contains('我妈说妈妈很好', '妈妈妈'), false)
  assert.equal(contains('我妈说妈妈很好', '妈妈'), true)
  assert.equal(contains('她说：我爱你', '说：我'), true, '她自己打了标点就按标点算')
  assert.equal(contains('她说 我爱你', '说我'), false)
  const db = openDb(':memory:')
  say(db, '2026-10-01T10:00:00', 'erica', '我妈，妈妈很好')
  say(db, '2026-10-01T10:01:00', 'ai', '我妈说妈妈很好')
  syncFulltext(db)
  assert.equal(searchFulltext(db, '妈妈妈').total, 0, '原文里不存在的串，一条都不给')
  assert.equal(searchFulltext(db, '妈妈').total, 2)
})

test('几个词都要出现（空格分开），不要求挨着；按日期和说话人筛', () => {
  const db = seed()
  syncFulltext(db)
  assert.equal(searchFulltext(db, '枇杷 海鲜').total, 1)
  assert.equal(searchFulltext(db, '枇杷 头疼').total, 0, '不在同一句里')
  assert.equal(searchFulltext(db, '枇杷', { from: '2026-10-01', to: '2026-12-31' }).total, 1)
  assert.equal(searchFulltext(db, '枇杷', { from: '2026-09-25', to: '2026-09-25' }).total, 1)
})

test('补索引：新消息往上补，补回来的旧记录往下补，重复跑不会重复索引', () => {
  const db = seed()
  syncFulltext(db)
  const before = fulltextStats(db)
  assert.equal(before.behind, 0)
  assert.equal(before.total, 5, '总数只数真的会进索引的那些（群聊不算）')
  assert.equal(syncFulltext(db).indexed, 0, '没有新的就什么都不做')
  say(db, '2026-11-13T08:00:00', 'erica', '新说的一句枇杷')
  say(db, '2026-09-20T08:00:00', 'ai', '更早补回来的', { seq: -9 })
  const r = syncFulltext(db)
  assert.equal(r.indexed, 2)
  assert.equal(fulltextStats(db).indexed, before.indexed + 2)
  assert.equal(searchFulltext(db, '枇杷').total, 3)
  assert.equal(searchFulltext(db, '更早补').total, 1)
  assert.equal(syncFulltext(db).indexed, 0, '再跑一次不重复')
})

test('第一次分批建索引：跑几次补齐', () => {
  const db = seed()
  const first = syncFulltext(db, { batch: 2 })
  assert.equal(first.indexed, 2)
  let guard = 0
  while (syncFulltext(db, { batch: 2 }).indexed > 0 && guard++ < 10) { /* 继续补 */ }
  assert.equal(fulltextStats(db).behind, 0)
  assert.equal(searchFulltext(db, '枇杷').total, 2)
})

test('看一句话的前后：念头剥掉、空的不算', () => {
  const db = seed()
  syncFulltext(db)
  const ctx = around(db, -1, 2)
  assert.ok(ctx.some(h => h.text === '老公我想吃枇杷'))
  assert.ok(ctx.every(h => !h.text.includes('她想吃枇杷')), '念头不给')
})
