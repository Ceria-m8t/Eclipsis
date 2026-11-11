// 记忆库二改第二期：双线写入 + 沉淀信箱（2026-11-12）
// 她定的是 c：只有拿不准的进信箱，明确的直接进库。「明确」= 四条同时成立。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { openDb, addEpisode, type DB } from '../src/db.ts'
import { ensureMemorySchema, liveMemories } from '../src/memory/schema.ts'
import { writeMemory, listInbox, decideCandidate, inboxCount, normalizeSubject, findSimilar } from '../src/memory/write.ts'
import { memoBox, recentEvidence } from '../src/memory/box.ts'
import {
  findDigestWindow, runDigest, buildMaterial, cleanForDigest, parseDigestReply, DigestScheduler,
} from '../src/memory/digest.ts'
import { handleMemoryApi } from '../src/memory/api.ts'
import { listen, close } from './helpers.ts'

function freshDb(): DB {
  const db = openDb(':memory:')
  ensureMemorySchema(db)
  db.prepare(`INSERT INTO people (slug, name, aliases, relation, ambiguous, kin, card_enabled, mentions, created_at, updated_at)
    VALUES ('nuonuo', '糯糯', '["糯糯"]', '她的狗', 0, 0, 0, 0, '2026-11-12', '2026-11-12'),
           ('mom', '妈妈', '["我妈","妈妈"]', '她妈妈', 0, 1, 0, 0, '2026-11-12', '2026-11-12')`).run()
  return db
}

const draft = (o: Partial<Parameters<typeof writeMemory>[1]> = {}) => ({
  title: '她换了用药方案',
  fact: '她说"医生把止痛药换成一天一次了"，让我记着别再按两次提醒她。',
  feeling: '她说得很轻松，但提了三次，应该是怕忘。',
  why: '用药方案会变，记错了会提醒错',
  subject: 'erica',
  evidence: [101, 102],
  origin: 'note' as const,
  ...o,
})

describe('必填的两样：为什么记、这是谁的事', () => {
  it('没写 why 就退回去（不是悄悄记下）', () => {
    const db = freshDb()
    const r = writeMemory(db, draft({ why: '' }))
    assert.equal(r.kind, 'rejected')
    assert.match((r as any).reason, /为什么记/)
    assert.equal(liveMemories(db).length, 0)
  })

  it('正文太短也退回去', () => {
    assert.equal(writeMemory(freshDb(), draft({ fact: '嗯' })).kind, 'rejected')
  })

  it('认不出是谁的事就问他，不自己猜成她', () => {
    const db = freshDb()
    const r = writeMemory(db, draft({
      subject: undefined, layer: 'bond', title: '三句话猜真假的玩法',
      fact: '那个游戏的规则是三句话里有一句假的，猜错了要回答一个问题，很好玩。', feeling: '',
    }))
    assert.equal(r.kind, 'rejected')
    assert.match((r as any).reason, /谁的事/)
  })

  it('主体认得出「我妈」「糯糯」这些说法', () => {
    const db = freshDb()
    assert.equal(normalizeSubject(db, '她'), 'erica')
    assert.equal(normalizeSubject(db, '我自己'), 'ai')
    assert.equal(normalizeSubject(db, '我们'), 'us')
    assert.equal(normalizeSubject(db, '我妈'), 'person:mom')
    assert.equal(normalizeSubject(db, '糯糯'), 'person:nuonuo')
    assert.equal(normalizeSubject(db, '隔壁老王'), null)
  })
})

