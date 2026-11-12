// 召回 → 判官 → 纸条（第三期）。**默认影子运行：算出来只记录，不进请求。**
//
// 白皮书那句照抄：开发完成不等于自动启用。所以 MEMORY_RECALL 三档：
//   off（不算）/ shadow（算出来记进 memory_deliveries，不给他看）/ live（真的拼进 system 末尾）
//
// 三道关，次序是故意的：
//   1. 候选池（recall.ts 的字面打分，不花钱）—— 只负责「找出来」。
//   2. **判官** —— 只负责「递不递」。recall-secretary 的第 1 条规矩：
//      搜索会把同名的人、相邻的事都塞进来；**拿不准就不递**。
//      这一期的判官是确定性规则（主体冲突、时间冲突、拿不准标记），不调模型：
//      先把能用规则判死的挡掉，剩下的模糊地带等第四期再上模型判官。
//   3. 纸条（renderRecallNote）—— 开头写明身份：
//      **旧记忆只作证据，不作处方；跟她此刻说的有出入，以此刻为准。**
//      这一句是她那个「召回认错人」担心的最后一道保险：就算真捞错了，他也不会拿旧记录反驳她。
import type { DB } from '../db.ts'
import { ensureMemorySchema, type MemoryRow } from './schema.ts'
import { recallCandidates, type Scored } from './recall.ts'
import { PEOPLE_SEEDS } from './classify.ts'
import { labelWithPeople } from './write.ts'
import { listRelationsOf } from './relations.ts'
import { searchQuotes, quoteSpan, renderQuotes, type Quote } from './quotes.ts'
import { expandQuery } from './aliases.ts'
import { embedConfig, apiEmbedder, queryVector, vectorStats } from './embed.ts'

export type RecallMode = 'off' | 'shadow' | 'live'

export function recallMode(env: NodeJS.ProcessEnv = process.env): RecallMode {
  const v = String(env.MEMORY_RECALL ?? 'shadow').toLowerCase()
  return v === 'off' || v === 'live' ? v : 'shadow'
}

export interface Verdict {
  ok: boolean
  why: string
}

/** 她这一轮提到了谁（按人物卡的别名认，「我妈」也认得出） */
export function mentionedPeople(query: string): string[] {
  const out: string[] = []
  for (const p of PEOPLE_SEEDS) {
    if (p.aliases.some(a => query.includes(a))) out.push(`person:${p.slug}`)
  }
  return out
}

const TIME_WORDS = /(今天|今晚|刚刚|刚才|这几天|最近)/

/**
 * 判官。只负责「递不递」，不改内容。
 * 这一期全是确定性规则 —— 能用规则判死的先挡掉，模糊地带宁可不递。
 */
export function judge(cand: Scored, query: string, now: Date = new Date()): Verdict {
  const row = cand.row
  const people = mentionedPeople(query)

  // 1. 主体冲突：她在说某个人，这张卡是另一个人的事 → 不递
  //    这就是她最怕的那个错（「朋友的电脑」被说成「她的电脑」）
  if (people.length && row.subject.startsWith('person:') && !people.includes(row.subject)) {
    return { ok: false, why: `她在说${people.map(p => p.slice(7)).join('、')}，这条是${row.subject.slice(7)}的事` }
  }
  if (people.length && row.subject === 'erica' && cand.score < 0.3) {
    return { ok: false, why: `她在说别人，这条是她自己的事，而且只是字面有点像（${cand.score.toFixed(2)}）` }
  }

  // 2. 近况层过期：state 层超过 14 天就别拿出来当「现在」
  if (row.layer === 'state') {
    const days = (now.getTime() - new Date(row.created_at).getTime()) / 86400_000
    if (days > 14) return { ok: false, why: `这是 ${Math.round(days)} 天前的近况，早该沉下去了` }
    if (TIME_WORDS.test(query) && days > 3) return { ok: false, why: '她问的是这几天，这条已经过去好几天了' }
  }

  // 3. 事实已失效
  if (row.valid_until && new Date(row.valid_until).getTime() < now.getTime()) {
    return { ok: false, why: '这条事实已经被推翻了（只该给当前有效的那条）' }
  }

  // 4. 说不清为什么相关的不递。
  //    字面命中要有两个字以上；一个字都没命中时，只认**语义分够高**的那种
  //    （换了说法的那类问话靠的就是这条，但门槛要高，不然等于随便给）。
  const solid = cand.hits.join('').replace(/\s/g, '')
  const sem = cand.sem ?? 0
  if (solid.length < 2 && sem < 0.5) return { ok: false, why: '只是零星几个字像，说不清为什么相关' }

  const why = cand.hits.length
    ? `命中「${cand.hits.join('」「')}」${sem >= 0.5 ? '，意思也接近' : ''}`
    : `字面对不上，但意思接近（${sem.toFixed(2)}）`
  return { ok: true, why }
}

