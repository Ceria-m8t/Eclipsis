// 同一轮只给他一条回复（2026-11-11，Erica 报的 bug）。
//
// 重新生成（前端带 x-eclipsis-version）和「停掉/出错再重试」（版本号没变）都会在同一个 turn 下留好几条回复。
// 算同一轮的好几版 = 同一个 turn + 中间没有她的话。turn 偶尔会撞（11-09 22:10 那一对就是同一个 turn 下
// 她又说了话的两轮），所以不能只看 turn。chat-history.ts 的分组用同一条规则，她和他看到的才一致。
// 她那边收在一起，聊天页只显示一条，右下角 1/2 能翻；他那边以前两条都看得到，等于她丢掉的那版还在他眼前。
//
// 哪条算数：**她翻到的那条**（Erica 2026-11-11 定）。前端翻版本时记进 turn_active；她没翻过就是最后一条。
// 库里所有版本都留着（她还能翻、还能切回去），只是不给他看被盖掉的那些。
//
// 三处要用：①上游入口（xiaoke 补的历史里有旧版本，DROP_OLD_VERSIONS=0 关）；②我们自己拼历史（assembler/history.ts）；
// ③他醒来时接最近一次聊天（wake/continuation.ts，那份是请求原样存下来的）。
import type { DB } from './db.ts'

/** 比对时不看思考、这一刻和时间标记（历史里这些会被剪掉，经历表里是原样） */
export function normReply(s: string): string {
  return s
    .replace(/<(think|thinking)>[\s\S]*?(?:<\/\1>|$)/gi, ' ')
    .replace(/<moment(\s+lock)?\s*>[\s\S]*?(?:<\/moment>|$)/gi, ' ')
    .replace(/<current_time>[\s\S]*?<\/current_time>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const LOOKBACK_DAYS = 30        // 只看最近一个月的轮次（更早的旧版本不再拿来比文字，免得误伤同样的新回复）
const LOOKBACK_ROWS = 1500

interface Row { seq: number; turn: string; content: string }

/** 同一轮的好几版：同一个 turn、中间没有她的话。返回每一组（两条以上的才给） */
function versionGroups(db: DB, now = Date.now()): { turn: string; rows: Row[] }[] {
  const since = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString()
  const rows = db.prepare(`
    SELECT seq, actor, json_extract(meta, '$.turn') AS turn, content FROM episodes
    WHERE channel = 'chat' AND scope = 'daily' AND kind = 'message' AND actor IN ('erica', 'ai')
      AND retracted_at IS NULL AND ts > ?
    ORDER BY seq DESC LIMIT ?
  `).all(since, LOOKBACK_ROWS) as unknown as (Row & { actor: string })[]
  rows.reverse()
  const groups: { turn: string; rows: Row[] }[] = []
  const open = new Map<string, { turn: string; rows: Row[] }>()   // 还没被她的话打断的那几组
  for (const r of rows) {
    if (r.actor === 'erica') { open.clear(); continue }
    if (!r.turn) continue
    const g = open.get(r.turn)
    if (g) g.rows.push({ seq: r.seq, turn: r.turn, content: r.content })
    else {
      const next = { turn: r.turn, rows: [{ seq: r.seq, turn: r.turn, content: r.content }] }
      open.set(r.turn, next)
      groups.push(next)
    }
  }
  return groups.filter(g => g.rows.length > 1)
}

/** 她翻到的那条（turn → seq）；没记过的轮次不在里面 */
export function activeChoices(db: DB): Map<string, number> {
  const rows = db.prepare('SELECT turn, seq FROM turn_active').all() as { turn: string; seq: number }[]
  return new Map(rows.map(r => [r.turn, r.seq]))
}

/** 被盖掉的那些回复（同一轮里除了算数那条以外的） */
export function supersededRows(db: DB, now = Date.now()): Row[] {
  const chosen = activeChoices(db)
  const out: Row[] = []
  for (const { turn, rows: list } of versionGroups(db, now)) {
    const pick = chosen.get(turn)
    const active = pick !== undefined && list.some(r => r.seq === pick) ? pick : list[list.length - 1]!.seq
    for (const r of list) if (r.seq !== active) out.push(r)
  }
  return out
}

export function supersededSeqs(db: DB, now = Date.now()): Set<number> {
  return new Set(supersededRows(db, now).map(r => r.seq))
}

/** 这一轮算数的是哪条（给聊天记录接口用：她翻到的那条，没翻过是最后一条） */
export function activeSeqOfTurns(db: DB, turns: string[]): Map<string, number> {
  const out = new Map<string, number>()
  if (!turns.length) return out
  const chosen = activeChoices(db)
  for (const t of turns) { const s = chosen.get(t); if (s !== undefined) out.set(t, s) }
  return out
}

/** 她翻到哪一版就记一下。seq 要是这一轮里他的一条回复 */
export function setActiveVersion(db: DB, turn: string, seq: number): { ok: true; turn: string; seq: number } {
  const row = db.prepare(`
    SELECT seq FROM episodes
    WHERE seq = ? AND actor = 'ai' AND kind = 'message' AND retracted_at IS NULL
      AND json_extract(meta, '$.turn') = ?
  `).get(seq, turn) as { seq: number } | undefined
  if (!row) throw new Error('这一轮里没有这条回复')
  db.prepare(`INSERT INTO turn_active(turn, seq, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(turn) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at`)
    .run(turn, seq, new Date().toISOString())
  return { ok: true, turn, seq }
}

/**
 * 把历史里被盖掉的那些回复删掉（按正文认，历史里没有 turn）。
 * 同一段文字被盖掉过几次就最多删几条，算数那条留着；她连着两次生成出一样的话也只会留一条。
 */
export function dropSupersededVersions(messages: any[], db: DB, now = Date.now()): { messages: any[]; dropped: number } {
  const rows = supersededRows(db, now)
  if (!rows.length) return { messages, dropped: 0 }
  const bag = new Map<string, number>()
  for (const r of rows) {
    const k = normReply(r.content)
    if (k) bag.set(k, (bag.get(k) || 0) + 1)
  }
  if (!bag.size) return { messages, dropped: 0 }
  const out: any[] = []
  let dropped = 0
  for (const m of messages) {
    if (m?.role === 'assistant' && !m.tool_calls?.length) {
      const k = normReply(typeof m.content === 'string' ? m.content : textParts(m.content))
      const left = bag.get(k)
      if (k && left) { bag.set(k, left - 1); dropped++; continue }
    }
    out.push(m)
  }
  return dropped ? { messages: out, dropped } : { messages, dropped: 0 }
}

function textParts(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((p: any) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('\n')
}
