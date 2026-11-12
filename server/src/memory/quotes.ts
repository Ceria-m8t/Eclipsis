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
  const exp = expandQuery(db, query)
  const words = [...new Set(bigrams(exp.text))].filter(g => g.length >= 2)
  if (!words.length) return []

  const where = ["retracted_at IS NULL", "kind = 'message'", "actor IN ('erica', 'ai')", "content != ''"]
  const args: (string | number)[] = []
  if (o.actor) { where.push('actor = ?'); args.push(o.actor) }
  if (o.since) { where.push('ts >= ?'); args.push(o.since) }
  if (o.until) { where.push('ts <= ?'); args.push(o.until) }
  if (!allowsPrivate(o.scene)) where.push("(privacy IS NULL OR privacy != 'private')")

  const rows = db.prepare(`SELECT seq, ts, actor, content FROM episodes
    WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`)
    .all(...args, Math.min(Math.max(o.scan ?? MAX_SCAN, 50), 20_000)) as unknown as
    { seq: number; ts: string; actor: string; content: string }[]

  // 直接找「原文里出现过的那几个说法」：这比打分更可解释，也更符合她的直觉
  const fromQuery = query.match(/[\u4e00-\u9fa5]{2,}|[A-Za-z0-9_.-]{2,}/g) ?? []
  const terms = [...new Set([...exp.matched, ...exp.added, ...fromQuery])].filter(t => t.length >= 2)
  const out: Quote[] = []
  for (const r of rows) {
    // 他的 <think> 块不算「原话」——那是他想的，不是说出口的。
    // 她看原话是想看「当时谁说了什么」，不是看他的内心活动（2026-11-12）
    const text = cleanForDigest(r.content)
    if (!text) continue
    const hits = terms.filter(t => text.includes(t))
    if (!hits.length) continue
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
  const exp = expandQuery(db, query)
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
    lines.push(`这个说法一共出现过 ${span.total} 次${span.first ? `，最早是 ${span.first.slice(0, 10)}` : ''}，下面是最像的几条。`)
  }
  for (const q of quotes) {
    lines.push(`· ${q.ts.slice(0, 16).replace('T', ' ')}　${q.who}：${q.text}`)
  }
  lines.push('〕')
  return lines.join('\n')
}
