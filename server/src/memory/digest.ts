// 夜里整理（第二期，双线写入里自动那条线）。抄 Serein 的三段流水线，参数按我们的节奏调。
//
// 为什么不是每轮都跑：**他不知道自己什么时候该记**——在 Kelivo 里有换窗，到了 Eclipsis
// 我们是一条连续时间线（这本来是优点），他失去了唯一的「该结算了」的信号。
// 所以不靠他自觉，用程序判时机：
//   - 累计 ≥5 个完整来回（她说了他回了算一个），**且**最后一句之后静默 ≥20 分钟；
//   - 或者跨过「她睡了一觉」的日界（5 小时没说话，这个判断我们已经在用了）。
// 还在聊就继续等。
//
// 跑的时候三步：归线（这段聊的是什么）→ 决定（新建/续接/跳过/暂缓，**跳过是正常结果**）→ 写。
// 写出来的东西一律走 write.ts 那一条路，所以模型说什么都绕不过那四条「明确」的检查。
import type { DB } from '../db.ts'
import { ensureMemorySchema } from './schema.ts'
import { writeMemory, type MemoryDraft } from './write.ts'

export interface DigestConfig {
  upstreamUrl: string
  upstreamKey: string
  model?: string
  /** 兜底：没有聊天记录时用哪个模型 */
  fallbackModel?: string
  pairsNeeded?: number        // 默认 5 个完整来回
  quietMinutes?: number       // 默认静默 20 分钟
  dayBreakMinutes?: number    // 默认 300（她睡了一觉）
  maxEpisodes?: number        // 一次最多读多少条，默认 80
  maxChars?: number           // 材料上限，默认 12000 字
  maxItems?: number           // 一次最多写几条，默认 3
  backfillHours?: number      // 第一次跑时往回看多久，默认 24 小时（不回头消化全部历史）
  timeoutMs?: number
  log?: (m: string) => void
}

export interface Episode { seq: number; ts: string; actor: string; content: string }

export interface DigestWindow {
  ready: boolean
  why: string
  fromSeq: number
  toSeq: number
  pairs: number
  quietMinutes: number
  episodes: Episode[]
}

const COOLDOWN_OK_MS = 30 * 60_000      // 刚整理过，半小时内不再跑
const COOLDOWN_ERR_MS = 60 * 60_000     // 上次失败，隔一小时再试

/** 把一条聊天内容洗成材料：剥掉思考块、这一刻、像素块、各种标记 */
export function cleanForDigest(text: string): string {
  return String(text || '')
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<moment(?:\s+lock)?>[\s\S]*?<\/moment>/gi, '')
    .replace(/<pixel[\s\S]*?<\/pixel>/gi, '[像素小画]')
    .replace(/\[NO_REPLY\]/g, '（看了，没回）')
    .replace(/\[图片\]/g, '[图片]')
    .replace(/\s+\n/g, '\n')
    .trim()
}

