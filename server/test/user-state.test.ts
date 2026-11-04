// user-state.ts：三路证据（她说的话 / 作息曲线 / 沉默）合成状态概率 + 适宜度 + 给他看的话
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import { ensureWakeSchema } from '../src/wake/index.ts'
import { inferUserState, stripTimeShell } from '../src/wake/user-state.ts'

let db: DB
beforeEach(() => { db = openDb(':memory:'); ensureWakeSchema(db) })

// 每次新建 :memory: db，作息缓存按 db 分桶，互不干扰
function say(ts: string, content: string, actor = 'erica') {
  db.prepare(`INSERT INTO episodes(ts, channel, scope, actor, kind, content, source_ref)
    VALUES (?, 'chat', 'daily', ?, 'message', ?, ?)`).run(ts, actor, content, `t:${ts}:${Math.random()}`)
}

describe('stripTimeShell', () => {
  it('剥 current_time、Kelivo 时间前缀、图片占位', () => {
    assert.equal(stripTimeShell('去睡了 <current_time>Tue 2026-11-03 02:00</current_time>'), '去睡了')
    assert.equal(stripTimeShell('（2026-10-31 15:20）老公'), '老公')
    assert.equal(stripTimeShell('看这个 [图片] 好看吗'), '看这个 好看吗')
  })
})

describe('inferUserState — 信号 1 她说的话', () => {
  it('刚说完话 → chatting，适宜度低', () => {
    const now = new Date('2026-10-29T12:00:00Z')  // 北京 20:00
    say('2026-10-29T11:57:00Z', '在呢')
    const e = inferUserState(db, now)
    assert.equal(e.state, 'chatting')
    assert.ok(e.suitability <= 0.2, `适宜度应低: ${e.suitability}`)
    assert.ok(e.pSleeping < 0.1)
  })

  it('说"晚安"后几小时 → sleeping，P(睡)>0.5，但适宜度非 0', () => {
    const now = new Date('2026-10-29T18:00:00Z')   // 北京 02:00
    say('2026-10-29T11:00:00Z', '困死了，晚安老公')  // 北京 19:00
    const e = inferUserState(db, now)
    assert.equal(e.state, 'sleeping')
    assert.ok(e.pSleeping > 0.5, `P睡: ${e.pSleeping}`)
    assert.ok(e.suitability > 0.2 && e.suitability < 0.5, `适宜度: ${e.suitability}`)
    assert.match(e.evidence, /睡/)
  })

  it('"睡不着/不想睡" 不触发 sleeping cue', () => {
    const now = new Date('2026-10-29T18:10:00Z')
    say('2026-10-29T18:05:00Z', '我现在不想睡，睡不着')  // 刚说，5 分钟内
    const e = inferUserState(db, now)
    assert.notEqual(e.state, 'sleeping')
    assert.ok(e.pSleeping < 0.2, `P睡应低: ${e.pSleeping}`)
  })

  it('"去洗澡" → busy/away，不是 sleeping', () => {
    const now = new Date('2026-10-29T13:10:00Z')
    say('2026-10-29T13:00:00Z', '我去洗澡啦')
    const e = inferUserState(db, now)
    assert.ok(e.state === 'busy' || e.state === 'away', `state: ${e.state}`)
    assert.ok(e.pSleeping < 0.1)
    assert.match(e.evidence, /洗澡/)
  })

  it('"七点半回来"：窗口内 away，过点后置信度衰减', () => {
    // 北京 10:00 说七点半回来 → 结束北京 19:30
    const said = '2026-10-29T02:00:00Z'
    say(said, '我出门了，七点半回来')
    const during = inferUserState(db, new Date('2026-10-29T06:00:00Z'))  // 北京 14:00
    assert.equal(during.state, 'away')
    assert.match(during.evidence, /还没回来/)
    // 远远过了 19:30（北京次日 10:00）后，这条线索应已衰减，不再主导
    const after = inferUserState(db, new Date('2026-10-30T02:00:00Z'))
    assert.notEqual(after.evidence, during.evidence)
  })

  it('解析中文数字时间：七点半 与 7点半 等价', () => {
    say('2026-10-29T02:00:00Z', '出门啦七点半回来')
    const cn = inferUserState(db, new Date('2026-10-29T06:00:00Z'))
    db = openDb(':memory:'); ensureWakeSchema(db)
    say('2026-10-29T02:00:00Z', '出门啦7点半回来')
    const num = inferUserState(db, new Date('2026-10-29T06:00:00Z'))
    assert.equal(cn.state, num.state)
    assert.equal(cn.state, 'away')
  })
})

describe('inferUserState — 作息曲线兜底', () => {
  it('没有任何消息 → 退回作息先验，不报错', () => {
    const e = inferUserState(db, new Date('2026-10-29T18:00:00Z'))
    assert.ok(e.probabilities)
    assert.ok(Math.abs(
      Object.values(e.probabilities).reduce((a, b) => a + b, 0) - 1
    ) < 1e-6, '概率和应为 1')
  })

  it('攒够作息数据后，深夜静默 → 倾向 sleeping', () => {
    // 造 30 天数据：每天只在北京 9:00-22:00 说话，夜里从不说
    const base = Date.UTC(2026, 9, 1)  // 10-01
    for (let d = 0; d < 30; d++) {
      for (const bjHour of [9, 12, 15, 18, 21]) {
        const utc = base + d * 86_400_000 + (bjHour - 8) * 3600_000
        say(new Date(utc).toISOString(), `第${d}天${bjHour}点`)
      }
    }
    // 北京 03:00 判断（UTC 19:00），距最后一条已数小时
    const now = new Date(Date.UTC(2026, 9, 30, 19, 0))
    const e = inferUserState(db, now)
    assert.equal(e.state, 'sleeping', `深夜该判 sleeping: ${e.state} ${JSON.stringify(e.probabilities)}`)
  })
})
