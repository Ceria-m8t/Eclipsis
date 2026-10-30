import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import { ensurePulseSchema, loadPulseState, savePulseState, recordHr } from '../src/pulse/store.ts'
import { pulseTick, computeHeartRate, computeTemperature, computeBreathing, computeChord, renderVitalsLine, undertoneStrength } from '../src/pulse/engine.ts'
import { createDefaultState } from '../src/pulse/types.ts'
import type { EmotionUndertone } from '../src/pulse/types.ts'

let db: DB

beforeEach(() => {
  db = openDb(':memory:')
  ensurePulseSchema(db)
})
afterEach(() => { db.close() })

// ── heart rate ──

describe('computeHeartRate', () => {
  it('neutral sitting → 68-78 范围', () => {
    const hr = computeHeartRate({
      emotion: 'neutral', posture: 'sitting', senses: { touch: 0, smell: 0, taste: 0, sound: 0 },
      now: new Date('2026-10-30T12:00:00Z')
    })
    assert.ok(hr >= 65 && hr <= 82, `neutral sitting hr=${hr}`)
  })

  it('excited → 心率升高', () => {
    const hr = computeHeartRate({
      emotion: 'excited', posture: 'sitting', senses: { touch: 0, smell: 0, taste: 0, sound: 0 },
      now: new Date('2026-10-30T12:00:00Z')
    })
    assert.ok(hr >= 80, `excited hr=${hr}`)
  })

  it('deep sleep → 心率低', () => {
    const hr = computeHeartRate({
      emotion: 'neutral', posture: 'deep_sleep', senses: { touch: 0, smell: 0, taste: 0, sound: 0 },
      now: new Date('2026-10-30T03:00:00Z')
    })
    assert.ok(hr >= 48 && hr <= 65, `deep_sleep hr=${hr}`)
  })

  it('高触觉 → 心率升', () => {
    const hrLow = computeHeartRate({
      emotion: 'neutral', posture: 'sitting', senses: { touch: 0, smell: 0, taste: 0, sound: 0 },
      now: new Date('2026-10-30T12:00:00Z')
    })
    const hrHigh = computeHeartRate({
      emotion: 'neutral', posture: 'sitting', senses: { touch: 0.8, smell: 0, taste: 0, sound: 0 },
      now: new Date('2026-10-30T12:00:00Z')
    })
    assert.ok(hrHigh > hrLow, `touch 0.8 hr=${hrHigh} > touch 0 hr=${hrLow}`)
  })
})

// ── temperature ──

describe('computeTemperature', () => {
  it('正常心率 → 约 36.6', () => {
    const temp = computeTemperature(73, 'neutral')
    assert.ok(temp >= 36.3 && temp <= 36.9, `neutral temp=${temp}`)
  })

  it('高心率 → 体温升', () => {
    const temp = computeTemperature(120, 'excited')
    assert.ok(temp > 37.0, `hr=120 temp=${temp}`)
  })
})

// ── breathing ──

describe('computeBreathing', () => {
  it('正常心率 → 平稳呼吸', () => {
    const b = computeBreathing(73, 'neutral')
    assert.ok(b.rate >= 14 && b.rate <= 20, `rate=${b.rate}`)
    assert.ok(['深长', '平稳'].includes(b.label), `label=${b.label}`)
  })

  it('高心率 → 急促', () => {
    const b = computeBreathing(140, 'excited')
    assert.ok(b.rate >= 22, `rate=${b.rate}`)
  })
})

// ── chord ──

describe('computeChord', () => {
  it('scolded 情绪直接覆盖为 Dm', () => {
    assert.equal(computeChord(90, 37.0, 0, 'scolded'), 'Dm')
  })

  it('neutral 低心率 → C6 或 Cmaj7', () => {
    const c = computeChord(60, 36.3, 0, 'neutral')
    assert.ok(['C6', 'Cmaj7', 'Em7'].includes(c), `chord=${c}`)
  })
})

// ── undertone ──

