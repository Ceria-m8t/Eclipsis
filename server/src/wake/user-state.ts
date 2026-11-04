// Wake 用户状态推断：现在她大概在干嘛、适不适合他主动找她。
//
// 三路证据合成（强→弱）：
//   1. 她说的话：最后一段连发里的"睡了/洗澡/吃饭/出门/X点回来"等线索，各带预计结束时间，
//      过了预计时间后置信度快速衰减。最强。
//   2. 作息曲线：近 30 天她每天每个小时"出现过没有"的直方图（环形平滑、近期加权），
//      数据少时退回弱先验。借 Persisto Mate 的 circadian 做法，不要它的情绪内核。
//   3. 沉默时长：距最后一条消息多久。
//
// 输出：各状态概率分布 + 一句给他看的话（userEvidence）+ P(睡着)。
// 发送适宜度 = Σ P(状态) × 效用(状态)（借 Revive Companion 的期望效用框架）。
//   睡着不是 0——Erica 要睡着也能收到（她不会被 passive 推送吵醒）。
import type { DB } from '../db.ts'

export type UserState = 'chatting' | 'idle' | 'busy' | 'sleeping' | 'away' | 'needs_care'

export const USER_STATES: UserState[] = ['chatting', 'idle', 'busy', 'sleeping', 'away', 'needs_care']

/** 各状态的发送适宜度 [0,1]。sleeping 不为 0（她要睡着也能收到，用 passive 推送）。 */
const STATE_UTILITY: Record<UserState, number> = {
  chatting: 0.15,     // 她已经在了，别用 wake 打断
  idle: 0.7,          // 闲着 → 好时机
  busy: 0.1,          // 在忙 → 别打扰
  sleeping: 0.35,     // 睡了 → 可以留话，passive 推送，她醒来看到
  away: 0.35,         // 不在手机边 → 留话也行
  needs_care: 0.9     // 可能需要关心 → 主动联系
}

export interface UserStateEstimate {
  /** 最可能的状态（argmax） */
  state: UserState
  /** 发送适宜度 [0,1] = Σ P(状态)×效用 */
  suitability: number
  /** 各状态概率，和为 1 */
  probabilities: Record<UserState, number>
  /** P(睡着)，dispatch 用它决定 Bark 是否 passive */
  pSleeping: number
  /** 一句给他看的话，解释"她现在大概怎样、为什么这么猜" */
  evidence: string
}

// ── 北京时间工具（设备时区 UTC+8）──

const BEIJING_OFFSET_MS = 8 * 3600_000

/** 返回某 UTC 时刻对应的北京小时 [0,23] */
function beijingHour(ms: number): number {
  return new Date(ms + BEIJING_OFFSET_MS).getUTCHours()
}
/** 返回北京日历日序号（用于"同一天同一小时只算一次"去重与天龄） */
function beijingDayIndex(ms: number): number {
  return Math.floor((ms + BEIJING_OFFSET_MS) / 86_400_000)
}

// ── 噪声过滤 ──
// 线上她的消息里混进了 Kelivo 客户端自动发的东西（标题生成、记忆注入、环境块），
// 这些不是她真的在说话，作息曲线和"最后一条"都要排除。发文件是真实在场，算活跃但不扫文本。

const NOISE_MARKERS = [
  '以下内容由系统提供，不是用户本轮发送的内容',
  'I will give you some dialogue content',
  'You need to summarize the conversation',
  '<user_profile',
  '<user_memory',
  '<environment>',
  'work.context:'
]

type MsgKind = 'noise' | 'file' | 'text'

