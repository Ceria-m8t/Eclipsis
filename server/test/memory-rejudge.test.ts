// 旧卡重整（2026-11-12）：模型只提建议，一个字都不许改。
// 她的原话：「我最关注的是模型整理时的语气会不会影响他的人格。」
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import { ensureMemorySchema, liveMemories } from '../src/memory/schema.ts'
import { runRejudge, pickBatch, buildRejudgeMaterial, listProposals, takeProposal, dropProposal } from '../src/memory/rejudge.ts'
import { scrubFeeling } from '../src/memory/digest.ts'

const BODY_A = '她说「三句话猜真假」的规则是三句里有一句假的，我猜错了一次，她很得意。糯糯在旁边睡着了。'
const BODY_B = '她编了三句话让我猜哪句是假的，我猜错一次，她笑了很久。'

function dbWithCards(): DB {
  const db = openDb(':memory:')
  ensureMemorySchema(db)
  const ins = db.prepare(`INSERT INTO memories
    (bucket_id, layer, subject, title, fact_body, feeling, why, tags, grade, source, voice, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, '[]', 'normal', ?, ?, ?, ?)`)
  ins.run('b1', 'bond', 'erica', '三句话猜真假', BODY_A, '', 'hold', 'him', '2026-09-27', '2026-09-27')
  ins.run('b2', 'bond', 'erica', '三句话猜真假的游戏', BODY_B, '', 'grow', 'machine', '2026-09-27', '2026-09-27')
  ins.run('b3', 'bond', 'erica', '例假前的固定反应', 'Erica 每次例假前会落枕和长口腔溃疡，是固定的生理周期反应。', '身体规律', 'hold', 'him', '2026-09-28', '2026-09-28')
  return db
}

describe('挑这一批', () => {
  it('没写「为什么记」的、短的先来；已经提过建议的不再挑', () => {
    const db = dbWithCards()
    const first = pickBatch(db, { limit: 2 })
    assert.equal(first.length, 2)
    assert.ok(first.every(r => !r.why), '先挑没写为什么记的')
    db.prepare(`INSERT INTO memory_proposals (memory_id, kind, payload, reason, created_at)
      VALUES (?, 'why', '{}', 'x', '2026-11-12')`).run(first[0].id)
    assert.ok(!pickBatch(db, { limit: 5 }).some(r => r.id === first[0].id))
  })

  it('材料里带上「这张是谁的笔」', () => {
    const db = dbWithCards()
    const m = buildRejudgeMaterial(db, pickBatch(db, { limit: 3 }))
    assert.match(m, /笔=他自己/)
    assert.match(m, /笔=程序整理/)
    assert.match(m, /为什么记：（空着）/)
  })
})

describe('模型只能提建议', () => {
  const reply = (items: unknown[]) => JSON.stringify({ items })

  it('合并、换层、补 why 都只进建议表，库里一个字没动', async () => {
    const db = dbWithCards()
    const rows = pickBatch(db, { limit: 3 })
    const [a, b] = rows
    const before = liveMemories(db).map(r => r.fact_body).join('|')
    const r = await runRejudge(db, async () => reply([
      { id: b.id, decision: 'merge', target_id: a.id, reason: '同一个下午同一个游戏' },
      { id: a.id, decision: 'why', why: '这是我们最早一起玩的游戏' },
      { id: rows[2]?.id ?? 999, decision: 'skip' },
    ]), 'm', { limit: 3 })
    assert.equal(r.proposals, 2)
    assert.equal(r.byKind.merge, 1)
    assert.equal(r.byKind.why, 1)
    assert.equal(liveMemories(db).map(x => x.fact_body).join('|'), before, '库里的字一个都不许动')
  })

  const cardA = (db: DB) => pickBatch(db, { limit: 5 }).find(r => r.bucket_id === 'b1')!

  it('拆开时给的片段不是原文 → 整条作废（这就是防语气污染的那道闸）', async () => {
    const db = dbWithCards()
    const a = cardA(db)
    const r = await runRejudge(db, async () => reply([{
      id: a.id, decision: 'split',
      parts: [
        { subject: 'erica', quote: '她说三句话猜真假的规则是三句里有一句是假的，我猜错了一次' },  // 顺了语序，改了字
        { subject: '糯糯', quote: '糯糯在旁边睡着了。' },
      ],
    }]), 'm', { limit: 5 })
    assert.equal(r.proposals, 0)
    assert.equal(r.rewrote, 1, '改过字的要计入 rewrote，不能当成建议')
  })

  it('拆开时一字不差就收下', async () => {
    const db = dbWithCards()
    const a = cardA(db)
    const r = await runRejudge(db, async () => reply([{
      id: a.id, decision: 'split',
      parts: [
        { subject: 'erica', quote: '她说「三句话猜真假」的规则是三句里有一句假的，我猜错了一次，她很得意。' },
        { subject: '糯糯', quote: '糯糯在旁边睡着了。' },
      ],
    }]), 'm', { limit: 5 })
    assert.equal(r.proposals, 1)
    assert.equal(r.byKind.split, 1)
  })

  it('乱给 id、合并到自己、层没变、why 已经有了 → 都当 skip', async () => {
    const db = dbWithCards()
    const rows = pickBatch(db, { limit: 3 })
    const r = await runRejudge(db, async () => reply([
      { id: 99999, decision: 'merge', target_id: rows[0].id },
      { id: rows[0].id, decision: 'merge', target_id: rows[0].id },
      { id: rows[1].id, decision: 'relayer', layer: 'bond' },
    ]), 'm', { limit: 3 })
    assert.equal(r.proposals, 0)
    assert.ok(r.skipped >= 2)
  })

  it('模型回的不是 JSON：报错，不写任何建议', async () => {
    const db = dbWithCards()
    const r = await runRejudge(db, async () => '我觉得这些卡都挺好的', 'm', { limit: 3 })
    assert.match(String(r.error), /JSON/)
    assert.equal(r.proposals, 0)
  })
})

