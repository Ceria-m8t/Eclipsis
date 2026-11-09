// 组装器：后端自己接上前面的聊天（替换 xiaoke 的那一步，2026-11-10 起先影子运行）。
//
// xiaoke 的做法：按条数补到 300 条，补的那段插在窗口历史前面，不按时间；不管今天截没截完。
// 这里的做法（Erica 定，约两百条）：
//   1. 今天（她这一天：从她上一次睡醒算起，不按半夜十二点）的聊天一条都不截；
//   2. 剩下的名额往前补，补到 TARGET 条为止（今天本身超过了就只放今天）；
//   3. 相邻两天之间插一行日期分隔（挂在那天她的第一句前面），他一眼看得出哪段是哪天；
//   4. 从经历表按时间取，顺序永远对；撤回的（她删的）不进来。
// 影子阶段：只算出来，和 xiaoke 实际拼的那份比一比，记在 exchanges.transforms.shadow_context，不改发出去的请求。
import type { DB } from '../db.ts'
import { textOf } from '../recorder.ts'

export const TARGET = 220            // 大约两百多条
export const MAX_TODAY = 600         // 今天聊得特别多时也有个上限（再多就从今天的开头截）
export const SLEEP_GAP_MS = 5 * 3600_000   // 她连续这么久没说话 = 睡了一觉，之后算新的一天