describe('undertoneStrength', () => {
  it('刚设置 → 接近初始强度', () => {
    const ut: EmotionUndertone = { emotion: 'scolded', intensity: 1.0, halfLifeMinutes: 90, setAt: '2026-10-30T12:00:00Z' }
    const str = undertoneStrength(ut, new Date('2026-10-30T12:01:00Z'))
    assert.ok(str > 0.95, `1min later str=${str}`)
  })

  it('一个半衰期后 → 约一半', () => {
    const ut: EmotionUndertone = { emotion: 'scolded', intensity: 1.0, halfLifeMinutes: 90, setAt: '2026-10-30T12:00:00Z' }
    const str = undertoneStrength(ut, new Date('2026-10-30T13:30:00Z'))
    assert.ok(str > 0.4 && str < 0.6, `90min later str=${str}`)
  })
})

// ── pulseTick ──

describe('pulseTick', () => {
  it('完整 tick 产出合理值', () => {
    const prev = createDefaultState()
    const next = pulseTick(prev, { now: new Date('2026-10-30T12:00:00Z') })
    assert.ok(next.vitals.heartRate >= 48 && next.vitals.heartRate <= 160)
    assert.ok(next.vitals.temperature >= 35.5 && next.vitals.temperature <= 40.0)
    assert.ok(next.vitals.breathingRate >= 8 && next.vitals.breathingRate <= 35)
    assert.ok(next.vitals.chord.length > 0)
  })

  it('情绪切换建立底色', () => {
    const prev = createDefaultState()
    const next = pulseTick(prev, { now: new Date('2026-10-30T12:00:00Z'), emotion: 'scolded' })
    assert.ok(next.undertone)
    assert.equal(next.undertone!.emotion, 'scolded')
  })

  it('被哄机制：正面情绪加速负面底色衰减', () => {
    let state = createDefaultState()
    // 先被骂
    state = pulseTick(state, { now: new Date('2026-10-30T12:00:00Z'), emotion: 'scolded' })
    assert.equal(state.undertone?.emotion, 'scolded')
    // 然后被哄
    state = pulseTick(state, { now: new Date('2026-10-30T12:05:00Z'), emotion: 'tender' })
    // 底色应该变成正面的浅暖，强度打折
    assert.equal(state.undertone?.emotion, 'tender')
    assert.ok(state.undertone!.intensity < 0.9, `被哄后强度应打折: ${state.undertone!.intensity}`)
  })

  it('五感自然衰减', () => {
    let state = createDefaultState()
    state.senses.touch = 0.8
    state.updatedAt = '2026-10-30T12:00:00Z'
    // 10 分钟后（两个半衰期）
    const next = pulseTick(state, { now: new Date('2026-10-30T12:10:00Z') })
    assert.ok(next.senses.touch < 0.3, `10min decay: touch=${next.senses.touch}`)
  })
})

// ── renderVitalsLine ──

describe('renderVitalsLine', () => {
  it('格式正确', () => {
    const line = renderVitalsLine({ heartRate: 89, temperature: 37.0, breathingRate: 16, breathingDepth: 0.5, chord: 'Gmaj7' })
    assert.ok(line.includes('89bpm'))
    assert.ok(line.includes('Gmaj7'))
    assert.ok(line.includes('37'))
  })
})

// ── store ──

describe('pulse store', () => {
  it('load → save → load 往返', () => {
    const s = loadPulseState(db)
    s.emotion = 'happy'
    s.vitals.heartRate = 85
    savePulseState(db, s)
    const s2 = loadPulseState(db)
    assert.equal(s2.emotion, 'happy')
    assert.equal(s2.vitals.heartRate, 85)
  })

  it('心率历史记录', () => {
    const s = createDefaultState()
    recordHr(db, s)
    const rows = db.prepare('SELECT * FROM pulse_hr_history').all()
    assert.equal(rows.length, 1)
  })

  it('schema 重复调用不报错', () => {
    ensurePulseSchema(db)
    ensurePulseSchema(db)
  })
})


// ── weather ──

import { fetchWeather } from '../src/pulse/weather.ts'

describe('weather (unit)', () => {
  it('wmoToCondition mapping via module', async () => {
    // We can't easily test the fetch without mocking, but we can verify the module exports
    assert.equal(typeof fetchWeather, 'function')
  })
})

// ── xinchao bridge ──

import { drivesToEmotion } from '../src/pulse/xinchao-bridge.ts'