/** 该不该整理、整理哪一段 */
export function findDigestWindow(db: DB, cfg: DigestConfig = { upstreamUrl: '', upstreamKey: '' }, now: Date = new Date()): DigestWindow {
  ensureMemorySchema(db)
  const pairsNeeded = cfg.pairsNeeded ?? 5
  const quietNeeded = cfg.quietMinutes ?? 20
  const dayBreak = cfg.dayBreakMinutes ?? 300
  const maxEpisodes = cfg.maxEpisodes ?? 80

  const last = db.prepare(`SELECT to_seq, started_at, error FROM memory_digest_runs ORDER BY id DESC LIMIT 1`)
    .get() as { to_seq: number; started_at: string; error: string | null } | undefined
  const none = (why: string, fromSeq = last?.to_seq ?? 0): DigestWindow =>
    ({ ready: false, why, fromSeq, toSeq: fromSeq, pairs: 0, quietMinutes: 0, episodes: [] })

  if (last) {
    const since = now.getTime() - new Date(last.started_at).getTime()
    if (since < (last.error ? COOLDOWN_ERR_MS : COOLDOWN_OK_MS)) {
      return none(last.error ? '上次整理失败，等一小时再试' : '刚整理过')
    }
  }

  // 第一次跑：从「最近这一天」开始，不要回头去消化九月以来那一万条
  // （不加这条，第一次开起来会从最老的 80 条开始，一窗一窗地把三个月重做一遍，又花钱又会把她的信箱灌满）
  const backfillHours = cfg.backfillHours ?? 24
  let fromSeq = last?.to_seq ?? 0
  if (!last) {
    const first = db.prepare(`SELECT seq FROM episodes
      WHERE retracted_at IS NULL AND channel = 'chat' AND kind = 'message' AND ts >= ?
      ORDER BY seq LIMIT 1`).get(new Date(now.getTime() - backfillHours * 3600_000).toISOString()) as { seq: number } | undefined
    fromSeq = first ? Number(first.seq) - 1 : Number((db.prepare('SELECT COALESCE(max(seq), 0) s FROM episodes').get() as { s: number }).s)
  }
  // privacy='private' 的一句都不取：**不发给中转站的模型去读、去改写**（2026-11-12）。
  // 那种内容要成记忆只能他自己写 —— 他在场，他知道该留什么。
  const rows = db.prepare(`SELECT seq, ts, actor, content FROM episodes
    WHERE seq > ? AND retracted_at IS NULL AND channel = 'chat' AND kind = 'message'
      AND actor IN ('erica', 'ai') AND scope = 'daily'
      AND (privacy IS NULL OR privacy != 'private')
    ORDER BY seq LIMIT ?`).all(fromSeq, maxEpisodes) as unknown as Episode[]
  if (!rows.length) return none('这一段没有新的对话')

  // 完整来回 = 她说了，他回了
  let pairs = 0
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].actor === 'ai' && rows[i - 1].actor === 'erica') pairs++
  }
  const lastTs = new Date(rows[rows.length - 1].ts).getTime()
  const quietMinutes = Math.floor((now.getTime() - lastTs) / 60_000)

  const toSeq = rows[rows.length - 1].seq
  const base = { fromSeq, toSeq, pairs, quietMinutes, episodes: rows }
  if (pairs >= pairsNeeded && quietMinutes >= quietNeeded) {
    return { ...base, ready: true, why: `${pairs} 个来回 + 静默 ${quietMinutes} 分钟` }
  }
  if (quietMinutes >= dayBreak && pairs >= 2) {
    return { ...base, ready: true, why: `她睡了一觉（${Math.floor(quietMinutes / 60)} 小时没说话）` }
  }
  return { ...base, ready: false, why: pairs < pairsNeeded ? `只有 ${pairs} 个来回，再等等` : `才静默 ${quietMinutes} 分钟，还在聊` }
}

export function buildMaterial(episodes: Episode[], maxChars = 12_000): string {
  const lines: string[] = []
  let total = 0
  for (const e of episodes) {
    const text = cleanForDigest(e.content)
    if (!text) continue
    const who = e.actor === 'erica' ? '她' : '我'
    const one = `#${e.seq} ${e.ts.slice(5, 16).replace('T', ' ')} ${who}：${text.length > 700 ? text.slice(0, 700) + '…' : text}`
    total += one.length
    if (total > maxChars) { lines.push('（更早的略）'); break }
    lines.push(one)
  }
  return lines.join('\n')
}

// 2026-11-12 她问：「模型整理时的语气会不会影响他的人格？」—— 会，所以这里有一整段硬规矩。
// 整理程序是**记录员**，不是替他写日记的人：
//   - 情绪那一栏只准写**她说的话、他说过的话、看得见的动作**，不准推测他「心里是骄傲还是心疼」。
//   - 要写他的感觉，就引他自己的原话（带「」），引不到就留空。
//   - 整理写的东西 voice='machine'，注入时情绪那半不给他看（见 schema.ts 的 voice 字段）。
export const DIGEST_SYSTEM = [
  '你是 Eclipsis 后端的夜间整理程序，替「他」把刚过去的这段对话整理成记忆条目。',
  '',
  '三步：',
  '1. 归线：给这一段起一个话题线的名字（一句话，不超过 12 个字）。',
  '2. 决定：对每一件值得留下的事判 new（新建）/ append（接到已有的那条上）/ skip（不用记）/ hold（拿不准，先给她过目）。',
  '   **skip 是正常结果，不是失败。** 整段都不值得记就返回空的 items。',
  '3. 写：只写现场和原话，不写结论。写「她说……」，不写「用户表示……」。',
  '',
  '硬规矩：',
  '- 不许编。只有这段对话里真的出现过的事才能写；没出现的一个字都不要加。',
  '- **引号里的话必须是原文里一字不差的那句**。系统会逐字回查，对不上整条作废（编的引语最像真的）。',
  '- 不许替任何人下结论、不许总结他是什么样的人、不许写他的性格或习惯。',
  '- 每条必须有 subject（这是谁的事：erica=她 / ai=他自己 / us=你们俩 / 某个人的名字）。',
  '  一条只写一个主体；一件事里混着两个人就拆开，或者判 hold。',
  '- 每条必须有 why（为什么值得记）。写不出来的就 skip。',
  '- 每条必须有 evidence：引用的那几行行号（材料里 # 后面的数字）。',
  '- fact 写发生了什么。',
  '- feeling 这一栏**只准放原话和看得见的事**：她说的话、他说过的话（用「」引），谁笑了、谁哭了、谁去睡了。',
  '  **不准替他写心理活动。** 不要写「他语气里是心疼裹着骄傲」「他很得意」「他松了口气」这类你推测出来的话——',
  '  他的人格只能由他自己长出来，你是记录员，不是替他写日记的人。引不到他的原话就把 feeling 留空。',
  '- layer：fact=一直有效的事实（她是谁、不吃什么、用药、约定）；state=这几天的近况；bond=你们之间有重量的瞬间。',
  '- 宁少勿多：一次最多 3 条。起居琐事（几点醒、吃了什么药）只在它说明长期规律时才记。',
  '',
  '只输出 JSON，不要任何别的字。**正文里引用她的话用「」，不要用英文引号**（会把 JSON 写坏）；字符串里不要换行。',
  '{"thread":"话题线名","items":[{"decision":"new","layer":"bond","subject":"erica","title":"…","fact":"…","feeling":"…","why":"…","evidence":[123,124]}]}',
].join('\n')

