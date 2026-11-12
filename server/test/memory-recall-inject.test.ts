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
import { recallCandidates, lexAdmitted } from '../src/memory/recall.ts'

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
    assert.equal(judge({ row, score: 0.6, hits: ['糯糯'], rareDf: 1 }, '糯糯怎么了').ok, true)
    const old = { ...row, created_at: new Date(Date.now() - 5 * 86400_000).toISOString() }
    const v = judge({ row: old, score: 0.6, hits: ['糯糯'], rareDf: 1 }, '糯糯这几天怎么样')
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

  it('一条都没有时**明说没搜到**，把缺口摆回他眼前（不是沉默）', () => {
    const db = lib()
    const r = runRecall(db, '明天股市会涨吗')
    assert.equal(r.picked.length, 0)
    // WrenWen 的取证：每轮都摆着几条「已记得」，模型就再也不主动翻记忆（5000 轮里只 47 次）。
    // 所以没捞到要明说，而且措辞不给台阶。
    assert.match(r.note, /没搜到/)
    assert.match(r.note, /自己去/)
    assert.doesNotMatch(r.note, /你可以/)
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

describe('WrenWen 那份文档换来的几条（2026-11-12）', () => {
  it('反回声：刚递过的扣分，但分够高还是回得来', () => {
    const db = lib()
    const row = byTitle(db, '她不吃海鲜')
    const before = recallCandidates(db, '晚饭点海鲜行不行')[0]
    assert.equal(before.row.id, row.id)
    assert.equal(before.echoPenalty, undefined)
    // 刚递过
    db.prepare(`INSERT INTO memory_deliveries (memory_id, turn, scene, mode, state, score, hits, query, created_at)
      VALUES (?, 't1', 'chat', 'live', 'delivered', 0.5, '[]', 'x', ?)`).run(row.id, new Date().toISOString())
    const after = recallCandidates(db, '晚饭点海鲜行不行')[0]
    assert.ok(after.echoPenalty && after.echoPenalty > 0, '要扣分')
    assert.ok(after.score < before.score)
    assert.equal(after.row.id, row.id, '扣了分还是它——她连着问同一件事时它该回来')
  })

  it('近 7 天位限：新鲜的不许把远期的挤光，而且是上限不是保底', () => {
    const db = lib()
    const ins = db.prepare(`INSERT INTO memories (layer, subject, title, fact_body, why, tags, grade, source, voice, created_at, updated_at)
      VALUES (?, 'erica', ?, ?, '要紧', '[]', 'normal', 'hold', 'him', ?, ?)`)
    // 垫一堆不相干的卡：让「枇杷」在库里保持稀有，不然 idf 趋零、谁都不算命中
    for (let i = 0; i < 20; i++) {
      ins.run('bond', `垫底 ${i}`, `这是第 ${i} 张不相干的卡，讲的是别的事，用来把库撑大一点。`, '2026-08-01', '2026-08-01')
    }
    const fresh = new Date(Date.now() - 2 * 86400_000).toISOString()
    for (let i = 0; i < 3; i++) {
      ins.run('state', `这几天的枇杷 ${i}`, `她这几天一直在说枇杷这件事，第 ${i} 次。`, fresh, fresh)
    }
    ins.run('bond', '外婆家的枇杷树', '她说起小时候在外婆家那棵枇杷树，说树还在。', '2026-09-01', '2026-09-01')
    const r = runRecall(db, '枇杷', { limit: 3 })
    const freshLine = new Date(Date.now() - 7 * 86400_000).toISOString()
    assert.ok(r.picked.length >= 2, '该捞到几条')
    assert.ok(r.picked.filter(p => p.row.created_at >= freshLine).length <= 2, '三个位子里近 7 天最多占两个')
    assert.ok((r.suppressed.近七天排满了 ?? 0) > 0, '要记下近 7 天排满了几条')
    assert.ok(r.picked.some(p => p.row.title === '外婆家的枇杷树'), '远期那条没被挤光')
  })

  it('筛掉的都要有原因（「这轮为什么只有 1 条」要能回答）', () => {
    const db = lib()
    const r = runRecall(db, '海鲜', { limit: 1 })
    assert.ok(Object.keys(r.suppressed).includes('没过门槛'))
    assert.ok(typeof r.suppressed.判官挡了 === 'number')
  })

  it('达标规则：长问句要命中五成，除非那个词特别罕见（拿规则本身测，不靠小库里的巧合）', () => {
    const hit = (hitCount: number, longest: number, rarestContentDf: number) =>
      ({ score: 0.5, raw: 5, hits: [], hitCount, longest, rarestDf: rarestContentDf, rarestContentDf })
    // 一句话里有 10 个实词片段 → 要命中 5 个（2026-11-12 她说「还有一点点杂」之后从四成提到五成）
    assert.equal(lexAdmitted(hit(2, 2, 40), 10, false, 200), false, '只命中两个到处都有的词 → 不算')
    assert.equal(lexAdmitted(hit(4, 2, 40), 10, false, 200), false, '四成也不够了')
    assert.equal(lexAdmitted(hit(5, 2, 40), 10, false, 200), true, '命中五成 → 算')
    assert.equal(lexAdmitted(hit(1, 2, 1), 10, false, 200), true, '只命中一个实词，而且整库只有一张卡提过 → 算')
    // 「我现」「每一」这种带代词的碎片不算实词：rarestContentDf 是 Infinity
    assert.equal(lexAdmitted({ score: 0.5, raw: 5, hits: [], hitCount: 1, longest: 2, rarestDf: 1, rarestContentDf: Infinity }, 10, false, 200), false,
      '只命中一个「我现」这种碎片 → 不算，哪怕它很罕见')
    assert.equal(lexAdmitted(hit(2, 2, 40), 10, true, 200), true, '标题命中 + 正文两个 → 算')
    // 短问句（她就问两个字）命中一个就算
    assert.equal(lexAdmitted(hit(1, 2, 40), 2, false, 200), true)
    assert.equal(lexAdmitted(hit(0, 0, Infinity), 2, false, 200), false, '一个都没命中当然不算')
  })

  it('长问句里撞上一个**很罕见**的词：算数（那一个词就是全部意义）', () => {
    const db = lib()
    const r = runRecall(db, '晚饭点个海鲜大餐好不好啊我有点饿了你说呢')
    assert.ok(r.picked.some(p => p.row.title === '她不吃海鲜'), '「海鲜」整库只有一张卡提过，这一个词就够')
  })
})
