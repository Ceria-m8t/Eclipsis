// 和 xiaoke 对账（软删同步）。现在 xiaoke 是"他看得到什么"的依据：她在 xiaoke 里删掉的，这里标成已撤回。
//   1. 关联：网关记的经历在 xiaoke 里找对应的那条（角色 + 内容 + 时间 ±30 分钟），记下 xiaoke_id
//   2. 撤回：关联过的那条在 xiaoke 里没了 → 撤回；过了宽限期还在 xiaoke 里找不到 → 也撤回
//      （包括她在关联前就删掉的、失败没进 xiaoke 的）
//   3. 连带：撤回的回复里的工具调用、工具结果一起撤回
// 软删：内容留着，retracted_at 有值的永远不会被组装进上下文。
//
// xiaoke 的库在 /root 下，后端读不到，所以由 root 导出、管道喂进来（见 deploy/eclipsis-reconcile.service）：
//   sqlite3 -json 'file:/root/xiaoke/data/xiaoke.sqlite?mode=ro' "<EXPORT_SQL>" | node server/src/reconcile-xiaoke.ts [--dry-run]
import { openDb, tx, type DB } from './db.ts'
import { loadConfig } from './config.ts'

export interface XiaokeRow { id: string; role: string; created_at: string; content: string | null }

export const LINK_WINDOW_MS = 30 * 60_000   // 关联时允许的时间差
export const GRACE_MS = 15 * 60_000         // 过了这么久还没关联上 → 视为不在 xiaoke 里
export const CONTENT_DAYS = 3               // 只导出最近几天的正文（更早的只要 id）

const ROLE_OF_ACTOR: Record<string, string> = { erica: 'user', ai: 'assistant' }
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

export interface ReconcileResult {
  linked: number
  retractedDeleted: number      // 关联过、xiaoke 里被删了
  retractedMissing: number      // 宽限期过了仍不在 xiaoke 里
  cascaded: number              // 连带撤回的工具记录
  waiting: number               // 还在宽限期内没关联上
  dryRun: boolean
}

