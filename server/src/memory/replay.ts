// 回放抽检（2026-11-12，她说「我总觉得不放心」）。
//
// 她不放心的不是「别人怎么做」，是「这套在我的库上到底准不准」。再读十个仓库也答不了，
// 只有拿她真实说过的话回放一遍才答得了。
//
// 抄 WrenWen 的毕业条件（他们的线卷上生产前也是这么过的）：
//   影子 ≥3 天、观测 ≥10 轮、**用户抽看无错命中**。
//
// 这个模块**只读**：不写 memory_deliveries、不写任何东西，跑多少遍都没有副作用。
import type { DB } from '../db.ts'
import { ensureMemorySchema } from './schema.ts'
import { runRecall, distinctWords, type RecallResult } from './inject.ts'
import { cachedQueryVector, embedConfig, apiEmbedder, queryVector } from './embed.ts'
import { cleanForDigest } from './digest.ts'

export interface ReplayTurn {
  turn: string | null
  at: string
  /** 她那一句（原话，截断） */
  said: string
  /** 他那一轮真实回了什么（截断，用来判「要是给了他，他会不会用上」） */
  replied: string
  picked: { id: number; title: string; score: number; lex: number; sem: number; why: string; axisLen: number }[]
  rejected: { title: string; why: string }[]
  quotes: number
  suppressed: Record<string, number>
  /** 这一轮给出去的几条里，有几条在他真实回复里能对上（影子期只能这么估） */
  wouldUse: number
  /** 没捞到任何东西 */
  empty: boolean
}

export interface ReplayReport {
  turns: number
  withPicks: number
  empty: number
  avgPicked: number
  wouldUseRate: number | null
  semanticUsed: number
  items: ReplayTurn[]
}

/** 这条记忆有没有在他的回复里露出痕迹（和三态回执同一套判据） */
function usedIn(reply: string, title: string, body: string): boolean {
  if (!reply) return false
  return distinctWords(`${title} ${body}`).some(w => reply.includes(w))
}

/**
 * 拿最近 N 轮真实对话回放。
 * 查询向量优先走缓存；allowEmbed=true 时允许现算（回放是离线的，可以等）。
 */
export async function replayRecall(
  db: DB,
  o: { turns?: number; allowEmbed?: boolean; scene?: string; limit?: number } = {}
): Promise<ReplayReport> {
  ensureMemorySchema(db)
  const n = Math.min(Math.max(o.turns ?? 20, 1), 100)
  // 她说的每一句 + 她之后他的那条回复（按 turn 对上；没有 turn 的按 seq 找下一条 ai）
  const rows = db.prepare(`SELECT seq, ts, content, json_extract(meta, '$.turn') AS turn FROM episodes
    WHERE actor = 'erica' AND kind = 'message' AND channel = 'chat' AND retracted_at IS NULL
      AND length(content) >= 4
    ORDER BY seq DESC LIMIT ?`).all(n) as unknown as
    { seq: number; ts: string; content: string; turn: string | null }[]

  const cfg = embedConfig()
  const report: ReplayReport = {
    turns: 0, withPicks: 0, empty: 0, avgPicked: 0, wouldUseRate: null, semanticUsed: 0, items: [],
  }
  let totalPicked = 0
  let judged = 0
  let used = 0

  for (const row of rows.reverse()) {
    const said = cleanForDigest(row.content)
    if (!said) continue
    const reply = (db.prepare(`SELECT content FROM episodes
      WHERE actor = 'ai' AND kind = 'message' AND seq > ? AND retracted_at IS NULL
      ORDER BY seq LIMIT 1`).get(row.seq) as { content: string } | undefined)?.content ?? ''
    const replyClean = cleanForDigest(reply)

    let vec: Float32Array | null = cfg ? cachedQueryVector(db, said, cfg.model) : null
    if (!vec && cfg && o.allowEmbed) {
      const got = await queryVector(db, said, apiEmbedder(cfg, 20_000), { model: cfg.model })
      vec = got?.vec ?? null
    }
    const r: RecallResult = runRecall(db, said, { scene: o.scene ?? 'chat', limit: o.limit ?? 3, queryVec: vec })
    if (vec) report.semanticUsed++

    const wouldUse = r.picked.filter(p => usedIn(replyClean, p.row.title, p.row.fact_body)).length
    judged += r.picked.length
    used += wouldUse
    totalPicked += r.picked.length
    report.turns++
    if (r.picked.length) report.withPicks++
    if (!r.picked.length && !r.quotes.length) report.empty++

    report.items.push({
      turn: row.turn, at: row.ts,
      said: said.slice(0, 120),
      replied: replyClean.slice(0, 120),
      picked: r.picked.map(p => ({
        id: p.row.id, title: p.row.title, score: Number(p.score.toFixed(3)),
        lex: Number((p.lex ?? 0).toFixed(3)), sem: Number((p.sem ?? 0).toFixed(3)),
        why: p.why, axisLen: p.axis.length,
      })),
      rejected: r.rejected.slice(0, 4).map(x => ({ title: x.title, why: x.why })),
      quotes: r.quotes.length,
      suppressed: r.suppressed,
      wouldUse, empty: !r.picked.length && !r.quotes.length,
    })
  }

  report.avgPicked = report.turns ? Number((totalPicked / report.turns).toFixed(2)) : 0
  report.wouldUseRate = judged ? Number((used / judged).toFixed(3)) : null
  return report
}