export interface AxisRow {
  id: number
  date: string
  title: string
  line: string
}

/**
 * 事件轴速览表（抄「时间长河」那张图的轴卷/速览）。
 * 它说得对：「会话记录向量召回太碎，整个事件的时间跨度无法关联」。
 * 所以召回命中一张卡时，**先给这件事的时间速览表**（时间｜事件｜一句话），再按需下钻原话。
 *
 * 这一期的轴是用现成的东西拼的：同一条话题线（thread）+ same_event/follows 连着的那些，按时间排。
 */
export function buildAxis(db: DB, memoryId: number, limit = 6): AxisRow[] {
  ensureMemorySchema(db)
  const seed = db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) as unknown as MemoryRow | undefined
  if (!seed) return []
  const ids = new Set<number>([seed.id])

  // 同一条话题线
  if (seed.thread) {
    for (const r of db.prepare(`SELECT id FROM memories WHERE thread = ? AND retracted_at IS NULL`)
      .all(seed.thread) as unknown as { id: number }[]) ids.add(r.id)
  }
  // 顺着「同一件事 / 后来怎样了」走一步（只走一步：走远了就不是同一件事了）
  for (const rel of listRelationsOf(db, seed.id)) {
    if (rel.kind === 'same_event' || rel.kind === 'follows') ids.add(rel.other!.id)
  }
  if (ids.size < 2) return []

  const rows = db.prepare(`SELECT id, title, fact_body, created_at FROM memories
    WHERE id IN (${[...ids].map(() => '?').join(',')}) AND retracted_at IS NULL ORDER BY created_at`)
    .all(...ids) as unknown as { id: number; title: string; fact_body: string; created_at: string }[]
  return rows.slice(0, limit).map(r => ({
    id: r.id,
    date: r.created_at.slice(0, 10),
    title: r.title,
    line: firstSentence(r.fact_body),
  }))
}

function firstSentence(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  const m = /^(.{0,60}?[。！？])/.exec(t)
  return (m ? m[1] : t.slice(0, 60)) || ''
}

export interface Picked {
  row: MemoryRow
  score: number
  /** 字面分 / 语义分分开留着，好看出是哪条腿起的作用 */
  lex?: number
  sem?: number
  hits: string[]
  why: string
  axis: AxisRow[]
}

export interface RecallResult {
  query: string
  /** 语义这一层用上了没有、花了多久（她最怕的是「时间太长」） */
  semantic: { used: boolean; cached: boolean; ms: number; why?: string }
  /** 展开后的说法（「我妈」→ 也搜「妈妈」「她妈」） */
  expanded: string[]
  candidates: number
  picked: Picked[]
  rejected: { id: number; title: string; why: string }[]
  /** 原话（经历表里一字不改的那几句）。卡片给判断，原话给质感 */
  quotes: Quote[]
  quoteSpan: { total: number; first: string | null; last: string | null }
  note: string
}

export interface RecallOpts {
  scene?: string
  /** 这一句的向量（异步算好再传进来；runRecall 本身是同步的，绝不等网络） */
  queryVec?: Float32Array | null
  limit?: number          // 最多递几条，默认 3
  exclude?: number[]      // 冷却：刚给过的不重复给
  now?: Date
}