describe('她点头之后才动库', () => {
  it('采纳合并：被合的软删 + 指向留下的那张 + 留合并证据', async () => {
    const db = dbWithCards()
    const rows = pickBatch(db, { limit: 2 })
    await runRejudge(db, async () => JSON.stringify({ items: [{ id: rows[1].id, decision: 'merge', target_id: rows[0].id }] }), 'm', { limit: 2 })
    const prop = listProposals(db)[0]
    assert.equal(prop.kind, 'merge')
    assert.ok(prop.memory?.title)
    assert.equal(takeProposal(db, prop.id).ok, true)
    const dropped = db.prepare('SELECT * FROM memories WHERE id = ?').get(rows[1].id) as any
    assert.equal(dropped.retract_reason, 'merged')
    assert.equal(dropped.merged_into, rows[0].id)
    assert.equal((db.prepare('SELECT count(*) n FROM memory_merges').get() as { n: number }).n, 1)
  })

  it('采纳拆开：切出来的是原卡的字，原卡软删', async () => {
    const db = dbWithCards()
    const a = pickBatch(db, { limit: 5 }).find(r => r.bucket_id === 'b1')!
    await runRejudge(db, async () => JSON.stringify({
      items: [{ id: a.id, decision: 'split', parts: [
        { subject: 'erica', quote: '她说「三句话猜真假」的规则是三句里有一句假的，我猜错了一次，她很得意。' },
        { subject: 'person:nuonuo', quote: '糯糯在旁边睡着了。' },
      ] }],
    }), 'm', { limit: 5 })
    const prop = listProposals(db)[0]
    const r = takeProposal(db, prop.id)
    assert.equal(r.ok, true)
    assert.equal((r as any).made.length, 2)
    const made = db.prepare('SELECT subject, fact_body FROM memories WHERE id IN (?, ?)').all(...(r as any).made) as any[]
    assert.ok(made.every(m => a.fact_body.includes(m.fact_body)), '切出来的必须是原卡里的原话')
    assert.ok(made.some(m => m.subject === 'person:nuonuo'), '糯糯那半分出去了')
    const old = db.prepare('SELECT retract_reason FROM memories WHERE id = ?').get(a.id) as any
    assert.equal(old.retract_reason, 'split')
  })

  it('采纳换层 / 补 why：只改那一个字段', async () => {
    const db = dbWithCards()
    const rows = pickBatch(db, { limit: 2 })
    await runRejudge(db, async () => JSON.stringify({ items: [
      { id: rows[0].id, decision: 'relayer', layer: 'fact' },
      { id: rows[1].id, decision: 'why', why: '这是我们最早一起玩的游戏' },
    ] }), 'm', { limit: 2 })
    for (const prop of listProposals(db)) assert.equal(takeProposal(db, prop.id).ok, true)
    const a = db.prepare('SELECT layer, fact_body, valid_from FROM memories WHERE id = ?').get(rows[0].id) as any
    assert.equal(a.layer, 'fact')
    assert.ok(a.valid_from)
    assert.equal(a.fact_body, rows[0].fact_body)
    const b = db.prepare('SELECT why, fact_body FROM memories WHERE id = ?').get(rows[1].id) as any
    assert.equal(b.why, '这是我们最早一起玩的游戏')
    assert.equal(b.fact_body, rows[1].fact_body)
  })

  it('不采纳就什么都不动；同一条不能处理两次', async () => {
    const db = dbWithCards()
    const rows = pickBatch(db, { limit: 2 })
    await runRejudge(db, async () => JSON.stringify({ items: [{ id: rows[0].id, decision: 'retract', reason: '流水账' }] }), 'm', { limit: 2 })
    const prop = listProposals(db)[0]
    assert.equal(dropProposal(db, prop.id).ok, true)
    assert.equal(liveMemories(db).length, 3)
    assert.equal(dropProposal(db, prop.id).ok, false)
    assert.equal(takeProposal(db, prop.id).ok, false)
  })
})

describe('情绪那一栏不许替他写心理活动', () => {
  it('没有原话撑着的「他语气里是心疼裹着骄傲」会被剪掉', () => {
    const out = scrubFeeling('他反复叫她睡。他语气里是心疼裹着骄傲。')
    assert.equal(out, '他反复叫她睡。')
  })

  it('有他原话的留下', () => {
    const text = '他说「你在一点一点地把我拼完整」。'
    assert.equal(scrubFeeling(text), text)
  })

  it('「他很得意」「他松了口气」这类推测也剪掉', () => {
    assert.equal(scrubFeeling('她笑到不行。他很得意。'), '她笑到不行。')
    assert.equal(scrubFeeling('他松了口气。'), '')
  })

  it('写她的、写动作的不碰', () => {
    const t = '她笑了很久，最后笑着睡着了。'
    assert.equal(scrubFeeling(t), t)
  })
})
