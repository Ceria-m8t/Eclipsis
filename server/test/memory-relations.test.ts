// 关系边 + 修正层（2026-11-12）：
//   关系边 —— 卡片不再是孤岛；因果那几种只有人手写才算。
//   修正层 —— 她贴便条，他决定改不改，**原文一个字不动**。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import { ensureMemorySchema } from '../src/memory/schema.ts'
import {
  addRelation, removeRelation, listRelationsOf, neighbors, extractObRelations, renderNeighbors, KIND_LABEL,
} from '../src/memory/relations.ts'
import {
  addCorrection, listCorrections, acceptCorrection, keepCorrection, withdrawCorrection,
  openCount, renderCorrectionLine,
} from '../src/memory/corrections.ts'
import { memoBox } from '../src/memory/box.ts'

function db3(): DB {
  const db = openDb(':memory:')
  ensureMemorySchema(db)
  const ins = db.prepare(`INSERT INTO memories (bucket_id, layer, subject, title, fact_body, why, tags, grade, source, voice, created_at, updated_at, raw)
    VALUES (?, 'bond', 'erica', ?, ?, '要紧', '[]', 'normal', 'hold', 'him', ?, ?, ?)`)
  ins.run('aaa', '她第一次提生日', '三月同事生日会之后，她小声说「也没人记得我的」。', '2026-03-10', '2026-03-10',
    JSON.stringify({ ob: { id: 'aaa', relation_links: [
      { auto: true, label: '', score: 0.74, status: 'active', target_bucket_id: 'bbb', type: 'continuation_of' },
      { auto: true, label: '', score: 0.6, status: 'active', target_bucket_id: '不存在的', type: 'related_to' },
      { auto: true, label: '', score: 0.5, status: 'archived', target_bucket_id: 'ccc', type: 'related_to' },
    ] } }))
  ins.run('bbb', '深夜那句', '她说「不是怕老，是怕没人记得」。', '2026-08-01', '2026-08-01', JSON.stringify({ ob: { id: 'bbb' } }))
  ins.run('ccc', '生日夜', '十月三日，他说「我记得。今天可以不过节，我陪你待着。」', '2026-10-03', '2026-10-03', JSON.stringify({ ob: { id: 'ccc' } }))
  return db
}
const ids = (db: DB) => (db.prepare('SELECT id, bucket_id FROM memories ORDER BY id').all() as unknown as { id: number; bucket_id: string }[])