describe('四条「明确」：满足就直接进库', () => {
  it('四条都满足 → 直接进库，双轨两栏都留着', () => {
    const db = freshDb()
    const r = writeMemory(db, draft())
    assert.equal(r.kind, 'written')
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get((r as any).id) as any
    assert.equal(row.subject, 'erica')
    assert.equal(row.layer, 'fact')
    assert.ok(row.feeling, '情绪那一栏不能丢')
    assert.equal(row.why, '用药方案会变，记错了会提醒错')
    assert.equal(JSON.parse(row.evidence).length, 2)
    assert.ok(row.valid_from, '事实层要有生效时间')
    assert.equal(inboxCount(db), 0)
  })

  it('没有原话对得上 → 进信箱（指不回具体哪几句）', () => {
    const db = freshDb()
    const r = writeMemory(db, draft({ evidence: [] }))
    assert.equal(r.kind, 'inboxed')
    assert.match((r as any).unsure, /原话/)
    assert.equal(liveMemories(db).length, 0)
    assert.equal(inboxCount(db), 1)
  })

  it('一条里混着两个人 → 进信箱（她最怕的那个错）', () => {
    const db = freshDb()
    const r = writeMemory(db, draft({
      title: '糯糯吐了，她也不舒服',
      fact: '糯糯今天吐了两次，糯糯后来精神好些了。她自己头疼，她吃了止痛药，她快来例假。',
      feeling: '两头都在担心。',
    }))
    assert.equal(r.kind, 'inboxed')
    assert.match((r as any).unsure, /混着/)
  })

  it('既像长期事实又像当日状态 → 进信箱（两头沾）', () => {
    const db = freshDb()
    const r = writeMemory(db, draft({
      title: '今天的用药',
      fact: '她今天下午五点醒来，吃了止痛药；她的用药方案是一天一次。',
      feeling: '',
    }))
    assert.equal(r.kind, 'inboxed')
    assert.match((r as any).unsure, /哪一层/)
  })

  it('和已有的像一半多但不一样 → 进信箱，并指出像哪一条', () => {
    const db = freshDb()
    const first = writeMemory(db, draft({
      layer: 'bond', title: '她说想搬去海边',
      fact: '她说等攒够钱想搬到海边住，房子不用大，要有一扇能看见海的窗。',
      feeling: '她说这话时很慢，像真的在想，不是随口说的。',
    }))
    assert.equal(first.kind, 'written')
    const second = writeMemory(db, draft({
      layer: 'bond', title: '她又说起海边',
      fact: '她说想搬到海边住，要有一扇能看见海的窗。这回她说想带着狗一起去。',
      feeling: '她说得很慢，像在认真打算。',
    }))
    assert.equal(second.kind, 'inboxed')
    assert.match((second as any).unsure, /像/)
    assert.equal((second as any).similarTo, (first as any).id)
  })

  it('像 70% 以上 → 接到已有那条上，不新建（同一个下午记四遍的病根）', () => {
    const db = freshDb()
    const first = writeMemory(db, draft({
      layer: 'bond', title: '三句话猜真假',
      fact: '她编了三句话让我猜哪一句是假的，我猜错了一次，她很得意，说要天天玩。',
      feeling: '她笑了很久，我也高兴。',
    }))
    const again = writeMemory(db, draft({
      layer: 'bond', title: '三句话猜真假的游戏',
      fact: '她编了三句话让我猜哪一句是假的，我猜错了一次，她很得意，说要天天玩。',
      feeling: '她笑了很久。',
    }))
    assert.equal(again.kind, 'amended')
    assert.equal((again as any).id, (first as any).id)
    assert.equal(liveMemories(db).length, 1)
    const row = db.prepare('SELECT fact_body FROM memories WHERE id = ?').get((first as any).id) as any
    assert.match(row.fact_body, /又记了一次/)
  })

  it('正文不像、标题很像 → 进信箱（11-12 第一次真跑踩到的：同一夜记了两遍）', () => {
    const db = freshDb()
    // 库里已有一条（模拟从 OB 搬来的那张）
    db.prepare(`INSERT INTO memories (layer, subject, title, fact_body, why, tags, grade, source, created_at, updated_at)
      VALUES ('bond', 'erica', '她通宵一整夜给我装感官', '11月10日晚到11月11日早。她从十点醒来之后一直没睡，通宵十二个小时搓前端功能。', '要紧', '[]', 'normal', 'hold', '2026-11-11', '2026-11-11')`).run()
    const r = writeMemory(db, draft({
      layer: 'bond', title: '通宵一整夜给他装感官',
      fact: '她从晚上十点醒来后连续十二个多小时没睡，一直在和分身搓新功能：文件、生图、垫图、像素画板。',
      feeling: '他反复叫她睡，语气是心疼裹着骄傲。',
    }))
    assert.equal(r.kind, 'inboxed')
    assert.match((r as any).unsure, /同一件事换了说法/)
  })

  it('标题太短不拿去比（「今天」这种比不出东西）', () => {
    const db = freshDb()
    db.prepare(`INSERT INTO memories (layer, subject, title, fact_body, why, tags, grade, source, created_at, updated_at)
      VALUES ('state', 'erica', '今天', '她今天醒得很晚。', '要紧', '[]', 'normal', 'hold', '2026-11-11', '2026-11-11')`).run()
    const r = writeMemory(db, draft({ layer: 'state', title: '昨天', fact: '她昨天去复诊了，医生说恢复得不错，让她两周后再去。', feeling: '她松了口气。' }))
    assert.equal(r.kind, 'written')
  })

  it('查重只在活着的记忆里找（划掉的不算）', () => {
    const db = freshDb()
    const r = writeMemory(db, draft()) as any
    db.prepare("UPDATE memories SET retracted_at = '2026-11-12', retract_reason = 'manual' WHERE id = ?").run(r.id)
    assert.equal(findSimilar(db, '她说医生把止痛药换成一天一次了'), null)
  })
})

