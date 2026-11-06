// 错过的闹钟：到点没能执行的记 missed、不补醒；下次醒来告诉他一次
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import { ensureWakeSchema } from '../src/wake/index.ts'
import { ensurePromptSchema } from '../src/prompts.ts'
import { WakeScheduler } from '../src/wake/scheduler.ts'
import { setAlarm } from '../src/wake/tools.ts'
import { dispatchWake, buildWakePrompt } from '../src/wake/dispatch.ts'
import type { WakeOpportunity } from '../src/wake/types.ts'
import { fakeUpstream, listen, close } from './helpers.ts'

const MIN = 60_000

function freshDb(): DB {
  const db = openDb(':memory:'); ensureWakeSchema(db); ensurePromptSchema(db)
  // 门槛设高：只看闹钟，不让累积触发
  db.prepare("UPDATE wake_state SET h = 0, theta = 3, last_tick_at = ? WHERE id = 1").run(new Date(Date.now() - MIN).toISOString())
  return db
}
const addAlarm = (db: DB, id: string, minAgo: number, note: string) =>
  db.prepare("INSERT INTO wake_precise(id, source, wake_at, note, status, created_at) VALUES (?, 'self', ?, ?, 'pending', ?)")
    .run(id, new Date(Date.now() - minAgo * MIN).toISOString(), note, new Date(Date.now() - 600 * MIN).toISOString())
const status = (db: DB, id: string) => (db.prepare('SELECT status FROM wake_precise WHERE id = ?').get(id) as any).status

describe('调度器：错过的闹钟', () => {
  it('过了 10 分钟宽限 → missed，不补醒；宽限内 → 照常醒（同一天也认得出来）', () => {
    const db = freshDb()
    addAlarm(db, 'late', 30, '回来接话')
    addAlarm(db, 'ontime', 3, '看她醒没醒')
    const woke: WakeOpportunity[] = []
    const s = new WakeScheduler(db, { tickIntervalMs: 3_600_000, onWake: async o => { woke.push(o) }, log: () => {} })
    s.start(); s.stop()
    assert.equal(status(db, 'late'), 'missed')
    assert.equal(status(db, 'ontime'), 'triggered')
    assert.equal(woke.length, 1)
    assert.match(woke[0].reason, /看她醒没醒/)
  })

  it('setAlarm 带时区的时间统一存成 ISO', () => {
    const db = freshDb()
    const r = setAlarm(db, { at: '2030-01-01T07:30:00+08:00', note: 'x' })
    assert.equal(r.wakeAt, '2029-12-31T23:30:00.000Z')
  })
})

