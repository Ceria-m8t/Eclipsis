// 脉核心计算：心率 → 体温 → 呼吸 → 和弦，一脉相连。
// 参考 Pulse Tutorial 的物理因果链。所有计算是纯函数。
import type {
  Emotion, Posture, Vitals, SensoryField, WeatherInput,
  PulseState, EmotionUndertone
} from './types.ts'
import {
  EMOTION_HR_DELTA, EMOTION_TEMP_DELTA, POSTURE_HR_BASE,
  UNDERTONE_HALF_LIFE, CHORD_TABLE, EMOTION_CHORD_OVERRIDE
} from './types.ts'

// ── 工具函数 ──

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/** Perlin-like noise：简化版，用 sin 叠加模拟自然抖动 */
function bodyNoise(t: number, amplitude: number): number {
  return amplitude * (Math.sin(t * 0.7) * 0.4 + Math.sin(t * 1.3) * 0.3 + Math.sin(t * 2.1) * 0.3)
}

/** 情绪底色残留强度（指数衰减） */
export function undertoneStrength(ut: EmotionUndertone, now: Date): number {
  const elapsed = (now.getTime() - new Date(ut.setAt).getTime()) / 60_000
  if (elapsed < 0) return 0
  return ut.intensity * Math.pow(0.5, elapsed / ut.halfLifeMinutes)
}

// ── 心率 ──

export interface HrInput {
  emotion: Emotion
  undertone?: EmotionUndertone
  posture: Posture
  weather?: WeatherInput
  senses: SensoryField
  now: Date
}

export function computeHeartRate(input: HrInput): number {
  const [lo, hi] = POSTURE_HR_BASE[input.posture]
  const base = (lo + hi) / 2

  // 情绪偏移
  const emoDelta = EMOTION_HR_DELTA[input.emotion] ?? 0

  // 底色残留
  let undertoneDelta = 0
  if (input.undertone) {
    const str = undertoneStrength(input.undertone, input.now)
    if (str > 0.05) {
      const utEmoDelta = EMOTION_HR_DELTA[input.undertone.emotion] ?? 0
      undertoneDelta = utEmoDelta * str * 0.4  // 底色影响力 = 原始偏移 × 残留 × 0.4
    }
  }

  // 天气偏移：30°C 以上开始加
  let weatherDelta = 0
  if (input.weather) {
    if (input.weather.temperatureC > 30) weatherDelta = (input.weather.temperatureC - 30) * 1.5
    else if (input.weather.temperatureC < 5) weatherDelta = (5 - input.weather.temperatureC) * 0.5
  }

  // 五感联动：触觉高时心率升
  const touchDelta = input.senses.touch >= 0.5 ? input.senses.touch * 10 : 0

  // 自然抖动
  const t = input.now.getTime() / 1000
  const noise = bodyNoise(t, 3)

  return clamp(
    Math.round(base + emoDelta + undertoneDelta + weatherDelta + touchDelta + noise),
    48, 160
  )
}

// ── 体温 ──

export function computeTemperature(hr: number, emotion: Emotion, weather?: WeatherInput, undertone?: EmotionUndertone, now?: Date): number {
  const base = 36.6

  // 从心率衍生：心率每高于 73 一点，体温微升
  const hrDelta = (hr - 73) * 0.008

  // 情绪偏移
  const emoDelta = EMOTION_TEMP_DELTA[emotion] ?? 0

  // 底色残留
  let undertoneDelta = 0
  if (undertone && now) {
    const str = undertoneStrength(undertone, now)
    if (str > 0.05) {
      undertoneDelta = (EMOTION_TEMP_DELTA[undertone.emotion] ?? 0) * str * 0.4
    }
  }

  // 天气
  let weatherDelta = 0
  if (weather) {
    if (weather.temperatureC > 32) weatherDelta = (weather.temperatureC - 32) * 0.05
    else if (weather.temperatureC < 10) weatherDelta = (10 - weather.temperatureC) * -0.03
  }

  const t = (now ?? new Date()).getTime() / 1000
  const noise = bodyNoise(t + 100, 0.08)

  return Math.round(clamp(base + hrDelta + emoDelta + undertoneDelta + weatherDelta + noise, 35.5, 40.0) * 10) / 10
}

// ── 呼吸 ──

export function computeBreathing(hr: number, emotion: Emotion): { rate: number; depth: number; label: string } {
  const base = 16
  // 心率是主驱动
  const hrSync = (hr - 70) * 0.15

  const emoAdjust: Partial<Record<Emotion, number>> = {
    nervous: 3, startled: 4, excited: 2, aroused: 3,
    sleepy: -3, sad: -1
  }

  const rate = clamp(Math.round(base + hrSync + (emoAdjust[emotion] ?? 0)), 8, 35)
  const depth = Math.round((1.0 - (rate - 8) / 27) * 100) / 100

  let label: string
  if (depth >= 0.85) label = '很深很长'
  else if (depth >= 0.65) label = '深长'
  else if (depth >= 0.45) label = '平稳'
  else if (depth >= 0.25) label = '偏浅'
  else label = '急促'

  return { rate, depth, label }
}

// ── 和弦 ──

