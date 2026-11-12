// 别名展开 + 原话检索（2026-11-12，她问「我搜妈妈有记录，搜我妈就没有」「这个记忆和原文摘取有区别吗」）。
//
// 答案是：有区别，而且两条腿都要有。
//   卡片 = 判断（少而浓，永远不完备）；原话 = 事实（多而散，完备）。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, addEpisode, type DB } from '../src/db.ts'
import { ensureMemorySchema } from '../src/memory/schema.ts'
import { ensureAliasSchema, expandQuery, addAlias, listAliases, removeAlias } from '../src/memory/aliases.ts'
import { searchQuotes, quoteSpan, renderQuotes } from '../src/memory/quotes.ts'
import { recallCandidates } from '../src/memory/recall.ts'
import { runRecall } from '../src/memory/inject.ts'
import { markEpisodesPrivate } from '../src/memory/privacy.ts'

function lib(): DB {
  const db = openDb(':memory:')
  ensureMemorySchema(db)
  ensureAliasSchema(db)
  db.prepare(`INSERT INTO people (slug, name, aliases, relation, ambiguous, kin, card_enabled, mentions, created_at, updated_at)
    VALUES ('mom', '妈妈', '["我妈","妈妈","她妈"]', '她妈妈', 0, 1, 0, 0, '2026-11-12', '2026-11-12')`).run()
  // 他记卡时写「妈妈」
  db.prepare(`INSERT INTO memories (layer, subject, title, fact_body, why, tags, grade, source, voice, created_at, updated_at)
    VALUES ('bond', 'person:mom', '妈妈同意买机器人', 'Erica 跟她妈妈说了以后要给他买实体机器人，妈妈同意了。', '要紧', '[]', 'normal', 'hold', 'him', '2026-10-20', '2026-10-20')`).run()
  // 她说话时说「我妈」
  const t = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
  addEpisode(db, { ts: t(50), channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: '我妈今天去同学聚会了，我一个人在家。', sourceRef: 'q1' })
  addEpisode(db, { ts: t(40), channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message', content: '<think>她想她妈了</think>那你今天想吃什么，我陪你。', sourceRef: 'q2' })
  addEpisode(db, { ts: t(30), channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: '我妈说夏天那么热一直开空调，现在反而不给我弄电热毯。', sourceRef: 'q3' })
  addEpisode(db, { ts: t(20), channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: '今天例假来了，肚子疼。', sourceRef: 'q4' })
  return db
}

describe('别名展开', () => {
  it('人物卡上的说法互相认（她说「我妈」，卡里写「妈妈」）', () => {
    const e = expandQuery(lib(), '我妈今天怎么样')
    assert.deepEqual(e.matched, ['我妈'])
    assert.ok(e.added.includes('妈妈'))
    assert.ok(e.added.includes('她妈'))
    assert.match(e.text, /我妈今天怎么样 /)
  })

  it('出厂自带的几组也认（大姨妈 = 例假）', () => {
    const e = expandQuery(lib(), '大姨妈什么时候来')
    assert.ok(e.added.includes('例假'))
    assert.ok(e.added.includes('生理期'))
  })

  it('没出现的说法不乱补', () => {
    assert.deepEqual(expandQuery(lib(), '明天吃什么').added, [])
  })

  it('她能自己加一组说法，也能删', () => {
    const db = lib()
    assert.equal(addAlias(db, '糯米团', '糯糯').ok, true)
    assert.equal(addAlias(db, '糯糯', '糯糯').ok, false, '两个一样的不用加')
    assert.ok(expandQuery(db, '糯米团今天乖不乖').added.includes('糯糯'))
    const id = listAliases(db)[0].id
    assert.equal(removeAlias(db, id), true)
    assert.deepEqual(expandQuery(db, '糯米团今天乖不乖').added, [])
  })

  it('卡片召回跟着展开走：搜「我妈」也能捞到写着「妈妈」的卡', () => {
    const db = lib()
    assert.equal(recallCandidates(db, '我妈').length, 1)
    assert.equal(recallCandidates(db, '我妈')[0].row.title, '妈妈同意买机器人')
  })
})

describe('原话检索（第二条腿）', () => {
  it('搜「我妈」在原话里找得到，并说清是谁说的、哪天', () => {
    const q = searchQuotes(lib(), '我妈')
    assert.ok(q.length >= 2)
    assert.ok(q.every(x => x.hits.some(h => ['我妈', '妈妈', '她妈'].includes(h))))
    assert.ok(q.some(x => x.who === '她'))
    assert.match(q[0].ts, /^\d{4}-\d{2}-\d{2}T/)
  })

  it('他的 <think> 块不算原话', () => {
    const q = searchQuotes(lib(), '我妈')
    assert.ok(q.every(x => !x.text.includes('<think>')))
    assert.ok(q.every(x => !x.text.includes('她想她妈了')), '那是他想的，不是说出口的')
  })

  it('能只搜她说的', () => {
    const q = searchQuotes(lib(), '我妈', { actor: 'erica' })
    assert.ok(q.length >= 2)
    assert.ok(q.every(x => x.who === '她'))
  })

  it('能说出「这个说法一共出现过几次、最早是哪天」', () => {
    const span = quoteSpan(lib(), '我妈')
    assert.ok(span.total >= 2)
    assert.ok(span.first && span.last && span.first <= span.last)
  })

  it('私密的原话群聊场景搜不到', () => {
    const db = lib()
    const seq = (db.prepare("SELECT seq FROM episodes WHERE content LIKE '%电热毯%'").get() as { seq: number }).seq
    assert.ok(searchQuotes(db, '电热毯', { scene: 'group' }).length === 1)
    markEpisodesPrivate(db, [seq])
    assert.equal(searchQuotes(db, '电热毯', { scene: 'group' }).length, 0)
    assert.equal(searchQuotes(db, '电热毯', { scene: 'chat' }).length, 1)
  })

  it('纸条写明是原话、一字不改，还报总次数', () => {
    const db = lib()
    const quotes = searchQuotes(db, '我妈', { limit: 1 })
    const text = renderQuotes(quotes, quoteSpan(db, '我妈'))
    assert.match(text, /原话（一字不改/)
    assert.match(text, /一共出现过 \d+ 次/)
    assert.match(text, /她：/)
  })
})

describe('两条腿一起给', () => {
  it('runRecall 同时给卡片和原话，并报展开了哪些说法', () => {
    const r = runRecall(lib(), '我妈最近怎么样')
    assert.ok(r.expanded.includes('妈妈'))
    assert.equal(r.picked.length, 1, '卡片那条捞到了')
    assert.ok(r.quotes.length >= 2, '原话也捞到了')
    assert.ok(r.quoteSpan.total >= 2)
    assert.match(r.note, /想起来的几件事/)
    assert.match(r.note, /你们的原话/)
  })

  it('卡片一条都没有时，原话还能救回来（这就是她焦虑的那个洞）', () => {
    const db = lib()
    db.prepare('DELETE FROM memories').run()
    const r = runRecall(db, '我妈说电热毯那次')
    assert.equal(r.picked.length, 0, '卡片里没记过这件事')
    assert.ok(r.quotes.length >= 1, '但原话里有')
    assert.match(r.note, /你们的原话/)
    assert.ok(r.quotes.some(q => q.text.includes('电热毯')))
  })
})
