// 原话检索（2026-11-12）。她问的那句话值得单独回答：
//   「这个记忆和原文摘取记录记忆有区别吗？区别有多少？」
//
// 区别很大，而且这正是她焦虑的来源：
//   - **记忆卡片**：188 条，是**判断**——他觉得值得留的那些，带为什么记、带情绪、带关系。
//     它永远是不完备的，因为它只记了 188 件事。
//   - **原话（经历表）**：10478 条，是**事实**——你们说过的每一句，一字不改。
//     它完备，但没有判断，全文搜出来是一堆散句。
//
// 「时间长河」那张图把这件事画清楚了：日记·源头（逐字留着，只读永不改写）在最底层，
// 上面才是轴卷和正式轴。我们一直只做了上面两层，**底层那层根本没接进召回**——
// 所以「我妈」在 248 条原话里出现过，召回却一条都给不出来。
//
// 这一层补上：卡片给判断，原话给质感和证据。两条腿一起走。
import type { DB } from '../db.ts'
import { bigrams } from './recall.ts'
import { expandQuery } from './aliases.ts'
import { allowsPrivate } from './privacy.ts'
import { cleanForDigest } from './digest.ts'
import { isWeakTerm } from './recall.ts'
import { bjDate, bjStamp } from './when.ts'

export interface Quote {
  seq: number
  ts: string
  actor: string
  who: string
  text: string
  score: number
  hits: string[]
}

const MAX_SCAN = 4000          // 最多扫最近这么多条（188 张卡 + 几千条原话，毫秒级）
const SNIPPET = 120

const bare = (s: string) => String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '')

function snippet(text: string, hit: string): string {
  const t = String(text || '').replace(/\s+/g, ' ')
  if (!hit) return t.slice(0, SNIPPET)
  const at = t.indexOf(hit)
  if (at < 0) return t.slice(0, SNIPPET)
  const from = Math.max(0, at - 30)
  return (from ? '…' : '') + t.slice(from, from + SNIPPET) + (from + SNIPPET < t.length ? '…' : '')
}

export interface QuoteOptions {
  scene?: string
  limit?: number
  /**
   * 只看这么多小时以前的（默认 24）。
   * 2026-11-12：她说「东西太杂」，查出来原话层在把**正在进行的这场对话**当记忆捞回来——
   * 她说「我们的屎山。。。」，命中的是他两分钟后回的那句。那些话本来就在他的上下文里
   * （历史带着今天全部 + 往前约 220 条），再捞一遍是纯噪声。
   * 原话的价值在「很久以前说过的那句」。
   */
  olderThanHours?: number
  /**
   * 原话不是独立的一条腿，是**卡片的证据**（她发的「时间长河」那张图：
   * 「召回具体事件块，指针指向当时的日记和上下文」）。
   * 给了 anchors（卡片命中的那几个词）时，只收和它们对得上的原话。
   */
  anchors?: string[]
  /** 没有卡片时，只认特别罕见的词（默认 0.2% —— 不然这种两个人聊了一万条的库里什么都能命中） */
  maxDfRatio?: number
  /** 只搜她说的 / 只搜他说的 */
  actor?: 'erica' | 'ai'
  /** 哪天之后 */
  since?: string
  /** 哪天之前（配合「那年五月」这种问法） */
  until?: string
  scan?: number
}

/**
 * 在原话里搜。打分用和卡片同一套（字符二元组 + 虚词不算），
 * 这样「我妈」展开成「妈妈/她妈」之后两边都能命中。
 */
