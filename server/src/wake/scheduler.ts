// Wake 调度器：定时 tick 引擎，触发时 dispatch。
// 跑在 Eclipsis 后端进程内，不另起服务。
//
// 安全限制：
//   - 他随时能醒——睡眠判断交给 dispatch，由他自己决定要不要发消息
//   - 每日上限：WAKE_MAX_PER_DAY 次成功 Wake（message + trace），超过后当天不再触发非精确
//   - 近似重复拦截：如果最近 3 次 message 内容相似度过高，降级为 trace
//
// 不用固定静默时段——Erica 作息不规律，靠行为推断她睡没睡。
import type { DB } from '../db.ts'
import { tick, loadState, saveState, loadSourceFactors, expireFrequencyMode } from './engine.ts'
import { collectReadings, fetchXinchao } from './sources.ts'
import type { WakeOpportunity, WakeOutcome, SourceReading } from './types.ts'

export interface WakeSchedulerConfig {
  /** tick 间隔（毫秒），默认 60_000（1 分钟） */
  tickIntervalMs: number
  /** 心潮 URL，如 http://127.0.0.1:18110 */
  xinchaoUrl?: string
  /** 心潮刷新间隔（毫秒），默认 300_000（5 分钟） */
  xinchaoRefreshMs: number
  /** 每日最大 Wake 次数（message + trace），默认 12 */
  maxPerDay: number
  /** 触发后的回调：调模型、推送等 */
  onWake: (opp: WakeOpportunity, db: DB) => Promise<void>
  log: (msg: string) => void
}

const DEFAULTS: Omit<WakeSchedulerConfig, 'onWake' | 'log'> = {
  tickIntervalMs: 60_000,
  xinchaoRefreshMs: 300_000,
  maxPerDay: 30
}