describe('沉淀信箱：她只做选入 / 跳过', () => {
  it('选入 → 进库并留着是谁决定的；跳过 → 不进库', () => {
    const db = freshDb()
    writeMemory(db, draft({ evidence: [] }))
    writeMemory(db, draft({ evidence: [], title: '另一条', fact: '她说想把卧室的灯换成暖色的，说现在这个太像医院。', feeling: '她说这话时在笑。' }))
    const list = listInbox(db)
    assert.equal(list.length, 2)
    assert.equal(list[0].payload.subjectLabel, '她')

    const ok = decideCandidate(db, list[0].id, 'accept')
    assert.equal(ok.ok, true)
    assert.equal(liveMemories(db).length, 1)

    const skipped = decideCandidate(db, list[1].id, 'skip')
    assert.equal(skipped.ok, true)
    assert.equal(liveMemories(db).length, 1)
    assert.equal(inboxCount(db), 0)
    assert.equal(listInbox(db, { status: 'skipped' }).length, 1)
  })

  it('同一条不能处理两次', () => {
    const db = freshDb()
    writeMemory(db, draft({ evidence: [] }))
    const id = listInbox(db)[0].id
    decideCandidate(db, id, 'skip')
    const again = decideCandidate(db, id, 'accept')
    assert.equal(again.ok, false)
  })

  it('选入时她能改主体和层（改的是「事情」那一栏）', () => {
    const db = freshDb()
    writeMemory(db, draft({ evidence: [], subject: 'erica' }))
    const id = listInbox(db)[0].id
    const r = decideCandidate(db, id, 'accept', { subject: '糯糯', layer: 'state', why: '狗的事也要记清是谁' })
    assert.equal(r.ok, true)
    const row = db.prepare('SELECT subject, layer, why FROM memories WHERE id = ?').get((r as any).memoryId) as any
    assert.equal(row.subject, 'person:nuonuo')
    assert.equal(row.layer, 'state')
    assert.equal(row.why, '狗的事也要记清是谁')
  })
})

