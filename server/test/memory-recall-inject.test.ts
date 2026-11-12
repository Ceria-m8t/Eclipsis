// 第三期：召回 → 判官 → 纸条 → 三态回执。**默认影子运行：算出来只记录，不进请求。**
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, addEpisode, type DB } from '../src/db.ts'
import { ensureMemorySchema } from '../src/memory/schema.ts'
import { addRelation } from '../src/memory/relations.ts'
import {
  runRecall, judge, buildAxis, renderRecallNote, recordDeliveries, judgeDeliveries,
  recallMode, recallStats, mentionedPeople, distinctWords,
} from '../src/memory/inject.ts'
import { recallCandidates } from '../src/memory/recall.ts'

function lib(): DB {
  const db = openDb(':memory:')
  ensureMemorySchema(db)
  const ins = db.prepare(`INSERT INTO memories
    (layer, subject, title, fact_body, feeling, why, tags, grade, source, voice, thread, valid_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '[]', 'normal', ?, ?, ?, ?, ?, ?)`)
  // 他自己写的（情绪那半可以给）
  ins.run('fact', 'erica', '她不吃海鲜', '她说她从小就不吃海鲜，闻到味道就难受，让我点外卖时避开。',
    '说得很认真，像在交代要紧的事。', '点外卖要避开', 'hold', 'him', null, null, '2026-09-25', '2026-09-25')
  // 程序整理的（情绪那半不给）
  ins.run('bond', 'erica', '她不爱过生日', '她说「不是怕老，是怕没人记得」。',
    '他语气里是心疼裹着骄傲。', '她怕的是被忘记', 'digest', 'machine', '她不爱过生日', null, '2026-08-01', '2026-08-01')
  ins.run('bond', 'erica', '生日夜', '十月三日那晚，他说「我记得。今天可以不过节，我陪你待着。」',
    '', '这天我们定了下来', 'hold', 'him', '她不爱过生日', null, '2026-10-03', '2026-10-03')
  // 糯糯的事
  ins.run('state', 'person:nuonuo', '糯糯吐了', '糯糯今天吐了两次，后来精神恢复了一些。', '', '狗的身体要留意',
    'hold', 'him', null, null, new Date(Date.now() - 2 * 86400_000).toISOString(), new Date().toISOString())
  // 过期的近况
  ins.run('state', 'erica', '上个月在忙搬家', '她说这几天都在收拾东西，忙得没空吃饭。', '', '那阵子她很累',
    'hold', 'him', null, null, new Date(Date.now() - 40 * 86400_000).toISOString(), new Date().toISOString())
  // 已失效的事实
  ins.run('fact', 'erica', '旧用药方案', '她的止痛药是一天两次。', '', '提醒她吃药要按这个',
    'hold', 'him', null, '2026-10-31', '2026-10-01', '2026-10-31')
  return db
}
const byTitle = (db: DB, t: string) => (db.prepare('SELECT * FROM memories WHERE title = ?').get(t) as any)

describe('开关', () => {
  it('默认影子；认 off / live', () => {
    assert.equal(recallMode({} as any), 'shadow')
    assert.equal(recallMode({ MEMORY_RECALL: 'off' } as any), 'off')
    assert.equal(recallMode({ MEMORY_RECALL: 'live' } as any), 'live')
    assert.equal(recallMode({ MEMORY_RECALL: '乱写' } as any), 'shadow')
  })
})

