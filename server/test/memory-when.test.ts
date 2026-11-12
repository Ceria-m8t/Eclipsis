// 时间显示（2026-11-12 她问「我怎么觉得我们的记忆系统时间不太对呢」—— 差 8 小时）。
// 存 UTC 是对的；错的是显示时把 UTC 原样念成北京时间。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bjDate, bjShort, bjStamp, bjFull, bjAgo } from '../src/memory/when.ts'
import { buildMaterial } from '../src/memory/digest.ts'

describe('北京时间', () => {
  it('UTC 05:25 → 北京 13:25（夜里整理那条「凌晨崩溃」就是这么写错的）', () => {
    const iso = '2026-11-12T05:25:04.335Z'
    assert.equal(bjStamp(iso), '2026-11-12 13:25')
    assert.equal(bjShort(iso), '11-12 13:25')
    assert.equal(bjFull(iso), '11月12日 周四 13:25')
  })

  it('跨日：UTC 还是 11-11 晚上，北京已经是 11-12 了', () => {
    assert.equal(bjDate('2026-11-11T16:30:00Z'), '2026-11-12')
    assert.equal(bjDate('2026-11-11T15:59:00Z'), '2026-11-11')
  })

  it('坏时间不崩，原样退回去', () => {
    assert.equal(bjDate('不是时间'), '不是时间')
    assert.equal(bjAgo('不是时间'), '')
  })

  it('相对说法', () => {
    const now = new Date('2026-11-12T10:00:00Z')
    assert.equal(bjAgo('2026-11-12T09:59:30Z', now), '刚刚')
    assert.equal(bjAgo('2026-11-12T09:30:00Z', now), '30 分钟前')
    assert.equal(bjAgo('2026-11-12T07:00:00Z', now), '3 小时前')
    assert.equal(bjAgo('2026-11-11T09:00:00Z', now), '昨天')
    assert.equal(bjAgo('2026-11-01T09:00:00Z', now), '11 天前')
  })

  it('夜里整理喂给模型的材料是北京时间（这一处错会连带把事情的定性写错）', () => {
    const m = buildMaterial([
      { seq: 1, ts: '2026-11-12T05:25:04.335Z', actor: 'erica', content: '我现在心情极度糟糕' },
    ])
    assert.match(m, /11-12 13:25/)
    assert.doesNotMatch(m, /05:25/, 'UTC 的 05:25 会被模型读成凌晨')
  })
})