/** 她这一轮说的话 → 该想起哪几条。允许一条都不给 */
export function runRecall(db: DB, query: string, o: RecallOpts = {}): RecallResult {
  ensureMemorySchema(db)
  const now = o.now ?? new Date()
  const q = String(query || '').trim()
  const exp = expandQuery(db, q)
  const out: RecallResult = {
    query: q.slice(0, 200), expanded: exp.added, semantic: { used: false, cached: false, ms: 0 },
    candidates: 0, picked: [], rejected: [],
    quotes: [], quoteSpan: { total: 0, first: null, last: null }, note: '',
  }
  if (q.replace(/\s/g, '').length < 2) return out

  const cands = recallCandidates(db, q, { scene: o.scene, exclude: o.exclude, limit: 20, queryVec: o.queryVec ?? null })
  out.candidates = cands.length
  const max = Math.min(Math.max(o.limit ?? 3, 1), 5)

  for (const c of cands) {
    if (out.picked.length >= max) break
    const v = judge(c, q, now)
    if (!v.ok) { out.rejected.push({ id: c.row.id, title: c.row.title, why: v.why }); continue }
    out.picked.push({
      row: c.row, score: c.score, lex: c.lex, sem: c.sem,
      hits: c.hits, why: v.why, axis: buildAxis(db, c.row.id),
    })
  }
  // 原话那一层（第二条腿）：卡片不完备，原话完备。MEMORY_RECALL_QUOTES=0 关
  if (process.env.MEMORY_RECALL_QUOTES !== '0') {
    try {
      out.quotes = searchQuotes(db, q, { scene: o.scene, limit: Number(process.env.MEMORY_RECALL_QUOTES_MAX) || 3 })
      if (out.quotes.length) out.quoteSpan = quoteSpan(db, q, { scene: o.scene })
    } catch { /* 搜不了就只给卡片 */ }
  }
  out.note = [renderRecallNote(db, out.picked), renderQuotes(out.quotes, out.quoteSpan)].filter(Boolean).join('\n\n')
  return out
}

const NOTE_HEAD = [
  '〔想起来的几件事（系统从你的记忆库里捞的，不是她说的）：',
  '旧记忆只作**证据**，不作**处方**。摘要不是原话；跟她此刻说的有出入，**以此刻为准**。',
].join('\n')

/**
 * 纸条。情绪那一栏只在**他自己写的**那条上给
 * （voice='machine' 的是整理程序的语气，给他看他会照着长，见 schema.ts 的 voice）。
 */
export function renderRecallNote(db: DB, picked: Picked[]): string {
  if (!picked.length) return ''
  const parts: string[] = [NOTE_HEAD, '']
  for (const p of picked) {
    const r = p.row
    parts.push(`· ${r.created_at.slice(0, 10)}｜${labelWithPeople(db, r.subject)}｜${r.title}`)
    parts.push(`  ${firstSentence(r.fact_body)}`)
    if (r.feeling && r.voice === 'him') parts.push(`  当时：${firstSentence(r.feeling)}`)
    if (r.why) parts.push(`  当时记它是因为：${r.why}`)
    if (p.axis.length >= 2) {
      parts.push(`  这件事浮现过 ${p.axis.length} 次：`)
      for (const a of p.axis) parts.push(`    ${a.date}　${a.title}`)
    }
  }
  parts.push('〕')
  return parts.join('\n')
}

// ── 三态回执 ──