export function reconcile(db: DB, rows: XiaokeRow[], now = Date.now(), opts: { dryRun?: boolean } = {}): ReconcileResult {
  const ids = new Set(rows.map(r => r.id))
  const linkedCount = (db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE xiaoke_id IS NOT NULL AND retracted_at IS NULL').get() as { n: number }).n
  // 导出坏了（空的、读错库）时不能把所有东西都撤回
  if (linkedCount > 100 && ids.size < linkedCount * 0.5) {
    throw new Error(`xiaoke 导出只有 ${ids.size} 条，但已关联 ${linkedCount} 条，疑似导出失败，本次不处理`)
  }
  const result: ReconcileResult = { linked: 0, retractedDeleted: 0, retractedMissing: 0, cascaded: 0, waiting: 0, dryRun: !!opts.dryRun }
  const nowIso = new Date(now).toISOString()
  const contentFrom = now - CONTENT_DAYS * 86_400_000

  const run = () => {
    // ---- 1. 关联 ----
    const taken = new Set((db.prepare('SELECT xiaoke_id FROM episodes WHERE xiaoke_id IS NOT NULL').all() as { xiaoke_id: string }[]).map(r => r.xiaoke_id))
    const byKey = new Map<string, { id: string; t: number }[]>()
    for (const r of rows) {
      if (r.content == null || taken.has(r.id) || (r.role !== 'user' && r.role !== 'assistant')) continue
      const key = r.role + '|' + norm(r.content)
      const list = byKey.get(key) || []
      list.push({ id: r.id, t: new Date(r.created_at).getTime() })
      byKey.set(key, list)
    }
    const candidates = db.prepare(`SELECT seq, ts, actor, content FROM episodes
      WHERE xiaoke_id IS NULL AND retracted_at IS NULL AND kind IN ('message', 'wake') AND actor IN ('erica', 'ai')
        AND (source_ref IS NULL OR source_ref NOT LIKE 'xiaoke:%') AND ts >= ?`).all(new Date(contentFrom).toISOString()) as
      { seq: number; ts: string; actor: string; content: string }[]
    // 先列出所有可能的配对，按时间差从小到大分配，一条 xiaoke 记录只配一次
    const pairs: { seq: number; id: string; dt: number }[] = []
    for (const c of candidates) {
      const t = new Date(c.ts).getTime()
      for (const x of byKey.get(ROLE_OF_ACTOR[c.actor] + '|' + norm(c.content)) || []) {
        const dt = Math.abs(x.t - t)
        if (dt <= LINK_WINDOW_MS) pairs.push({ seq: c.seq, id: x.id, dt })
      }
    }
    pairs.sort((a, b) => a.dt - b.dt)
    const usedSeq = new Set<number>(), usedId = new Set<string>()
    const link = db.prepare('UPDATE episodes SET xiaoke_id = ? WHERE seq = ?')
    for (const p of pairs) {
      if (usedSeq.has(p.seq) || usedId.has(p.id)) continue
      usedSeq.add(p.seq); usedId.add(p.id)
      link.run(p.id, p.seq)
      result.linked++
    }

    // ---- 2. 撤回 ----
    const retract = db.prepare('UPDATE episodes SET retracted_at = ?, retract_reason = ? WHERE seq = ?')
    const retractedSeqs: number[] = []
    const linked = db.prepare('SELECT seq, xiaoke_id FROM episodes WHERE xiaoke_id IS NOT NULL AND retracted_at IS NULL').all() as { seq: number; xiaoke_id: string }[]
    for (const e of linked) {
      if (ids.has(e.xiaoke_id)) continue
      retract.run(nowIso, 'xiaoke_deleted', e.seq)
      retractedSeqs.push(e.seq)
      result.retractedDeleted++
    }
    for (const c of candidates) {
      if (usedSeq.has(c.seq)) continue
      if (now - new Date(c.ts).getTime() < GRACE_MS) { result.waiting++; continue }
      retract.run(nowIso, 'not_in_xiaoke', c.seq)
      retractedSeqs.push(c.seq)
      result.retractedMissing++
    }

    // ---- 3. 连带：同一 rid 的工具调用 + 这些调用的结果 ----
    const cascade = db.prepare(`UPDATE episodes SET retracted_at = ?, retract_reason = 'cascade' WHERE retracted_at IS NULL AND (
        (kind = 'tool_call' AND json_extract(meta, '$.rid') = ?)
        OR (kind = 'tool_result' AND json_extract(meta, '$.tool_call_id') IN (
          SELECT json_extract(meta, '$.tool_call_id') FROM episodes WHERE kind = 'tool_call' AND json_extract(meta, '$.rid') = ?)))`)
    const ridOf = db.prepare("SELECT json_extract(meta, '$.rid') AS rid FROM episodes WHERE seq = ? AND actor = 'ai'")
    for (const seq of retractedSeqs) {
      const rid = (ridOf.get(seq) as { rid: string | null } | undefined)?.rid
      if (rid) result.cascaded += Number(cascade.run(nowIso, rid, rid).changes)
    }
    if (opts.dryRun) throw new DryRun()
  }
  try { tx(db, run) } catch (e) { if (!(e instanceof DryRun)) throw e }
  return result
}

class DryRun extends Error {}

// root 端导出用的 SQL：全部 id（判断删除）；最近几天的 user/assistant 带正文（用来关联）
export const EXPORT_SQL = `SELECT id, role, created_at, CASE WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%S', 'now', '-${CONTENT_DAYS} days') AND role IN ('user','assistant') THEN content END AS content FROM timeline_records`

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.includes('--print-sql')) { console.log(EXPORT_SQL); process.exit(0) }
  const text = (await readStdin()).trim()
  if (!text) { console.error('[reconcile] 没收到 xiaoke 导出（sqlite3 失败？）'); process.exit(1) }
  const rows = JSON.parse(text) as XiaokeRow[]
  const db = openDb(loadConfig().dbPath)
  try {
    console.log('[reconcile]', JSON.stringify({ xiaoke_rows: rows.length, ...reconcile(db, rows, Date.now(), { dryRun: args.includes('--dry-run') }) }))
  } finally { db.close() }
}