function classify(content: string): MsgKind {
  const head = content.slice(0, 200)
  for (const m of NOISE_MARKERS) if (head.includes(m)) return 'noise'
  if (/^#{0,3}\s*user sent a file/i.test(content.trimStart())) return 'file'
  return 'text'
}

/** 去掉她消息里的时间壳：<current_time>…</current_time>、Kelivo 的"（YYYY-MM-DD HH:mm）"前缀、[图片] 占位。 */
export function stripTimeShell(content: string): string {
  return content
    .replace(/<current_time>[\s\S]*?<\/current_time>/gi, ' ')
    .replace(/^\s*（\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}）\s*/, '')
    .replace(/\[图片\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── 作息曲线（24 格直方图）──

interface Circadian {
  /** 24 格清醒程度 [0,1]，环形平滑后 */
  awake: number[]
  /** 总接触质量（加权在场计数），用来决定信不信数据 */
  mass: number
}

const PRIOR_DAY = 0.75   // 白天弱先验清醒度
const PRIOR_NIGHT = 0.35 // 夜里弱先验清醒度
const SUFFICIENT_MASS = 30
const DECAY_PER_CONTACT = 0.995

function priorAwake(hour: number): number {
  return hour >= 7 && hour < 23 ? PRIOR_DAY : PRIOR_NIGHT
}

/** 环形平滑：中心权重 2、左右邻格各 1 */
function smoothRing(raw: number[]): number[] {
  const out = new Array(24).fill(0)
  for (let h = 0; h < 24; h++) {
    const l = raw[(h + 23) % 24], c = raw[h], r = raw[(h + 1) % 24]
    out[h] = (2 * c + l + r) / 4
  }
  return out
}

// 每个 db 缓存一份曲线，~10 分钟重建（用真实墙钟，不受传入 now 影响）
const circadianCache = new WeakMap<object, { builtAtMs: number; curve: Circadian }>()
const CIRCADIAN_TTL_MS = 10 * 60_000

function buildCircadian(db: DB, now: Date): Circadian {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString()
  const rows = db.prepare(`
    SELECT ts, content FROM episodes
    WHERE retracted_at IS NULL
      AND channel IN ('chat', 'room')
      AND actor = 'erica'
      AND kind = 'message'
      AND ts >= ?
    ORDER BY ts ASC
  `).all(since) as { ts: string; content: string }[]

  // 同一天同一小时只算一次在场（按条数会被连发刷爆）
  const seenCell = new Set<string>()
  const events: { ms: number; hour: number }[] = []
  for (const r of rows) {
    if (classify(r.content) === 'noise') continue
    const ms = new Date(r.ts).getTime()
    if (!Number.isFinite(ms)) continue
    const hour = beijingHour(ms)
    const key = `${beijingDayIndex(ms)}:${hour}`
    if (seenCell.has(key)) continue
    seenCell.add(key)
    events.push({ ms, hour })
  }

  // 近期加权：越老的在场权重越低（decayPerContact 随事件数衰减）
  const raw = new Array(24).fill(0)
  let mass = 0
  const n = events.length
  for (let i = 0; i < n; i++) {
    const ageContacts = n - 1 - i   // 最新的 =0，最老的权重最低
    const w = Math.pow(DECAY_PER_CONTACT, ageContacts)
    raw[events[i].hour] += w
    mass += w
  }

  const smooth = smoothRing(raw)
  const peak = Math.max(...smooth, 1e-9)
  // 数据驱动的清醒度：到峰值 45% 就算基本清醒（她的活跃时段很宽）
  const dataAwake = smooth.map(v => Math.min(1, v / (peak * 0.45)))

  // 数据少 → 偏向先验；数据足 → 信数据
  const trust = Math.min(1, mass / SUFFICIENT_MASS)
  const awake = dataAwake.map((v, h) => {
    const blended = trust * v + (1 - trust) * priorAwake(h)
    return Math.max(0.05, Math.min(0.97, blended))
  })

  return { awake, mass }
}

function getCircadian(db: DB, now: Date): Circadian {
  const cached = circadianCache.get(db as unknown as object)
  const realNow = Date.now()
  if (cached && realNow - cached.builtAtMs < CIRCADIAN_TTL_MS) return cached.curve
  const curve = buildCircadian(db, now)
  circadianCache.set(db as unknown as object, { builtAtMs: realNow, curve })
  return curve
}

// ── 信号 1：她说的话 ──

interface Cue {
  kind: string
  dist: Partial<Record<UserState, number>>
  word: string
  snippet: string
  saidAtMs: number
  endMs: number
  baseConf: number
}

const CN_NUM: Record<string, number> = {
  零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12
}

/** 解析中文/阿拉伯数字小时，支持"七点半""7点""十一点" */
function parseHour(s: string): number | null {
  const m = s.match(/(\d{1,2}|[零一两二三四五六七八九十]{1,3})\s*点/)
  if (!m) return null
  const raw = m[1]
  if (/^\d+$/.test(raw)) return Number(raw)
  if (raw in CN_NUM) return CN_NUM[raw]
  // 十X
  const tenMatch = raw.match(/^十([一二三四五六七八九])$/)
  if (tenMatch) return 10 + CN_NUM[tenMatch[1]]
  const xTen = raw.match(/^([一二两三四五六七八九])十([一二三四五六七八九])?$/)
  if (xTen) return CN_NUM[xTen[1]] * 10 + (xTen[2] ? CN_NUM[xTen[2]] : 0)
  return null
}

/** 从 cue 时刻起，按作息曲线找下一个"该醒"的北京小时，推回 UTC 毫秒；默认 8 小时。
 *  数据不足时作息曲线接近先验（白天恒高），会把睡眠窗口压得太短——此时直接用 8 小时。 */
function estimateWakeEndMs(saidAtMs: number, curve: Circadian): number {
  const fallback = saidAtMs + 8 * 3600_000
  if (curve.mass < SUFFICIENT_MASS) return fallback
  const startHour = beijingHour(saidAtMs)
  // 先走过"还该睡"的低谷，再找第一个回升到清醒的小时，避免刚说完就撞上白天先验
  let seenLow = false
  for (let i = 1; i <= 14; i++) {
    const h = (startHour + i) % 24
    if (curve.awake[h] < 0.5) seenLow = true
    if (seenLow && curve.awake[h] >= 0.6) return saidAtMs + i * 3600_000
  }
  return fallback
}

/** 给定一个 cue 时刻、目标北京小时（可带半点），算结束 UTC 毫秒（已过则算次日） */
function clockToEndMs(saidAtMs: number, targetHour: number, half: boolean): number {
  const d = new Date(saidAtMs + BEIJING_OFFSET_MS)
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), targetHour, half ? 30 : 0) - BEIJING_OFFSET_MS
  return base > saidAtMs ? base : base + 86_400_000
}

/** 扫一段文本找最强的生活线索 */
function detectCue(text: string, saidAtMs: number, curve: Circadian): Cue | null {
  const t = text

  // 负面/问句守卫：排除"不困/睡不着/没睡/不敢睡/不想睡/睡了吗？"
  const sleepNegated = /(不困|睡不着|没睡|不敢睡|不想睡|别睡|没有睡|还没睡)/.test(t)
  const sleepQuestion = /睡(了|着)?\s*(吗|没|嘛|么)\s*[?？]?/.test(t) && !/我.*睡|要睡|去睡|睡了。|睡觉了/.test(t)

  const cues: Cue[] = []

  // 睡觉（强）
  if (!sleepNegated && !sleepQuestion && /(晚安|睡了|睡觉了|要睡了|去睡|睡啦|眯一会|眯一下|先睡|准备睡|洗洗睡|睡醒再)/.test(t)) {
    const w = (t.match(/(晚安|睡觉了|要睡了|去睡|睡了|睡啦|先睡|准备睡)/) || ['睡'])[0]
    cues.push({
      kind: 'sleep', dist: { sleeping: 0.9, away: 0.07, idle: 0.03 }, word: w,
      snippet: pickSnippet(t, w), saidAtMs, endMs: estimateWakeEndMs(saidAtMs, curve), baseConf: 0.9
    })
  }
  // 躺下（弱）
  else if (!sleepNegated && /(躺下|躺床上|躺着|上床|钻被窝|床上躺)/.test(t)) {
    const w = (t.match(/(躺床上|躺下|躺着|上床|钻被窝)/) || ['躺'])[0]
    cues.push({
      kind: 'lie', dist: { sleeping: 0.45, idle: 0.35, away: 0.2 }, word: w,
      snippet: pickSnippet(t, w), saidAtMs, endMs: estimateWakeEndMs(saidAtMs, curve), baseConf: 0.45
    })
  }

  // 洗澡
  if (/(洗澡|冲澡|泡澡|去冲个|洗头)/.test(t)) {
    const w = (t.match(/(洗澡|冲澡|泡澡|洗头)/) || ['洗澡'])[0]
    cues.push({
      kind: 'bath', dist: { busy: 0.55, away: 0.35, idle: 0.1 }, word: w,
      snippet: pickSnippet(t, w), saidAtMs, endMs: saidAtMs + 40 * 60_000, baseConf: 0.8
    })
  }
  // 吃饭
  if (/(吃饭|吃饭了|去吃|吃个饭|吃夜宵|吃午饭|吃晚饭|吃早饭|吃烤串|恰饭)/.test(t)) {
    const w = (t.match(/(吃晚饭|吃午饭|吃早饭|吃夜宵|吃烤串|吃饭|去吃|恰饭)/) || ['吃饭'])[0]
    cues.push({
      kind: 'meal', dist: { busy: 0.4, away: 0.3, idle: 0.2, chatting: 0.1 }, word: w,
      snippet: pickSnippet(t, w), saidAtMs, endMs: saidAtMs + 50 * 60_000, baseConf: 0.65
    })
  }
  // 出门 / 上课 / 上班 / 开会
  if (/(出门|上课|上班|开会|出去|外面|在路上|去上|地铁|公交)/.test(t)) {
    const w = (t.match(/(出门|上课|上班|开会|在路上|地铁|公交|出去)/) || ['出门'])[0]
    cues.push({
      kind: 'out', dist: { away: 0.65, busy: 0.25, idle: 0.1 }, word: w,
      snippet: pickSnippet(t, w), saidAtMs, endMs: saidAtMs + 120 * 60_000, baseConf: 0.7
    })
  }

  // X点(半)回来 / X分钟后 / 一会儿回来
  const backClock = t.match(/((?:\d{1,2}|[零一两二三四五六七八九十]{1,3})\s*点(?:半)?)\s*(?:钟)?\s*(?:左右|前后)?\s*(?:回来|回去|回家|过来)/)
  const backMin = t.match(/(\d{1,2}|[一两二三四五六七八九十]{1,3}|半)\s*(分钟|小时)\s*(?:后|之后)?\s*(?:回来|回去|过来)?/)
  if (backClock) {
    const hour = parseHour(backClock[1])
    const half = /半/.test(backClock[1])
    if (hour !== null) {
      const endMs = clockToEndMs(saidAtMs, hour, half)
      cues.push({
        kind: 'back_clock', dist: { away: 0.7, busy: 0.2, idle: 0.1 }, word: backClock[0],
        snippet: pickSnippet(t, backClock[0]), saidAtMs, endMs, baseConf: 0.75
      })
    }
  } else if (backMin && /回来|回去|过来/.test(t)) {
    const unit = backMin[2]
    let n = backMin[1] === '半' ? 0.5 : (CN_NUM[backMin[1]] ?? Number(backMin[1]))
    if (!Number.isFinite(n)) n = unit === '小时' ? 1 : 30
    const ms = unit === '小时' ? n * 3600_000 : n * 60_000
    cues.push({
      kind: 'back_rel', dist: { away: 0.7, busy: 0.2, idle: 0.1 }, word: backMin[0],
      snippet: pickSnippet(t, backMin[0]), saidAtMs, endMs: saidAtMs + ms, baseConf: 0.7
    })
  }

  if (cues.length === 0) return null
  // 取当前置信度最高的
  let best: Cue | null = null
  let bestConf = 0
  for (const c of cues) {
    const conf = cueConfidence(c, saidAtMs)   // 用 cue 自己的 saidAtMs 作参考不衰减，真正衰减在 infer 里用 now
    if (conf >= bestConf) { bestConf = conf; best = c }
  }
  return best
}

/** 置信度：窗口内满值，过了预计结束时间后 1 小时半衰期衰减；太老直接 0 */
function cueConfidence(cue: Cue, nowMs: number): number {
  const ageH = (nowMs - cue.saidAtMs) / 3600_000
  if (ageH > 14) return 0
  if (nowMs <= cue.endMs) return cue.baseConf
  const overH = (nowMs - cue.endMs) / 3600_000
  return cue.baseConf * Math.pow(0.5, overH / 1)
}

function pickSnippet(text: string, word: string): string {
  const idx = text.indexOf(word)
  if (idx < 0) return text.slice(0, 24)
  const clauses = text.split(/[。！!？?，,、\n]/)
  for (const c of clauses) if (c.includes(word)) {
    const s = c.trim()
    return s.length > 22 ? s.slice(0, 22) + '…' : s
  }
  const start = Math.max(0, idx - 6)
  return text.slice(start, start + 22)
}

// ── 合成 ──

function zeroDist(): Record<UserState, number> {
  return { chatting: 0, idle: 0, busy: 0, sleeping: 0, away: 0, needs_care: 0 }
}

function normalize(d: Record<UserState, number>): Record<UserState, number> {
  let sum = 0
  for (const k of USER_STATES) sum += Math.max(0, d[k])
  const out = zeroDist()
  if (sum <= 0) { out.away = 1; return out }
  for (const k of USER_STATES) out[k] = Math.max(0, d[k]) / sum
  return out
}

function argmax(d: Record<UserState, number>): UserState {
  let best: UserState = 'away', bestV = -1
  for (const k of USER_STATES) if (d[k] > bestV) { bestV = d[k]; best = k }
  return best
}

/** 近 N 条她的消息（含发文件，算在场）里，最后一段连发（距最后一条 10 分钟内） */
function loadBurst(db: DB): { msgs: { ms: number; content: string }[]; lastMs: number | null } {
  const rows = db.prepare(`
    SELECT ts, content FROM episodes
    WHERE retracted_at IS NULL AND channel IN ('chat','room')
      AND actor = 'erica' AND kind = 'message'
    ORDER BY ts DESC LIMIT 40
  `).all() as { ts: string; content: string }[]

  const real = rows
    .map(r => ({ ms: new Date(r.ts).getTime(), content: r.content, k: classify(r.content) }))
    .filter(r => Number.isFinite(r.ms) && r.k !== 'noise')

  if (real.length === 0) return { msgs: [], lastMs: null }

  const lastMs = real[0].ms
  const burst: { ms: number; content: string }[] = []
  let prev = lastMs
  for (const r of real) {
    if (prev - r.ms > 10 * 60_000) break
    if (r.k === 'text') burst.unshift({ ms: r.ms, content: r.content })
    prev = r.ms
  }
  return { msgs: burst, lastMs }
}

function formatAgo(nowMs: number, thenMs: number): string {
  const min = Math.round((nowMs - thenMs) / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = (nowMs - thenMs) / 3600_000
  return h < 10 ? `${h.toFixed(1)} 小时前` : `${Math.round(h)} 小时前`
}

const STATE_CN: Record<UserState, string> = {
  chatting: '在跟你聊天', idle: '闲着', busy: '在忙', sleeping: '睡着', away: '不在手机边', needs_care: '可能需要关心'
}

export function inferUserState(db: DB, now: Date): UserStateEstimate {
  const nowMs = now.getTime()
  const curve = getCircadian(db, now)
  const hour = beijingHour(nowMs)
  const { msgs: burst, lastMs } = loadBurst(db)

  // 没有任何消息：退回作息曲线
  if (lastMs === null) {
    const base = baseDist(curve.awake[hour], Infinity)
    return finalize(base, '还没有她的消息，按她平时的作息猜。', nowMs)
  }

  const sinceMin = (nowMs - lastMs) / 60_000

  // 基础分布：作息清醒度 + 沉默时长
  let dist = baseDist(curve.awake[hour], sinceMin)

  // 信号 1：她说的话（在整段连发文本里找线索）
  const burstText = burst.map(m => stripTimeShell(m.content)).join(' ')
  const cue = burst.length > 0 ? detectCue(burstText, lastMs, curve) : null
  let evidence: string | null = null

  if (cue) {
    const conf = cueConfidence(cue, nowMs)
    if (conf > 0.05) {
      const cueDist = zeroDist()
      for (const k of USER_STATES) cueDist[k] = cue.dist[k] ?? 0
      const cd = normalize(cueDist)
      // 置信度越高越听她的话
      const alpha = Math.min(0.9, conf)
      for (const k of USER_STATES) dist[k] = alpha * cd[k] + (1 - alpha) * dist[k]
      evidence = cueEvidence(cue, cd, nowMs)
    }
  }

  const final = normalize(dist)
  if (!evidence) evidence = fallbackEvidence(final, nowMs, lastMs, curve.mass)
  return finalize(final, evidence, nowMs, final)
}

/** 作息清醒度 + 沉默时长 → 基础分布 */
function baseDist(awake: number, sinceMin: number): Record<UserState, number> {
  const d = zeroDist()
  // 刚说过话 → 清醒几乎确定，盖过作息
  const activityAwake = sinceMin < 5 ? 0.99 : sinceMin < 30 ? 0.9 : sinceMin < 120 ? 0.6 : 0
  const pAwake = Math.max(awake, activityAwake)
  const pSleep = 1 - pAwake
  d.sleeping = pSleep

  // 清醒的质量按沉默时长分给 chatting/idle/busy/away
  let wChat: number, wIdle: number, wBusy: number, wAway: number
  if (sinceMin < 5) { wChat = 0.95; wIdle = 0.03; wBusy = 0.01; wAway = 0.01 }
  else if (sinceMin < 30) { wChat = 0.2; wIdle = 0.6; wBusy = 0.1; wAway = 0.1 }
  else if (sinceMin < 120) { wChat = 0.03; wIdle = 0.32; wBusy = 0.25; wAway = 0.4 }
  else { wChat = 0.01; wIdle = 0.14; wBusy = 0.25; wAway = 0.6 }
  const wSum = wChat + wIdle + wBusy + wAway
  d.chatting = pAwake * wChat / wSum
  d.idle = pAwake * wIdle / wSum
  d.busy = pAwake * wBusy / wSum
  d.away = pAwake * wAway / wSum
  return d
}

function finalize(
  probsIn: Record<UserState, number>, evidence: string, _nowMs: number, pre?: Record<UserState, number>
): UserStateEstimate {
  const probabilities = pre ?? normalize(probsIn)
  let suitability = 0
  for (const k of USER_STATES) suitability += probabilities[k] * STATE_UTILITY[k]
  return {
    state: argmax(probabilities),
    suitability: Math.max(0, Math.min(1, suitability)),
    probabilities,
    pSleeping: probabilities.sleeping,
    evidence
  }
}

function cueEvidence(cue: Cue, cueDist: Record<UserState, number>, nowMs: number): string {
  const ago = formatAgo(nowMs, cue.saidAtMs)
  const likely = argmax(cueDist)
  const snip = cue.snippet
  if (cue.kind === 'sleep' || cue.kind === 'lie') {
    if (nowMs <= cue.endMs) return `她 ${ago}说"${snip}"，这会儿多半${STATE_CN[likely]}。`
    return `她 ${ago}说"${snip}"，按她平时这个点，现在多半${STATE_CN.sleeping}。`
  }
  if (cue.kind === 'back_clock' || cue.kind === 'back_rel') {
    if (nowMs <= cue.endMs) return `她 ${ago}说"${snip}"，应该还没回来。`
    return `她 ${ago}说"${snip}"，按说这会儿该回来了。`
  }
  return `她 ${ago}说"${snip}"，这会儿多半${STATE_CN[likely]}。`
}

function fallbackEvidence(
  dist: Record<UserState, number>, nowMs: number, lastMs: number, mass: number
): string {
  const state = argmax(dist)
  const ago = formatAgo(nowMs, lastMs)
  switch (state) {
    case 'chatting': return `她 ${ago}还在说话，正在跟你聊。`
    case 'idle': return `她 ${ago}说过话，应该还在手机边上。`
    case 'busy': return `之前聊得挺密，${ago}突然断了，她可能去忙了。`
    case 'sleeping':
      return mass >= SUFFICIENT_MASS
        ? `她 ${ago}没消息了，按她平时这个点，多半睡着。`
        : `她 ${ago}没消息了，这个点多半睡着（她的作息还没攒够数据，只是估）。`
    case 'away': return `她 ${ago}没消息了，这会儿大概不在手机边。`
    default: return `她 ${ago}有过消息。`
  }
}
