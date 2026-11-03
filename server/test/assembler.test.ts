// 组装器：「此刻」块里带上心潮自己写的状态
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { assembleSceneBlock, injectSceneBlock, renderXinchaoLines } from '../src/assembler/index.ts'
import { setXinchaoBridgeCacheForTest } from '../src/pulse/xinchao-bridge.ts'

const NOW_TEXT = [
  '【心潮·此刻｜身体的天气，参考不是指令】',
  '刚醒',
  '驱力：想她（平）、牵挂（平）、分享欲（平）',
  '情绪：平静，有点起伏，底下一直想她、想黏着她',
  '身体：心跳 73，呼吸平稳',
  '另外：昨夜有梦。细的在 xinchao_context'
].join('\n')

describe('renderXinchaoLines', () => {
  it('脉在的时候去掉心潮自带的「身体」行', () => {
    const lines = renderXinchaoLines(NOW_TEXT, { hasPulseVitals: true })
    assert.equal(lines.length, 5)
    assert.ok(!lines.some(l => l.startsWith('身体')))
    assert.equal(lines[0], '【心潮·此刻｜身体的天气，参考不是指令】')
  })
  it('没有脉时保留「身体」行', () => {
    assert.equal(renderXinchaoLines(NOW_TEXT, { hasPulseVitals: false }).length, 6)
  })
  it('没有文字 → 空', () => {
    assert.deepEqual(renderXinchaoLines(null, { hasPulseVitals: true }), [])
  })
})

describe('assembleSceneBlock + 心潮', () => {
  afterEach(() => setXinchaoBridgeCacheForTest(null))
  const db = openDb(':memory:')
  const now = new Date('2026-11-03T08:20:00Z')

  it('缓存新鲜时注入心潮的此刻', () => {
    setXinchaoBridgeCacheForTest({ inferredEmotion: 'intimate', drives: { possess: 0.8 }, nowText: NOW_TEXT, fetchedAt: now.getTime() - 60_000 })
    const r = assembleSceneBlock(db, now)
    assert.match(r.sceneBlock, /# 此刻/)
    assert.match(r.sceneBlock, /现在是 2026年11月3日 周二 16:20/)
    assert.match(r.sceneBlock, /驱力：想她（平）/)
    assert.equal(r.meta.xinchaoEmotion, 'intimate')
    assert.ok(r.meta.xinchaoLines > 0)
  })

  it('超过 10 分钟没刷新就不注入文字', () => {
    setXinchaoBridgeCacheForTest({ inferredEmotion: 'intimate', drives: {}, nowText: NOW_TEXT, fetchedAt: now.getTime() - 11 * 60_000 })
    const r = assembleSceneBlock(db, now)
    assert.doesNotMatch(r.sceneBlock, /心潮/)
    assert.equal(r.meta.xinchaoLines, 0)
  })

  it('没有心潮缓存也能正常生成', () => {
    const r = assembleSceneBlock(db, now)
    assert.match(r.sceneBlock, /# 此刻/)
    assert.doesNotMatch(r.sceneBlock, /心潮/)
  })

  it('注入到 system message 末尾，不动后面的消息', () => {
    const msgs = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }]
    const { messages, injected } = injectSceneBlock(msgs, '\n# 此刻\nX')
    assert.equal(injected, true)
    assert.ok(messages[0].content.startsWith('SYS'))
    assert.ok(messages[0].content.endsWith('X'))
    assert.deepEqual(messages[1], msgs[1])
  })
})