export interface HistRow { seq: number; ts: string; actor: 'erica' | 'ai'; content: string }

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
/** 中国时间的日期标签：11月9日 周一 */
export function dayLabel(ms: number): string {
  const d = new Date(ms + 8 * 3600_000)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEK[d.getUTCDay()]}`
}
const dayKey = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)

/** 她这一天从哪条开始：最后一次「她超过 5 小时没说话」之后她的第一句 */
export function todayStart(rows: HistRow[], now = Date.now()): number {
  let lastHer = now
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    if (r.actor !== 'erica') continue
    const t = Date.parse(r.ts)
    if (lastHer - t > SLEEP_GAP_MS) return i + 1 < rows.length ? nextHer(rows, i + 1) : rows.length
    lastHer = t
  }
  return 0
}
function nextHer(rows: HistRow[], from: number): number {
  for (let i = from; i < rows.length; i++) if (rows[i]!.actor === 'erica') return i
  return rows.length
}

export function loadRecent(db: DB, limit = MAX_TODAY + TARGET, beforeSeq?: number): HistRow[] {
  const rows = db.prepare(`SELECT seq, ts, actor, content FROM episodes
    WHERE channel = 'chat' AND scope = 'daily' AND kind = 'message' AND actor IN ('erica', 'ai') AND retracted_at IS NULL
      AND (? IS NULL OR seq < ?)
    ORDER BY seq DESC LIMIT ?`).all(beforeSeq ?? null, beforeSeq ?? null, limit) as unknown as HistRow[]
  return rows.reverse()
}

export interface Assembled {
  rows: HistRow[]          // 选进来的（按时间）
  todayFrom: number        // rows 里今天从第几条开始
  days: { label: string; at: number }[]   // 每一天在 rows 里从哪条开始
}

/** 选哪些：今天全要，再往前补到 TARGET */
export function selectHistory(all: HistRow[], now = Date.now()): Assembled {
  let start = todayStart(all, now)
  if (all.length - start > MAX_TODAY) start = all.length - MAX_TODAY
  const from = Math.max(0, Math.min(start, all.length - TARGET))
  const rows = all.slice(from)
  const days: Assembled['days'] = []
  let lastKey = ''
  rows.forEach((r, i) => {
    const k = dayKey(Date.parse(r.ts))
    if (k !== lastKey) { days.push({ label: dayLabel(Date.parse(r.ts)), at: i }); lastKey = k }
  })
  return { rows, todayFrom: start - from, days }
}

/** 拼成发给他的消息：日期分隔挂在每天她的第一句前面（不加在他的话上，免得他学着写日期） */
export function toMessages(a: Assembled, now = Date.now()): any[] {
  const out: any[] = []
  const todayKey = dayKey(now), yKey = dayKey(now - 86_400_000)
  const pendingDay = new Map<number, string>()
  for (const d of a.days) {
    const k = dayKey(Date.parse(a.rows[d.at]!.ts))
    const rel = k === todayKey ? '（今天）' : k === yKey ? '（昨天）' : ''
    // 这天第一句她的话
    let j = d.at
    while (j < a.rows.length && a.rows[j]!.actor !== 'erica' && dayKey(Date.parse(a.rows[j]!.ts)) === k) j++
    if (j < a.rows.length && dayKey(Date.parse(a.rows[j]!.ts)) === k) pendingDay.set(j, `—— ${d.label}${rel} ——`)
  }
  a.rows.forEach((r, i) => {
    const sep = pendingDay.get(i)
    out.push({ role: r.actor === 'erica' ? 'user' : 'assistant', content: sep ? `${sep}\n${r.content}` : r.content })
  })
  return out
}

// ---------------- 影子对比 ----------------

// 比较时不看时间标记和思考（上游入口会剪掉历史里的思考，xiaoke 那份是剪过的）
const norm = (s: string) => s.replace(/<current_time>[\s\S]*?<\/current_time>/g, '')
  .replace(/<(think|thinking)>[\s\S]*?(?:<\/\1>|$)/gi, '').replace(/\s+/g, ' ').trim()

/** 请求里的历史部分：去掉开头的 system 和结尾这一轮（她最后连着说的几句 + 工具轮），工具消息不算 */
export function requestHistory(messages: any[]): { role: string; text: string }[] {
  let head = 0
  while (head < messages.length && messages[head]?.role === 'system') head++
  let tail = messages.length
  while (tail > head && (messages[tail - 1]?.role === 'tool' || (messages[tail - 1]?.role === 'assistant' && messages[tail - 1]?.tool_calls?.length))) tail--
  while (tail > head && messages[tail - 1]?.role === 'user') tail--
  return messages.slice(head, tail)
    .filter(m => (m?.role === 'user' || m?.role === 'assistant') && !(m.role === 'assistant' && m.tool_calls?.length && !textOf(m.content).trim()))
    .map(m => ({ role: m.role, text: norm(textOf(m.content)) }))
    .filter(m => m.text)
}

export interface ShadowReport {
  xiaoke: number           // xiaoke 那份历史有几条
  ours: number             // 我们会给几条
  today: number            // 其中今天的
  days: number             // 跨了几天
  overlap: number          // 两边都有的
  onlyXiaoke: number       // 只有 xiaoke 有（我们少了的：多半是更早的，或者我们记录里没有的）
  onlyOurs: number         // 只有我们有（xiaoke 没补进来的，比如别的窗口新说的）
  xiaokeOutOfOrder: number // xiaoke 那份里时间倒着走的地方
  missingToday: number     // 今天的，xiaoke 没给（「晚上忘了早上」）
  sampleOnlyXiaoke?: string[]
}

export function shadowCompare(db: DB, messages: any[], now = Date.now()): ShadowReport {
  const all = loadRecent(db)
  const a = selectHistory(all, now)
  const theirs = requestHistory(messages)
  const ourKeys = a.rows.map(r => (r.actor === 'erica' ? 'user' : 'assistant') + '|' + norm(r.content))
  const theirKeys = theirs.map(m => m.role + '|' + m.text)
  const bag = (keys: string[]) => { const m = new Map<string, number>(); for (const k of keys) m.set(k, (m.get(k) || 0) + 1); return m }
  const ob = bag(ourKeys), tb = bag(theirKeys)
  let overlap = 0
  for (const [k, n] of ob) overlap += Math.min(n, tb.get(k) || 0)
  // xiaoke 那份的时间顺序：用经历表里对得上的时间
  const tsOf = new Map<string, number[]>()
  for (const r of all) { const k = (r.actor === 'erica' ? 'user' : 'assistant') + '|' + norm(r.content); (tsOf.get(k) || tsOf.set(k, []).get(k)!).push(Date.parse(r.ts)) }
  let last = -Infinity, ooo = 0
  for (const k of theirKeys) { const t = tsOf.get(k)?.[0]; if (t === undefined) continue; if (t < last - 60_000) ooo++; last = Math.max(last, t) }
  const todayKeys = bag(ourKeys.slice(a.todayFrom))
  let missingToday = 0
  for (const [k, n] of todayKeys) missingToday += Math.max(0, n - (tb.get(k) || 0))
  const onlyX = theirKeys.filter(k => !ob.has(k))
  return {
    xiaoke: theirKeys.length, ours: ourKeys.length, today: ourKeys.length - a.todayFrom, days: a.days.length,
    overlap, onlyXiaoke: theirKeys.length - overlap, onlyOurs: ourKeys.length - overlap,
    xiaokeOutOfOrder: ooo, missingToday,
    sampleOnlyXiaoke: onlyX.slice(-3).map(k => k.slice(0, 60)),
  }
}
