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
import { cleanForDigest } from './digest.ts'

export interface Scored {
  row: MemoryRow
  score: number
  /** 为什么命中（可解释：命中了哪几个片段） */
  hits: string[]
  /** 字面分 / 语义分（分开留着，好看出是哪条腿起的作用） */
  lex?: number
  sem?: number
  /** 字面的原始分（未归一）。绝对门槛挂在这上面——归一之后 0.5 分到处都是，挂不住 */
  lexRaw?: number
  /** 反回声扣了多少分（刚给过他的） */
  echoPenalty?: number
  /** 命中的实词片段里最罕见的那个出现在几张卡里（判官要用） */
  rareDf?: number
}

export interface Scorer {
  name: string
  /** 返回 0–1 的相似度 */
  score(query: string, doc: string): { score: number; hits: string[] }
}

/** 二元组：中文不分词，直接切两个字一组 */
export function bigrams(text: string): string[] {
  const out: string[] = []
  // 日期和时间整串去掉：它们的碎片（026 / 11 / 48）在任何库里都"稀有"，却什么都不说明
  text = String(text || '')
    .replace(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/g, ' ')
    .replace(/\d{1,2}[:：]\d{2}(?:[:：]\d{2})?/g, ' ')
  // 按标点和空格切段，**只在段内切两字一组**。
  // 跨段拼会造出假片段：「我妈 妈妈」连起来会多出一个「妈妈妈」，
  // 看着像命中，其实两个词之间根本不相邻（2026-11-12 别名展开之后踩到的）。
  for (const seg of String(text || '').split(/[\s\p{P}\p{S}]+/u)) {
    for (let i = 0; i < seg.length - 1; i++) {
      const g = seg.slice(i, i + 2)
      // 数字/英文的两字片段不算：18110 会被下面按整词收，而「18」「81」「02」「26」
      // 这些只是数字串切出来的碎片（她消息里的时间前缀就是这么乱命中的）
      if (/^[0-9a-zA-Z._-]{2}$/.test(g)) continue
      out.push(g)
    }
  }
  // 英文和数字按词也算一份（型号、端口、账号这类要能命中）。
  // **纯数字要 4 位以上**：18110（端口）有用，「026」「48」这种日期碎片只会乱命中。
  for (const w of String(text || '').toLowerCase().match(/[a-z0-9_.-]{2,}/g) ?? []) {
    if (/^[\d.]+$/.test(w) && w.replace(/\D/g, '').length < 4) continue
    out.push(w)
  }
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
/**
 * 这几个数是**拿她的真实数据标定的**，不是拍脑袋（抄 WrenWen 的规矩：
 * 「孤立的数没有来历，只会被下一个人顺手调掉」）。
 * 标定脚本只读、零外呼（查询向量走缓存），随时能重跑：/tmp/cal2.mjs、/tmp/cal3.mjs。
 *
 * 2026-11-12，40 条她真说过的话 × 202 张卡 = 2000 个字面候选 / 8080 个向量对：
 *   字面原始分：p25=2.54 p50=3.68 p75=5.04 p90=7.56 max=21.8
 *   **「凑数」长什么样**（只命中两个字的那些）：p50=2.83、p90=4.41
 *     → 字面门槛压在它上面：8（约等于凑数的两倍），放行 8.8% 的候选、4.4 条/查询
 *   bge-m3 余弦（随机对）：p50=0.440 p90=0.509 **p99=0.563**
 *   每条查询最像的那张：p10=0.539 p50=0.575 p90=0.643 max=0.664
 *     → 语义准入线 0.55（随机对的 p99），放行 1.7%、3.4 张/查询；上限按 max 取 0.66
 *   注意：原来写的 SEM_FLOOR=0.40 **比随机对的中位数还低**，等于谁都算「意思接近」。
 */
/**
 * 字面「达标」不是一个分数门槛，是一条准入规则（抄 WrenWen §3.2）。
 *
 * 为什么不用分数：BM25 的原始分跟着 idf 走，idf 跟着库的大小走
 * （202 张卡时最稀有的片段值约 4.9 分，5 张卡时只值 1.4 分）。标定出来的「8」
 * 在她的库里是对的，换个库就全错——这正是 WrenWen 那句「给一条判据划射程时，
 * 先看它的量纲在每条路上是不是同一个意思」。
 *
 * 规则（和库大小无关）：
 *   - 查询很短（≤2 个实词片段）：命中 1 个就算（她就问「海鲜」的时候，那两个字就是全部）
 *   - 查询长一些：要么命中 ≥2 个片段，要么有一个 ≥3 字的连续片段，要么标题里命中
 * 「凑数」正好被这条挡住：长问句里偶然撞上一个两字片段，不算数。
 */
export function lexAdmitted(r: Bm25Result, queryTokens: number, titleHit: boolean, total = 200): boolean {
  if (!r.hitCount) return false
  // 短问句：命中一个就算（她就问「海鲜」的时候，那两个字就是全部）
  if (queryTokens <= 2) return true
  // 长问句：**要命中四成**（抄 WrenWen §3.2 的 max(2, ceil(40%))）。
  // 2026-11-12 她看完回放说「太杂」：之前只要命中 2 个片段就算数，于是
  // 「我说我妈不在家，她问我成年了没…」这种长句靠「她问我」「回来」也能把卡捞上来。
  // 四成这条一上，长句必须真的对上话题才给。
  // 2026-11-12 她看完第二轮回放说「还有一点点杂」→ 四成提到五成
  const need = Math.max(2, Math.ceil(queryTokens * 0.5))
  if (r.hitCount >= need) return true
  // 例外一：命中的那个词特别罕见（整库只有一两张卡提过）。
  //   「晚饭点个海鲜大餐好不好」里只有「海鲜」对得上，但「海鲜」在 177 张卡里只出现过一两次，
  //   那一个词就是全部意义所在；而「我想」「回来」这种到处都有的词永远过不了这一关。
  if (r.rarestContentDf <= rareEnough(total)) return true
  // 例外二：标题/标签命中 + 正文里还命中两个（他们那条「锚命中 + 正文 2 词」）
  return titleHit && r.hitCount >= 2
}

/**
 * 「特别罕见」= 整库里最多这么多张卡提过。
 * 2026-11-12 第一版取 1%（177 张库 → 2 张），她说还是有点杂：
 * 「体面」「生物」这种 2 张卡提过的词也靠这条例外进来了。收到 0.5%（→ 1 张）。
 */
export const rareEnough = (n: number) => Math.max(1, Math.floor(n * 0.005))
export const SEM_ADMIT = 0.55
export const SEM_CEIL = 0.66

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
/**
 * 词级停用表。直接抄 WrenWen §5.2 那张「弱召回词」表（他们的原话：命中了也不算数），
 * 加上回放时真的看见的几个（「才能」「一段」「不清」这种）。
 */
const STOP_TERMS = new Set([
  '我们', '你们', '这个', '那个', '就是', '还是', '已经', '现在', '继续', '好的', '可以',
  '为什么', '怎么办', '什么', '没有', '一个', '不是', '知道', '感觉', '然后', '但是', '因为', '所以',
  '才能', '一段', '不清', '起来', '出来', '过来', '时候', '事情', '东西', '地方', '问题', '觉得',
  // 2026-11-12 她看完回放说「东西有点太杂了，我说不清楚这个清楚都能命中」——
  // 下面这批就是回放里真的在乱命中的：它们在她的库里到处都是，命中了什么也说明不了
  '清楚', '明白', '其实', '这样', '那样', '一样', '需要', '开始', '真的', '有点', '比较',
  '一直', '还有', '自己', '很多', '所有', '之类', '大概', '差不', '好像', '应该', '可是',
  // 称呼和口头语：按出现频率掐不掉（「老公」在 177 张卡里只占 4.5%，不算常见），
  // 但它们是称呼不是话题 —— 她说「老公。」时捞出三张提到老公的卡，纯噪声。
  '老公', '老婆', '宝宝', '亲爱', '个人', '世界', '任何', '家庭', '一点', '一些', '一下',
  '这边', '那边', '这种', '那种', '怎样', '那些', '这些',
])
/** 助词：带助词的两字片段基本是跨词碎片（「的记」「了的」），不算特征 */
const PARTICLES = '的了着过地得'

/** 这个词是不是「弱召回词」（命中了也不算数）。原话层也用它 */
export function isWeakTerm(t: string): boolean {
  const w = String(t || '')
  if (w.length < 2) return true
  if (STOP_TERMS.has(w)) return true
  const soft = [...w].filter(c => FUNCTION_CHARS.includes(c) || PARTICLES.includes(c)).length
  // 整串都是虚词，或者虚词占了大半 —— 「我说不清」四个字里三个是虚词、「才能睡」三个字里两个，
  // 它们在原话层捞回来的是「她以前也说过类似的话」，不是记忆（2026-11-12 她指出来的）
  if (soft === w.length) return true
  if (w.length === 3 && soft >= 2) return true
  if (w.length >= 4 && soft / w.length >= 0.7) return true
  return false
}

/**
 * 「实词片段」：一个虚词、代词、助词都不带。
 * 2026-11-12 回放看明白的：垃圾命中全是「我现」「每一」「我停」「我再」「我冷」这类
 * 带人称代词的碎片，而且它们的语义分一律是 0；真正的好命中靠的是「分身」「工作」「冷落」
 * 「没睡」「记忆系统」这种实词。所以「单个罕见词也算达标」那条例外只对实词开。
 */
const isContentGram = (g: string) =>
  g.length >= 2 && ![...g].some(c => FUNCTION_CHARS.includes(c) || PARTICLES.includes(c))

const isFunctionGram = (g: string) =>
  g.length === 2 && (
    STOP_TERMS.has(g) ||
    [...g].some(c => PARTICLES.includes(c)) ||
    [...g].every(c => FUNCTION_CHARS.includes(c))
  )

/** BM25（字符二元组版）。分数压到 0–1，好和别的打分加权 */
export interface Bm25Result {
  score: number
  raw: number
  hits: string[]
  /** 命中了几个片段、最长的那个多少字（准入规则要用） */
  hitCount: number
  longest: number
  /** 命中的片段里最罕见的那个出现在几张卡里（越小越特别） */
  rarestDf: number
  /** 同上，但只算**实词片段**（不含代词虚词的那种）。单词命中的例外挂在这上面 */
  rarestContentDf: number
}

export function bm25(query: string, doc: string, idf: Idf, opts: { allowCommon?: boolean } = {}): Bm25Result {
  const q = [...new Set(bigrams(query))]
  if (!q.length) return { score: 0, raw: 0, hits: [], hitCount: 0, longest: 0, rarestDf: Infinity, rarestContentDf: Infinity }
  const docGrams = bigrams(doc)
  const len = docGrams.length || 1
  const tf = new Map<string, number>()
  for (const g of docGrams) tf.set(g, (tf.get(g) ?? 0) + 1)

  let sum = 0
  const hitGrams: string[] = []
  for (const g of q) {
    const f = tf.get(g) ?? 0
    if (!f) continue
    // 套话和全库常见的片段：不计分、不算命中。
    // 例外（allowCommon）：这一句里**一个稀有片段都没有**时，常见的就是她能给的全部线索，
    // 那就按它排——不然「她问的词正好在半个库里出现过」会变成一条都搜不到。
    if (isFunctionGram(g)) continue
    if (!opts.allowCommon && !isRare(g, idf)) continue
    const w = idf.idf.get(g) ?? Math.log(2)
    hitGrams.push(g)
    sum += w * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (len / idf.avgLen))))
  }
  if (!sum) return { score: 0, raw: 0, hits: [], hitCount: 0, longest: 0, rarestDf: Infinity, rarestContentDf: Infinity }
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
  const uniq = [...new Set(hits)]
  return {
    score: sum / (sum + SAT), raw: sum, hits: uniq.slice(0, 5),
    hitCount: uniq.length, longest: uniq.reduce((n, h) => Math.max(n, h.length), 0),
    rarestDf: hitGrams.reduce((n, g) => Math.min(n, idf.df.get(g) ?? Infinity), Infinity),
    rarestContentDf: hitGrams
      .filter(isContentGram)
      .reduce((n, g) => Math.min(n, idf.df.get(g) ?? Infinity), Infinity),
  }
}

