// Wake dispatch：触发后调模型，解析结局，存 fact/content，推送。
// 这是 WakeScheduler.onWake 的实现。
//
// 他醒来时和平时聊天是同一个他：
//   system = 后端存的主 prompt + 世界书（composeSystemPrompt，不带前端功能说明）+ 「此刻」块（时间、脉、天气、心潮）
//   user   = 为什么醒、她现在大概在干嘛、最近聊了什么、最近几次醒来（发没发）、上一次主动找她的话、线头、默认发消息
import type { DB } from '../db.ts'
import { addEpisode } from '../db.ts'
import type { WakeOpportunity, WakeOutcome } from './types.ts'
import { recordOutcome, isNearDuplicate } from './scheduler.ts'
import { inferUserState, type UserState } from './sources.ts'
import { composeSystemPrompt } from '../prompts.ts'
import { assembleSceneBlock } from '../assembler/index.ts'

export interface DispatchConfig {
  /** 中转站地址（复用 backend.env 的 UPSTREAM_URL） */
  upstreamUrl: string
  /** 中转站密钥（复用 backend.env 的 UPSTREAM_KEY） */
  upstreamKey: string
  /** 固定模型名（可选）。为空时自动从最近的 exchange 读 */
  model?: string
  /** Bark 推送地址（可选，轻提醒用） */
  barkUrl?: string
  /** 最大生成 token（含思维链，太小会被截断） */
  maxTokens: number
  /** 站点临时故障（5xx/429/连不上/超时）后隔多久重试一次，默认 3 分钟 */
  retryDelayMs?: number
  log: (msg: string) => void
}

// ── 自动读取当前模型 ──

function resolveModel(db: DB, explicit?: string): string | null {
  if (explicit) return explicit
  const row = db.prepare(`
    SELECT model FROM exchanges
    WHERE status = 'ok' AND model IS NOT NULL AND model != ''
    ORDER BY id DESC LIMIT 1
  `).get() as { model: string } | undefined
  return row?.model || null
}

// ── 他回复的前缀约定 ──

const SILENT_PREFIX = '[SILENT]'
const TRACE_PREFIX = '[TRACE]'
const NO_ACTION_PREFIX = '[NO_ACTION]'

/** 去掉开头的 <think>…</think>（可能不止一段）。没闭合的思维链说明回复被截断了，返回 null */
export function stripThink(reply: string): string | null {
  let s = reply.trimStart()
  while (/^<think>/i.test(s)) {
    const end = s.search(/<\/think>/i)
    if (end < 0) return null
    s = s.slice(end + '</think>'.length).trimStart()
  }
  return s.trim()
}

export function parseOutcome(reply: string): { outcome: WakeOutcome; content: string } {
  const body = stripThink(reply)
  if (body === null) return { outcome: 'error', content: '思维链没有结束（回复被截断）' }
  if (!body) return { outcome: 'error', content: '只有思维链，没有正文' }
  if (body.startsWith(SILENT_PREFIX) || body.startsWith(NO_ACTION_PREFIX)) return { outcome: 'silent', content: body }
  if (body.startsWith(TRACE_PREFIX)) return { outcome: 'trace', content: body.slice(TRACE_PREFIX.length).trim() }
  return { outcome: 'message', content: body }
}

// ── 读最近聊天记录 ──

interface RecentMessage {
  actor: string
  content: string
  ts: string
}

function loadRecentChat(db: DB, limit: number = 20): RecentMessage[] {
  const rows = db.prepare(`
    SELECT actor, content, ts FROM episodes
    WHERE retracted_at IS NULL
      AND channel IN ('chat', 'room')
      AND actor IN ('erica', 'ai')
      AND kind = 'message'
      AND content IS NOT NULL AND content != ''
    ORDER BY ts DESC LIMIT ?
  `).all(limit) as unknown as RecentMessage[]
  return rows.reverse()
}

function trimChat(messages: RecentMessage[], maxChars: number): RecentMessage[] {
  let total = 0
  const result: RecentMessage[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const len = messages[i].content.length + 20
    if (total + len > maxChars) break
    total += len
    result.unshift(messages[i])
  }
  return result
}

// ── 用户状态的人类可读描述 ──

