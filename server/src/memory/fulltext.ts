// 细目层第一块：原话的全文索引（2026-11-13）。
//
// 为什么要它：原话检索一直是「取出最近 4000 条，在内存里一条条看」。4000 条大约只有三周，
// 9 月和 10 月的原话**根本搜不到**（她补回最早四天之后，这件事更明显了）。
//
// 做法照 Beam 那份文档：**先分词再索引**。SQLite 自带的 unicode61 把中文按三字一组切，
// 两个字的词（「枇杷」「海鲜」「我妈」）搜不到——而她搜的几乎都是两个字的词。
// 所以索引里存的是**预先切好的两字一组 + 整个的数字/英文词**，查询也走同一套切法。
//
// 诚实边界：
//   - FTS 只负责**把候选找出来**（快），命中算不算真的，由后面「原文里真的有这串字」这一关定。
//     所以不会出现「分词碎片蹭中」那种假命中。
//   - **这一层没有接进召回**。召回那条腿的每个阈值都是在「最近 4000 条」这个池子上标定的
//     （见 17-召回标定表.md），换了池子，df 比例的含义就变了，必须重新标定 + 回放才能动。
//     这一层现在只服务**她自己搜**和时间树里的段内搜。
import type { DB } from '../db.ts'

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS episode_fts USING fts5(tokens, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS memory_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);`

export function ensureFulltextSchema(db: DB): void { db.exec(SCHEMA) }

const getKv = (db: DB, k: string): number | null => {
  const r = db.prepare('SELECT v FROM memory_kv WHERE k = ?').get(k) as { v: string } | undefined
  return r ? Number(r.v) : null
}
const setKv = (db: DB, k: string, v: number) =>
  db.prepare('INSERT INTO memory_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v))

/** 原话：去掉他的念头、时间标记、她消息里的时间前缀。念头只当土壤，不当证据（年轮那条规矩） */
export function cleanQuote(s: string): string {
  return String(s || '')
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g, '')
    .replace(/<current_time>[\s\S]*?<\/current_time>/g, '')
    .replace(/^（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）/, '')
    .trim()
}

/** 去标点空白 */
export const bare = (s: string) => String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '')
/** 只去空白（标点留着） */
const squash = (s: string) => String(s || '').replace(/\s+/gu, '')

/**
 * 「原文里真的有这串字」那一关。
 * ⚠ 不能拿去掉标点的整句去比：「我妈说妈妈很好」去掉标点以后会包含「妈妈妈」这种原文根本没有的串
 * （2026-11-13 拿 LIKE 对账时抓到的，和召回那边「跨段拼出假片段」是同一个坑）。
 * 所以：她打的词里没有标点时，要求**某一段**（按标点空白切出来的段）里连着出现；
 * 带了标点就按「只去空白」比，她自己打的标点算她的要求。
 */
export function contains(text: string, part: string): boolean {
  text = String(text || '').toLowerCase()
  part = String(part || '').toLowerCase()
  const flat = bare(part)
  if (!flat) return false
  if (flat === squash(part).replace(/\s+/g, '')) {
    // 她打的词本身不含标点：只在段内找
    for (const seg of String(text || '').split(/[\s\p{P}\p{S}]+/u)) if (seg.includes(flat)) return true
    return false
  }
  return squash(text).includes(squash(part))
}

/**
 * 切成索引用的 token：段内两字一组 + 整个的数字/英文词。
 * 和召回那边的 `bigrams` 是同一套切法（跨段不拼，免得造出「妈妈妈」这种假片段），
 * 但这里**不去掉日期时间**：她可能就是要搜「10月3日」。
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const seg of String(text || '').split(/[\s\p{P}\p{S}]+/u)) {
    if (!seg) continue
    for (const word of seg.match(/[0-9a-zA-Z._-]{2,}/g) ?? []) out.push(word.toLowerCase())
    for (let i = 0; i < seg.length - 1; i++) {
      const g = seg.slice(i, i + 2)
      if (/^[0-9a-zA-Z._-]{2}$/.test(g)) continue   // 数字/英文的碎片不要，上面已按整词收
      out.push(g)
    }
    if (seg.length === 1 && /[\u4e00-\u9fa5]/.test(seg)) out.push(seg)   // 单个汉字（「嗯」）也留一个
  }
  return out
}

const EP_WHERE = `retracted_at IS NULL AND kind = 'message' AND actor IN ('erica','ai')
  AND scope = 'daily' AND channel IN ('chat','archive') AND content != ''`

/**
 * 把还没索引的原话补进索引。两个水位：hi 往上（新消息）、lo 往下（补回来的旧记录 seq 是负的）。
 * 水位只认**真的索引到了的那一条**，不认「这一批本来想到哪」——否则 batch 用完时中间会留一段永远不补的空洞。
 */
export function syncFulltext(db: DB, o: { batch?: number } = {}): { indexed: number; lo: number | null; hi: number | null } {
  ensureFulltextSchema(db)
  const batch = Math.min(Math.max(o.batch ?? 4000, 1), 50_000)
  const span = db.prepare(`SELECT min(seq) lo, max(seq) hi FROM episodes WHERE ${EP_WHERE}`).get() as { lo: number | null; hi: number | null }
  if (span.lo === null) return { indexed: 0, lo: null, hi: null }
  let lo = getKv(db, 'fts_lo')
  let hi = getKv(db, 'fts_hi')
  const ins = db.prepare('INSERT INTO episode_fts (rowid, tokens) VALUES (?, ?)')
  const del = db.prepare('DELETE FROM episode_fts WHERE rowid = ?')
  let indexed = 0

  /** 索引一批，返回真的处理到的 seq 范围 */
  const run = (sql: string, args: (number | string)[]): { min: number; max: number } | null => {
    const left = batch - indexed
    if (left <= 0) return null
    const rows = db.prepare(`SELECT seq, content FROM episodes WHERE ${EP_WHERE} AND ${sql} LIMIT ?`)
      .all(...args, left) as { seq: number; content: string }[]
    if (!rows.length) return null
    let min = rows[0]!.seq, max = rows[0]!.seq
    for (const r of rows) {
      const text = cleanQuote(r.content)
      del.run(r.seq)
      if (text) ins.run(r.seq, tokenize(text).join(' '))
      indexed++
      if (r.seq < min) min = r.seq
      if (r.seq > max) max = r.seq
    }
    return { min, max }
  }

  if (lo === null || hi === null) {            // 第一次：从最新那条起个头
    const r = run('seq >= ? ORDER BY seq DESC', [span.lo])
    if (!r) return { indexed: 0, lo: null, hi: null }
    lo = r.min; hi = r.max
    setKv(db, 'fts_lo', lo); setKv(db, 'fts_hi', hi)
  }
  if (span.hi! > hi) {                          // 新消息
    const r = run('seq > ? ORDER BY seq', [hi])
    if (r) { hi = r.max; setKv(db, 'fts_hi', hi) }
  }
  if (span.lo < lo) {                            // 更早的（补回来的那批）
    const r = run('seq < ? ORDER BY seq DESC', [lo])
    if (r) { lo = r.min; setKv(db, 'fts_lo', lo) }
  }
  return { indexed, lo, hi }
}

export function fulltextStats(db: DB): { indexed: number; total: number; behind: number; lo: number | null; hi: number | null } {
  ensureFulltextSchema(db)
  const indexed = Number((db.prepare('SELECT count(*) n FROM episode_fts').get() as { n: number }).n)
  const total = Number((db.prepare(`SELECT count(*) n FROM episodes WHERE ${EP_WHERE}`).get() as { n: number }).n)
  const lo = getKv(db, 'fts_lo')
  const hi = getKv(db, 'fts_hi')
  // 还差多少 = 水位之外的那些（水位之内的要么索引了，要么剥掉念头之后是空的，不用再看）
  const behind = lo === null || hi === null ? total
    : Number((db.prepare(`SELECT count(*) n FROM episodes WHERE ${EP_WHERE} AND (seq < ? OR seq > ?)`).get(lo, hi) as { n: number }).n)
  return { indexed, total, behind, lo, hi }
}

export interface Hit { seq: number; ts: string; day: string; who: 'her' | 'him'; text: string }
export interface SearchResult { hits: Hit[]; total: number; exact: boolean; offset: number; next: number | null }

const CAP = 600          // 最多核对这么多候选；超了就说「至少」

/**
 * 全库搜一句原话。FTS 找候选 → 「原文里真的有这串字」核对 → 按时间倒序给。
 * 查询里有空格 = 几个词都要出现（不要求挨着）。
 */
export function searchFulltext(db: DB, query: string, o: { limit?: number; offset?: number; from?: string; to?: string; who?: 'her' | 'him' } = {}): SearchResult {
  ensureFulltextSchema(db)
  const parts = String(query || '').split(/\s+/).map(s => s.trim()).filter(Boolean)
  const needles = parts.filter(p => bare(p))
  if (!needles.length) return { hits: [], total: 0, exact: true, offset: 0, next: null }
  const tokens = [...new Set(parts.flatMap(tokenize))]
  if (!tokens.length) return { hits: [], total: 0, exact: true, offset: 0, next: null }

  // 短的英文/数字（OB、v6、3d）：索引里存的是**整个词**，所以 'ob' 找不到 'mobile' 里的 ob。
  // 这种直接扫一遍（一万多条，几毫秒），保证不漏；其余走 FTS。
  const shortLatin = (p: string) => /^[0-9a-z._-]{1,4}$/i.test(bare(p))
  const useLike = needles.every(shortLatin)
  const where = [EP_WHERE]
  const args: (string | number)[] = []
  if (useLike) for (const n of needles) { where.push('e.content LIKE ?'); args.push(`%${bare(n)}%`) }
  else {
    where.push(`e.seq IN (SELECT rowid FROM episode_fts WHERE episode_fts MATCH ?)`)
    args.push(tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' AND '))
  }
  if (o.from) { where.push('e.ts >= ?'); args.push(new Date(Date.parse(`${o.from}T00:00:00Z`) - 8 * 3600_000).toISOString()) }
  if (o.to) { where.push('e.ts < ?'); args.push(new Date(Date.parse(`${o.to}T00:00:00Z`) - 8 * 3600_000 + 86_400_000).toISOString()) }
  if (o.who) { where.push('e.actor = ?'); args.push(o.who === 'her' ? 'erica' : 'ai') }

  const cand = db.prepare(`SELECT e.seq, e.ts, e.actor, e.content, date(datetime(e.ts, '+8 hours')) day
    FROM episodes e WHERE ${where.join(' AND ')} ORDER BY e.ts DESC, e.seq DESC LIMIT ?`)
    .all(...args, CAP + 1) as { seq: number; ts: string; actor: string; content: string; day: string }[]

  const verified: Hit[] = []
  for (const r of cand.slice(0, CAP)) {
    const text = cleanQuote(r.content)
    if (!needles.every(n => contains(text, n))) continue
    verified.push({ seq: r.seq, ts: r.ts, day: r.day, who: r.actor === 'erica' ? 'her' : 'him', text })
  }
  const limit = Math.min(Math.max(o.limit ?? 30, 1), 100)
  const offset = Math.max(0, o.offset ?? 0)
  const page = verified.slice(offset, offset + limit)
  return {
    hits: page,
    total: verified.length,
    exact: cand.length <= CAP,
    offset,
    next: offset + page.length < verified.length ? offset + page.length : null,
  }
}

/** 一句原话前后各几句（点开某条命中时看上下文） */
export function around(db: DB, seq: number, n = 3): Hit[] {
  const row = db.prepare(`SELECT ts FROM episodes WHERE seq = ?`).get(seq) as { ts: string } | undefined
  if (!row) return []
  const pick = (cmp: string, order: string) => db.prepare(`SELECT seq, ts, actor, content, date(datetime(ts, '+8 hours')) day
    FROM episodes e WHERE ${EP_WHERE} AND ts ${cmp} ? ORDER BY ts ${order}, seq ${order} LIMIT ?`)
    .all(row.ts, n) as { seq: number; ts: string; actor: string; content: string; day: string }[]
  const rows = [...pick('<', 'DESC').reverse(), ...pick('>=', 'ASC')]
  return rows.map(r => ({ seq: r.seq, ts: r.ts, day: r.day, who: r.actor === 'erica' ? 'her' as const : 'him' as const, text: cleanQuote(r.content) }))
    .filter(h => h.text)
}