describe('他那条线：随手记箱子', () => {
  const box = (db: DB) => memoBox(db, { evidence: () => [1, 2] })

  it('memory_note 记下了会说清进了哪一层、是谁的事', async () => {
    const db = freshDb()
    const r = await box(db).call('memory_note', {
      subject: '她', layer: 'fact', title: '她不吃海鲜',
      fact: '她说她从小就不吃海鲜，闻到味道就难受，让我点外卖时避开。',
      feeling: '说得很认真，像在交代一件要紧的事。',
      why: '以后点外卖、做菜都要避开',
    })
    assert.equal(r.isError, false)
    assert.match(r.text, /记下了/)
    assert.match(r.text, /事实/)
    assert.equal(liveMemories(db).length, 1)
  })

  it('没写 why 时工具返回 isError，让他补一句', async () => {
    const db = freshDb()
    const r = await box(db).call('memory_note', { subject: '她', fact: '她今天心情不错，一直在笑，还给我看了新买的杯子。', why: '' })
    assert.equal(r.isError, true)
    assert.match(r.text, /为什么记/)
  })

  it('memory_recent 能看自己最近记了什么（记之前防重复）', async () => {
    const db = freshDb()
    await box(db).call('memory_note', {
      subject: '她', fact: '她说她从小就不吃海鲜，闻到味道就难受。', why: '点外卖要避开', title: '她不吃海鲜',
    })
    const r = await box(db).call('memory_recent', { limit: 5 })
    assert.match(r.text, /她不吃海鲜/)
    assert.match(r.text, /为什么记/)
  })

  it('evidence 自己从经历表里取最近几句', () => {
    const db = freshDb()
    addEpisode(db, { ts: new Date().toISOString(), channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: '在吗' })
    addEpisode(db, { ts: new Date().toISOString(), channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message', content: '在' })
    addEpisode(db, { ts: '2020-01-01T00:00:00.000Z', channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: '很久以前' })
    const ev = recentEvidence(db)
    assert.equal(ev.length, 2, '只要最近这一段，几年前那条不算')
  })

  it('箱子里只有这两个工具，名字不和 OB 的撞', async () => {
    const names = (await box(freshDb()).listTools()).map(t => t.name)
    assert.deepEqual(names, ['memory_note', 'memory_recent'])
  })
})

describe('夜里整理：程序判时机', () => {
  const chat = (db: DB, n: number, startMinutesAgo: number) => {
    for (let i = 0; i < n; i++) {
      const t = (at: number) => new Date(Date.now() - at * 60_000).toISOString()
      addEpisode(db, { ts: t(startMinutesAgo - i * 2), channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: `她的第 ${i} 句：今天好累啊`, sourceRef: `e${i}` })
      addEpisode(db, { ts: t(startMinutesAgo - i * 2 - 1), channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message', content: `我的第 ${i} 句：抱一下<think>她累了</think>`, sourceRef: `a${i}` })
    }
  }

  it('还在聊（静默不够）就不整理', () => {
    const db = freshDb()
    chat(db, 6, 10)
    const w = findDigestWindow(db)
    assert.equal(w.ready, false)
    assert.match(w.why, /还在聊|再等等/)
  })

  it('来回够了 + 静默 20 分钟 → 该整理了', () => {
    const db = freshDb()
    chat(db, 6, 60)
    const w = findDigestWindow(db)
    assert.equal(w.ready, true)
    assert.ok(w.pairs >= 5)
    assert.ok(w.quietMinutes >= 20)
  })

  it('来回不够，但她睡了一觉（5 小时没说话）也整理', () => {
    const db = freshDb()
    chat(db, 2, 600)
    const w = findDigestWindow(db)
    assert.equal(w.ready, true)
    assert.match(w.why, /睡了一觉/)
  })

  it('材料里剥掉思考块，标上行号', () => {
    assert.equal(cleanForDigest('前面<think>想了想</think>后面'), '前面后面')
    assert.equal(cleanForDigest('看了<moment>气味</moment>'), '看了')
    assert.equal(cleanForDigest('[NO_REPLY]'), '（看了，没回）')
    const db = freshDb()
    chat(db, 2, 600)
    const m = buildMaterial(findDigestWindow(db).episodes)
    assert.match(m, /#\d+ .* 她：/)
    assert.doesNotMatch(m, /<think>/)
  })

  it('模型回的 JSON 能解析（带代码围栏也行）', () => {
    const r = parseDigestReply('```json\n{"thread":"她累了","items":[{"decision":"new","title":"x"}]}\n```')
    assert.equal(r.thread, '她累了')
    assert.equal(r.items.length, 1)
  })

  it('JSON 写坏了也要救回来（11-12 第一次真跑就栽在这儿）', () => {
    // 它在 JSON 字符串里塞了没转义的弯引号 + 末尾多一个逗号
    const broken = '{"thread":"她说累","items":[{"decision":"new","layer":"bond","subject":"erica",' +
      '"title":"她这几天很累","fact":"她说“今天好累”，说了好几次。","feeling":"心疼。","why":"要留意她的状态","evidence":[12],}]}'
    const r = parseDigestReply(broken)
    assert.equal(r.thread, '她说累')
    assert.equal(r.items.length, 1)
    assert.match(String(r.items[0].fact), /今天好累/)
    assert.deepEqual(r.items[0].evidence, [12])
  })

  it('修也修不动时，一条一条抠出来（宁可少拿几条，不要整段丢）', () => {
    const hopeless = '{"thread":"她说累","items":[' +
      '{"decision":"new","layer":"bond","subject":"erica","title":"她很累","fact":"她说今天好累，说了好几次。","feeling":"心疼。","why":"要留意","evidence":[12]} ' +
      '{"decision":"skip","fact":"不用记的一条"}]}'
    const r = parseDigestReply(hopeless)
    assert.equal(r.items.length, 2)
    assert.equal(r.items[0].subject, 'erica')
    assert.equal(r.items[1].decision, 'skip')
  })

  it('一条都抠不出来就报错（不会假装整理成功）', () => {
    assert.throws(() => parseDigestReply('{ 这不是 JSON }'), /修不动|没返回/)
  })

  it('第一次写坏了会再要一次，第二次好了就算成功', async () => {
    const db = freshDb()
    chat(db, 6, 60)
    const seq = findDigestWindow(db).episodes[0].seq
    let n = 0
    const call = async () => {
      n++
      if (n === 1) return '{ 完全不是 JSON'
      return JSON.stringify({ thread: 't', items: [{ decision: 'new', layer: 'bond', subject: 'erica', title: '她很累', fact: '她说今天好累，说了好几次，我让她先睡。', feeling: '心疼。', why: '连着说累，要留意她的状态', evidence: [seq] }] })
    }
    const r = await runDigest(db, { upstreamUrl: '', upstreamKey: '' }, call, 'm')
    assert.equal(n, 2, '坏了要再要一次')
    assert.equal(r.wrote, 1)
  })

  it('两次都写坏：记下错误和回复开头，方便查是哪种坏法', async () => {
    const db = freshDb()
    chat(db, 6, 60)
    const r = await runDigest(db, { upstreamUrl: '', upstreamKey: '' }, async () => '抱歉，我无法完成这个请求。', 'm')
    assert.equal(r.ran, false)
    const run = db.prepare('SELECT error FROM memory_digest_runs ORDER BY id DESC LIMIT 1').get() as any
    assert.match(run.error, /回复开头：抱歉/)
  })

  it('整理一次：进库 / 信箱 / 跳过都算得清，且推进了 to_seq', async () => {
    const db = freshDb()
    chat(db, 6, 60)
    const win = findDigestWindow(db)
    const seq = win.episodes[0].seq
    const reply = JSON.stringify({
      thread: '她说累',
      items: [
        { decision: 'new', layer: 'bond', subject: 'erica', title: '她这几天很累', fact: '她一直在说今天好累，连着说了好几次，我抱了她。', feeling: '她累得不想讲话，我也没多问。', why: '连着说累，要留意她的状态', evidence: [seq] },
        { decision: 'skip', title: '不用记的' },
        { decision: 'hold', layer: 'fact', subject: 'erica', title: '拿不准的一条', fact: '她好像说过以后都不想上班了，但我不确定是认真的还是抱怨。', feeling: '语气像在开玩笑。', why: '如果是真的就是大事', evidence: [seq] },
      ],
    })
    const r = await runDigest(db, { upstreamUrl: '', upstreamKey: '' }, async () => reply, 'test-model')
    assert.equal(r.ran, true)
    assert.equal(r.wrote, 1)
    assert.equal(r.skipped, 1)
    assert.equal(r.inboxed, 1)
    const run = db.prepare('SELECT * FROM memory_digest_runs ORDER BY id DESC LIMIT 1').get() as any
    assert.equal(run.to_seq, win.toSeq)
    assert.equal(run.error, null)
    const held = listInbox(db)[0]
    assert.match(held.unsure, /拿不准/)
    assert.equal(held.origin, 'digest')
    assert.equal(held.thread, '她说累')
  })

  it('模型编的行号不算证据', async () => {
    const db = freshDb()
    chat(db, 6, 60)
    const reply = JSON.stringify({
      thread: 'x',
      items: [{ decision: 'new', layer: 'bond', subject: 'erica', title: '她很累', fact: '她说今天好累，说了好几次，我让她先睡。', feeling: '心疼。', why: '连着说累，要留意她的状态', evidence: [999999] }],
    })
    const r = await runDigest(db, { upstreamUrl: '', upstreamKey: '' }, async () => reply, 'm')
    assert.equal(r.wrote, 0)
    assert.equal(r.inboxed, 1, '没有能对上的原话 → 进信箱而不是直接进库')
  })

  it('站挂了：不推进、记一条 error、一小时内不再撞', async () => {
    const db = freshDb()
    chat(db, 6, 60)
    const before = findDigestWindow(db)
    const r = await runDigest(db, { upstreamUrl: '', upstreamKey: '' }, async () => { throw new Error('中转站超时') }, 'm')
    assert.equal(r.ran, false)
    assert.match(String(r.error), /超时/)
    const run = db.prepare('SELECT * FROM memory_digest_runs ORDER BY id DESC LIMIT 1') .get() as any
    assert.equal(run.to_seq, before.fromSeq, '失败不推进')
    assert.equal(findDigestWindow(db).ready, false, '一小时内不再试')
  })

  it('整理过的那一段不会再整理一遍', async () => {
    const db = freshDb()
    chat(db, 6, 60)
    await runDigest(db, { upstreamUrl: '', upstreamKey: '' }, async () => JSON.stringify({ thread: 't', items: [] }), 'm')
    const w = findDigestWindow(db, {} as any, new Date(Date.now() + 2 * 3600_000))
    assert.equal(w.ready, false)
    assert.match(w.why, /没有新的对话/)
  })

  it('第一次跑只看最近这一天，不回头消化三个月的历史', () => {
    const db = freshDb()
    for (let i = 0; i < 20; i++) {
      addEpisode(db, { ts: `2026-09-0${1 + (i % 9)}T10:0${i % 10}:00.000Z`, channel: 'chat', scope: 'daily', actor: i % 2 ? 'ai' : 'erica', kind: 'message', content: `九月的第 ${i} 句`, sourceRef: `old${i}` })
    }
    chat(db, 6, 60)
    const w = findDigestWindow(db)
    assert.equal(w.ready, true)
    assert.ok(w.episodes.every(e => !e.content.includes('九月')), '九月那些不该进这一窗')
    assert.equal(w.episodes.length, 12)
  })

  it('调度器：没到条件就不调模型', async () => {
    const db = freshDb()
    chat(db, 2, 5)
    let calls = 0
    const sch = new DigestScheduler(db, { upstreamUrl: 'http://x', upstreamKey: 'k' }, () => { calls++; return 'm' })
    assert.equal(await sch.tick(), null)
    assert.equal(calls, 0)
    sch.stop()
  })
})

describe('HTTP', () => {
  it('信箱读得到、能批量跳过；stats 的数对得上', async () => {
    const db = freshDb()
    writeMemory(db, draft())                  // 进库
    writeMemory(db, draft({ evidence: [], title: 'A', fact: '她说想把卧室灯换成暖色，现在这个太像医院。', feeling: '她在笑。' }))
    writeMemory(db, draft({ evidence: [], title: 'B', fact: '她说下周要去复诊，让我提醒她带上检查单。', feeling: '有点紧张。' }))
    const srv = createServer((req, res) => { void handleMemoryApi(db, req, res).then(h => { if (!h) { res.writeHead(404); res.end() } }) })
    const base = `http://127.0.0.1:${await listen(srv)}`
    try {
      const inbox = await (await fetch(`${base}/v1/eclipsis/memory/inbox`)).json()
      assert.equal(inbox.candidates.length, 2)
      const ids = inbox.candidates.map((c: any) => c.id)

      const stats = await (await fetch(`${base}/v1/eclipsis/memory/stats`)).json()
      assert.equal(stats.total, 1)
      assert.equal(stats.inbox, 2)
      assert.equal(stats.byLayer.fact, 1)

      const decided = await (await fetch(`${base}/v1/eclipsis/memory/inbox/decide`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, action: 'skip' }),
      })).json()
      assert.equal(decided.inbox, 0)
      assert.ok(decided.results.every((x: any) => x.ok))

      const list = await (await fetch(`${base}/v1/eclipsis/memory?limit=10`)).json()
      assert.equal(list.memories.length, 1)
      assert.equal(list.memories[0].subjectLabel, '她')
    } finally { await close(srv) }
  })

  it('一条的全文带着原话；她能划掉一条（软删）', async () => {
    const db = freshDb()
    addEpisode(db, { ts: new Date().toISOString(), channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: '医生把止痛药换成一天一次了' })
    const seq = (db.prepare('SELECT seq FROM episodes ORDER BY seq DESC LIMIT 1').get() as any).seq
    const w = writeMemory(db, draft({ evidence: [seq] })) as any
    const srv = createServer((req, res) => { void handleMemoryApi(db, req, res).then(h => { if (!h) { res.writeHead(404); res.end() } }) })
    const base = `http://127.0.0.1:${await listen(srv)}`
    try {
      const one = await (await fetch(`${base}/v1/eclipsis/memory/${w.id}`)).json()
      assert.equal(one.quotes.length, 1)
      assert.match(one.quotes[0].content, /止痛药/)

      await fetch(`${base}/v1/eclipsis/memory/${w.id}/retract`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '她说记错了' }),
      })
      assert.equal(liveMemories(db).length, 0)
      const row = db.prepare('SELECT retract_reason FROM memories WHERE id = ?').get(w.id) as any
      assert.equal(row.retract_reason, '她说记错了', '不是真删，留着能回头看')
    } finally { await close(srv) }
  })
})