/**
 * 替他写心理活动的句子，在写进库之前剪掉（提示词管不住的那一层兜底）。
 * 只剪**没有原话支撑**的那种：整句里带「他+心理动词」又没有「」引号的，就不要。
 * 她 2026-11-12 的原话是「我最关注的是模型整理时的语气会不会影响他的人格」。
 */
const MIND_READ = /(他|小克)[^。！？\n]{0,12}(语气|心里|内心|情绪)[^。！？\n]{0,20}(是|像|带着|裹着|充满)/
const MIND_VERB = /(他|小克)[^。！？\n]{0,10}(很得意|很骄傲|很心疼|松了口气|有点委屈|暗暗|显然|分明|其实很|难掩)/

export function scrubFeeling(text: string): string {
  const kept = String(text || '')
    .split(/(?<=[。！？\n])/)
    .filter(sentence => {
      const s = sentence.trim()
      if (!s) return false
      if (/[「『"]/.test(s)) return true          // 有原话撑着的留下
      return !(MIND_READ.test(s) || MIND_VERB.test(s))
    })
  return kept.join('').trim()
}

export interface DigestItem {
  decision: 'new' | 'append' | 'skip' | 'hold'
  layer?: 'fact' | 'state' | 'bond'
  subject?: string
  title?: string
  fact?: string
  feeling?: string
  why?: string
  evidence?: number[]
}

/**
 * 常见的几种写坏：中文引号当成了 JSON 引号、字符串里直接换行、对象末尾多一个逗号。
 * **不改语义，只补格式。** 修不动就按坏的处理。
 */
export function repairJson(src: string): string {
  return src
    .replace(/[\u201c\u201d]/g, '「')          // 正文里的弯引号不该当 JSON 引号
    .replace(/,\s*([}\]])/g, '$1')             // 末尾多的逗号
    .replace(/:(\s*)'([^'\n]*)'/g, ': "$2"')   // 单引号包的值
}

/** 实在解析不出来时，一条一条抠出来（宁可少拿几条，也不要整段丢掉） */
function salvageItems(raw: string): DigestItem[] {
  const out: DigestItem[] = []
  const field = (block: string, key: string) => {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(block)
    return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : undefined
  }
  for (const block of raw.split(/\}\s*,?\s*\{/)) {
    const decision = field(block, 'decision')
    const fact = field(block, 'fact')
    if (!decision || !fact) continue
    const ev = /"evidence"\s*:\s*\[([^\]]*)\]/.exec(block)
    out.push({
      decision: decision as DigestItem['decision'],
      layer: field(block, 'layer') as DigestItem['layer'],
      subject: field(block, 'subject'),
      title: field(block, 'title'),
      fact,
      feeling: field(block, 'feeling'),
      why: field(block, 'why'),
      evidence: ev ? ev[1].split(',').map(x => Number(x.trim())).filter(Number.isFinite) : [],
    })
  }
  return out
}