describe('醒来时告诉他错过了哪些', () => {
  it('醒来说明里列出原定时间、晚了多久、当时写的话', () => {
    const p = buildWakePrompt({
      threads: [], recentWakes: [], recentChat: [], userState: 'idle', reason: 'r', now: new Date('2026-11-06T02:00:00Z'),
      missedAlarms: [{ id: 'a', wakeAt: '2026-11-05T23:30:00Z', note: '回来\n接话' }]
    })
    assert.match(p, /你错过了 1 个自己定的闹钟（到点的时候系统没在运行，没能叫醒你）/)
    assert.match(p, /原定 11月6日 07:30，到现在晚了 2\.5 小时：「回来 接话」/)
  })

  function run(db: DB, reply: { status?: number; content?: string }) {
    const up = fakeUpstream((req, res) => {
      if (req.url.startsWith('/bark')) { res.writeHead(200); res.end('{}'); return }
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: reply.content ?? '' }, finish_reason: 'stop' }] }))
    })
    const opp: WakeOpportunity = { id: crypto.randomUUID(), origin: 'spontaneous', sources: [], reason: '测试', createdAt: new Date().toISOString() }
    db.prepare('INSERT INTO wake_opportunities(id, origin, reason, created_at) VALUES (?, ?, ?, ?)').run(opp.id, opp.origin, opp.reason, opp.createdAt)
    return (async () => {
      const port = await listen(up.server)
      try {
        await dispatchWake(opp, db, { upstreamUrl: `http://127.0.0.1:${port}/v1`, upstreamKey: 'k', model: 'm', maxTokens: 2000, retryDelayMs: 0, log: () => {} })
      } finally { await close(up.server) }
      return JSON.parse(up.seen[0].body).messages.at(-1).content as string
    })()
  }

  it('成功醒来一次就算告诉过，下次不再说；醒来出错不算', async () => {
    const db = freshDb()
    addAlarm(db, 'm1', 120, '回来接话')
    db.prepare("UPDATE wake_precise SET status = 'missed' WHERE id = 'm1'").run()

    const p1 = await run(db, { status: 400 })                  // 出错（400 不重试）
    assert.match(p1, /你错过了 1 个/)
    assert.equal((db.prepare("SELECT missed_notified_at FROM wake_precise WHERE id='m1'").get() as any).missed_notified_at, null)

    const p2 = await run(db, { content: '[SILENT]' })          // 成功
    assert.match(p2, /你错过了 1 个/)
    assert.ok((db.prepare("SELECT missed_notified_at FROM wake_precise WHERE id='m1'").get() as any).missed_notified_at)

    const p3 = await run(db, { content: '[SILENT]' })
    assert.doesNotMatch(p3, /你错过了/)
  })

  it('不带工具的旧做法也一样', async () => {
    process.env.WAKE_TOOLS = '0'
    try {
      const db = freshDb()
      addAlarm(db, 'm2', 120, 'x')
      db.prepare("UPDATE wake_precise SET status = 'missed' WHERE id = 'm2'").run()
      assert.match(await run(db, { content: '[SILENT]' }), /你错过了 1 个/)
      assert.doesNotMatch(await run(db, { content: '[SILENT]' }), /你错过了/)
    } finally { delete process.env.WAKE_TOOLS }
  })
})

describe('她正在聊的时候不另外醒（2026-11-07）', () => {
  function sched(db: DB) {
    const woke: WakeOpportunity[] = []
    const logs: string[] = []
    const s = new WakeScheduler(db, { tickIntervalMs: 3_600_000, onWake: async o => { woke.push(o) }, log: m => logs.push(m) })
    return { woke, logs, once: () => { s.start(); s.stop() } }
  }
  const herMsg = (db: DB, minAgo: number) => db.prepare(`INSERT INTO episodes(ts, channel, scope, actor, kind, content)
    VALUES (?, 'chat', 'daily', 'erica', 'message', 'hi')`).run(new Date(Date.now() - minAgo * MIN).toISOString())
  const primed = () => {
    const db = freshDb()
    // 累积已经过了门槛：这一 tick 一定触发
    db.prepare('UPDATE wake_state SET h = 5, theta = 1 WHERE id = 1').run()
    return db
  }

  it('累积到了、她 3 分钟前还在说话 → 不醒，累积清零重新攒', () => {
    const db = primed(); herMsg(db, 3)
    const t = sched(db); t.once()
    assert.equal(t.woke.length, 0)
    assert.ok(t.logs.some(l => l.includes('正在聊') && l.includes('不另外醒')))
    assert.equal((db.prepare('SELECT h FROM wake_state').get() as any).h, 0)
  })

  it('她 20 分钟前说的话 → 照常醒', () => {
    const db = primed(); herMsg(db, 20)
    const t = sched(db); t.once()
    assert.equal(t.woke.length, 1)
  })

  it('他自己定的闹钟不受影响：聊着天也照响', () => {
    const db = freshDb(); herMsg(db, 1)
    addAlarm(db, 'a', 1, '提醒她喝水')
    const t = sched(db); t.once()
    assert.equal(t.woke.length, 1)
    assert.match(t.woke[0].reason, /提醒她喝水/)
  })
})