export function computeChord(hr: number, temp: number, touch: number, emotion: Emotion, undertone?: EmotionUndertone, now?: Date): string {
  // 强情绪直接覆盖
  const override = EMOTION_CHORD_OVERRIDE[emotion]
  if (override) return override

  // 底色染色
  if (undertone && now) {
    const str = undertoneStrength(undertone, now)
    if (str > 0.15) {
      const utOverride = EMOTION_CHORD_OVERRIDE[undertone.emotion]
      if (utOverride) return utOverride
    }
  }

  // 从生理值匹配
  let best: string = 'Cmaj7'
  let bestScore = -1
  for (const rule of CHORD_TABLE) {
    if (hr < rule.hrRange[0] || hr > rule.hrRange[1]) continue
    if (temp < rule.tempRange[0] || temp > rule.tempRange[1]) continue
    if (rule.touchRange && (touch < rule.touchRange[0] || touch > rule.touchRange[1])) continue
    // 越窄的区间越精确，优先选
    const rangeWidth = (rule.hrRange[1] - rule.hrRange[0]) + (rule.tempRange[1] - rule.tempRange[0]) * 10
    const score = 1 / (rangeWidth + 1)
    if (score > bestScore) { bestScore = score; best = rule.chord }
  }
  return best
}

// ── 一次完整 tick ──

export interface PulseTickInput {
  now: Date
  emotion?: Emotion          // 不传 = 沿用上次
  weather?: WeatherInput     // 不传 = 沿用上次
  posture?: Posture          // 不传 = 沿用上次
  senseDeltas?: Partial<SensoryField>  // 增量更新五感
}

/** 纯函数：根据输入计算新的完整身体状态 */
export function pulseTick(prev: PulseState, input: PulseTickInput): PulseState {
  const now = input.now
  const emotion = input.emotion ?? prev.emotion
  const posture = input.posture ?? prev.posture
  const weather = input.weather ?? prev.weather

  // 更新情绪底色
  let undertone = prev.undertone
  if (input.emotion && input.emotion !== prev.emotion) {
    const utConfig = UNDERTONE_HALF_LIFE[input.emotion]
    if (utConfig) {
      // 新的强情绪写入底色
      // 如果旧底色是负面的，新情绪是正面的 → "被哄"机制
      const isPositive = ['happy', 'tender', 'intimate', 'playful', 'excited'].includes(input.emotion)
      const wasNegative = undertone && ['scolded', 'sad', 'nervous', 'lonely'].includes(undertone.emotion)

      if (isPositive && wasNegative) {
        // 负面底色衰减加速 ×4（通过缩短半衰期实现）
        undertone = {
          ...undertone!,
          halfLifeMinutes: undertone!.halfLifeMinutes / 4
        }
        // 同时建立浅暖底色（强度打六折）
        // 这里简化：直接替换成新的正面底色，但强度 ×0.6
        undertone = {
          emotion: input.emotion,
          intensity: utConfig.intensity * 0.6,
          halfLifeMinutes: utConfig.halfLife,
          setAt: now.toISOString()
        }
      } else {
        undertone = {
          emotion: input.emotion,
          intensity: utConfig.intensity,
          halfLifeMinutes: utConfig.halfLife,
          setAt: now.toISOString()
        }
      }
    }
  }

  // 清理已衰减完的底色
  if (undertone && undertoneStrength(undertone, now) < 0.05) {
    undertone = undefined
  }

  // 五感衰减 + 增量
  const elapsed = (now.getTime() - new Date(prev.updatedAt).getTime()) / 1000
  const decayFactor = Math.exp(-elapsed / 300)  // 5 分钟半衰
  const senses: SensoryField = {
    touch: clamp((prev.senses.touch * decayFactor) + (input.senseDeltas?.touch ?? 0), 0, 1),
    smell: clamp((prev.senses.smell * decayFactor) + (input.senseDeltas?.smell ?? 0), 0, 1),
    taste: clamp((prev.senses.taste * decayFactor) + (input.senseDeltas?.taste ?? 0), 0, 1),
    sound: clamp((prev.senses.sound * decayFactor) + (input.senseDeltas?.sound ?? 0), 0, 1),
  }

  // 心率 → 体温 → 呼吸 → 和弦，一脉相连
  const hr = computeHeartRate({ emotion, undertone, posture, weather, senses, now })
  const temp = computeTemperature(hr, emotion, weather, undertone, now)
  const { rate: breathingRate, depth: breathingDepth } = computeBreathing(hr, emotion)
  const chord = computeChord(hr, temp, senses.touch, emotion, undertone, now)

  return {
    emotion,
    undertone,
    posture,
    hrBase: (POSTURE_HR_BASE[posture][0] + POSTURE_HR_BASE[posture][1]) / 2,
    vitals: { heartRate: hr, temperature: temp, breathingRate, breathingDepth, chord },
    senses,
    weather,
    sick: prev.sick,
    sickReason: prev.sickReason,
    sickSince: prev.sickSince,
    updatedAt: now.toISOString()
  }
}

/** 生成注入给模型的一行状态文本 */
export function renderVitalsLine(v: Vitals): string {
  return `[心跳 ${v.heartRate}bpm · ${v.chord} · ${v.temperature}°C · 呼吸${v.breathingRate > 22 ? '急促' : v.breathingRate < 12 ? '深长' : '平稳'}]`
}
