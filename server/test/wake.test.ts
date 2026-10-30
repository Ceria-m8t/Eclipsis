import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import { ensureWakeSchema } from '../src/wake/schema.ts'
import { tick, drawTheta, loadState, saveState, DEFAULT_PARAMS } from '../src/wake/engine.ts'
import { readSilence, readUserState, readThreads } from '../src/wake/sources.ts'
import { recordOutcome } from '../src/wake/scheduler.ts'
import {
  setFrequency, setSourceFactor, setAlarm, cancelAlarm,
  addThread, completeThread, inspectWakeControl
} from '../src/wake/tools.ts'

import type { SpontaneousState, SourceReading } from '../src/wake/types.ts'

let db: DB

beforeEach(() => {
  db = openDb(':memory:')
  ensureWakeSchema(db)
})

afterEach(() => { db.close() })

// ── engine ──

describe('tick', () => {
  it('H 累积，λ 正比于来源值', () => {
    const state: SpontaneousState = {
      H: 0, theta: 1, lastTickAt: '2026-10-29T10:00:00Z',
      frequencyMode: 'normal'
    }
    const readings: SourceReading[] = [
      { sourceId: 'silence', value: 0.8, stale: false },
      { sourceId: 'user_state', value: 0.7, stale: false }
    ]
    const result = tick(state, {
      now: new Date('2026-10-29T11:00:00Z'),  // 1 小时后
      readings,
      sourceFactors: new Map()
    })
    assert.ok(result.lambda > 0, 'λ 应该 > 0')
    assert.ok(result.state.H > 0 || result.triggered, 'H 应该增长或已触发')
    assert.equal(result.contributions.length, 2)
  })

  it('stale 来源权重自动降为 0', () => {
    const state: SpontaneousState = {
      H: 0, theta: 10, lastTickAt: '2026-10-29T10:00:00Z',
      frequencyMode: 'normal'
    }
    const readings: SourceReading[] = [
      { sourceId: 'silence', value: 0.9, stale: true },
      { sourceId: 'user_state', value: 0.9, stale: true }
    ]
    const result = tick(state, {
      now: new Date('2026-10-29T11:00:00Z'),
      readings,
      sourceFactors: new Map()
    })
    // 所有来源 stale → 有效加权和为 0 → λ 被 clamp 到 lambdaMin
    assert.ok(result.lambda <= DEFAULT_PARAMS.lambdaMin + 0.001)
  })

  it('冷却期内 λ 被压低', () => {
    const state: SpontaneousState = {
      H: 0, theta: 10, lastTickAt: '2026-10-29T10:00:00Z',
      lastWakeAt: '2026-10-29T10:00:00Z',  // 刚醒来
      frequencyMode: 'normal'
    }
    const readings: SourceReading[] = [
      { sourceId: 'silence', value: 1.0, stale: false }
    ]
    const result = tick(state, {
      now: new Date('2026-10-29T10:05:00Z'),  // 5 分钟后
      readings,
      sourceFactors: new Map()
    })
    // 5 分钟 / 20 分钟冷却 = 0.25 乘数，λ 应该比较低
    assert.ok(result.lambda < DEFAULT_PARAMS.lambdaBase * 0.5, `λ=${result.lambda} 冷却期应更低`)
  })

  it('silent 模式下 λ = 0', () => {
    const state: SpontaneousState = {
      H: 0, theta: 1, lastTickAt: '2026-10-29T10:00:00Z',
      frequencyMode: 'silent'
    }
    const result = tick(state, {
      now: new Date('2026-10-29T11:00:00Z'),
      readings: [{ sourceId: 'silence', value: 1.0, stale: false }],
      sourceFactors: new Map()
    })
    assert.equal(result.lambda, 0)
    assert.equal(result.triggered, false)
  })

  it('自定义 factor 覆盖来源权重', () => {
    const state: SpontaneousState = {
      H: 0, theta: 10, lastTickAt: '2026-10-29T10:00:00Z',
      frequencyMode: 'normal'
    }
    const readings: SourceReading[] = [
      { sourceId: 'silence', value: 0.8, stale: false },
      { sourceId: 'user_state', value: 0.8, stale: false }
    ]
    // 把 silence 关掉（factor=0），只有 user_state 参与
    const factors = new Map([['silence' as const, 0]])
    const result = tick(state, {
      now: new Date('2026-10-29T11:00:00Z'),
      readings,
      sourceFactors: factors
    })
    const silenceContrib = result.contributions.find(c => c.sourceId === 'silence')!
    assert.equal(silenceContrib.factor, 0)
    assert.equal(silenceContrib.weighted, 0)
  })

  it('H ≥ Θ 时触发并重置', () => {
    const state: SpontaneousState = {
      H: 0.95, theta: 1.0, lastTickAt: '2026-10-29T10:00:00Z',
      frequencyMode: 'normal'
    }
    const result = tick(state, {
      now: new Date('2026-10-29T11:00:00Z'),
      readings: [{ sourceId: 'silence', value: 1.0, stale: false }],
      sourceFactors: new Map()
    })
    assert.equal(result.triggered, true)
    assert.equal(result.state.H, 0, 'H 触发后归零')
    assert.notEqual(result.state.theta, 1.0, 'Θ 触发后重新抽取')
  })

  it('dt 上限 6 小时，防止宕机后 H 暴涨', () => {
    const state: SpontaneousState = {
      H: 0, theta: 100, lastTickAt: '2026-10-28T10:00:00Z',
      frequencyMode: 'normal'
    }
    const result = tick(state, {
      now: new Date('2026-10-29T10:00:00Z'),  // 24 小时后
      readings: [{ sourceId: 'silence', value: 1.0, stale: false }],
      sourceFactors: new Map()
    })
    // 最多算 6 小时 × lambdaMax
    const maxH = DEFAULT_PARAMS.lambdaMax * 6
    assert.ok(result.state.H <= maxH, `H=${result.state.H} 不应超过 ${maxH}`)
  })
})