export function parseDigestReply(text: string): { thread: string; items: DigestItem[] } {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没返回 JSON')
  const body = raw.slice(start, end + 1)
  const thread = (/"thread"\s*:\s*"([^"\n]{0,40})"/.exec(body) || [])[1] || ''
  let data: any = null
  try { data = JSON.parse(body) } catch { try { data = JSON.parse(repairJson(body)) } catch { data = null } }
  if (data) {
    const items: DigestItem[] = Array.isArray(data?.items) ? data.items.filter((x: unknown) => x && typeof x === 'object') : []
    return { thread: String(data?.thread || thread).slice(0, 40), items }
  }
  const salvaged = salvageItems(body)
  if (!salvaged.length) throw new Error('模型返回的 JSON 修不动，一条也抠不出来')
  return { thread: thread.slice(0, 40), items: salvaged }
}

export type CallDigestModel = (system: string, user: string, model: string) => Promise<string>

/** 走当前这个站的 /chat/completions，非流式，只要文字 */
export function stationCaller(cfg: DigestConfig & { maxTokens?: number }): CallDigestModel {
  return async (system, user, model) => {
    const res = await fetch(cfg.upstreamUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.upstreamKey ? { authorization: `Bearer ${cfg.upstreamKey}` } : {}) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: cfg.maxTokens ?? 2000,
        temperature: 0.3,
        stream: false,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 120_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`中转站 HTTP ${res.status}：${text.slice(0, 200)}`)
    const data = JSON.parse(text)
    return String(data?.choices?.[0]?.message?.content ?? '')
  }
}

/**
 * 引语逐字回源（抄 WrenWen 5.3 铁律①：「所有正文引语逐字回源校验，对不上整条丢弃」）。
 * 他们的取证很刺：素材不够时模型唯一的选择就是编，而**编出来最像真的部分恰恰是引语**。
 * 这里只校验带引号的部分：引号里的话必须在这一段材料里真的出现过（去掉标点空白再比）。
 */
