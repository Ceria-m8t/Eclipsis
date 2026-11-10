// 组装器：后端自己接上前面的聊天（替换 xiaoke 的那一步，2026-11-10 起先影子运行）。
//
// xiaoke 的做法：按条数补到 300 条，补的那段插在窗口历史前面，不按时间；不管今天截没截完。
// 这里的做法（Erica 定，约两百条）：
//   1. 今天（她这一天：从她上一次睡醒算起，不按半夜十二点）的聊天一条都不截；
//   2. 剩下的名额往前补，补到 TARGET 条为止（今天本身超过了就只放今天）；
//   3. 相邻两天之间插一行日期分隔（挂在那天她的第一句前面），他一眼看得出哪段是哪天；
//   4. 从经历表按时间取，顺序永远对；撤回的（她删的）、被盖掉的旧版本（重新生成前那条）不进来。
// 影子阶段：只算出来，和 xiaoke 实际拼的那份比一比，记在 exchanges.transforms.shadow_context，不改发出去的请求。
import type { DB } from '../db.ts'
import { textOf, cleanHerText, WAKE_MARKER } from '../recorder.ts'
import { supersededSeqs } from '../versions.ts'

export const TARGET = 220            // 大约两百多条
export const MAX_TODAY = 600         // 今天聊得特别多时也有个上限（再多就从今天的开头截）
export const SLEEP_GAP_MS = 5 * 3600_000   // 她连续这么久没说话 = 睡了一觉，之后算新的一天

export interface HistRow { seq: number; ts: string; actor: 'erica' | 'ai'; content: string; partial?: number | null }

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
  const rows = db.prepare(`SELECT seq, ts, actor, content, json_extract(meta, '$.partial') AS partial FROM episodes
    WHERE channel = 'chat' AND scope = 'daily' AND kind = 'message' AND actor IN ('erica', 'ai') AND retracted_at IS NULL
      AND (? IS NULL OR seq < ?)
    ORDER BY seq DESC LIMIT ?`).all(beforeSeq ?? null, beforeSeq ?? null, limit) as unknown as HistRow[]
  // 同一轮重新生成过的：只留算数那条（她翻到的，没翻过是最后一条）
  const dead = supersededSeqs(db)
  return rows.reverse().filter(r => !dead.has(r.seq))
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

// ---------------- 换掉请求里的历史（替换 xiaoke 的那一步） ----------------

// 这一轮不要换历史的几种请求：Kelivo 起标题、Kelivo 夹带的记忆注入、唤醒提示。
// 它们不是正常的一轮聊天，塞 220 条进去只会浪费钱、还可能让他照着答。
const TITLE_REQUEST = /(为(这段|以上)?(对话|聊天)|给(这段|以上)?(对话|聊天))?(起|生成|取|拟)一?个?(简短|简洁|合适)?的?(标题|题目)/
const INJECTED_MEMORY = /^\s*(\[记忆[^\]]*\]|<memory|【记忆)/i

/** 比对她的话时不看时间前缀和 Kelivo 加的 <current_time> */
export const sameLine = (s: string) => cleanHerText(s).replace(/\s+/g, ' ').trim()

/**
 * 砍掉历史尾巴上属于「这一轮」的几条：她这次发的话（已经记过的）和没写完的那条回复。
 * 她分条发时每句一条经历，所以要一条条往回看。
 */
export function trimThisRound(all: HistRow[], tailTexts: Set<string>): { rows: HistRow[]; trimmed: number } {
  let end = all.length
  while (end > 0) {
    const r = all[end - 1]!
    if (r.actor === 'erica' && tailTexts.has(sameLine(r.content))) { end--; continue }
    if (r.actor === 'ai' && r.partial) { end--; continue }
    break
  }
  const trimmed = all.length - end
  return { rows: trimmed ? all.slice(0, end) : all, trimmed }
}

/** 请求里属于「这一轮」的那一段：结尾连着的 user，以及没结束的工具轮 */
export function tailStart(messages: any[], head: number): number {
  let tail = messages.length
  while (tail > head && (messages[tail - 1]?.role === 'tool' || (messages[tail - 1]?.role === 'assistant' && messages[tail - 1]?.tool_calls?.length))) tail--
  while (tail > head && messages[tail - 1]?.role === 'user') tail--
  return tail
}

export interface ReplaceInfo { before: number; after: number; today: number; days: number; trimmed?: number }

/**
 * 把请求里 system 之后、这一轮之前的那一大段历史，换成我们自己从经历表拼的那份。
 * xiaoke 补的（顺序乱、少今天的）和 Kelivo 自己带的（它本机那份）都换掉；system 和这一轮原样留着。
 * 不该换的请求返回 null。
 */
