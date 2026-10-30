// Wake 引擎核心：λ/H/Θ 累积触发模型
// 参考 Kli Wake Veil 1.0 的数学模型，简化为 Eclipsis 需要的形态。
//
// 工作原理：
//   每次 tick（间隔 dt 小时），引擎从各来源收集本源值，加权汇总成瞬时 λ(t)。
//   λ(t) 累积到 H(t)，H(t) ≥ Θ 时触发 WakeOpportunity，H 归零，重新抽 Θ。
//   这不是定时器——λ 高的时候 H 涨得快，低的时候涨得慢，所以醒来的节奏跟状态挂钩。

import type {
  SourceId, SourceReading, FrequencyMode, FrequencyParams,
  SpontaneousState
} from './types.ts'
import type { DB } from '../db.ts'

// ── 默认参数 ──

export const DEFAULT_PARAMS: FrequencyParams = {
  lambdaBase: 1.0,         // 每小时期望 1 次（所有来源中性时）
  cooldownMinutes: 20,     // 刚醒来后 20 分钟内 λ 压到极低
  lambdaMin: 0.1,          // 极安静时每小时最多 0.1 次机会
  lambdaMax: 6.0           // 极活跃时每小时最多 6 次机会
}

const LOW_FREQ_PARAMS: FrequencyParams = {
  lambdaBase: 0.25,
  cooldownMinutes: 90,
  lambdaMin: 0.05,
  lambdaMax: 2.0
}

/** 频率模式 → 实际参数 */
export function resolveParams(mode: FrequencyMode, custom?: FrequencyParams): FrequencyParams {
  switch (mode) {
    case 'normal': return DEFAULT_PARAMS
    case 'low_frequency': return LOW_FREQ_PARAMS
    case 'silent': return { ...DEFAULT_PARAMS, lambdaBase: 0, lambdaMax: 0 }
    case 'custom': return custom ?? DEFAULT_PARAMS
  }
}

// ── 核心计算 ──

export interface TickInput {
  now: Date
  readings: SourceReading[]
  sourceFactors: Map<SourceId, number>  // 他设的因子覆盖
}

export interface TickResult {
  /** 更新后的状态 */
  state: SpontaneousState
  /** 本次计算的瞬时 λ */
  lambda: number
  /** 是否触发了 WakeOpportunity */
  triggered: boolean
  /** 各来源的加权贡献（调试用） */
  contributions: { sourceId: SourceId; raw: number; factor: number; weighted: number; stale: boolean }[]
}

/**
 * 单步 tick：推进 H(t)，检查是否 ≥ Θ。
 * 纯函数，不写数据库——调用方负责持久化。
 */
export function tick(prev: SpontaneousState, input: TickInput): TickResult {
  const params = resolveParams(prev.frequencyMode, prev.customParams)
  const prevTime = new Date(prev.lastTickAt).getTime()
  const nowMs = input.now.getTime()
  // 防止时间倒退或间隔过长（超过 6 小时按 6 小时算，防止宕机后 H 暴涨）
  const dtMs = Math.max(0, Math.min(nowMs - prevTime, 6 * 3600_000))
  const dtHours = dtMs / 3600_000

  if (dtHours <= 0 || params.lambdaMax <= 0) {
    return {
      state: { ...prev, lastTickAt: input.now.toISOString() },
      lambda: 0, triggered: false, contributions: []
    }
  }

  // 计算各来源的加权贡献
  const contributions = input.readings.map(r => {
    const override = input.sourceFactors.get(r.sourceId)
    const factor = r.stale ? 0 : (override ?? 1)  // stale 来源自动降权到 0
    return {
      sourceId: r.sourceId,
      raw: r.value,
      factor,
      weighted: r.value * factor,
      stale: r.stale
    }
  })

  // 有效来源的加权和（归一化到活跃来源数量）
  const active = contributions.filter(c => c.factor > 0 && !c.stale)
  const weightedSum = active.length > 0
    ? contributions.reduce((sum, c) => sum + c.weighted, 0) / active.length
    : 0

  // 冷却衰减：刚醒来后压低 λ
  let cooldownMultiplier = 1
  if (prev.lastWakeAt) {
    const sinceLast = (nowMs - new Date(prev.lastWakeAt).getTime()) / 60_000
    if (sinceLast < params.cooldownMinutes) {
      cooldownMultiplier = sinceLast / params.cooldownMinutes  // 0 → 1 线性恢复
    }
  }

  // 瞬时 λ(t)
  const rawLambda = params.lambdaBase * weightedSum * cooldownMultiplier
  const lambda = Math.max(params.lambdaMin, Math.min(rawLambda, params.lambdaMax))

  // 累积 H(t)
  const H = prev.H + lambda * dtHours
  const triggered = H >= prev.theta

  const state: SpontaneousState = {
    ...prev,
    H: triggered ? 0 : H,
    theta: triggered ? drawTheta() : prev.theta,
    lastTickAt: input.now.toISOString(),
    lastWakeAt: triggered ? input.now.toISOString() : prev.lastWakeAt
  }

  return { state, lambda, triggered, contributions }
}

/**
 * 抽一个新的阈值 Θ。
 * 用指数分布使醒来间隔自然随机化（不是精确的每 1/λ 小时一次）。
 * Θ 范围 [0.3, 3.0]，中位数约 0.7。
 */
export function drawTheta(): number {
  // -ln(U) 是标准指数分布
  const raw = -Math.log(Math.random())
  // clamp 到合理范围
  return Math.max(0.3, Math.min(raw, 3.0))
}

// ── 状态持久化 ──

export function loadState(db: DB): SpontaneousState {
  const row = db.prepare('SELECT * FROM wake_state WHERE id = 1').get() as any
  return {
    H: row.h,
    theta: row.theta,
    lastTickAt: row.last_tick_at,
    lastWakeAt: row.last_wake_at ?? undefined,
    frequencyMode: row.frequency_mode as FrequencyMode,
    customParams: row.custom_params ? JSON.parse(row.custom_params) : undefined,
    frequencyExpiresAt: row.frequency_expires_at ?? undefined
  }
}

export function saveState(db: DB, s: SpontaneousState): void {
  db.prepare(`UPDATE wake_state SET
    h = ?, theta = ?, last_tick_at = ?, last_wake_at = ?,
    frequency_mode = ?, custom_params = ?, frequency_expires_at = ?
    WHERE id = 1`).run(
    s.H, s.theta, s.lastTickAt, s.lastWakeAt ?? null,
    s.frequencyMode, s.customParams ? JSON.stringify(s.customParams) : null,
    s.frequencyExpiresAt ?? null
  )
}

/** 加载他设的来源因子覆盖（过期的自动清理并恢复默认） */
export function loadSourceFactors(db: DB, now: Date): Map<SourceId, number> {
  const nowIso = now.toISOString()
  // 清理过期的
  db.prepare('DELETE FROM wake_source_controls WHERE expires_at IS NOT NULL AND expires_at <= ?').run(nowIso)
  const rows = db.prepare('SELECT source_id, factor FROM wake_source_controls').all() as { source_id: string; factor: number }[]
  return new Map(rows.map(r => [r.source_id as SourceId, r.factor]))
}

/** 检查并恢复过期的频率模式 */
export function expireFrequencyMode(db: DB, state: SpontaneousState, now: Date): SpontaneousState {
  if (state.frequencyExpiresAt && new Date(state.frequencyExpiresAt) <= now) {
    const updated = { ...state, frequencyMode: 'normal' as FrequencyMode, frequencyExpiresAt: undefined }
    saveState(db, updated)
    return updated
  }
  return state
}
