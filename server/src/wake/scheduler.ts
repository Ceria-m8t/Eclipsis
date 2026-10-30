// Wake 调度器：定时 tick 引擎，触发时 dispatch。
// 跑在 Eclipsis 后端进程内，不另起服务。
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
  /** 触发后的回调：调模型、推送等 */
  onWake: (opp: WakeOpportunity, db: DB) => Promise<void>
  log: (msg: string) => void
}

const DEFAULTS: Omit<WakeSchedulerConfig, 'onWake' | 'log'> = {
  tickIntervalMs: 60_000,
  xinchaoRefreshMs: 300_000
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

      // 1. 检查精确 Wake（到点的闹钟）
      this.checkPreciseWakes(now)

      // 2. 非精确 Wake tick
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
          // 被他关了，不触发，标记为 policy_suppressed
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

    // 更新线头浮现计数
    for (const t of threads) {
      this.db.prepare(`UPDATE wake_threads SET surfaced_count = surfaced_count + 1,
        last_surfaced_at = ? WHERE id = ?`).run(nowIso, t.id)
    }

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