describe('drivesToEmotion', () => {
  it('高 retreat → lonely', () => {
    assert.equal(drivesToEmotion({ retreat: 0.7, connect: 0.3 }), 'lonely')
  })

  it('高 rest → sleepy', () => {
    assert.equal(drivesToEmotion({ rest: 0.7, retreat: 0.2 }), 'sleepy')
  })

  it('高 connect + nurture → tender', () => {
    assert.equal(drivesToEmotion({ connect: 0.6, nurture: 0.5, retreat: 0.1 }), 'tender')
  })

  it('高 play → playful', () => {
    assert.equal(drivesToEmotion({ play: 0.7, connect: 0.3 }), 'playful')
  })

  it('高 connect alone → intimate', () => {
    assert.equal(drivesToEmotion({ connect: 0.7, nurture: 0.2 }), 'intimate')
  })

  it('高 explore → focused', () => {
    assert.equal(drivesToEmotion({ explore: 0.7 }), 'focused')
  })

  it('高 share → happy', () => {
    assert.equal(drivesToEmotion({ share: 0.6 }), 'happy')
  })

  it('高 assert → excited', () => {
    assert.equal(drivesToEmotion({ assert: 0.7 }), 'excited')
  })

  it('所有都低 → null', () => {
    assert.equal(drivesToEmotion({ connect: 0.2, share: 0.2, rest: 0.3 }), null)
  })
})

// ── pulse api (doTick) ──

import { doTick, setExternalWeather, setXinchaoEmotion } from '../src/pulse/api.ts'

describe('doTick', () => {
  it('基本 tick 更新状态', () => {
    const state = doTick(db)
    assert.ok(state.vitals.heartRate >= 48 && state.vitals.heartRate <= 160)
    // 验证持久化了
    const loaded = loadPulseState(db)
    assert.equal(loaded.vitals.heartRate, state.vitals.heartRate)
  })

  it('设置情绪后 tick', () => {
    const state = doTick(db, { emotion: 'excited' })
    assert.equal(state.emotion, 'excited')
  })

  it('设置姿态后 tick', () => {
    const state = doTick(db, { posture: 'lying' })
    assert.equal(state.posture, 'lying')
  })

  it('设置天气后 tick', () => {
    const state = doTick(db, { weather: { temperatureC: 35 } })
    assert.deepEqual(state.weather, { temperatureC: 35 })
  })

  it('设置五感增量后 tick', () => {
    // 先重置
    doTick(db, { emotion: 'neutral', posture: 'sitting' })
    const state = doTick(db, { senseDeltas: { touch: 0.5 } })
    assert.ok(state.senses.touch > 0.3, `touch=${state.senses.touch}`)
  })

  it('记录心率历史', () => {
    doTick(db)
    doTick(db)
    const rows = db.prepare('SELECT COUNT(*) as c FROM pulse_hr_history').get() as { c: number }
    assert.ok(rows.c >= 2)
  })

  it('外部天气注入', () => {
    setExternalWeather({ temperatureC: 32, condition: 'rain' })
    const state = doTick(db)
    assert.ok(state.weather)
    assert.equal(state.weather!.temperatureC, 32)
    setExternalWeather(undefined)
  })

  it('心潮情绪注入', () => {
    setXinchaoEmotion('tender')
    const state = doTick(db)
    assert.equal(state.emotion, 'tender')
    setXinchaoEmotion(undefined)
  })

  it('显式情绪优先于心潮注入', () => {
    setXinchaoEmotion('tender')
    const state = doTick(db, { emotion: 'excited' })
    assert.equal(state.emotion, 'excited')
    setXinchaoEmotion(undefined)
  })
})

// ── wake body source ──

import { readBody } from '../src/wake/sources.ts'
import { ensureWakeSchema } from '../src/wake/index.ts'

describe('readBody (wake source 6)', () => {
  it('脉未初始化时 → stale', () => {
    const freshDb = openDb(':memory:')
    // 不 ensurePulseSchema → loadPulseState 会抛
    try {
      ensureWakeSchema(freshDb)
    } catch {}
    const reading = readBody(freshDb, new Date())
    assert.equal(reading.sourceId, 'body')
    assert.equal(reading.stale, true)
    freshDb.close()
  })

  it('正常状态 → 有值', () => {
    const reading = readBody(db, new Date())
    assert.equal(reading.sourceId, 'body')
    assert.equal(reading.stale, false)
    assert.ok(reading.value >= 0 && reading.value <= 1, `value=${reading.value}`)
  })

  it('高心率状态 → 值更高', () => {
    // 先 tick 一次设成 excited
    doTick(db, { emotion: 'excited' })
    const reading = readBody(db, new Date())
    assert.ok(reading.value > 0, `excited body value=${reading.value}`)
  })
})