describe('drawTheta', () => {
  it('结果在 [0.3, 3.0] 范围内', () => {
    for (let i = 0; i < 100; i++) {
      const t = drawTheta()
      assert.ok(t >= 0.3 && t <= 3.0, `theta=${t}`)
    }
  })
})

describe('state persistence', () => {
  it('load → save → load 往返一致', () => {
    const s1 = loadState(db)
    s1.H = 0.42
    s1.theta = 1.7
    s1.frequencyMode = 'low_frequency'
    s1.lastWakeAt = '2026-10-29T08:00:00Z'
    saveState(db, s1)

    const s2 = loadState(db)
    assert.equal(s2.H, 0.42)
    assert.equal(s2.theta, 1.7)
    assert.equal(s2.frequencyMode, 'low_frequency')
    assert.equal(s2.lastWakeAt, '2026-10-29T08:00:00Z')
  })
})

// ── sources ──

describe('readSilence', () => {
  it('无历史消息时返回 0.5', () => {
    const r = readSilence(db, new Date())
    assert.equal(r.sourceId, 'silence')
    assert.equal(r.value, 0.5)
  })

  it('有消息时按间隔计算', () => {
    db.prepare(`INSERT INTO episodes(ts, channel, scope, actor, kind, content, source_ref)
      VALUES (?, 'chat', 'daily', 'erica', 'message', '你好', 'test:1')`).run('2026-10-29T10:00:00Z')
    
    // 60 分钟后 → sigmoid 约 0.5
    const r = readSilence(db, new Date('2026-10-29T11:00:00Z'))
    assert.ok(r.value > 0.4 && r.value < 0.6, `60min silence → ${r.value}`)
    
    // 240 分钟后 → sigmoid 应该高
    const r2 = readSilence(db, new Date('2026-10-29T14:00:00Z'))
    assert.ok(r2.value > 0.8, `240min silence → ${r2.value}`)
  })
})

describe('readUserState', () => {
  it('5分钟内有消息 → chatting (低适宜度)', () => {
    const now = new Date('2026-10-29T12:00:00Z')
    db.prepare(`INSERT INTO episodes(ts, channel, scope, actor, kind, content, source_ref)
      VALUES (?, 'chat', 'daily', 'erica', 'message', '在呢', 'test:us1')`).run('2026-10-29T11:57:00Z')
    
    const r = readUserState(db, now)
    assert.ok(r.value <= 0.2, `chatting suitability should be low: ${r.value}`)
  })

  it('6小时没消息 → sleeping (适宜度 0)', () => {
    const now = new Date('2026-10-29T18:00:00Z')
    db.prepare(`INSERT INTO episodes(ts, channel, scope, actor, kind, content, source_ref)
      VALUES (?, 'chat', 'daily', 'erica', 'message', '晚安', 'test:us2')`).run('2026-10-29T11:00:00Z')
    
    const r = readUserState(db, now)
    assert.equal(r.value, 0, 'sleeping → 0')
  })
})