/**
 * 上一次候选池筛掉了多少、为什么筛掉。
 * WrenWen 的那句教训：「饿死是静默的」——凡是多方抢一个预算的地方，
 * 输家为什么输必须记下来，不然你永远不知道有一整类记忆从来没被模型看见过。
 */
export let lastSuppressed: Record<string, number> = {}

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
  /** 跳过字面准入规则（标定脚本用） */
  skipAdmission?: boolean
  /** 关掉反回声（标定脚本要关，不然分数会被历史影响） */
  antiEcho?: boolean
}

/**
 * 候选池：字面打分取前几条。**允许一条都不给**
 * （「聊到才想起，没有相关的就一条不给」——这条规矩比凑满三条重要）。
 */
export function recallCandidates(db: DB, query: string, o: RecallOptions = {}): Scored[] {
  ensureMemorySchema(db)
  // 先洗掉时间前缀（她的消息带着「（2026-11-12 10:48）」），再把说法展开
  const clean = cleanForDigest(query)
  const expanded = expandQuery(db, clean).text
  const where = ['retracted_at IS NULL', 'dont_surface = 0', 'needs_review = 0']
  const args: (string | number)[] = []
  if (o.layer) { where.push('layer = ?'); args.push(o.layer) }
  if (o.subject) { where.push('subject = ?'); args.push(o.subject) }
  if (o.since) { where.push('created_at >= ?'); args.push(o.since) }
  if (!allowsPrivate(o.scene)) where.push("(privacy IS NULL OR privacy != 'private')")
  const rows = db.prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')}`).all(...args) as unknown as MemoryRow[]
  if (!rows.length) return []

  const skip = new Set(o.exclude ?? [])
  // 反回声（抄 WrenWen 的 antiEcho）：刚递过的扣分，但分够高还是能回来——
  // 她连着追问同一件事时它应该回来，只是不许天然霸榜。
  const echo = new Map<number, number>()
  if (o.antiEcho !== false) {
    try {
      const rows2 = db.prepare(`SELECT memory_id, max(created_at) at FROM memory_deliveries
        WHERE created_at >= ? GROUP BY memory_id`)
        .all(new Date(Date.now() - 72 * 3600_000).toISOString()) as unknown as { memory_id: number; at: string }[]
      const now = Date.now()
      for (const r of rows2) {
        const hours = (now - new Date(r.at).getTime()) / 3600_000
        echo.set(r.memory_id, hours <= 24 ? 0.18 : 0.09)
      }
    } catch { /* 还没有回执表就当没有 */ }
  }
  const docs = rows.map(r => `${r.title}\n${r.fact_body}\n${(() => { try { return JSON.parse(r.tags).join(' ') } catch { return '' } })()}`)
  const idf = buildIdf(docs)
  const floor = o.floor ?? 0.12
  // 查询里有几个「实词片段」（虚词和全库常见的都不算）——准入规则按它分档
  const grams = [...new Set(bigrams(expanded))].filter(g => !isFunctionGram(g))
  const rareTokens = grams.filter(g => isRare(g, idf)).length
  const allowCommon = rareTokens === 0 && grams.length > 0
  const queryTokens = rareTokens || grams.length

  // 语义那条腿：有查询向量才算（没有就当它不存在，不等、不报错）
  const vecs = o.queryVec ? loadVectors(db, rows.map(r => r.id)) : new Map<number, Float32Array>()
  const useSem = !!o.queryVec

  const scored: Scored[] = []
  const suppressed = { 没过门槛: 0, 刚给过: 0, 排除: 0 }
  rows.forEach((row, i) => {
    if (skip.has(row.id)) { suppressed.排除++; return }
    const res = bm25(expanded, docs[i], idf, { allowCommon })
    const { score: lex, raw: lexRaw, hits } = res
    let sem = 0
    if (useSem) {
      const v = vecs.get(row.id)
      if (v) {
        const c = cosine(o.queryVec!, v)
        sem = c <= SEM_ADMIT ? 0 : Math.min(1, (c - SEM_ADMIT) / (SEM_CEIL - SEM_ADMIT))
      }
    }
    // **绝对门槛，两条通道各一条**（门槛制，不是配额制）：
    //   字面要过标定出来的原始分门槛；语义要过准入线。两条都没过就不是候选，
    //   宁可这一轮零条——「错的不如空着」。
    const titleHit = hits.some(h => row.title.includes(h))
    const lexOk = o.skipAdmission ? res.hitCount > 0 : lexAdmitted(res, queryTokens, titleHit, idf.n)
    const semOk = sem > 0
    if (!lexOk && !semOk) { suppressed.没过门槛++; return }

    // **取大的那条腿**，两条都有再加一点。
    // 加权平均试过（0.6 字面 + 0.45 语义）：问「我做指甲那次」时「黑猫美甲」字面 0.75，
    // 被语义 0.29 拖到 0.55，排名反而被「我做」这种套话命中挤掉。两条腿是互补不是投票。
    const base = useSem ? Math.max(lex, sem * 0.95) + (lex > 0.3 && sem > 0.3 ? 0.1 : 0) : lex
    const penalty = echo.get(row.id) ?? 0
    if (penalty) suppressed.刚给过++
    const score = Math.max(0, base - penalty)
    if (score >= floor) {
      scored.push({
        row, score, hits, lex, sem, lexRaw, echoPenalty: penalty || undefined,
        rareDf: Number.isFinite(res.rarestContentDf) ? res.rarestContentDf : undefined,
      })
    }
  })
  scored.sort((a, b) => b.score - a.score || b.row.created_at.localeCompare(a.row.created_at))
  // 相对门槛：比最高分差太远的不算候选（一句话里总有几张卡沾到一两个字）
  const top = scored[0]?.score ?? 0
  const kept = scored.filter(x => x.score >= top * (o.relFloor ?? 0.45))
  lastSuppressed = suppressed
  return kept.slice(0, Math.min(Math.max(o.limit ?? 20, 1), 50))
}

/** 本地字面打分器。以后要换别的打分方式就再写一个同形状的 */
export const lexicalScorer: Scorer = {
  name: 'lexical-bm25-bigram',
  score(query, doc) {
    const idf = buildIdf([doc])
    return bm25(query, doc, idf)
  },
}