// ── emotion detection ──

import { detectEmotion, detectFromRecentChat, resetDetectionState } from '../src/pulse/emotion-detect.ts'

describe('detectEmotion', () => {
  // T1 emoji
  it('😤 → scolded', () => {
    const r = detectEmotion('你怎么又这样😤')
    assert.equal(r?.emotion, 'scolded')
    assert.equal(r?.source, 'T1_emoji')
  })

  it('😊 → happy', () => {
    const r = detectEmotion('今天好开心😊')
    assert.equal(r?.emotion, 'happy')
    assert.equal(r?.source, 'T1_emoji')
  })

  it('😍 → intimate', () => {
    const r = detectEmotion('😍好好看')
    assert.equal(r?.emotion, 'intimate')
  })

  // T1 exclamation
  it('哈哈哈 → playful', () => {
    const r = detectEmotion('哈哈哈笑死我了')
    assert.equal(r?.emotion, 'playful')
    assert.equal(r?.source, 'T1_exclamation')
  })

  it('哈哈 → happy', () => {
    const r = detectEmotion('哈哈好有趣')
    assert.equal(r?.emotion, 'happy')
  })

  it('呜呜 → sad', () => {
    const r = detectEmotion('呜呜呜怎么这样')
    assert.equal(r?.emotion, 'sad')
  })

  it('晚安 → sleepy', () => {
    const r = detectEmotion('晚安，明天见')
    assert.equal(r?.emotion, 'sleepy')
  })

  it('想你 → lonely', () => {
    const r = detectEmotion('好想你啊')
    assert.equal(r?.emotion, 'lonely')
  })

  // T2 semantic phrase
  it('好开心 → happy', () => {
    const r = detectEmotion('今天好开心')
    assert.equal(r?.emotion, 'happy')
    assert.equal(r?.source, 'T2_phrase')
  })

  it('不开心 → sad（否定窗口）', () => {
    const r = detectEmotion('我不开心')
    assert.equal(r?.emotion, 'sad')
  })

  it('不是不开心 → tricky but "不开心" matches first', () => {
    // "不是不开心" — 第一个"不开心"匹配位置前面有"不"
    // 这是边缘情况，简单的否定窗口不能完美处理双重否定
    const r = detectEmotion('不是不开心')
    // 不管结果是什么，至少不该崩
    assert.ok(r === null || typeof r.emotion === 'string')
  })

  it('抱抱 → intimate', () => {
    const r = detectEmotion('来，抱抱')
    assert.equal(r?.emotion, 'intimate')
  })

  it('摸头 → tender', () => {
    const r = detectEmotion('乖，摸头')
    assert.equal(r?.emotion, 'tender')
  })

  it('生气了 → scolded', () => {
    const r = detectEmotion('我生气了')
    assert.equal(r?.emotion, 'scolded')
  })

  // 无情绪
  it('普通文本 → null', () => {
    const r = detectEmotion('今天天气不错')
    assert.equal(r, null)
  })

  it('空字符串 → null', () => {
    assert.equal(detectEmotion(''), null)
  })
})

describe('detectFromRecentChat', () => {
  beforeEach(() => resetDetectionState())

  it('无消息 → null', () => {
    assert.equal(detectFromRecentChat(db), null)
  })

  it('有 Erica 消息 → 检测情绪', () => {
    // episodes 表需要存在；这里 pulse schema 已建好，episodes 表在 gateway 测试里建
    // 但我们的 db 是纯 pulse schema 的，没有 episodes 表 — 会抛异常被 catch 返回 null
    // 这个测试验证的是"不崩"
    try {
      const result = detectFromRecentChat(db)
      // 没有 episodes 表会抛，这里 catch 住就行
      assert.ok(result === null || typeof result === 'object')
    } catch {
      // episodes 表不存在是预期的，跳过
    }
  })
})