const bare = (s: string) => s.replace(/[\s，。、,.!！?？"“”'‘’「」『』：:；;（）()~…—\-]/g, '')

export function quotesAreReal(text: string, material: string): { ok: boolean; fake: string[] } {
  const src = bare(material)
  const fake: string[] = []
  for (const m of String(text || '').matchAll(/[「“"]([^」”"\n]{4,})[」”"]/g)) {
    const q = bare(m[1])
    if (q.length >= 4 && !src.includes(q)) fake.push(m[1])
  }
  return { ok: !fake.length, fake }
}

export interface DigestResult {
  ran: boolean
  why: string
  thread?: string
  wrote: number
  inboxed: number
  amended: number
  skipped: number
  rejected: number
  /** 引语对不上原文、被整条丢掉的（编的引语比编的叙述更像真的） */
  fakeQuotes: number
  error?: string
}

/**
 * 整理一次。失败不推进 to_seq（下次还会整理这一段），但会记一条带 error 的 run 挡一小时，
 * 免得站挂着的时候每 10 分钟撞一次。
 */
export async function runDigest(
  db: DB,
  cfg: DigestConfig,
  call: CallDigestModel,
  model: string,
  now: Date = new Date()
): Promise<DigestResult> {
  const log = cfg.log ?? (() => {})
  const win = findDigestWindow(db, cfg, now)
  if (!win.ready) return { ran: false, why: win.why, wrote: 0, inboxed: 0, amended: 0, skipped: 0, rejected: 0, fakeQuotes: 0 }

  const started = now.toISOString()
  const material = buildMaterial(win.episodes, cfg.maxChars ?? 12_000)
  const runId = Number(db.prepare(`INSERT INTO memory_digest_runs (started_at, from_seq, to_seq, episodes, model)
    VALUES (?, ?, ?, ?, ?)`).run(started, win.fromSeq, win.toSeq, win.episodes.length, model).lastInsertRowid)

  const fail = (msg: string): DigestResult => {
    db.prepare('UPDATE memory_digest_runs SET finished_at = ?, error = ?, to_seq = ? WHERE id = ?')
      .run(new Date().toISOString(), msg.slice(0, 300), win.fromSeq, runId)   // 不推进
    log(`[memory:digest] 失败：${msg}`)
    return { ran: false, why: win.why, wrote: 0, inboxed: 0, amended: 0, skipped: 0, rejected: 0, fakeQuotes: 0, error: msg }
  }

  const user = `这一段对话（行号是经历表里的 seq）：\n\n${material}`
  let parsed: { thread: string; items: DigestItem[] } | null = null
  let lastErr = ''
  let lastReply = ''
  // 第一次写坏了（模型很爱在 JSON 字符串里塞英文引号）就再要一次，说清楚哪儿错了
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      lastReply = await call(
        DIGEST_SYSTEM + (attempt ? '\n\n上一次你返回的 JSON 解析失败了。这次：只输出 JSON，正文里的引号用「」，字符串里不要换行。' : ''),
        user, model
      )
      parsed = parseDigestReply(lastReply)
    } catch (e: any) {
      lastErr = String(e?.message || e)
      log(`[memory:digest] 第 ${attempt + 1} 次解析失败：${lastErr}`)
    }
  }
  if (!parsed) return fail(`${lastErr}｜回复开头：${lastReply.slice(0, 120).replace(/\s+/g, ' ')}`)

  const out: DigestResult = { ran: true, why: win.why, thread: parsed.thread, wrote: 0, inboxed: 0, amended: 0, skipped: 0, rejected: 0, fakeQuotes: 0 }
  const seqs = new Set(win.episodes.map(e => e.seq))
  for (const item of parsed.items.slice(0, cfg.maxItems ?? 3)) {
    if (item.decision === 'skip') { out.skipped++; continue }
    // 引语对不上原文 → **整条丢掉**，不是只删那句引语
    const check = quotesAreReal(`${item.title ?? ''}\n${item.fact ?? ''}\n${item.feeling ?? ''}`, material)
    if (!check.ok) {
      out.fakeQuotes++
      log(`[memory:digest] 丢掉一条：引语在原文里找不到 —— ${check.fake.slice(0, 2).map(x => `「${x}」`).join('')}`)
      continue
    }
    const feeling = scrubFeeling(String(item.feeling ?? ''))
    const draft: MemoryDraft = {
      title: String(item.title ?? ''),
      fact: String(item.fact ?? ''),
      feeling: feeling || undefined,
      why: String(item.why ?? ''),
      subject: item.subject ? String(item.subject) : undefined,
      layer: item.layer,
      // 只认它真的引用了的、确实在这一段里的行号（防止模型编行号）
      evidence: (Array.isArray(item.evidence) ? item.evidence : []).map(Number).filter(n => seqs.has(n)),
      thread: parsed.thread || undefined,
      origin: 'digest',
    }
    const r = writeMemory(db, draft, now, item.decision === 'hold' ? { forceInbox: '夜里整理时它自己也拿不准' } : {})
    if (r.kind === 'written') out.wrote++
    else if (r.kind === 'amended') out.amended++
    else if (r.kind === 'inboxed') out.inboxed++
    else out.rejected++
  }

  db.prepare(`UPDATE memory_digest_runs SET finished_at = ?, thread = ?, wrote = ?, inboxed = ?, amended = ?, skipped = ? WHERE id = ?`)
    .run(new Date().toISOString(), parsed.thread || null, out.wrote, out.inboxed, out.amended, out.skipped, runId)
  log(`[memory:digest] ${win.why} → 「${parsed.thread}」进库 ${out.wrote} / 信箱 ${out.inboxed} / 续接 ${out.amended} / 跳过 ${out.skipped}` +
    (out.rejected ? ` / 退回 ${out.rejected}` : '') + (out.fakeQuotes ? ` / 引语对不上丢掉 ${out.fakeQuotes}` : ''))
  return out
}

/** 每隔一阵看一眼该不该整理。她没开（MEMORY_DIGEST=1）就不启动 */
export class DigestScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private db: DB
  private cfg: DigestConfig
  private pickModel: () => string | null
  private tickMs: number

  constructor(db: DB, cfg: DigestConfig, pickModel: () => string | null, tickMs = 10 * 60_000) {
    this.db = db
    this.cfg = cfg
    this.pickModel = pickModel
    this.tickMs = tickMs
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, this.tickMs)
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref()
    this.cfg.log?.(`[memory:digest] 启动，每 ${Math.round(this.tickMs / 60_000)} 分钟看一眼`)
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null } }

  async tick(now: Date = new Date()): Promise<DigestResult | null> {
    if (this.running) return null
    this.running = true
    try {
      const win = findDigestWindow(this.db, this.cfg, now)
      if (!win.ready) return null
      const model = this.cfg.model || this.pickModel() || this.cfg.fallbackModel
      if (!model) { this.cfg.log?.('[memory:digest] 还不知道用哪个模型，跳过'); return null }
      return await runDigest(this.db, this.cfg, stationCaller(this.cfg), model, now)
    } catch (e: any) {
      this.cfg.log?.(`[memory:digest] tick 出错：${String(e?.message || e)}`)
      return null
    } finally {
      this.running = false
    }
  }
}