export interface Graduation {
  shadowDays: number | null
  shadowTurns: number
  spotChecked: number
  wrongMarked: number
  ready: boolean
  missing: string[]
}

/**
 * 毕业条件（借 WrenWen 的那三条）：影子 ≥3 天、观测 ≥10 轮、她抽看无错命中。
 * 「无错命中」靠她在错题本里标——**没人标过不等于没错**，所以要求至少抽看过 5 条。
 */
export function graduation(db: DB, env: NodeJS.ProcessEnv = process.env): Graduation {
  ensureMemorySchema(db)
  const one = (sql: string) => {
    try { return db.prepare(sql).get() as any } catch { return null }
  }
  const span = one(`SELECT min(created_at) a, max(created_at) b, count(DISTINCT turn) t FROM memory_deliveries WHERE mode = 'shadow'`)
  const days = span?.a ? (new Date(span.b).getTime() - new Date(span.a).getTime()) / 86400_000 : null
  const turns = Number(span?.t ?? 0)
  const checks = one(`SELECT count(*) n, sum(CASE WHEN verdict = 'wrong' THEN 1 ELSE 0 END) w FROM memory_spotchecks`) ?? { n: 0, w: 0 }
  const needDays = Number(env.MEMORY_RECALL_MIN_DAYS) || 3
  const needTurns = Number(env.MEMORY_RECALL_MIN_TURNS) || 10
  const needChecks = Number(env.MEMORY_RECALL_MIN_CHECKS) || 5

  const missing: string[] = []
  if ((days ?? 0) < needDays) missing.push(`影子还没跑够 ${needDays} 天（现在 ${days === null ? 0 : days.toFixed(1)} 天）`)
  if (turns < needTurns) missing.push(`观测还不够 ${needTurns} 轮（现在 ${turns} 轮）`)
  if (Number(checks.n) < needChecks) missing.push(`你还没抽看够 ${needChecks} 条（现在 ${checks.n} 条）`)
  if (Number(checks.w) > 0) missing.push(`错题本里有 ${checks.w} 条你标了「不该给」，先处理掉`)

  return {
    shadowDays: days === null ? null : Number(days.toFixed(1)),
    shadowTurns: turns,
    spotChecked: Number(checks.n),
    wrongMarked: Number(checks.w),
    ready: !missing.length,
    missing,
  }
}

export function ensureSpotcheckSchema(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_spotchecks (
    id INTEGER PRIMARY KEY,
    memory_id INTEGER,
    query TEXT NOT NULL,
    verdict TEXT NOT NULL,          -- right 该给 / wrong 不该给 / meh 无所谓
    note TEXT,
    created_at TEXT NOT NULL
  )`)
}

/** 错题本：她看到一条不该给的就标下来。标过的会变成判官的新规则（第四期之前要处理掉） */
export function addSpotcheck(
  db: DB,
  o: { memoryId?: number | null; query: string; verdict: 'right' | 'wrong' | 'meh'; note?: string },
  now: Date = new Date()
): { ok: true; id: number } | { ok: false; error: string } {
  ensureSpotcheckSchema(db)
  if (!['right', 'wrong', 'meh'].includes(o.verdict)) return { ok: false, error: 'verdict 只能是 right / wrong / meh' }
  const q = String(o.query ?? '').trim().slice(0, 200)
  if (!q) return { ok: false, error: '要带上她当时说的那句话' }
  const r = db.prepare(`INSERT INTO memory_spotchecks (memory_id, query, verdict, note, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(o.memoryId ?? null, q, o.verdict, (o.note ?? '').slice(0, 300) || null, now.toISOString())
  return { ok: true, id: Number(r.lastInsertRowid) }
}

export function listSpotchecks(db: DB, limit = 50): any[] {
  ensureSpotcheckSchema(db)
  return db.prepare(`SELECT s.*, m.title FROM memory_spotchecks s LEFT JOIN memories m ON m.id = s.memory_id
    ORDER BY s.id DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 200)) as unknown as any[]
}