export function recordDeliveries(
  db: DB,
  picked: Picked[],
  o: { turn?: string | null; scene?: string; mode: RecallMode; query: string },
  now: Date = new Date()
): number {
  if (!picked.length) return 0
  ensureMemorySchema(db)
  const ins = db.prepare(`INSERT INTO memory_deliveries (memory_id, turn, scene, mode, state, score, hits, query, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const state = o.mode === 'live' ? 'delivered' : 'asked'
  let n = 0
  for (const p of picked) {
    ins.run(p.row.id, o.turn ?? null, o.scene ?? 'chat', o.mode, state, p.score,
      JSON.stringify(p.hits), o.query.slice(0, 200), now.toISOString())
    n++
  }
  return n
}

/**
 * 第三态自动判：注入（或影子算出）之后，看他那一轮的回复里有没有用上。
 * 判据故意保守：**他的回复里出现了这条记忆特有的词**才算用上。
 * 影子模式下这个数字只说明「如果给了他，有多大机会用得上」，别当成准确率。
 */
export function judgeDeliveries(db: DB, o: { now?: Date; limit?: number } = {}): { judged: number; used: number } {
  ensureMemorySchema(db)
  const now = o.now ?? new Date()
  const rows = db.prepare(`SELECT d.id, d.memory_id, d.turn, d.created_at, m.title, m.fact_body
    FROM memory_deliveries d JOIN memories m ON m.id = d.memory_id
    WHERE d.state IN ('asked', 'delivered') AND d.turn IS NOT NULL AND d.judged_at IS NULL
      AND d.created_at < ?
    ORDER BY d.id LIMIT ?`)
    .all(new Date(now.getTime() - 60_000).toISOString(), Math.min(Math.max(o.limit ?? 50, 1), 200)) as unknown as any[]
  let judged = 0, used = 0
  const upd = db.prepare('UPDATE memory_deliveries SET state = ?, judged_at = ? WHERE id = ?')
  for (const d of rows) {
    const reply = db.prepare(`SELECT content FROM episodes
      WHERE actor = 'ai' AND kind = 'message' AND json_extract(meta, '$.turn') = ? ORDER BY seq DESC LIMIT 1`)
      .get(d.turn) as { content: string } | undefined
    if (!reply) continue
    const hit = distinctWords(`${d.title} ${d.fact_body}`).some(w => reply.content.includes(w))
    upd.run(hit ? 'used' : 'dropped', now.toISOString(), d.id)
    judged++
    if (hit) used++
  }
  return { judged, used }
}

// 全是套话的片段不算「特有」
const STOP = /^(她说她说|她说他说|我们一起|今天我们|这个时候|那个时候|什么时候|一直都是|因为所以|然后我们|自己的事|她说的话|他说的话)$/

/**
 * 这条记忆里比较特有的几个片段（判「他有没有用上」用的）。
 * 不能贪婪地整段抓：「她说她从小就不吃海鲜」整段抓走的话，「海鲜」两个字反而落在外面，
 * 他回复里说了「不点海鲜」也判不出来。所以按 4 字滑窗切，步长 2。
 */
export function distinctWords(text: string): string[] {
  const t = String(text || '')
  const out = new Set<string>()
  for (const run of t.match(/[\u4e00-\u9fa5]{4,}/g) ?? []) {
    for (let i = 0; i + 4 <= run.length; i += 2) {
      const w = run.slice(i, i + 4)
      if (!STOP.test(w)) out.add(w)
    }
  }
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9_.-]{3,}/g)) out.add(m[0])
  for (const p of PEOPLE_SEEDS) for (const a of p.aliases) if (a.length >= 2 && t.includes(a)) out.add(a)
  return [...out].slice(0, 24)
}

export interface RecallStats {
  mode: RecallMode
  total: number
  byState: Record<string, number>
  usedRate: number | null
  recent: { title: string; state: string; score: number | null; query: string; at: string }[]
}

export function recallStats(db: DB, env: NodeJS.ProcessEnv = process.env): RecallStats {
  ensureMemorySchema(db)
  const byState = Object.fromEntries((db.prepare('SELECT state, count(*) n FROM memory_deliveries GROUP BY state')
    .all() as unknown as { state: string; n: number }[]).map(r => [r.state, Number(r.n)]))
  const used = byState.used ?? 0
  const dropped = byState.dropped ?? 0
  const recent = db.prepare(`SELECT m.title, d.state, d.score, d.query, d.created_at AS at
    FROM memory_deliveries d JOIN memories m ON m.id = d.memory_id ORDER BY d.id DESC LIMIT 20`)
    .all() as unknown as RecallStats['recent']
  return {
    mode: recallMode(env),
    total: Object.values(byState).reduce((a, b) => a + b, 0),
    byState,
    usedRate: used + dropped ? used / (used + dropped) : null,
    recent,
  }
}


/**
 * 带语义的召回。**向量这一步有硬超时**（MEMORY_EMBED_TIMEOUT_MS，默认 250ms）：
 * 超时就当语义层不存在，只用字面分 —— 她的原话是「花钱无所谓，我只是害怕它时间太长」，
 * 所以这里永远不会让他的回复等着。
 */
export async function runRecallWithSemantics(db: DB, query: string, o: RecallOpts = {}): Promise<RecallResult> {
  const cfg = embedConfig()
  let vec: Float32Array | null = null
  let meta = { used: false, cached: false, ms: 0, why: undefined as string | undefined }
  if (!cfg) meta.why = '没配 embedding（MEMORY_EMBED_URL / KEY）'
  else if (vectorStats(db).indexed === 0) meta.why = '卡片还没建过向量索引'
  else {
    const t0 = Date.now()
    const got = await queryVector(db, query, apiEmbedder(cfg), { model: cfg.model, timeoutMs: cfg.timeoutMs })
    meta = got
      ? { used: true, cached: got.cached, ms: got.ms, why: undefined }
      : { used: false, cached: false, ms: Date.now() - t0, why: `${cfg.timeoutMs}ms 内没算出来，这一轮只用字面分` }
    vec = got?.vec ?? null
  }
  const r = runRecall(db, query, { ...o, queryVec: vec })
  r.semantic = meta
  return r
}
