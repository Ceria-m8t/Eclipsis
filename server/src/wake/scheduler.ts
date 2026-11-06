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
import { createHash } from 'node:crypto'
import { tick, loadState, saveState, loadSourceFactors, expireFrequencyMode, drawTheta } from './engine.ts'
import { collectReadings, fetchXinchao } from './sources.ts'
import type { WakeOpportunity, WakeOutcome, SourceReading } from './types.ts'

export interface WakeSchedulerConfig {
  /** tick 间隔（毫秒），默认 60_000（1 分钟） */
  tickIntervalMs: number
  /** 心潮 URL，如 http://127.0.0.1:18110 */
  xinchaoUrl?: string
  /** 心潮刷新间隔（毫秒），默认 300_000（5 分钟） */
  xinchaoRefreshMs: number
  /** 每日最大 Wake 次数（message + trace），默认 30 */
  maxPerDay: number
  /** 最长间隔（分钟）：距离上次说话/上次醒来超过这个就一定醒。在 [min, max] 之间随机，默认 150–180 */
  maxGapMinMinutes: number
  maxGapMaxMinutes: number
  /** 她这么多分钟内说过话 = 正在聊，不另外自己醒（闹钟不受影响） */
  chattingQuietMinutes: number
  /** 触发后的回调：调模型、推送等 */
  onWake: (opp: WakeOpportunity, db: DB) => Promise<void>
  log: (msg: string) => void
}

const DEFAULTS: Omit<WakeSchedulerConfig, 'onWake' | 'log'> = {
  tickIntervalMs: 60_000,
  xinchaoRefreshMs: 300_000,
  maxPerDay: 30,
  maxGapMinMinutes: 150,
  maxGapMaxMinutes: 180,
  chattingQuietMinutes: 10
}

// ── 最长间隔（2026-11-03 Erica：最长不超过三小时）──
// 锚点 = 最后一次聊天消息（她或他）和最后一次醒来（含失败）里较晚的那个。
// 截止时间在 [min, max] 分钟之间随机，但同一个锚点永远抽到同一个数——
// 每分钟重抽会让它几乎总是落在下限附近。
// 失败的醒来也算锚点，这样中转站挂了不会每分钟重试一次。

/** 同一个锚点 → 同一个截止时间 */
export function maxGapDeadline(anchor: Date, minMinutes: number, maxMinutes: number): Date {
  const h = createHash('sha256').update(anchor.toISOString()).digest()
  const u = h.readUInt32BE(0) / 0x1_0000_0000
  const minutes = minMinutes + u * Math.max(0, maxMinutes - minMinutes)
  return new Date(anchor.getTime() + minutes * 60_000)
}

/** 她最后一条消息的时间 */
export function lastEricaMessageAt(db: DB): Date | null {
  const row = db.prepare(`SELECT MAX(ts) AS t FROM episodes
    WHERE retracted_at IS NULL AND channel IN ('chat', 'room') AND actor = 'erica' AND kind = 'message'`).get() as { t: string | null }
  return row?.t ? new Date(row.t) : null
}

/** 最后一次聊天消息或醒来的时间；都没有返回 null */
export function lastActivityAt(db: DB): Date | null {
  const chat = db.prepare(`SELECT MAX(ts) AS t FROM episodes
    WHERE retracted_at IS NULL AND channel IN ('chat', 'room') AND actor IN ('erica', 'ai') AND kind = 'message'`).get() as { t: string | null }
  const wake = db.prepare('SELECT MAX(created_at) AS t FROM wake_opportunities').get() as { t: string | null }
  const times = [chat?.t, wake?.t].filter((t): t is string => !!t).map(t => new Date(t).getTime()).filter(Number.isFinite)
  return times.length ? new Date(Math.max(...times)) : null
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

/** 精确闹钟到点后多久之内还算准时（超过就记 missed） */
export const PRECISE_GRACE_MS = 10 * 60_000

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
      // 2026-11-07 Erica 定：她正在聊（10 分钟内说过话）就不另外醒——聊天里的他就在，这次累积算用掉了，重新攒
      const lastHer = lastEricaMessageAt(this.db)
      if (lastHer && now.getTime() - lastHer.getTime() < this.cfg.chattingQuietMinutes * 60_000) {
        this.cfg.log(`[wake] 累积到了，但她 ${Math.round((now.getTime() - lastHer.getTime()) / 60_000)} 分钟前还在说话（正在聊），不另外醒`)
        return
      }
      this.cfg.log(`[wake] 非精确触发 λ=${result.lambda.toFixed(3)} contributions=${JSON.stringify(
        result.contributions.filter(c => c.weighted > 0).map(c => `${c.sourceId}:${c.weighted.toFixed(2)}`)
      )}`)
      this.dispatch('spontaneous', readings, '非精确 Wake：累积达到阈值', undefined)
      return
    }

    // 最长间隔兜底。他自己选了 low_frequency（或上面已经 return 的 silent）时不生效：那是他自己的决定
    if (state.frequencyMode === 'low_frequency') return
    const anchor = lastActivityAt(this.db)
    if (!anchor) return
    const deadline = maxGapDeadline(anchor, this.cfg.maxGapMinMinutes, this.cfg.maxGapMaxMinutes)
    if (now < deadline) return
    const mins = Math.round((now.getTime() - anchor.getTime()) / 60_000)
    saveState(this.db, { ...result.state, H: 0, theta: drawTheta(), lastWakeAt: now.toISOString() })
    this.cfg.log(`[wake] 最长间隔到了：距离上次说话/醒来 ${mins} 分钟`)
    this.dispatch('spontaneous', readings, `距离你们上次说话或你上次醒来已经 ${mins} 分钟了`, undefined)
  }

  private checkPreciseWakes(now: Date): void {
    const nowIso = now.toISOString()
    // 到点时没能执行（后端没在跑）超过宽限的，记 missed，不补醒；下次醒来告诉他（Wake 2.0：补的是知情权，不是 Wake）。
    // 2026-11-06 修：以前和 datetime() 的 "YYYY-MM-DD HH:MM:SS" 比，ISO 的 "T" 永远更大，同一天的永远记不上 missed
    const graceIso = new Date(now.getTime() - PRECISE_GRACE_MS).toISOString()
    this.db.prepare(`UPDATE wake_precise SET status = 'missed' WHERE status = 'pending' AND wake_at < ?`).run(graceIso)

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