export function replaceHistory(
  messages: any[], db: DB, now = Date.now(), opts: { insertWhenEmpty?: boolean } = {}
): { messages: any[]; info: ReplaceInfo } | null {
  // 直连中转站以后，前端只发这一轮，请求里根本没有历史：那就是「插进去」而不是「换掉」。
  // 经过 xiaoke 时请求里带着一大段，没有历史的请求多半不是正常聊天（起标题之类），照旧不动。
  const insert = !!opts.insertWhenEmpty
  if (!Array.isArray(messages) || messages.length < (insert ? 2 : 4)) return null
  let head = 0
  while (head < messages.length && messages[head]?.role === 'system') head++
  const tail = tailStart(messages, head)
  if (tail >= messages.length) return null          // 结尾不是她的话（也不是工具轮）：不是正常一轮
  if (tail - head < 2 && !insert) return null       // 本来就没什么历史可换
  const lastUser = textOf(messages[messages.length - 1]?.content)
  if (TITLE_REQUEST.test(lastUser) || INJECTED_MEMORY.test(lastUser) || lastUser.includes(WAKE_MARKER)) return null

  // 她这一轮的话可能已经记进经历表了（重新生成、上一轮停掉后她补几句再发），
  // 还可能跟着一条没写完的回复。历史尾巴上这几条要去掉，不然和下面这一轮重复一遍。
  const tailTexts = new Set(
    messages.slice(tail).filter(m => m?.role === 'user').map(m => sameLine(textOf(m.content))).filter(Boolean)
  )
  const trim = trimThisRound(loadRecent(db), tailTexts)
  const a = selectHistory(trim.rows, now)
  if (!a.rows.length) return null

  // 保险：请求里那段历史和我们库里的记录几乎不重合，说明这根本不是她和他的那条线
  // （以后别的前端、别的 AI 走到这个入口来，不能把人家的上下文换成我们的）。
  // 比的是「整个库」而不是这次选的两百多条：Kelivo 自己带的历史比我们这个窗口长得多，
  // 拿窗口比的话真实轮次只有 24% 对得上，会被误伤（11-11 第一次就是这么被挡住的）。
  const theirs = requestHistory(messages)
  if (theirs.length >= 20) {
    const known = new Set(loadRecent(db, MAX_TODAY + TARGET * 3).map(r => norm(r.content)))
    const hit = theirs.filter(m => known.has(m.text)).length
    if (hit / theirs.length < 0.5) return null       // 真实轮次实测 83–89%
  }

  const ours = toMessages(a, now)
  return {
    messages: [...messages.slice(0, head), ...ours, ...messages.slice(tail)],
    info: { before: tail - head, after: ours.length, today: ours.length - a.todayFrom, days: a.days.length, ...(trim.trimmed ? { trimmed: trim.trimmed } : {}) },
  }
}

// ---------------- 今日概况（此刻块里那一行） ----------------

export interface TodaySummary {
  herWakeAt: string | null     // 她今天第一句的时间（= 睡醒之后）
  herLines: number             // 她今天说了几句
  hisLines: number             // 他今天回了几条
  lastAtMs: number | null      // 最后一句（谁说的都算）距现在多少毫秒
}

export function todaySummary(db: DB, now = Date.now()): TodaySummary | null {
  const all = loadRecent(db)
  if (!all.length) return null
  const start = todayStart(all, now)
  const today = all.slice(start)
  if (!today.length) return { herWakeAt: null, herLines: 0, hisLines: 0, lastAtMs: now - Date.parse(all[all.length - 1]!.ts) }
  return {
    herWakeAt: today[0]!.ts,
    herLines: today.filter(r => r.actor === 'erica').length,
    hisLines: today.filter(r => r.actor === 'ai').length,
    lastAtMs: now - Date.parse(today[today.length - 1]!.ts),
  }
}

const hhmm = (iso: string) => {
  const d = new Date(Date.parse(iso) + 8 * 3600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
const ago = (ms: number) => {
  const m = Math.round(ms / 60_000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h} 小时${m % 60 ? ' ' + (m % 60) + ' 分钟' : ''}前` : `${Math.floor(h / 24)} 天前`
}

/** 「此刻」块里的今日概况：她几点醒的、今天聊了多少、上一句多久以前 */
export function renderTodayLine(db: DB, now = Date.now()): string {
  const s = todaySummary(db, now)
  if (!s) return ''
  if (!s.herWakeAt) {
    return s.lastAtMs == null ? '' : `今天她还没说话（上一句是 ${ago(s.lastAtMs)}）`
  }
  const parts = [`今天她 ${hhmm(s.herWakeAt)} 起（睡醒后第一句）`]
  parts.push(`到现在她说了 ${s.herLines} 句、你回了 ${s.hisLines} 条`)
  if (s.lastAtMs != null) parts.push(`上一句 ${ago(s.lastAtMs)}`)
  return parts.join('，')
}
