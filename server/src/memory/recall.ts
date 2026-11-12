// 召回用的打分（第三期的地基）。
//
// 现在 OB 那边每轮召回都要调一次付费的 bge-m3（siliconflow），231 条向量也是那么来的。
// 这一层把「怎么算像」抽成一个接口，先给一个**不花钱、不联网、零依赖**的本地实现：
//   字符二元组 BM25 + 中文分词无关的字面匹配。223 张暴力算一遍几毫秒。
//
// 为什么先做字面的：它是向量的**下限**而不是替代。
//   - 优点：不花钱、不等网络、可解释（能说清为什么命中），而且对「原话复述」特别准。
//   - 缺点：**换了说法就抓不到**。而她那两张图里最要紧的一句正是
//     「关键词对不上的那句话，往往才是最想被记住的」。
// 所以 Scorer 是可插的：以后挂本地 bge-small（约 95MB，需要装 onnxruntime）或者继续用站上的
// embedding，只要实现同一个接口，召回那一层不用改。混合用法 = 两个分数加权（hybrid）。
import type { DB } from '../db.ts'
import { ensureMemorySchema, type Layer, type MemoryRow } from './schema.ts'
import { allowsPrivate } from './privacy.ts'

export interface Scored {
  row: MemoryRow
  score: number
  /** 为什么命中（可解释：命中了哪几个片段） */
  hits: string[]
}

export interface Scorer {
  name: string
  /** 返回 0–1 的相似度 */
  score(query: string, doc: string): { score: number; hits: string[] }
}

/** 二元组：中文不分词，直接切两个字一组 */
export function bigrams(text: string): string[] {
  const t = String(text || '').replace(/[\s\p{P}\p{S}]+/gu, '')
  const out: string[] = []
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2))
  // 英文和数字按词也算一份（型号、端口、账号这类要能命中）
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9_.-]{2,}/g) ?? []) out.push(w)
  return out
}

interface Idf { idf: Map<string, number>; avgLen: number }

function buildIdf(docs: string[]): Idf {
  const df = new Map<string, number>()
  let total = 0
  for (const d of docs) {
    const grams = new Set(bigrams(d))
    total += grams.size
    for (const g of grams) df.set(g, (df.get(g) ?? 0) + 1)
  }
  const N = Math.max(docs.length, 1)
  const idf = new Map<string, number>()
  for (const [g, n] of df) idf.set(g, Math.log(1 + (N - n + 0.5) / (n + 0.5)))
  return { idf, avgLen: total / N || 1 }
}

const K1 = 1.2
const B = 0.6
/** 饱和常数：原始分到这个量级算「挺像」。调大=更挑，调小=更宽 */
const SAT = 2.5
/**
 * 全是虚词的命中不算命中。
 * 实测：问「她是不是有点怕长大」，库里「她不爱过生日」那张**靠「不是」两个字**被捞上来——
 * 分数不高但确实进了候选。虚词命中是字面打分最容易出的假阳性，直接掐掉。
 */
const FUNCTION_CHARS = '的了是不在有和就都也很啊呢吧吗我你他她们个这那什么要会能着过被把让给说'
const isFunctionGram = (g: string) => g.length === 2 && [...g].every(c => FUNCTION_CHARS.includes(c))

/** BM25（字符二元组版）。分数压到 0–1，好和别的打分加权 */
export function bm25(query: string, doc: string, idf: Idf): { score: number; hits: string[] } {
  const q = [...new Set(bigrams(query))]
  if (!q.length) return { score: 0, hits: [] }
  const docGrams = bigrams(doc)
  const len = docGrams.length || 1
  const tf = new Map<string, number>()
  for (const g of docGrams) tf.set(g, (tf.get(g) ?? 0) + 1)

  let sum = 0
  let solid = 0          // 实词命中的分数（虚词不算）
  const hitGrams: string[] = []
  for (const g of q) {
    const w = idf.idf.get(g) ?? Math.log(2)
    const f = tf.get(g) ?? 0
    if (!f) continue
    hitGrams.push(g)
    const add = w * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (len / idf.avgLen))))
    sum += add
    if (!isFunctionGram(g)) solid += add
  }
  if (!solid) return { score: 0, hits: [] }      // 只靠虚词命中的，不算命中
  // 把连着命中的二元组拼成人能读的片段
  const hits: string[] = []
  let run = ''
  for (const g of bigrams(query)) {
    if (hitGrams.includes(g)) run = run ? run + g[g.length - 1] : g
    else if (run) { if (run.length >= 2) hits.push(run); run = '' }
  }
  if (run.length >= 2) hits.push(run)
  // 饱和归一（不按问句长度分母）：一句长问话里只要有一小段真的命中，分数就不该被稀释掉。
  // 「晚饭点个海鲜大餐好不好」里有用的只有「海鲜」两个字，但那两个字就是全部意义所在。
  return { score: sum / (sum + SAT), hits: [...new Set(hits)].slice(0, 5) }
}

export interface RecallOptions {
  layer?: Layer
  subject?: string
  /** 候选上限，不凑数 */
  limit?: number
  /** 低于这个分不要（绝对门槛） */
  floor?: number
  /** 比最高分差这么多倍以下的不要（相对门槛，默认 0.45） */
  relFloor?: number
  /** 刚给过的不重复给（第三期的冷却） */
  exclude?: number[]
  /** 只看这个时间之后的 */
  since?: string
  /** 哪个场景要召回。group / leto 这些**一律拿不到私密的那些** */
  scene?: string
}

/**
 * 候选池：字面打分取前几条。**允许一条都不给**
 * （「聊到才想起，没有相关的就一条不给」——这条规矩比凑满三条重要）。
 */
export function recallCandidates(db: DB, query: string, o: RecallOptions = {}): Scored[] {
  ensureMemorySchema(db)
  const where = ['retracted_at IS NULL', 'dont_surface = 0', 'needs_review = 0']
  const args: (string | number)[] = []
  if (o.layer) { where.push('layer = ?'); args.push(o.layer) }
  if (o.subject) { where.push('subject = ?'); args.push(o.subject) }
  if (o.since) { where.push('created_at >= ?'); args.push(o.since) }
  if (!allowsPrivate(o.scene)) where.push("(privacy IS NULL OR privacy != 'private')")
  const rows = db.prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')}`).all(...args) as unknown as MemoryRow[]
  if (!rows.length) return []

  const skip = new Set(o.exclude ?? [])
  const docs = rows.map(r => `${r.title}\n${r.fact_body}\n${(() => { try { return JSON.parse(r.tags).join(' ') } catch { return '' } })()}`)
  const idf = buildIdf(docs)
  const floor = o.floor ?? 0.12

  const scored: Scored[] = []
  rows.forEach((row, i) => {
    if (skip.has(row.id)) return
    const { score, hits } = bm25(query, docs[i], idf)
    if (score >= floor) scored.push({ row, score, hits })
  })
  scored.sort((a, b) => b.score - a.score || b.row.created_at.localeCompare(a.row.created_at))
  // 相对门槛：比最高分差太远的不算候选（一句话里总有几张卡沾到一两个字）
  const top = scored[0]?.score ?? 0
  const kept = scored.filter(x => x.score >= top * (o.relFloor ?? 0.45))
  return kept.slice(0, Math.min(Math.max(o.limit ?? 20, 1), 50))
}

/** 本地字面打分器（当前默认）。以后要换 bge 就再写一个同形状的 */
export const lexicalScorer: Scorer = {
  name: 'lexical-bm25-bigram',
  score(query, doc) {
    const idf = buildIdf([doc])
    return bm25(query, doc, idf)
  },
}
