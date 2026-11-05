// Wake 工具接口：给他（通过 MCP / 工具调用）控制自己的 Wake。
// 这些函数被 api.ts 挂成 HTTP 接口，心潮或前端的工具定义指向这里。
import type { DB } from '../db.ts'
import type { FrequencyMode, FrequencyParams, SourceId } from './types.ts'
import { loadState, saveState } from './engine.ts'

// ── 1. 调节律 ──

export interface SetFrequencyInput {
  mode: FrequencyMode
  /** 持续时长（分钟），不填 = 直到手动改 */
  durationMinutes?: number
  /** custom 模式的参数 */
  customParams?: Partial<FrequencyParams>
  reason?: string
}

export function setFrequency(db: DB, input: SetFrequencyInput): { ok: true; mode: FrequencyMode; expiresAt?: string } {
  const now = new Date()
  const state = loadState(db)

  state.frequencyMode = input.mode

  if (input.mode === 'custom' && input.customParams) {
    // 合并到现有 custom（或从 normal 默认值开始）
    const base = state.customParams || { lambdaBase: 1.0, cooldownMinutes: 20, lambdaMin: 0.1, lambdaMax: 6.0 }
    state.customParams = { ...base, ...input.customParams }
  }

  if (input.durationMinutes && input.durationMinutes > 0) {
    state.frequencyExpiresAt = new Date(now.getTime() + input.durationMinutes * 60_000).toISOString()
  } else {
    state.frequencyExpiresAt = undefined
  }

  saveState(db, state)

  return { ok: true, mode: state.frequencyMode, expiresAt: state.frequencyExpiresAt }
}

// ── 2. 调来源权重 ──

export interface SetSourceFactorInput {
  sourceId: SourceId
  /** 0 = 关闭，1 = 默认，2 = 最大增强 */
  factor: number
  durationMinutes?: number
  reason?: string
}

export function setSourceFactor(db: DB, input: SetSourceFactorInput): { ok: true; sourceId: SourceId; factor: number; expiresAt?: string } {
  const now = new Date()
  const factor = Math.max(0, Math.min(2, input.factor))
  const expiresAt = input.durationMinutes && input.durationMinutes > 0
    ? new Date(now.getTime() + input.durationMinutes * 60_000).toISOString()
    : null

  // upsert
  db.prepare(`INSERT INTO wake_source_controls(source_id, factor, reason, expires_at, set_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET factor = ?, reason = ?, expires_at = ?, set_at = ?`).run(
    input.sourceId, factor, input.reason ?? null, expiresAt, now.toISOString(),
    factor, input.reason ?? null, expiresAt, now.toISOString()
  )

  return { ok: true, sourceId: input.sourceId, factor, expiresAt: expiresAt ?? undefined }
}

// ── 3. 自设精确闹钟（Self Precise Wake）──

export interface SetAlarmInput {
  /** 分钟后（after）或绝对时间（at，UTC ISO） */
  afterMinutes?: number
  at?: string
  note?: string
}

export function setAlarm(db: DB, input: SetAlarmInput): { ok: true; id: string; wakeAt: string; note?: string } {
  const now = new Date()
  let wakeAt: string

  if (input.at) {
    const d = new Date(input.at)
    if (Number.isNaN(d.getTime())) throw new Error('at 看不懂')
    wakeAt = d.toISOString()
  } else if (input.afterMinutes && input.afterMinutes > 0) {
    wakeAt = new Date(now.getTime() + input.afterMinutes * 60_000).toISOString()
  } else {
    throw new Error('需要 afterMinutes 或 at')
  }

  const id = crypto.randomUUID()
  db.prepare(`INSERT INTO wake_precise(id, source, wake_at, note, status, created_at)
    VALUES (?, 'self', ?, ?, 'pending', ?)`).run(id, wakeAt, input.note ?? null, now.toISOString())

  return { ok: true, id, wakeAt, note: input.note }
}