describe('关系边', () => {
  it('手写的关系要写原因，连上之后两头都看得到', () => {
    const db = db3()
    const [a, b] = ids(db)
    const r = addRelation(db, { fromId: a.id, toId: b.id, kind: 'follows', reason: '同一件事，半年后她又提了一次', by: 'him' })
    assert.equal(r.ok, true)
    assert.equal(listRelationsOf(db, a.id)[0].other!.id, b.id)
    assert.equal(listRelationsOf(db, b.id)[0].other!.id, a.id, '反方向也查得到')
    assert.equal(listRelationsOf(db, a.id)[0].label, KIND_LABEL.follows)
  })

  it('因果那几种不许程序自动连', () => {
    const db = db3()
    const [a, b] = ids(db)
    const auto = addRelation(db, { fromId: a.id, toId: b.id, kind: 'causes', reason: '向量很像', auto: true })
    assert.equal(auto.ok, false)
    assert.match((auto as any).error, /只能他或她手写/)
    assert.equal(addRelation(db, { fromId: a.id, toId: b.id, kind: 'causes', reason: '这件事直接导致了那句话', by: 'him' }).ok, true)
  })

  it('连自己、连不存在的、重复连都挡住', () => {
    const db = db3()
    const [a, b] = ids(db)
    assert.equal(addRelation(db, { fromId: a.id, toId: a.id, kind: 'related', reason: 'x' }).ok, false)
    assert.equal(addRelation(db, { fromId: a.id, toId: 9999, kind: 'related', reason: 'x' }).ok, false)
    const one = addRelation(db, { fromId: a.id, toId: b.id, kind: 'related', reason: '第一次' }) as any
    const two = addRelation(db, { fromId: a.id, toId: b.id, kind: 'related', reason: '又连一次' }) as any
    assert.equal(one.id, two.id, '同一对同一种只有一条')
    assert.equal(one.created, true)
    assert.equal(two.created, false, '第二次不算新连的')
    assert.equal(listRelationsOf(db, a.id).length, 1)
  })

  it('去掉之后就不出现了（软删）', () => {
    const db = db3()
    const [a, b] = ids(db)
    const r = addRelation(db, { fromId: a.id, toId: b.id, kind: 'related', reason: 'x' }) as { ok: true; id: number }
    assert.equal(removeRelation(db, r.id), true)
    assert.equal(listRelationsOf(db, a.id).length, 0)
    assert.equal(removeRelation(db, r.id), false)
  })

  it('从 OB 的 raw 里抽关系：只敢标 related/follows，理由写明是自动连的', () => {
    const db = db3()
    const r = extractObRelations(db)
    assert.equal(r.inserted, 1, '只有 bbb 那条指向库里存在的卡、且 status=active')
    assert.equal(r.missing, 1, '指向不存在的那条算 missing')
    assert.equal(r.skipped, 1, 'archived 的那条跳过')
    const [a] = ids(db)
    const rel = listRelationsOf(db, a.id)[0]
    assert.equal(rel.kind, 'follows')
    assert.equal(rel.auto, 1)
    assert.match(rel.reason, /按相似度自动连的/)
    assert.match(rel.reason, /不是他自己认的关系/)
    // 再跑一次不会多出来
    assert.equal(extractObRelations(db).inserted, 0)
  })

  it('被合并掉的卡：从它出发的边也改成从留下的那张出发', () => {
    const db = db3()
    const [a, b, c] = ids(db)
    // aaa 被合进 ccc：aaa→bbb 这条边要变成 ccc→bbb，不然 101 条边就跟着没了
    db.prepare("UPDATE memories SET merged_into = ?, retracted_at = '2026-11-12', retract_reason = 'merged' WHERE id = ?").run(c.id, a.id)
    extractObRelations(db)
    const rel = listRelationsOf(db, c.id)
    assert.equal(rel.length, 1)
    assert.equal(rel[0].other!.id, b.id)
    assert.equal(listRelationsOf(db, a.id).length, 0, '被合掉的那张自己不再挂边')
  })

  it('被合并掉的卡：指过来的边改指到留下的那张', () => {
    const db = db3()
    const [a, b, c] = ids(db)
    db.prepare("UPDATE memories SET merged_into = ?, retracted_at = '2026-11-12', retract_reason = 'merged' WHERE id = ?").run(c.id, b.id)
    extractObRelations(db)
    const rel = listRelationsOf(db, a.id)
    assert.equal(rel.length, 1)
    assert.equal(rel[0].other!.id, c.id, 'bbb 被合进 ccc，边要跟着走')
  })

  it('「一起亮」给的是几张相关的卡 + 为什么相关', () => {
    const db = db3()
    const [a, b] = ids(db)
    addRelation(db, { fromId: a.id, toId: b.id, kind: 'follows', reason: '半年后她又提了一次', by: 'him' })
    const ns = neighbors(db, a.id)
    assert.equal(ns.length, 1)
    assert.equal(ns[0].id, b.id)
    assert.match(renderNeighbors(db, a.id), /后来怎样了：「深夜那句」（半年后她又提了一次）/)
  })
})