export function searchQuotes(db: DB, query: string, o: QuoteOptions = {}): Quote[] {
  query = cleanForDigest(query)
  const exp = expandQuery(db, query)
  const words = [...new Set(bigrams(exp.text))].filter(g => g.length >= 2)
  if (!words.length) return []

  const where = ["retracted_at IS NULL", "kind = 'message'", "actor IN ('erica', 'ai')", "content != ''"]
  const args: (string | number)[] = []
  if (o.actor) { where.push('actor = ?'); args.push(o.actor) }
  if (o.since) { where.push('ts >= ?'); args.push(o.since) }
  if (o.until) { where.push('ts <= ?'); args.push(o.until) }
  const olderHours = o.olderThanHours ?? 24
  if (olderHours > 0) {
    where.push('ts <= ?')
    args.push(new Date(Date.now() - olderHours * 3600_000).toISOString())
  }
  if (!allowsPrivate(o.scene)) where.push("(privacy IS NULL OR privacy != 'private')")

  const rows = db.prepare(`SELECT seq, ts, actor, content FROM episodes
    WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`)
    .all(...args, Math.min(Math.max(o.scan ?? MAX_SCAN, 50), 20_000)) as unknown as
    { seq: number; ts: string; actor: string; content: string }[]

  // 直接找「原文里出现过的那几个说法」：这比打分更可解释，也更符合她的直觉
  // **原话也要有门槛**（2026-11-12 她看完回放提的）：
  // 她说「我说不清。」时，原话层捞回来三条「我说不清」——那是她以前也说过这句话，
  // 不是记忆。所以线索词要满足两条：不是虚词串，而且在经历表里不是到处都有。
  //
  // 另外整句不能只当一个词用：「我不吃海鲜」整串在原话里几乎不会一字不差地出现，
  // 真正有用的线索是里面的「海鲜」。所以长句要切成 2–4 字的窗口再筛。
  const runs = query.match(/[\u4e00-\u9fa5]{2,}|[A-Za-z0-9_.-]{2,}/g) ?? []
  const windows: string[] = []
  for (const run of runs) {
    if (/[A-Za-z0-9]/.test(run)) { windows.push(run); continue }
    if (run.length <= 4) { windows.push(run); continue }
    for (let n = 4; n >= 2; n--) {
      for (let i = 0; i + n <= run.length; i++) windows.push(run.slice(i, i + n))
    }
  }
  const terms = [...new Set([...exp.matched, ...exp.added, ...windows])]
    .filter(t => t.length >= 2 && !isWeakTerm(t))
  if (!terms.length) return []
  // 哪些线索词在库里到处都是（命中了也说明不了什么）：先数一遍，超过 2% 的丢掉
  const df = new Map<string, number>()
  const cleaned = rows.map(r => cleanForDigest(r.content))
  for (const text of cleaned) {
    for (const t of terms) if (text.includes(t)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  // 原话那条腿的门槛要比卡片那条严得多：她每轮都说「老公」，
  // 「老公」在最近 4000 条原话里出现 455 次（11.4%）—— 2% 的门槛根本拦不住，
  // 于是 40 轮里 40 轮都带 3 条原话（2026-11-12 她说「东西有点太杂了」）。
  // 标定：美甲 0.5%、记忆系统 0.5%、海鲜 0.5%、打电话 0.6%、星盘 0.2% 都要留下，
  // 老公 11.4%、分身 5.0%、糯糯 5.5%（卡片那条腿已经覆盖）要掐掉 → 取 0.8%。
  const commonAt = Math.max(2, Math.floor(rows.length * (o.maxDfRatio ?? 0.008)))
  let useful = terms.filter(t => {
    const n = df.get(t) ?? 0
    return n > 0 && n <= commonAt
  })
  // 有卡片命中时，只留和卡片对得上的词：原话是来给那几张卡作证的，不是另开一条线
  if (o.anchors?.length) {
    const anchors = o.anchors.filter(a => a.length >= 2)
    useful = useful.filter(t => anchors.some(a => a.includes(t) || t.includes(a)))
  }
  if (!useful.length) return []
  // 没有卡片作锚、她又是一长句话时：单个线索词不够（要么两个词对上，要么那个词 ≥4 字）。
  // 她直接搜一个短词（「我妈」「海鲜」）不受这条限制 —— 那两个字就是她要找的全部。
  const shortQuery = bare(query).length <= 5
  if (!o.anchors?.length && !shortQuery && useful.length < 2 && !useful.some(t => t.length >= 4)) return []

  // 她这一句本身也在经历表里（回放时尤其明显）：别把「你以前说过同一句话」当成记忆
  const self = bare(query)
  const out: Quote[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    // 他的 <think> 块不算「原话」——那是他想的，不是说出口的。
    // 她看原话是想看「当时谁说了什么」，不是看他的内心活动（2026-11-12）
    const text = cleaned[i]
    if (!text) continue
    const raw = useful.filter(t => text.includes(t))
    if (!raw.length) continue
    // 命中的词里去掉「被更长的那个包住」的（「海鲜」已经在「不吃海鲜」里了，不用列两遍）
    const hits = raw.filter(t => !raw.some(o => o !== t && o.includes(t))).sort((a, b) => b.length - a.length)
    // 整句几乎一样 → 这是同一句话的另一次出现，不是「想起了什么」
    const b = bare(text)
    if (self.length >= 4 && (b === self || (b.length <= self.length * 1.3 && b.includes(self)))) continue
    // 命中的说法越特殊（越长）、越多，分越高
    const score = Math.min(1, hits.reduce((n, h) => n + h.length, 0) / 12)
    out.push({
      seq: r.seq, ts: r.ts, actor: r.actor, who: r.actor === 'erica' ? '她' : '他',
      text: snippet(text, hits[0]), score, hits,
    })
  }
  out.sort((a, b) => b.score - a.score || b.ts.localeCompare(a.ts))
  return out.slice(0, Math.min(Math.max(o.limit ?? 5, 1), 50))
}

/** 这些说法在原话里一共出现过多少次、第一次和最后一次是什么时候 */
export function quoteSpan(db: DB, query: string, o: QuoteOptions = {}): { total: number; first: string | null; last: string | null } {
  const exp = expandQuery(db, cleanForDigest(query))
  const terms = [...new Set([...exp.matched, ...exp.added])].filter(t => t.length >= 2)
  if (!terms.length) return { total: 0, first: null, last: null }
  const like = terms.map(() => 'content LIKE ?').join(' OR ')
  const args = terms.map(t => `%${t}%`)
  const priv = allowsPrivate(o.scene) ? '' : " AND (privacy IS NULL OR privacy != 'private')"
  const row = db.prepare(`SELECT count(*) n, min(ts) first, max(ts) last FROM episodes
    WHERE retracted_at IS NULL AND kind = 'message' AND actor IN ('erica','ai') AND (${like})${priv}`)
    .get(...args) as { n: number; first: string | null; last: string | null }
  return { total: Number(row.n), first: row.first, last: row.last }
}

/** 给他看的一小段：原话（谁说的、哪天、一字不改） */
export function renderQuotes(quotes: Quote[], span?: { total: number; first: string | null }): string {
  if (!quotes.length) return ''
  const lines = ['〔你们的原话（一字不改，从经历表里捞的）：']
  if (span && span.total > quotes.length) {
    lines.push(`这个说法一共出现过 ${span.total} 次${span.first ? `，最早是 ${bjDate(span.first)}` : ''}，下面是最像的几条。`)
  }
  for (const q of quotes) {
    lines.push(`· ${bjStamp(q.ts)}　${q.who}：${q.text}`)
  }
  lines.push('〕')
  return lines.join('\n')
}