/** 取消一个 pending 的闹钟 */
export function cancelAlarm(db: DB, id: string): { ok: true } | { ok: false; reason: string } {
  const row = db.prepare("SELECT status FROM wake_precise WHERE id = ? AND source = 'self'").get(id) as { status: string } | undefined
  if (!row) return { ok: false, reason: '找不到这个闹钟' }
  if (row.status !== 'pending') return { ok: false, reason: `状态是 ${row.status}，不能取消` }

  db.prepare("UPDATE wake_precise SET status = 'cancelled' WHERE id = ?").run(id)
  return { ok: true }
}

// ── 4. 生活线头 ──

export interface AddThreadInput {
  text: string
  /** 过期时间（小时），不填 = 不过期（由系统根据年龄淘汰） */
  expiresInHours?: number
}

export function addThread(db: DB, input: AddThreadInput): { ok: true; id: string; text: string; expiresAt?: string } {
  const now = new Date()
  const id = crypto.randomUUID()
  const expiresAt = input.expiresInHours && input.expiresInHours > 0
    ? new Date(now.getTime() + input.expiresInHours * 3600_000).toISOString()
    : null

  // 限制最多 5 根活跃线头——最旧的自动完成
  const active = db.prepare("SELECT id FROM wake_threads WHERE status = 'active' ORDER BY created_at ASC").all() as { id: string }[]
  if (active.length >= 5) {
    db.prepare("UPDATE wake_threads SET status = 'completed' WHERE id = ?").run(active[0].id)
  }

  db.prepare(`INSERT INTO wake_threads(id, text, created_at, expires_at, status, surfaced_count)
    VALUES (?, ?, ?, ?, 'active', 0)`).run(id, input.text, now.toISOString(), expiresAt)

  return { ok: true, id, text: input.text, expiresAt: expiresAt ?? undefined }
}

export function completeThread(db: DB, id: string): { ok: true } | { ok: false; reason: string } {
  const row = db.prepare("SELECT status FROM wake_threads WHERE id = ?").get(id) as { status: string } | undefined
  if (!row) return { ok: false, reason: '找不到这根线头' }
  if (row.status !== 'active') return { ok: false, reason: `状态是 ${row.status}` }

  db.prepare("UPDATE wake_threads SET status = 'completed' WHERE id = ?").run(id)
  return { ok: true }
}

// ── 5. 查询当前控制状态（读工具）──

export function inspectWakeControl(db: DB): {
  frequency: { mode: FrequencyMode; expiresAt?: string }
  sourceFactors: { sourceId: string; factor: number; expiresAt?: string }[]
  pendingAlarms: { id: string; wakeAt: string; note?: string }[]
  activeThreads: { id: string; text: string; surfacedCount: number }[]
} {
  const state = loadState(db)

  const sourceFactors = (db.prepare('SELECT source_id, factor, expires_at FROM wake_source_controls').all() as any[])
    .map(r => ({ sourceId: r.source_id, factor: r.factor, expiresAt: r.expires_at ?? undefined }))

  const pendingAlarms = (db.prepare("SELECT id, wake_at, note FROM wake_precise WHERE status = 'pending' ORDER BY wake_at").all() as any[])
    .map(r => ({ id: r.id, wakeAt: r.wake_at, note: r.note ?? undefined }))

  const activeThreads = (db.prepare("SELECT id, text, surfaced_count FROM wake_threads WHERE status = 'active' ORDER BY created_at DESC").all() as any[])
    .map(r => ({ id: r.id, text: r.text, surfacedCount: r.surfaced_count }))

  return {
    frequency: { mode: state.frequencyMode, expiresAt: state.frequencyExpiresAt },
    sourceFactors,
    pendingAlarms,
    activeThreads
  }
}

// ── 6. 查最近 Wake 历史（读工具）──

export function wakeHistory(db: DB, limit = 10): {
  id: string; origin: string; reason: string; outcome?: string; fact?: string; createdAt: string
}[] {
  return (db.prepare(`SELECT id, origin, reason, outcome, fact, created_at
    FROM wake_opportunities ORDER BY created_at DESC LIMIT ?`).all(limit) as any[])
    .map(r => ({
      id: r.id, origin: r.origin, reason: r.reason,
      outcome: r.outcome ?? undefined, fact: r.fact ?? undefined,
      createdAt: r.created_at
    }))
}