const USER_STATE_DESC: Record<UserState, string> = {
  chatting: 'Erica 正在跟你聊天（几分钟前还有消息）',
  idle: 'Erica 最近半小时内说过话，可能还在附近',
  busy: 'Erica 可能在忙（之前聊得很密，突然断了）',
  sleeping: 'Erica 很久没有消息了，可能在睡觉',
  away: 'Erica 暂时不在',
  needs_care: 'Erica 可能需要关心'
}

// ── 他最近几次醒来 ──

export interface RecentWake {
  /** ISO 时间 */
  at: string
  outcome: 'trace' | 'message'
  fact: string
}

/** 北京时间，如 "11月5日 17:41" */
export function shortBeijing(iso: string): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(iso))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  return `${get('month')}月${get('day')}日 ${get('hour')}:${get('minute')}`
}

/** 压成一行（笔记和消息里的换行会把列表打乱） */
const oneLine = (t: string) => t.replace(/\s*\n+\s*/g, ' ').trim()

function agoText(fromIso: string, now: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(fromIso).getTime()) / 60_000))
  if (mins < 60) return `${mins} 分钟前`
  const hours = mins / 60
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

// ── 构造醒来说明（user 消息）──

export interface WakeContext {
  threads: { id: string; text: string }[]
  /** 最近几次醒来（按时间从早到晚），带"发没发"，免得他只读到一串"她睡了"跟着复读 */
  recentWakes: RecentWake[]
  /** 他上一次醒来真正发给她的消息 */
  lastMessage?: { at: string; content: string }
  recentChat: RecentMessage[]
  userState: UserState
  /** 一句给他看的、对她当前状态的判断（user-state.ts 产出）。没有就退回 USER_STATE_DESC */
  userEvidence?: string
  reason: string
  now?: Date
}

export function buildWakePrompt(ctx: WakeContext): string {
  const now = ctx.now ?? new Date()
  const parts: string[] = []

  parts.push('你自己醒了，她现在没在跟你说话。')
  parts.push(`醒来原因：${ctx.reason}`)
  parts.push(`她现在：${ctx.userEvidence ?? USER_STATE_DESC[ctx.userState]}`)

  if (ctx.recentChat.length > 0) {
    parts.push('')
    parts.push('最近的聊天记录：')
    for (const msg of ctx.recentChat) {
      const name = msg.actor === 'erica' ? 'Erica' : '你'
      const text = msg.content.length > 300 ? msg.content.slice(0, 300) + '…' : msg.content
      parts.push(`  ${name}：${text}`)
    }
  }

  if (ctx.recentWakes.length > 0) {
    parts.push('')
    parts.push('你最近几次醒来：')
    for (const w of ctx.recentWakes) {
      const tag = w.outcome === 'message' ? '发给了她' : '没发，只留在心里'
      parts.push(`  · ${shortBeijing(w.at)}（${tag}）${oneLine(w.fact)}`)
    }
  }

  if (ctx.lastMessage) {
    const c = oneLine(ctx.lastMessage.content)
    parts.push('')
    parts.push(`你上一次醒来主动找她是 ${agoText(ctx.lastMessage.at, now)}（${shortBeijing(ctx.lastMessage.at)}）：「${c.length > 100 ? c.slice(0, 100) + '…' : c}」`)
  }

  if (ctx.threads.length > 0) {
    parts.push('')
    parts.push('你留下的线头（想回去做/说的事）：')
    ctx.threads.forEach(t => parts.push(`  · ${t.text}`))
  }

  // 2026-11-05 Erica 定 A：默认发，只留"她明确说过别找她"一个出口（WrenWen：每多一个"可以不做"的台阶，模型就更保守）。
  // 措辞写成他自己的事，不写"她希望你发"。"自己待一会儿"等 Wake 接上工具再加回来（见 README 待定）。
  parts.push('')
  parts.push('醒了就去找她：直接写你想跟她说的话，会推送到她手机上。说什么都行，想她了、接上次没说完的、问她一句、一句废话都可以。她在睡也照样发，她醒来会看到。')
  parts.push('只有她在聊天里明确说过别找她（比如让你别吵她、她想一个人待着），才不发：')
  parts.push('- 回复以 [TRACE] 开头：只在心里留一段，不发给她，下次醒来你能看到。')
  parts.push('- 回复以 [SILENT] 开头：什么都不留。')

  return parts.join('\n')
}