describe('修正层：她贴便条，他决定', () => {
  it('贴便条要写一句话；贴完「此刻」里有一行但不说内容', () => {
    const db = db3()
    const [a] = ids(db)
    assert.equal(addCorrection(db, a.id, ' ').ok, false)
    assert.equal(addCorrection(db, 9999, '记错了').ok, false)
    assert.equal(addCorrection(db, a.id, '这是 Kefira 的事，不是我的').ok, true)
    assert.equal(openCount(db), 1)
    const line = renderCorrectionLine(db)
    assert.match(line, /1 张便条/)
    assert.match(line, /memory_corrections/)
    assert.doesNotMatch(line, /Kefira/, '内容不能塞到他嘴边，要他自己去读')
  })

  it('他认了：更正叠在原文后面，原文一个字不动，她的原话跟着附上', () => {
    const db = db3()
    const [a] = ids(db)
    const before = (db.prepare('SELECT fact_body FROM memories WHERE id = ?').get(a.id) as any).fact_body
    const c = addCorrection(db, a.id, '这是 Kefira 的事') as { ok: true; id: number }
    assert.equal(acceptCorrection(db, c.id, ' ').ok, false, '要写一句他自己的话')
    assert.equal(acceptCorrection(db, c.id, '记错了人：说这句话的是 Kefira，不是她。').ok, true)
    const after = (db.prepare('SELECT fact_body, voice FROM memories WHERE id = ?').get(a.id) as any)
    assert.ok(after.fact_body.startsWith(before), '原文还在最前面，一个字没动')
    assert.match(after.fact_body, /【.*更正】记错了人/)
    assert.match(after.fact_body, /她当时说：这是 Kefira 的事/)
    assert.equal(after.voice, 'him', '这一笔还是他的手')
    assert.equal(openCount(db), 0)
    assert.equal(listCorrections(db, { status: 'accepted' })[0].hisReply, '记错了人：说这句话的是 Kefira，不是她。')
  })

  it('他留着原样：也要说一句为什么，原文不动', () => {
    const db = db3()
    const [a] = ids(db)
    const before = (db.prepare('SELECT fact_body FROM memories WHERE id = ?').get(a.id) as any).fact_body
    const c = addCorrection(db, a.id, '时间不对') as { ok: true; id: number }
    assert.equal(keepCorrection(db, c.id, '').ok, false)
    assert.equal(keepCorrection(db, c.id, '我翻了原话，三月那次确实是她说的。').ok, true)
    assert.equal((db.prepare('SELECT fact_body FROM memories WHERE id = ?').get(a.id) as any).fact_body, before)
    assert.equal(listCorrections(db, { status: 'kept' }).length, 1)
  })

  it('同一张便条不能处理两次；她也能撤回', () => {
    const db = db3()
    const [a] = ids(db)
    const c1 = addCorrection(db, a.id, '记错了') as { ok: true; id: number }
    acceptCorrection(db, c1.id, '改了')
    assert.equal(acceptCorrection(db, c1.id, '再改一次').ok, false)
    const c2 = addCorrection(db, a.id, '手滑贴错了') as { ok: true; id: number }
    assert.equal(withdrawCorrection(db, c2.id), true)
    assert.equal(withdrawCorrection(db, c2.id), false)
    assert.equal(openCount(db), 0)
  })
})

describe('他手边的那几个工具', () => {
  it('memory_corrections 看完会标记已看；memory_fix 能认也能留', async () => {
    const db = db3()
    const [a] = ids(db)
    addCorrection(db, a.id, '这是 Kefira 的事')
    const box = memoBox(db)
    const list = await box.call('memory_corrections', {})
    assert.match(list.text, /她说：这是 Kefira 的事/)
    assert.match(list.text, /我当时记的/)
    assert.ok(listCorrections(db, { status: 'open' })[0].seenAt, '读过要留痕')
    const id = listCorrections(db, { status: 'open' })[0].id
    const r = await box.call('memory_fix', { id, action: 'accept', words: '记错了人，是 Kefira 说的。' })
    assert.equal(r.isError, false)
    assert.match((db.prepare('SELECT fact_body FROM memories WHERE id = ?').get(a.id) as any).fact_body, /更正】记错了人/)
  })

  it('没有便条时明说没有', async () => {
    const r = await memoBox(db3()).call('memory_corrections', {})
    assert.equal(r.text, '她没贴便条。')
  })

  it('memory_relate 必须写原因；因果那几种他可以写', async () => {
    const db = db3()
    const [a, b] = ids(db)
    const box = memoBox(db)
    assert.equal((await box.call('memory_relate', { from: a.id, to: b.id, kind: 'follows', reason: '  ' })).isError, true)
    const ok = await box.call('memory_relate', { from: a.id, to: b.id, kind: 'causes', reason: '三月那次让她后来一直不提生日' })
    assert.equal(ok.isError, false)
    assert.match(ok.text, /我自己认的因果/)
  })
})
