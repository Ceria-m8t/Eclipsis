// 最长间隔：距离上次说话/醒来 150–180 分钟一定醒；他自己选了低频/静默时不生效
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, addEpisode } from '../src/db.ts'
import { ensureWakeSchema } from '../src/wake/index.ts'
import { WakeScheduler, maxGapDeadline, lastActivityAt } from '../src/wake/scheduler.ts'
import { readThreads } from '../src/wake/sources.ts'
import { loadState } from '../src/wake/engine.ts'
import type { WakeOpportunity } from '../src/wake/types.ts'

const MIN = 60_000

describe('maxGapDeadline', () => {
  it('落在 [150, 180] 分钟之间，同一个锚点结果固定', () => {
    for (let i = 0; i < 200; i++) {
      const a = new Date(Date.UTC(2026, 10, 3, 0, i * 7, i))
      const d = maxGapDeadline(a, 150, 180)
      const gap = (d.getTime() - a.getTime()) / MIN
      assert.ok(gap >= 150 && gap <= 180, `${gap}`)
      assert.equal(maxGapDeadline(a, 150, 180).getTime(), d.getTime())
    }
  })
  it('不同锚点会抽到不同的数（不是固定 150）', () => {
    const gaps = new Set<number>()
    for (let i = 0; i < 50; i++) {
      const a = new Date(Date.UTC(2026, 10, 3, 0, i))
      gaps.add(Math.round((maxGapDeadline(a, 150, 180).getTime() - a.getTime()) / MIN))
    }
    assert.ok(gaps.size > 10, `${gaps.size}`)
  })
})

function setup(opts: { lastChatMinAgo?: number; lastWakeMinAgo?: number; mode?: string } = {}) {
  const db = openDb(':memory:')
  ensureWakeSchema(db)
  const now = Date.now()
  // 门槛设高、刚 tick 过：正常累积不可能在这一次触发，只看兜底
  db.prepare("UPDATE wake_state SET h = 0, theta = 3, last_tick_at = ?, frequency_mode = ? WHERE id = 1")
    .run(new Date(now - MIN).toISOString(), opts.mode ?? 'normal')
  if (opts.lastChatMinAgo !== undefined) {
    addEpisode(db, { ts: new Date(now - opts.lastChatMinAgo * MIN).toISOString(), channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: 'hi' })
  }
  if (opts.lastWakeMinAgo !== undefined) {
    db.prepare("INSERT INTO wake_opportunities(id, origin, reason, created_at, outcome) VALUES ('w0', 'spontaneous', 'x', ?, 'error')")
      .run(new Date(now - opts.lastWakeMinAgo * MIN).toISOString())
  }
  const woke: WakeOpportunity[] = []
  const sched = new WakeScheduler(db, { tickIntervalMs: 3_600_000, onWake: async o => { woke.push(o) }, log: () => {} })
  return { db, woke, runOnce: () => { sched.start(); sched.stop() } }
}

describe('WakeScheduler 最长间隔兜底', () => {
  it('沉默 200 分钟 → 一定醒，原因说明过了多久', () => {
    const t = setup({ lastChatMinAgo: 200 })
    t.runOnce()
    assert.equal(t.woke.length, 1)
    assert.match(t.woke[0].reason, /已经 200 分钟了/)
    const s = loadState(t.db)
    assert.equal(s.H, 0)
    assert.ok(s.lastWakeAt)
  })
  it('30 分钟前还在聊 → 不兜底', () => {
    const t = setup({ lastChatMinAgo: 30 })
    t.runOnce()
    assert.equal(t.woke.length, 0)
  })
  it('锚点取较晚的那个：聊天 200 分钟前，但 20 分钟前醒过（哪怕失败）→ 不兜底', () => {
    const t = setup({ lastChatMinAgo: 200, lastWakeMinAgo: 20 })
    assert.equal(Math.round((Date.now() - lastActivityAt(t.db)!.getTime()) / MIN), 20)
    t.runOnce()
    assert.equal(t.woke.length, 0)
  })
  it('他自己选了 low_frequency / silent → 不兜底', () => {
    for (const mode of ['low_frequency', 'silent']) {
      const t = setup({ lastChatMinAgo: 300, mode })
      t.runOnce()
      assert.equal(t.woke.length, 0, mode)
    }
  })
  it('完全没有历史 → 不兜底', () => {
    const t = setup()
    t.runOnce()
    assert.equal(t.woke.length, 0)
  })
})

describe('readThreads', () => {
  it('没有线头时标为 stale，不参与平均', () => {
    const db = openDb(':memory:')
    ensureWakeSchema(db)
    assert.equal(readThreads(db, new Date()).stale, true)
  })
})