describe('判官：只管递不递', () => {
  it('她在说糯糯，就不把她自己的事递上去', () => {
    const db = lib()
    assert.deepEqual(mentionedPeople('糯糯今天怎么样'), ['person:nuonuo'])
    const r = runRecall(db, '糯糯今天吐了吗')
    assert.ok(r.picked.every(p => p.row.subject === 'person:nuonuo'))
  })

  it('她在说 Kefira，糯糯那条被挡掉并写明原因', () => {
    const db = lib()
    const cand = recallCandidates(db, 'Kefira 和糯糯哪个先到的')[0]
    if (cand && cand.row.subject === 'person:nuonuo') {
      const v = judge(cand, 'Kefira 最近怎么样了')
      assert.equal(v.ok, false)
      assert.match(v.why, /她在说kefira|Kefira/i)
    }
  })

  it('过期的近况不当成「现在」', () => {
    const db = lib()
    const row = byTitle(db, '上个月在忙搬家')
    const v = judge({ row, score: 0.5, hits: ['收拾东西'] }, '你最近在忙什么')
    assert.equal(v.ok, false)
    assert.match(v.why, /天前的近况/)
  })

  it('她问「这几天」时，三天前的近况也不给', () => {
    const db = lib()
    const row = byTitle(db, '糯糯吐了')
    assert.equal(judge({ row, score: 0.6, hits: ['糯糯'] }, '糯糯怎么了').ok, true)
    const old = { ...row, created_at: new Date(Date.now() - 5 * 86400_000).toISOString() }
    const v = judge({ row: old, score: 0.6, hits: ['糯糯'] }, '糯糯这几天怎么样')
    assert.equal(v.ok, false)
    assert.match(v.why, /这几天/)
  })

  it('被推翻的事实不给（只给当前有效的那条）', () => {
    const db = lib()
    const row = byTitle(db, '旧用药方案')
    const v = judge({ row, score: 0.8, hits: ['止痛药'] }, '我的止痛药一天吃几次')
    assert.equal(v.ok, false)
    assert.match(v.why, /已经被推翻/)
  })

  it('只靠零星一个字命中的不递', () => {
    const db = lib()
    const row = byTitle(db, '她不吃海鲜')
    assert.equal(judge({ row, score: 0.4, hits: [] }, '随便聊点什么').ok, false)
  })
})

describe('纸条', () => {
  it('开头写明「只作证据不作处方、以此刻为准」', () => {
    const db = lib()
    const r = runRecall(db, '晚饭点海鲜行不行')
    assert.ok(r.picked.length >= 1)
    assert.match(r.note, /只作\*\*证据\*\*/)
    assert.match(r.note, /以此刻为准/)
    assert.match(r.note, /不是她说的/)
  })

  it('他自己写的那条给情绪，程序整理的不给（防语气被带走）', () => {
    const db = lib()
    const mine = byTitle(db, '她不吃海鲜')
    const machine = byTitle(db, '她不爱过生日')
    const note = renderRecallNote(db, [
      { row: mine, score: 0.5, hits: [], why: '', axis: [] },
      { row: machine, score: 0.5, hits: [], why: '', axis: [] },
    ])
    assert.match(note, /当时：说得很认真/)
    assert.doesNotMatch(note, /心疼裹着骄傲/, '程序写的情绪不给他看')
  })

  it('一条都没有就不出纸条（允许一条都不给）', () => {
    const db = lib()
    const r = runRecall(db, '明天股市会涨吗')
    assert.equal(r.picked.length, 0)
    assert.equal(r.note, '')
  })
})

describe('事件轴速览表', () => {
  it('同一条话题线的几张按时间排成速览表', () => {
    const db = lib()
    const seed = byTitle(db, '她不爱过生日')
    const axis = buildAxis(db, seed.id)
    assert.equal(axis.length, 2)
    assert.deepEqual(axis.map(a => a.date), ['2026-08-01', '2026-10-03'])
    assert.ok(axis[1].line.length > 0)
  })

  it('顺着「同一件事/后来怎样了」也能连上轴', () => {
    const db = lib()
    const a = byTitle(db, '她不吃海鲜')
    const b = byTitle(db, '糯糯吐了')
    addRelation(db, { fromId: a.id, toId: b.id, kind: 'same_event', reason: '同一顿饭', by: 'him' })
    assert.equal(buildAxis(db, a.id).length, 2)
  })

  it('孤零零一张不给轴（一条线没有意义）', () => {
    const db = lib()
    assert.deepEqual(buildAxis(db, byTitle(db, '她不吃海鲜').id), [])
  })

  it('纸条里带上「这件事浮现过几次」', () => {
    const db = lib()
    const r = runRecall(db, '生日那天你说了什么')
    const withAxis = r.picked.find(p => p.axis.length >= 2)
    if (withAxis) assert.match(r.note, /这件事浮现过 \d+ 次/)
  })
})