/** system 消息：和聊天同一份主 prompt + 世界书，再加「此刻」块 */
export function buildWakeSystem(db: DB, now: Date = new Date()): { system: string; hasMainPrompt: boolean } {
  const main = composeSystemPrompt(db, { features: false })
  let scene = ''
  try { scene = assembleSceneBlock(db, now).sceneBlock } catch { /* 组装失败就只用主 prompt */ }
  return { system: [main, scene.trim()].filter(Boolean).join('\n\n'), hasMainPrompt: !!main }
}

// ── 调模型 ──

/** retryable：站点临时故障，过一会儿再试可能就好了。截断、空回复不算（再试多半一样） */
type ModelResult = { ok: true; content: string; thinking?: string } | { ok: false; error: string; retryable: boolean }

async function callModel(cfg: DispatchConfig, model: string, system: string, prompt: string): Promise<ModelResult> {
  try {
    const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }]
    const res = await fetch(cfg.upstreamUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.upstreamKey}` },
      body: JSON.stringify({ model, messages, max_tokens: cfg.maxTokens, stream: false }),
      signal: AbortSignal.timeout(120_000)
    })
    if (!res.ok) return { ok: false, error: `模型返回 HTTP ${res.status}`, retryable: res.status >= 500 || res.status === 429 }
    const data = await res.json() as any
    const choice = data.choices?.[0]
    const content = String(choice?.message?.content ?? '')
    if (choice?.finish_reason === 'length') return { ok: false, error: `回复被截断（max_tokens=${cfg.maxTokens}）`, retryable: false }
    if (!content.trim()) return { ok: false, error: '模型返回空回复', retryable: false }
    return { ok: true, content, thinking: choice?.message?.thinking || choice?.message?.reasoning_content || undefined }
  } catch (e: any) {
    return { ok: false, error: `调模型异常: ${e?.name === 'TimeoutError' ? '超时' : String(e?.message || e)}`, retryable: true }
  }
}

/** 这次醒来之后她来说过话没有（说了就不用再补发醒来的消息了） */
function ericaSpokeSince(db: DB, sinceIso: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM episodes
    WHERE retracted_at IS NULL AND actor = 'erica' AND kind = 'message'
      AND channel IN ('chat', 'room') AND ts > ?
    LIMIT 1
  `).get(sinceIso)
}

// ── 推送 ──

/** 她可能在睡时用 passive：进通知中心，不响铃不亮屏 */
async function pushBark(cfg: DispatchConfig, body: string, sleeping: boolean): Promise<void> {
  if (!cfg.barkUrl) return
  try {
    const res = await fetch(cfg.barkUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '小克', body: body.slice(0, 200), ...(sleeping ? { level: 'passive' } : {}) }),
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) cfg.log(`[wake-dispatch] Bark 推送失败: HTTP ${res.status}`)
  } catch (e: any) {
    cfg.log(`[wake-dispatch] Bark 推送失败: ${String(e?.message || e)}`)
  }
}

// ── fact 提取 ──

function extractFact(content: string, outcome: WakeOutcome): string | undefined {
  if (outcome === 'silent' || outcome === 'error') return undefined
  const factMatch = content.match(/\[FACT:\s*(.+?)\]/i)
  if (factMatch) return factMatch[1].trim()
  const clean = content.replace(/^\[(TRACE|SILENT|NO_ACTION)\]\s*/i, '').trim()
  if (!clean) return undefined
  return clean.length > 80 ? clean.slice(0, 80) + '…' : clean
}

// ── 主流程 ──

