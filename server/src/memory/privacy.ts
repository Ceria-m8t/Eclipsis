// 私密作用域（2026-11-12，她问「以后聊成人话题、接玩具摄像头，这些会被记进记忆吗」）。
//
// 四条规矩（她 10-27 给脉那边定过「亲密：单独入口、单独上锁、不进群聊」，这里把记忆库对上）：
//   1. 标了私密的经历**不交给夜里整理** —— 不发给中转站的模型去读、去改写。
//      要成记忆只能他自己写（他在场，他知道该留什么）。
//   2. 私密的东西**不进群聊、不进 Leto、不进任何给别的 AI 的上下文**。
//   3. 面板里默认折叠，要点一下才展开。
//   4. 他那边自己有开关（memory_note 的 private 参数；聊天里标某几句私密走 /privacy 接口）。
//
// 诚实说明（和 10-24 日记盒那条一样）：这些数据在她自己的服务器上是**明文**，
// 聊天本身也经过中转站。锁是产品层面的承诺——前端和接口不给绕过的入口，
// 但服务器归她管，技术上数据库总能直接读。
import type { DB } from '../db.ts'
import { addColumns } from '../db.ts'

export const PRIVATE = 'private'
export const NORMAL = 'normal'

/** 这些场景一律拿不到私密内容 */
const OUTSIDE = new Set(['group', 'leto', 'public'])

export function ensurePrivacySchema(db: DB): void {
  addColumns(db, 'memories', { privacy: `TEXT NOT NULL DEFAULT '${NORMAL}'` })
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_privacy ON memories(privacy)')
}

/** 某个场景能不能看到私密内容。chat / wake = 只有他们俩，可以；群聊和外部 AI，不行 */
export function allowsPrivate(scene: string | undefined): boolean {
  return !OUTSIDE.has(String(scene ?? 'chat'))
}

/** 拼进 SQL 的 WHERE 片段（给经历表用） */
export function privacySql(scene: string | undefined, column = 'privacy'): string {
  return allowsPrivate(scene) ? '' : ` AND (${column} IS NULL OR ${column} != '${PRIVATE}')`
}

export interface MarkResult { marked: number; skipped: number }

/** 把几条经历标成私密（或取消）。她在聊天里选几句，或者他自己标 */
export function markEpisodesPrivate(db: DB, seqs: number[], priv = true): MarkResult {
  const ids = seqs.map(Number).filter(n => Number.isFinite(n) && n > 0)
  if (!ids.length) return { marked: 0, skipped: 0 }
  const r = db.prepare(`UPDATE episodes SET privacy = ? WHERE seq IN (${ids.map(() => '?').join(',')})`)
    .run(priv ? PRIVATE : NORMAL, ...ids)
  return { marked: Number(r.changes), skipped: ids.length - Number(r.changes) }
}

/** 把一整轮标成私密（她点「这一轮不要记」时用；turn 来自前端那一轮的 id） */
export function markTurnPrivate(db: DB, turn: string, priv = true): MarkResult {
  const rows = db.prepare(`SELECT seq FROM episodes WHERE json_extract(meta, '$.turn') = ?`)
    .all(String(turn)) as unknown as { seq: number }[]
  return markEpisodesPrivate(db, rows.map(r => r.seq), priv)
}

export function markMemoryPrivate(db: DB, id: number, priv = true): boolean {
  ensurePrivacySchema(db)
  const r = db.prepare('UPDATE memories SET privacy = ?, updated_at = ? WHERE id = ?')
    .run(priv ? PRIVATE : NORMAL, new Date().toISOString(), id)
  return Number(r.changes) > 0
}

export function privateCounts(db: DB): { episodes: number; memories: number } {
  const one = (sql: string) => { try { return Number((db.prepare(sql).get() as { n: number }).n) } catch { return 0 } }
  return {
    episodes: one(`SELECT count(*) n FROM episodes WHERE privacy = '${PRIVATE}'`),
    memories: one(`SELECT count(*) n FROM memories WHERE privacy = '${PRIVATE}' AND retracted_at IS NULL`),
  }
}
