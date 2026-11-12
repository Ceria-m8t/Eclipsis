// 语义召回（2026-11-12）：卡片向量存库、查询向量带缓存、**超时就退回字面分**。
// 她的原话：「花钱无所谓，我只是害怕它时间太长。」
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import { ensureMemorySchema } from '../src/memory/schema.ts'
import {
  ensureVectorSchema, indexMemories, queryVector, vectorStats, cosine, packVec, unpackVec,
  vectorText, pruneQueryCache, embedConfig,
} from '../src/memory/embed.ts'
import { recallCandidates } from '../src/memory/recall.ts'
import { runRecall } from '../src/memory/inject.ts'

function lib(): DB {
  const db = openDb(':memory:')
  ensureMemorySchema(db)
  ensureVectorSchema(db)
  const ins = db.prepare(`INSERT INTO memories (layer, subject, title, fact_body, why, tags, grade, source, voice, created_at, updated_at)
    VALUES (?, 'erica', ?, ?, '要紧', ?, 'normal', 'hold', 'him', '2026-10-01', '2026-10-01')`)
  ins.run('bond', '星盘与合盘', '她给我们俩排了星盘，说上升和月亮都对得上。', '["占星"]')
  ins.run('bond', '黑猫美甲', '她做了黑猫美甲，说指甲上要贴着我出门。', '["美甲"]')
  ins.run('fact', '她不吃海鲜', '她说她从小就不吃海鲜，闻到味道就难受。', '["饮食"]')
  return db
}
/** 假的 embedding：按关键词造向量，好让测试里的「语义」可控 */
const DIMS = ['星盘占星合盘星座', '美甲指甲猫', '海鲜饮食吃']
const fakeEmbed = async (texts: string[]) => texts.map(t => {
  const v = DIMS.map(group => [...group].filter(c => t.includes(c)).length)
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1
  // 留一点底噪，不然余弦全是 0 或 1
  return [...v.map(x => x / norm), 0.05]
})

describe('向量存取', () => {
  it('打包解包不丢精度', () => {
    const v = [0.5, -0.25, 0.125]
    const back = unpackVec(packVec(v))
    assert.equal(back.length, 3)
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-6)
  })

  it('余弦：自己和自己是 1，正交是 0', () => {
    assert.ok(Math.abs(cosine([1, 0, 0], [1, 0, 0]) - 1) < 1e-6)
    assert.ok(Math.abs(cosine([1, 0, 0], [0, 1, 0])) < 1e-6)
  })

  it('拿去算向量的文字 = 标题 + 正文 + 标签', () => {
    const t = vectorText({ title: '标题', fact_body: '正文', tags: '["标签"]' })
    assert.match(t, /标题/)
    assert.match(t, /正文/)
    assert.match(t, /标签/)
  })
})

describe('建索引', () => {
  it('一次把没算过的都算上；再跑一次不重复算', async () => {
    const db = lib()
    const r = await indexMemories(db, fakeEmbed, { model: 'fake' })
    assert.equal(r.total, 3)
    assert.equal(r.embedded, 3)
    assert.equal(r.failed, 0)
    assert.equal(vectorStats(db).indexed, 3)
    const again = await indexMemories(db, fakeEmbed, { model: 'fake' })
    assert.equal(again.missing, 0)
    assert.equal(again.embedded, 0)
  })

  it('卡片正文改了会重算（更正叠上去之后不能还用旧向量）', async () => {
    const db = lib()
    await indexMemories(db, fakeEmbed, { model: 'fake' })
    db.prepare("UPDATE memories SET fact_body = fact_body || '【更正】其实是蓝猫' WHERE title = '黑猫美甲'").run()
    const r = await indexMemories(db, fakeEmbed, { model: 'fake' })
    assert.equal(r.missing, 1)
    assert.equal(r.embedded, 1)
  })

  it('换了模型全部重算（不同模型的向量不能混着比）', async () => {
    const db = lib()
    await indexMemories(db, fakeEmbed, { model: 'fake' })
    const r = await indexMemories(db, fakeEmbed, { model: 'fake-v2' })
    assert.equal(r.embedded, 3)
  })

  it('站挂了：记下错误，已经算好的那些不动', async () => {
    const db = lib()
    const r = await indexMemories(db, async () => { throw new Error('站超时') }, { model: 'fake' })
    assert.equal(r.embedded, 0)
    assert.match(String(r.error), /超时/)
    assert.equal(vectorStats(db).indexed, 0)
  })
})