describe('readThreads', () => {
  it('无线头时值为 0', () => {
    const r = readThreads(db, new Date())
    assert.equal(r.value, 0)
  })

  it('有活跃线头时值递增', () => {
    const now = new Date('2026-10-29T12:00:00Z')
    for (let i = 0; i < 3; i++) {
      db.prepare(`INSERT INTO wake_threads(id, text, created_at, status)
        VALUES (?, ?, ?, 'active')`).run(`t${i}`, `线头${i}`, now.toISOString())
    }
    const r = readThreads(db, now)
    assert.ok(r.value > 0.5, `3 threads → ${r.value}`)
  })
})

// ── wake_opportunities ──

describe('recordOutcome', () => {
  it('写入结局', () => {
    db.prepare(`INSERT INTO wake_opportunities(id, origin, reason, created_at)
      VALUES ('opp1', 'spontaneous', '测试', '2026-10-29T12:00:00Z')`).run()
    
    recordOutcome(db, 'opp1', 'message', '他发了条消息', '完整内容', 'rid123')
    
    const row = db.prepare('SELECT * FROM wake_opportunities WHERE id = ?').get('opp1') as any
    assert.equal(row.outcome, 'message')
    assert.equal(row.fact, '他发了条消息')
    assert.equal(row.content, '完整内容')
    assert.equal(row.exchange_rid, 'rid123')
    assert.ok(row.finished_at)
  })
})

// ── schema ──

describe('ensureWakeSchema', () => {
  it('重复调用不报错', () => {
    ensureWakeSchema(db)  // 第二次
    ensureWakeSchema(db)  // 第三次
    const state = loadState(db)
    assert.equal(state.frequencyMode, 'normal')
  })
})


// ── tools ──

describe('setFrequency', () => {
  it('切换到 silent 并设时限', () => {
    
    const r = setFrequency(db, { mode: 'silent', durationMinutes: 120 })
    assert.equal(r.ok, true)
    assert.equal(r.mode, 'silent')
    assert.ok(r.expiresAt)
    // 状态持久化
    
    const s = loadState(db)
    assert.equal(s.frequencyMode, 'silent')
  })
})

describe('setSourceFactor', () => {
  it('设置来源因子 clamp 到 [0,2]', () => {
    
    const r = setSourceFactor(db, { sourceId: 'silence', factor: 3 })
    assert.equal(r.factor, 2)  // clamped
    const r2 = setSourceFactor(db, { sourceId: 'silence', factor: -1 })
    assert.equal(r2.factor, 0)  // clamped
  })
})

describe('alarm', () => {
  it('设闹钟 → 取消', () => {
    
    const r = setAlarm(db, { afterMinutes: 30, note: '话没说完' })
    assert.equal(r.ok, true)
    assert.ok(r.id)
    assert.ok(r.wakeAt)
    assert.equal(r.note, '话没说完')
    // 取消
    const c = cancelAlarm(db, r.id)
    assert.equal(c.ok, true)
    // 再取消 → 失败
    const c2 = cancelAlarm(db, r.id)
    assert.equal(c2.ok, false)
  })
})

describe('thread', () => {
  it('添加线头 → 完成', () => {
    
    const r = addThread(db, { text: '想给她画张图' })
    assert.equal(r.ok, true)
    assert.equal(r.text, '想给她画张图')
    const c = completeThread(db, r.id)
    assert.equal(c.ok, true)
  })

  it('超过 5 根线头时最旧的自动完成', () => {
    
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      const r = addThread(db, { text: `线头${i}` })
      ids.push(r.id)
    }
    // 第 0 根应该被自动完成
    const row = db.prepare("SELECT status FROM wake_threads WHERE id = ?").get(ids[0]) as any
    assert.equal(row.status, 'completed')
  })
})

describe('inspectWakeControl', () => {
  it('返回当前控制状态', () => {
    
    const r = inspectWakeControl(db)
    assert.ok(r.frequency)
    assert.ok(Array.isArray(r.sourceFactors))
    assert.ok(Array.isArray(r.pendingAlarms))
    assert.ok(Array.isArray(r.activeThreads))
  })
})
