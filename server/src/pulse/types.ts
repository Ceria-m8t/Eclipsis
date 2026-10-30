// 脉（Pulse）类型定义
// 参考：Pulse Tutorial（蛋壳）的物理因果链 + Eventide 的周期概念
// 原则（07 文档 Erica 定）：后端只管数值/工具/接口，不写性格规则

// ── 情绪 ──

/** 情绪标签（从聊天文本检测） */
export type Emotion =
  | 'neutral' | 'happy' | 'excited' | 'intimate' | 'aroused'
  | 'focused' | 'nervous' | 'sad' | 'scolded' | 'startled'
  | 'lonely' | 'tender' | 'playful' | 'sleepy'

/** 情绪对心率的偏移 */
export const EMOTION_HR_DELTA: Record<Emotion, number> = {
  neutral: 0, happy: 4, excited: 12, intimate: 15, aroused: 25,
  focused: 2, nervous: 15, sad: -4, scolded: 18, startled: 25,
  lonely: -2, tender: 6, playful: 8, sleepy: -8
}

/** 情绪对体温的偏移 */
export const EMOTION_TEMP_DELTA: Record<Emotion, number> = {
  neutral: 0, happy: 0.1, excited: 0.2, intimate: 0.4, aroused: 0.8,
  focused: 0, nervous: 0.2, sad: -0.1, scolded: 0.3, startled: 0.1,
  lonely: -0.1, tender: 0.2, playful: 0.1, sleepy: -0.2
}

/** 情绪底色：强烈情绪残留，指数衰减 */
export interface EmotionUndertone {
  emotion: Emotion
  intensity: number       // 0-1，写入时的初始强度
  halfLifeMinutes: number // 半衰期
  setAt: string           // UTC ISO
}

/** 情绪底色半衰期（分钟），对齐生理现实 */
export const UNDERTONE_HALF_LIFE: Partial<Record<Emotion, { intensity: number; halfLife: number }>> = {
  scolded:  { intensity: 1.0, halfLife: 90 },   // 皮质醇 60-90min
  sad:      { intensity: 0.8, halfLife: 60 },
  nervous:  { intensity: 0.6, halfLife: 20 },   // 肾上腺素代谢快
  startled: { intensity: 0.7, halfLife: 15 },
  intimate: { intensity: 0.9, halfLife: 45 },   // 催产素
  aroused:  { intensity: 0.9, halfLife: 30 },
  excited:  { intensity: 0.7, halfLife: 20 },
  tender:   { intensity: 0.7, halfLife: 35 },   // 温柔
  playful:  { intensity: 0.5, halfLife: 20 },   // 玩闹
  happy:    { intensity: 0.5, halfLife: 25 },   // 开心
  lonely:   { intensity: 0.6, halfLife: 40 },
}

// ── 生理值 ──

export interface Vitals {
  heartRate: number       // bpm, 48-160
  temperature: number     // °C, 35.5-40.0
  breathingRate: number   // 次/分, 8-35
  breathingDepth: number  // 0-1, 越快越浅
  chord: string           // 和弦名，如 Gmaj7
}

/** 姿态（影响基线心率和体温） */
export type Posture = 'deep_sleep' | 'light_sleep' | 'lying' | 'sitting' | 'standing'

/** 姿态对心率基线的偏移 */
export const POSTURE_HR_BASE: Record<Posture, [number, number]> = {
  deep_sleep:  [52, 60],
  light_sleep: [58, 68],
  lying:       [62, 72],
  sitting:     [68, 78],
  standing:    [72, 85]
}

// ── 五感 ──

export type SenseChannel = 'touch' | 'smell' | 'taste' | 'sound'

export interface SensoryField {
  touch: number    // 0-1
  smell: number    // 0-1
  taste: number    // 0-1
  sound: number    // 0-1
}

// ── 和弦映射 ──

export interface ChordRule {
  chord: string
  /** 匹配条件：心率/体温/触觉区间 */
  hrRange: [number, number]
  tempRange: [number, number]
  touchRange?: [number, number]
}

/** 基础和弦表（从 Pulse Tutorial 简化） */
export const CHORD_TABLE: ChordRule[] = [
  // 安静独处
  { chord: 'C6',     hrRange: [48, 62],  tempRange: [35.5, 36.4] },
  // 平静清醒
  { chord: 'Cmaj7',  hrRange: [62, 72],  tempRange: [36.2, 36.8] },
  // 聊天愉快
  { chord: 'Gmaj7',  hrRange: [72, 85],  tempRange: [36.5, 37.2] },
  // 轻松活跃
  { chord: 'Dmaj7',  hrRange: [80, 95],  tempRange: [36.8, 37.4] },
  // 暧昧张力
  { chord: 'Dm7',    hrRange: [75, 95],  tempRange: [37.0, 37.8], touchRange: [0.3, 0.7] },
  // 紧张不安
  { chord: 'Am7',    hrRange: [85, 110], tempRange: [36.8, 37.5] },
  // 安静忧伤
  { chord: 'Em7',    hrRange: [55, 70],  tempRange: [36.0, 36.6] },
  // 温柔亲近
  { chord: 'Fmaj7',  hrRange: [70, 90],  tempRange: [37.0, 37.8], touchRange: [0.4, 1.0] },
  // 高兴奋
  { chord: 'Ebmaj7', hrRange: [95, 130], tempRange: [37.4, 38.5] },
  // 深睡
  { chord: 'Bb6',    hrRange: [48, 58],  tempRange: [35.8, 36.3] },
]

/** 情绪强覆盖和弦 */
export const EMOTION_CHORD_OVERRIDE: Partial<Record<Emotion, string>> = {
  scolded: 'Dm',
  sad: 'Am7',
  excited: 'Dmaj7',
  tender: 'Fmaj7',
  intimate: 'Fmaj7',
  nervous: 'Am7',
  startled: 'Bdim',
  lonely: 'Em7',
}

// ── 天气 ──

export interface WeatherInput {
  temperatureC: number   // 室外温度
  humidity?: number      // 0-100
  condition?: string     // rain, snow, sunny, cloudy...
}

// ── 完整身体状态（持久化） ──

export interface PulseState {
  /** 当前情绪 */
  emotion: Emotion
  /** 情绪底色（可能为空） */
  undertone?: EmotionUndertone
  /** 当前姿态 */
  posture: Posture
  /** 心率基线中点（从姿态算） */
  hrBase: number
  /** 上次计算的生理值 */
  vitals: Vitals
  /** 五感 */
  senses: SensoryField
  /** 最后一次天气输入 */
  weather?: WeatherInput
  /** 是否生病 */
  sick: boolean
  /** 生病原因 */
  sickReason?: string
  /** 生病开始时间 */
  sickSince?: string
  /** 上次更新时间 */
  updatedAt: string
}

export function createDefaultState(): PulseState {
  return {
    emotion: 'neutral',
    posture: 'sitting',
    hrBase: 73,
    vitals: { heartRate: 73, temperature: 36.6, breathingRate: 16, breathingDepth: 0.7, chord: 'Cmaj7' },
    senses: { touch: 0, smell: 0, taste: 0, sound: 0 },
    sick: false,
    updatedAt: new Date().toISOString()
  }
}