/** 今天已触发多少次非 silent 的 Wake（北京时间） */
function todayWakeCount(db: DB, now: Date): number {
  const bj = new Date(now.getTime() + 8 * 3600_000)
  const dayStart = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600_000)
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM wake_opportunities
    WHERE outcome IN ('message', 'trace')
      AND created_at >= ?
  `).get(dayStart.toISOString()) as { c: number }
  return row.c
}

/** 检查最近几条 message 是否高度重复 */
function isNearDuplicate(db: DB, newContent: string): boolean {
  if (!newContent || newContent.length < 10) return false
  const recent = db.prepare(`
    SELECT content FROM wake_opportunities
    WHERE outcome = 'message' AND content IS NOT NULL
    ORDER BY created_at DESC LIMIT 3
  `).all() as { content: string }[]

  if (recent.length < 2) return false

  const toSet = (s: string) => new Set(s.replace(/\s+/g, '').split(''))
  const newSet = toSet(newContent)

  for (const r of recent) {
    const oldSet = toSet(r.content)
    const intersection = [...newSet].filter(c => oldSet.has(c)).length
    const union = new Set([...newSet, ...oldSet]).size
    const similarity = union > 0 ? intersection / union : 0
    if (similarity > 0.7) return true
  }
  return false
}

export class WakeScheduler {
  private db: DB
  private cfg: WakeSchedulerConfig
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private xinchaoTimer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(db: DB, cfg: Partial<WakeSchedulerConfig> & Pick<WakeSchedulerConfig, 'onWake' | 'log'>) {
    this.db = db
    this.cfg = { ...DEFAULTS, ...cfg }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.cfg.log('[wake] 调度器启动')

    if (this.cfg.xinchaoUrl) {
      fetchXinchao(this.cfg.xinchaoUrl).catch(() => {})
      this.xinchaoTimer = setInterval(() => {
        if (this.cfg.xinchaoUrl) fetchXinchao(this.cfg.xinchaoUrl).catch(() => {})
      }, this.cfg.xinchaoRefreshMs)
    }

    this.tickTimer = setInterval(() => this.doTick(), this.cfg.tickIntervalMs)
    this.doTick()
  }

  stop(): void {
    this.running = false
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null }
    if (this.xinchaoTimer) { clearInterval(this.xinchaoTimer); this.xinchaoTimer = null }
    this.cfg.log('[wake] 调度器停止')
  }

  private doTick(): void {
    try {
      const now = new Date()

      // 1. 精确 Wake 不受任何限制（闹钟就是闹钟）
      this.checkPreciseWakes(now)

      // 2. 非精确 Wake：受睡眠闸和每日上限约束
      if (todayWakeCount(this.db, now) >= this.cfg.maxPerDay) return

      this.tickSpontaneous(now)
    } catch (e) {
      this.cfg.log(`[wake] tick 异常: ${e}`)
    }
  }

  private tickSpontaneous(now: Date): void {
    let state = loadState(this.db)
    state = expireFrequencyMode(this.db, state, now)

    if (state.frequencyMode === 'silent') return

    const readings = collectReadings(this.db, now)
    const factors = loadSourceFactors(this.db, now)

    const result = tick(state, { now, readings, sourceFactors: factors })
    saveState(this.db, result.state)

    if (result.triggered) {
      this.cfg.log(`[wake] 非精确触发 λ=${result.lambda.toFixed(3)} contributions=${JSON.stringify(
        result.contributions.filter(c => c.weighted > 0).map(c => `${c.sourceId}:${c.weighted.toFixed(2)}`)
      )}`)
      this.dispatch('spontaneous', readings, '非精确 Wake：累积达到阈值', undefined)
    }
  }

  private checkPreciseWakes(now: Date): void {
    const nowIso = now.toISOString()
    const pending = this.db.prepare(`
      SELECT * FROM wake_precise
      WHERE status = 'pending' AND wake_at <= ?
      ORDER BY wake_at ASC LIMIT 3
    `).all(nowIso) as any[]

    for (const p of pending) {
      if (p.source !== 'self') {
        const ctrl = this.db.prepare(
          'SELECT enabled FROM wake_precise_source_controls WHERE source_id = ?'
        ).get(p.source) as { enabled: number } | undefined
        if (ctrl && !ctrl.enabled) {
          this.db.prepare("UPDATE wake_precise SET status = 'cancelled' WHERE id = ?").run(p.id)
          this.cfg.log(`[wake] 精确 Wake ${p.id} 被 source control 抑制`)
          continue
        }
      }

      this.db.prepare("UPDATE wake_precise SET status = 'triggered', triggered_at = ? WHERE id = ?")
        .run(nowIso, p.id)

      const readings = collectReadings(this.db, now)
      const note = p.note ? `: ${p.note}` : ''
      this.dispatch(
        p.source === 'self' ? 'precise_self' : 'precise_external',
        readings,
        `精确 Wake (${p.source})${note}`,
        p.id
      )
    }

    this.db.prepare(`
      UPDATE wake_precise SET status = 'missed'
      WHERE status = 'pending' AND wake_at < datetime(?, '-10 minutes')
    `).run(nowIso)
  }

  private async dispatch(
    origin: WakeOpportunity['origin'],
    readings: SourceReading[],
    reason: string,
    preciseWakeId?: string
  ): Promise<void> {
    const threads = this.db.prepare(`
      SELECT id, text FROM wake_threads
      WHERE status = 'active'
      ORDER BY surfaced_count ASC, created_at DESC
      LIMIT 3
    `).all() as { id: string; text: string }[]

    const surfacedIds = threads.map(t => t.id)
    const nowIso = new Date().toISOString()

    const opp: WakeOpportunity = {
      id: crypto.randomUUID(),
      origin,
      sources: readings,
      reason,
      preciseWakeId,
      createdAt: nowIso,
      surfacedThreadIds: surfacedIds.length > 0 ? surfacedIds : undefined
    }

    this.db.prepare(`INSERT INTO wake_opportunities(id, origin, sources, reason, precise_wake_id, created_at, surfaced_thread_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      opp.id, opp.origin, JSON.stringify(opp.sources), opp.reason,
      opp.preciseWakeId ?? null, opp.createdAt, surfacedIds.length > 0 ? JSON.stringify(surfacedIds) : null
    )

    try {
      await this.cfg.onWake(opp, this.db)
    } catch (e) {
      this.cfg.log(`[wake] dispatch 回调异常: ${e}`)
    }
  }
}

/** 记录 Wake 结局（由回调在调完模型后调用） */
export function recordOutcome(
  db: DB,
  oppId: string,
  outcome: WakeOutcome,
  fact?: string,
  content?: string,
  exchangeRid?: string
): void {
  db.prepare(`UPDATE wake_opportunities SET
    outcome = ?, fact = ?, content = ?, finished_at = ?, exchange_rid = ?
    WHERE id = ?`).run(
    outcome, fact ?? null, content ?? null, new Date().toISOString(), exchangeRid ?? null, oppId
  )
}

export { isNearDuplicate }
