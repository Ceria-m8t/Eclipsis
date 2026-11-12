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
import { expandQuery } from './aliases.ts'
import { cosine, loadVectors } from './embed.ts'

export interface Scored {
  row: MemoryRow
  score: number
  /** 为什么命中（可解释：命中了哪几个片段） */
  hits: string[]
  /** 字面分 / 语义分（分开留着，好看出是哪条腿起的作用） */
  lex?: number
  sem?: number
}

export interface Scorer {
  name: string
  /** 返回 0–1 的相似度 */
  score(query: string, doc: string): { score: number; hits: string[] }
}

/** 二元组：中文不分词，直接切两个字一组 */
export function bigrams(text: string): string[] {
  const out: string[] = []
  // 按标点和空格切段，**只在段内切两字一组**。
  // 跨段拼会造出假片段：「我妈 妈妈」连起来会多出一个「妈妈妈」，
  // 看着像命中，其实两个词之间根本不相邻（2026-11-12 别名展开之后踩到的）。
  for (const seg of String(text || '').split(/[\s\p{P}\p{S}]+/u)) {
    for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2))
  }
  // 英文和数字按词也算一份（型号、端口、账号这类要能命中）
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9_.-]{2,}/g) ?? []) out.push(w)
  return out
}

interface Idf {
  idf: Map<string, number>
  df: Map<string, number>
  n: number
  avgLen: number
}

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
  return { idf, df, n: N, avgLen: total / N || 1 }
}

/**
 * 「特征词」= 在整个库里出现得不算频繁的片段。
 *
 * 2026-11-12 第一次拿真库试跑，问「糯糯今天怎么样」捞回来的是
 * 「48小时暂停按钮」「第21窗 Eclipsis新架构」，命中的是「今天」「怎么」「一天」——
 * 全是出现在半个库里的套话，分数还有 0.69。所以计分**只算特征词**：
 * 出现在超过 12% 的卡里的片段，一分都不给（也不写进 hits，不然「为什么命中」全是废话）。
 */
const COMMON_RATIO = 0.12
/** 库小的时候别按比例掐（5 张卡里出现 1 次就是 20%），所以同时留一个绝对下限 */
const isRare = (g: string, idf: Idf) => (idf.df.get(g) ?? 0) <= Math.max(2, idf.n * COMMON_RATIO)

const K1 = 1.2
const B = 0.6
/** 饱和常数：原始分到这个量级算「挺像」。调大=更挑，调小=更宽 */
const SAT = 2.5
/**
 * 虚词片段一分不给。
 *
 * 2026-11-12 拿真库试跑：问「糯糯今天怎么样」，排第二第三的是
 * 「48小时暂停按钮」「第21窗 Eclipsis新架构」，命中的是「今天」「怎么」「么样」。
 * 它们在 177 张卡里只占 4%–7%，**按 df 掐不掉**（库小而杂），只能按「是不是虚词」掐。
 * 判据：两个字都在虚词表里才算虚词片段 —— 「生日」「吵架」「止痛」「糯糯」都不会被误伤。
 * 实测：问「她是不是有点怕长大」，库里「她不爱过生日」那张**靠「不是」两个字**被捞上来——
 * 分数不高但确实进了候选。虚词命中是字面打分最容易出的假阳性，直接掐掉。
 */
const FUNCTION_CHARS =
  '的了是不在有和就都也很啊呢吧吗嘛呀哦啦我你他她们个这那什么要会能着过被把让给说' +
  '一今天怎样点跟为次还没最近多少时候些哪里对可能应该觉得真当然于与之而且但' +
  '早晚上下前后里外中间次回边种样做'
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
  const hitGrams: string[] = []
  for (const g of q) {
    const f = tf.get(g) ?? 0
    if (!f) continue
    // 套话和全库常见的片段：不计分、不算命中
    if (isFunctionGram(g) || !isRare(g, idf)) continue
    const w = idf.idf.get(g) ?? Math.log(2)
    hitGrams.push(g)
    sum += w * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (len / idf.avgLen))))
  }
  if (!sum) return { score: 0, hits: [] }
  // 把连着命中的二元组拼成人能读的片段。**按段分别拼**，不跨段 ——
  // 别名展开之后查询是「我妈 妈妈 她妈」，跨段拼会拼出「妈妈妈」这种没人说过的词
  const hits: string[] = []
  for (const seg of String(query || '').split(/[\s\p{P}\p{S}]+/u)) {
    let run = ''
    for (let i = 0; i < seg.length - 1; i++) {
      const g = seg.slice(i, i + 2)
      if (hitGrams.includes(g)) run = run ? run + g[1] : g
      else { if (run.length >= 2) hits.push(run); run = '' }
    }
    if (run.length >= 2) hits.push(run)
  }
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
  /** 这一句的向量（有就混合打分；没有就纯字面，绝不等） */
  queryVec?: Float32Array | null
  /** 语义占多少权重，默认 0.45 */
  semWeight?: number
}

/**
 * 候选池：字面打分取前几条。**允许一条都不给**
 * （「聊到才想起，没有相关的就一条不给」——这条规矩比凑满三条重要）。
 */
export function recallCandidates(db: DB, query: string, o: RecallOptions = {}): Scored[] {
  ensureMemorySchema(db)
  // 她说「我妈」，卡里写的是「妈妈」——先把说法展开（aliases.ts），不然一条都搜不到
  const expanded = expandQuery(db, query).text
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

  // 语义那条腿：有查询向量才算（没有就当它不存在，不等、不报错）
  const vecs = o.queryVec ? loadVectors(db, rows.map(r => r.id)) : new Map<number, Float32Array>()
  const useSem = !!o.queryVec
  // bge-m3 中文「短问句 vs 长卡片」的余弦大多落在 0.40–0.75，低于下限算噪声
  const SEM_FLOOR = 0.40
  const SEM_CEIL = 0.75

  const scored: Scored[] = []
  rows.forEach((row, i) => {
    if (skip.has(row.id)) return
    const { score: lex, hits } = bm25(expanded, docs[i], idf)
    let sem = 0
    if (useSem) {
      const v = vecs.get(row.id)
      if (v) {
        const c = cosine(o.queryVec!, v)
        sem = c <= SEM_FLOOR ? 0 : Math.min(1, (c - SEM_FLOOR) / (SEM_CEIL - SEM_FLOOR))
      }
    }
    // **取大的那条腿**，两条都有再加一点。
    // 加权平均试过（0.6 字面 + 0.45 语义）：问「我做指甲那次」时「黑猫美甲」字面 0.75，
    // 被语义 0.29 拖到 0.55，排名反而被「我做」这种套话命中挤掉。两条腿是互补不是投票。
    const score = useSem ? Math.max(lex, sem * 0.95) + (lex > 0.3 && sem > 0.3 ? 0.1 : 0) : lex
    if (score >= floor) scored.push({ row, score, hits, lex, sem })
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