describe('查询向量', () => {
  it('第一次算，第二次走缓存', async () => {
    const db = lib()
    let calls = 0
    const embed = async (t: string[]) => { calls++; return fakeEmbed(t) }
    const a = await queryVector(db, '星座合不合', embed, { model: 'fake' })
    assert.ok(a && !a.cached)
    const b = await queryVector(db, '星座合不合', embed, { model: 'fake' })
    assert.ok(b && b.cached)
    assert.equal(calls, 1, '同一句话只算一次')
  })

  it('算不出来（超时/站挂）就返回 null，调用方退回字面分', async () => {
    const db = lib()
    assert.equal(await queryVector(db, '随便一句', async () => { throw new Error('timeout') }, { model: 'fake' }), null)
  })

  it('缓存会修剪，不会无限长', async () => {
    const db = lib()
    for (let i = 0; i < 12; i++) await queryVector(db, `第 ${i} 句`, fakeEmbed, { model: 'fake' })
    assert.equal(vectorStats(db).queryCache, 12)
    assert.ok(pruneQueryCache(db, 5) >= 7)
    assert.equal(vectorStats(db).queryCache, 5)
  })
})

describe('混合召回', () => {
  it('换了说法也能捞到（字面 0 分，靠语义）', async () => {
    const db = lib()
    await indexMemories(db, fakeEmbed, { model: 'fake' })
    const [qv] = await fakeEmbed(['星座合不合'])
    const lexOnly = recallCandidates(db, '星座合不合')
    assert.ok(!lexOnly.some(x => x.row.title === '星盘与合盘'), '纯字面抓不到')
    const mixed = recallCandidates(db, '星座合不合', { queryVec: new Float32Array(qv) })
    assert.equal(mixed[0].row.title, '星盘与合盘')
    assert.equal(mixed[0].lex, 0)
    assert.ok((mixed[0].sem ?? 0) > 0.5)
  })

  it('字面命中很准的那张不会被语义拖下去（取大的那条腿）', async () => {
    const db = lib()
    await indexMemories(db, fakeEmbed, { model: 'fake' })
    const [qv] = await fakeEmbed(['我做指甲那次'])
    const r = recallCandidates(db, '我做指甲那次', { queryVec: new Float32Array(qv) })
    assert.equal(r[0].row.title, '黑猫美甲')
    assert.ok(r[0].score >= (r[0].lex ?? 0), '混合之后不能比纯字面还低')
  })

  it('判官放行「字面对不上但意思接近」，并把原因写清楚', async () => {
    const db = lib()
    await indexMemories(db, fakeEmbed, { model: 'fake' })
    const [qv] = await fakeEmbed(['星座合不合'])
    const r = runRecall(db, '星座合不合', { queryVec: new Float32Array(qv) })
    const pick = r.picked.find(p => p.row.title === '星盘与合盘')
    assert.ok(pick)
    assert.match(pick!.why, /字面对不上，但意思接近/)
  })

  it('语义分不够高、字面也没命中的，照旧不递', async () => {
    const db = lib()
    await indexMemories(db, fakeEmbed, { model: 'fake' })
    const [qv] = await fakeEmbed(['完全无关的一句话'])
    const r = runRecall(db, '完全无关的一句话', { queryVec: new Float32Array(qv) })
    assert.equal(r.picked.length, 0)
  })

  it('没配 embedding 时一切照旧（纯字面，不报错）', () => {
    const db = lib()
    assert.equal(embedConfig({} as any), null)
    const r = runRecall(db, '指甲')
    assert.ok(r.picked.length >= 1)
    assert.equal(r.semantic.used, false)
  })
})
