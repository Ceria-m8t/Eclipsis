// Wake 调度器：定时 tick 引擎，触发时 dispatch。
// 跑在 Eclipsis 后端进程内，不另起服务。
//
// 安全限制（参考 Wake-Trace）：
//   - 静默时段：WAKE_QUIET_START ~ WAKE_QUIET_END 只触发精确 Wake，不触发非精确
//   - 每日上限：WAKE_MAX_PER_DAY 次成功 Wake（message + trace），超过后当天不再触发非精确
//   - 近似重复拦截：如果最近 3 次 message 内容相似度过高，降级为 trace
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
  /** 静默时段开始小时（0-23，北京时间），默认 1（凌晨 1 点） */
  quietStart: number
  /** 静默时段结束小时（0-23，北京时间），默认 7（早上 7 点） */
  quietEnd: number
  /** 每日最大 Wake 次数（message + trace），默认 12 */
  maxPerDay: number
  /** 触发后的回调：调模型、推送等 */
  onWake: (opp: WakeOpportunity, db: DB) => Promise<void>
  log: (msg: string) => void
}

const DEFAULTS: Omit<WakeSchedulerConfig, 'onWake' | 'log'> = {
  tickIntervalMs: 60_000,
  xinchaoRefreshMs: 300_000,
  quietStart: 1,
  quietEnd: 7,
  maxPerDay: 12
}

/** 判断当前是否在静默时段（北京时间 UTC+8） */
function isQuietHour(now: Date, start: number, end: number): boolean {
  const hour = (now.getUTCHours() + 8) % 24
  if (start < end) {
    return hour >= start && hour < end
  }
  // 跨午夜：比如 23 → 7
  return hour >= start || hour < end
}

/** 今天已触发多少次非 silent 的 Wake（北京时间） */
function todayWakeCount(db: DB, now: Date): number {
  // 北京时间今天 0 点的 UTC 时间
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

  // 简单的 jaccard 相似度：按字分词，交集/并集
  const toSet = (s: string) => new Set(s.replace(/\s+/g, '').split(''))
  const newSet = toSet(newContent)

  for (const r of recent) {
    const oldSet = toSet(r.content)
    const intersection = [...newSet].filter(c => oldSet.has(c)).length
    const union = new Set([...newSet, ...oldSet]).size
    const similarity = union > 0 ? intersection / union : 0
    if (similarity > 0.7) return true  // 70% 以上字重叠 → 太像了
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

    // 初始心潮拉取
    if (this.cfg.xinchaoUrl) {
      fetchXinchao(this.cfg.xinchaoUrl).catch(() => {})
      this.xinchaoTimer = setInterval(() => {
        if (this.cfg.xinchaoUrl) fetchXinchao(this.cfg.xinchaoUrl).catch(() => {})
      }, this.cfg.xinchaoRefreshMs)
    }

    // 主循环
    this.tickTimer = setInterval(() => this.doTick(), this.cfg.tickIntervalMs)
    // 启动后立刻跑一次
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

      // 1. 精确 Wake 不受静默时段限制（闹钟就是闹钟）
      this.checkPreciseWakes(now)

      // 2. 非精确 Wake：受静默时段和每日上限约束
      if (isQuietHour(now, this.cfg.quietStart, this.cfg.quietEnd)) return
      if (todayWakeCount(this.db, now) >= this.cfg.maxPerDay) return
      this.tickSpontaneous(now)
    } catch (e) {
      this.cfg.log(`[wake] tick 异常: ${e}`)
    }
  }

  private tickSpontaneous(now: Date): void {
    let state = loadState(this.db)
    state = expireFrequencyMode(this.db, state, now)

    // silent 模式：不 tick 非精确
    if (state.frequencyMode === 'silent') return

    const readings = collectReadings(this.db, now)
    const factors = loadSourceFactors(this.db, now)

    const result = tick(state, { now, readings, sourceFactors: factors })

    // 持久化状态
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
      // 检查外部精确来源是否被关闭
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

    // 标记过期未触发的（宕机期间错过的）为 missed
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
    // 浮现生活线头
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

    // 先写一条 pending 记录
    this.db.prepare(`INSERT INTO wake_opportunities(id, origin, sources, reason, precise_wake_id, created_at, surfaced_thread_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      opp.id, opp.origin, JSON.stringify(opp.sources), opp.reason,
      opp.preciseWakeId ?? null, opp.createdAt, surfacedIds.length > 0 ? JSON.stringify(surfacedIds) : null
    )

    // 交给回调（调模型、推送等）
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

// 导出供 dispatch 使用
export { isNearDuplicate }