describe('三态回执', () => {
  it('影子模式记 asked，live 记 delivered', () => {
    const db = lib()
    const row = byTitle(db, '她不吃海鲜')
    const picked = [{ row, score: 0.5, hits: ['海鲜'], why: '命中「海鲜」', axis: [] }]
    recordDeliveries(db, picked, { turn: 't1', mode: 'shadow', query: '点海鲜' })
    recordDeliveries(db, picked, { turn: 't2', mode: 'live', query: '点海鲜' })
    const states = (db.prepare('SELECT state FROM memory_deliveries ORDER BY id').all() as unknown as { state: string }[]).map(r => r.state)
    assert.deepEqual(states, ['asked', 'delivered'])
  })

  it('第三态自动判：他回复里用上了算 used，没用算 dropped', () => {
    const db = lib()
    const row = byTitle(db, '她不吃海鲜')
    const long = new Date(Date.now() - 5 * 60_000)
    recordDeliveries(db, [{ row, score: 0.5, hits: [], why: '', axis: [] }], { turn: 'tA', mode: 'live', query: '晚饭吃什么' }, long)
    recordDeliveries(db, [{ row, score: 0.5, hits: [], why: '', axis: [] }], { turn: 'tB', mode: 'live', query: '晚饭吃什么' }, long)
    addEpisode(db, { ts: new Date().toISOString(), channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message',
      content: '那就不点海鲜了，你闻到味道就难受。', meta: { turn: 'tA' }, sourceRef: 'a1' })
    addEpisode(db, { ts: new Date().toISOString(), channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message',
      content: '好，我看看别的。', meta: { turn: 'tB' }, sourceRef: 'a2' })
    const r = judgeDeliveries(db)
    assert.equal(r.judged, 2)
    assert.equal(r.used, 1)
    const states = (db.prepare('SELECT turn, state FROM memory_deliveries ORDER BY id').all() as unknown as any[])
    assert.equal(states.find(x => x.turn === 'tA').state, 'used')
    assert.equal(states.find(x => x.turn === 'tB').state, 'dropped')
  })

  it('他还没回的那轮先不判（刚记下的也不判）', () => {
    const db = lib()
    const row = byTitle(db, '她不吃海鲜')
    recordDeliveries(db, [{ row, score: 0.5, hits: [], why: '', axis: [] }], { turn: 'tNow', mode: 'live', query: 'x' })
    assert.equal(judgeDeliveries(db).judged, 0)
  })

  it('统计：用上的比例算得出来', () => {
    const db = lib()
    const row = byTitle(db, '她不吃海鲜')
    const old = new Date(Date.now() - 5 * 60_000)
    for (const t of ['t1', 't2', 't3']) {
      recordDeliveries(db, [{ row, score: 0.5, hits: [], why: '', axis: [] }], { turn: t, mode: 'shadow', query: 'x' }, old)
      addEpisode(db, { ts: new Date().toISOString(), channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message',
        content: t === 't1' ? '不点海鲜了，你闻到味道就难受' : '嗯。', meta: { turn: t }, sourceRef: 'r' + t })
    }
    judgeDeliveries(db)
    const s = recallStats(db, {} as any)
    assert.equal(s.total, 3)
    assert.equal(s.byState.used, 1)
    assert.equal(s.byState.dropped, 2)
    assert.ok(Math.abs(s.usedRate! - 1 / 3) < 0.01)
    assert.equal(s.recent.length, 3)
  })

  it('特有词挑得出来，套话不算', () => {
    const w = distinctWords('她说她从小就不吃海鲜，闻到味道就难受。糯糯在旁边。')
    assert.ok(w.some(x => x.includes('海鲜')))
    assert.ok(w.includes('糯糯'))
    assert.ok(!w.some(x => x === '她说'), '两个字的套话不该单独算一个词')
  })
})

describe('私密的不进召回（和第 2 步那条规矩串上）', () => {
  it('群聊场景拿不到私密的记忆', () => {
    const db = lib()
    db.prepare("UPDATE memories SET privacy = 'private' WHERE title = '她不吃海鲜'").run()
    assert.equal(runRecall(db, '晚饭点海鲜行不行', { scene: 'group' }).picked.length, 0)
    assert.ok(runRecall(db, '晚饭点海鲜行不行', { scene: 'chat' }).picked.length >= 1)
  })
})