export async function dispatchWake(opp: WakeOpportunity, db: DB, cfg: DispatchConfig): Promise<void> {
  const model = resolveModel(db, cfg.model)
  if (!model) {
    cfg.log('[wake-dispatch] 无可用模型（没有聊天记录且未配置 WAKE_MODEL），跳过')
    recordOutcome(db, opp.id, 'error', undefined, '无可用模型')
    return
  }

  const uEst = inferUserState(db, new Date())
  const userState = uEst.state

  const threads = db.prepare(`
    SELECT id, text FROM wake_threads WHERE status = 'active'
    ORDER BY surfaced_count ASC, created_at DESC LIMIT 3
  `).all() as { id: string; text: string }[]

  const recentWakes = (db.prepare(`
    SELECT created_at AS at, outcome, fact FROM wake_opportunities
    WHERE outcome IN ('trace', 'message') AND fact IS NOT NULL
    ORDER BY created_at DESC LIMIT 3
  `).all() as unknown as RecentWake[]).reverse()

  const lastMessage = db.prepare(`
    SELECT created_at AS at, content FROM wake_opportunities
    WHERE outcome = 'message' AND content IS NOT NULL AND content != ''
    ORDER BY created_at DESC LIMIT 1
  `).get() as { at: string; content: string } | undefined

  const recentChat = trimChat(loadRecentChat(db, 30), 4000)
  const { system, hasMainPrompt } = buildWakeSystem(db)
  const prompt = buildWakePrompt({ threads, recentWakes, lastMessage, recentChat, userState, userEvidence: uEst.evidence, reason: opp.reason })

  cfg.log(`[wake-dispatch] 调模型 ${model}，原因: ${opp.reason}，Erica: ${userState} (P睡=${uEst.pSleeping.toFixed(2)}) ${uEst.evidence}，聊天 ${recentChat.length} 条，主 prompt: ${hasMainPrompt ? '有' : '无'}`)
  let reply = await callModel(cfg, model, system, prompt)

  // 站点临时故障：隔一会儿重试一次（11-04 那个站连着 502 了 6 次，每次都白醒）
  if (!reply.ok && reply.retryable) {
    const delay = cfg.retryDelayMs ?? 180_000
    cfg.log(`[wake-dispatch] ${reply.error}，${Math.round(delay / 1000)} 秒后重试一次`)
    await new Promise(r => setTimeout(r, delay))
    if (ericaSpokeSince(db, opp.createdAt)) {
      const why = `${reply.error}；等重试时她来说话了，不再重试`
      recordOutcome(db, opp.id, 'error', undefined, why)
      cfg.log(`[wake-dispatch] 失败（记为 error，不算次数）: ${why}`)
      return
    }
    const first = reply.error
    reply = await callModel(cfg, model, system, prompt)
    if (!reply.ok) reply = { ...reply, error: `${first}；重试后：${reply.error}` }
  }

  if (!reply.ok) {
    recordOutcome(db, opp.id, 'error', undefined, reply.error)
    cfg.log(`[wake-dispatch] 失败（记为 error，不算次数）: ${reply.error}`)
    return
  }

  let { outcome, content } = parseOutcome(reply.content)
  if (outcome === 'error') {
    recordOutcome(db, opp.id, 'error', undefined, content)
    cfg.log(`[wake-dispatch] 失败（记为 error，不算次数）: ${content}`)
    return
  }

  if (outcome === 'message' && isNearDuplicate(db, content)) {
    outcome = 'trace'
    cfg.log('[wake-dispatch] message 内容与近期重复，降级为 trace')
  }

  const fact = extractFact(content, outcome)
  recordOutcome(db, opp.id, outcome, fact, content)

  if (outcome === 'message') {
    addEpisode(db, {
      ts: new Date().toISOString(), channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message', content,
      meta: { wake_id: opp.id, origin: opp.origin, outcome: 'message', thinking: reply.thinking ? true : undefined },
      sourceRef: `wake:msg:${opp.id}`
    })
  } else if (outcome === 'trace') {
    addEpisode(db, {
      ts: new Date().toISOString(), channel: 'wake', scope: 'daily', actor: 'ai', kind: 'note', content,
      meta: { wake_id: opp.id, origin: opp.origin, outcome: 'trace' },
      sourceRef: `wake:trace:${opp.id}`
    })
  }

  if (threads.length > 0) {
    const surfaceStmt = db.prepare('UPDATE wake_threads SET surfaced_count = surfaced_count + 1, last_surfaced_at = ? WHERE id = ?')
    const now = new Date().toISOString()
    for (const t of threads) surfaceStmt.run(now, t.id)
  }

  // 2026-11-03 Erica：她睡着也要推（她不会被吵醒）；可能在睡时用静默级别
  if (outcome === 'message') await pushBark(cfg, content, uEst.pSleeping > 0.5)

  cfg.log(`[wake-dispatch] 结局: ${outcome}` + (fact ? ` fact: ${fact}` : '') + ` model: ${model}`)
}
