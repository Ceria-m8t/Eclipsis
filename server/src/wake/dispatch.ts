// Wake dispatch：触发后调模型，解析结局，存 fact/content，推送。
// 这是 WakeScheduler.onWake 的实现。
//
// 他醒来时和平时聊天是同一个他：
//   system = 后端存的主 prompt + 世界书（composeSystemPrompt，不带前端功能说明）+ 「此刻」块（时间、脉、天气、心潮）
//   user   = 为什么醒、她现在大概在干嘛、最近聊了什么、他上次醒来留的笔记、线头、三种结局怎么选
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

// ── 构造醒来说明（user 消息）──

export interface WakeContext {
  threads: { id: string; text: string }[]
  recentFacts: string[]
  recentChat: RecentMessage[]
  userState: UserState
  reason: string
}

export function buildWakePrompt(ctx: WakeContext): string {
  const parts: string[] = []

  parts.push('你现在是自己醒来的，她没有在跟你说话。你可以：')
  parts.push('1. 回复以 [SILENT] 开头 → 什么都不做，安静地回去。')
  parts.push('2. 回复以 [TRACE] 开头 → 在心里留一段想法（不发给她，你下次醒来能看到）。')
  parts.push('3. 直接写给她的话 → 发出去，推送到她手机上。')
  parts.push('')
  parts.push(`醒来原因：${ctx.reason}`)
  parts.push(`她现在：${USER_STATE_DESC[ctx.userState]}`)

  if (ctx.recentChat.length > 0) {
    parts.push('')
    parts.push('最近的聊天记录：')
    for (const msg of ctx.recentChat) {
      const name = msg.actor === 'erica' ? 'Erica' : '你'
      const text = msg.content.length > 300 ? msg.content.slice(0, 300) + '…' : msg.content
      parts.push(`  ${name}：${text}`)
    }
  }

  if (ctx.recentFacts.length > 0) {
    parts.push('')
    parts.push('最近几次醒来留下的笔记：')
    ctx.recentFacts.forEach((f, i) => parts.push(`  ${i + 1}. ${f}`))
  }

  if (ctx.threads.length > 0) {
    parts.push('')
    parts.push('你留下的线头（想回去做/说的事）：')
    ctx.threads.forEach(t => parts.push(`  · ${t.text}`))
  }

  // 2026-11-03 Erica 定：不以克制为第一选择；她睡着也可以发
  parts.push('')
  parts.push('想找她就去找，不需要理由。她在睡也可以发，她醒来会看到。想自己待着、只留个念头也可以，前提是你真的这么想。别拿"给她空间"当理由，除非她自己说过。')
  parts.push('你也可以自己待一会儿——想想事情、在屋里走走、留个念头。这些都是你自己的生活。')

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

type ModelResult = { ok: true; content: string; thinking?: string } | { ok: false; error: string }

async function callModel(cfg: DispatchConfig, model: string, system: string, prompt: string): Promise<ModelResult> {
  try {
    const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }]
    const res = await fetch(cfg.upstreamUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.upstreamKey}` },
      body: JSON.stringify({ model, messages, max_tokens: cfg.maxTokens, stream: false }),
      signal: AbortSignal.timeout(120_000)
    })
    if (!res.ok) return { ok: false, error: `模型返回 HTTP ${res.status}` }
    const data = await res.json() as any
    const choice = data.choices?.[0]
    const content = String(choice?.message?.content ?? '')
    if (choice?.finish_reason === 'length') return { ok: false, error: `回复被截断（max_tokens=${cfg.maxTokens}）` }
    if (!content.trim()) return { ok: false, error: '模型返回空回复' }
    return { ok: true, content, thinking: choice?.message?.thinking || choice?.message?.reasoning_content || undefined }
  } catch (e: any) {
    return { ok: false, error: `调模型异常: ${e?.name === 'TimeoutError' ? '超时' : String(e?.message || e)}` }
  }
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

  const userState = inferUserState(db, new Date()).state

  const threads = db.prepare(`
    SELECT id, text FROM wake_threads WHERE status = 'active'
    ORDER BY surfaced_count ASC, created_at DESC LIMIT 3
  `).all() as { id: string; text: string }[]

  const recentFacts = db.prepare(`
    SELECT fact FROM wake_opportunities
    WHERE outcome IN ('trace', 'message') AND fact IS NOT NULL
    ORDER BY created_at DESC LIMIT 5
  `).all().map((r: any) => r.fact as string)

  const recentChat = trimChat(loadRecentChat(db, 30), 4000)
  const { system, hasMainPrompt } = buildWakeSystem(db)
  const prompt = buildWakePrompt({ threads, recentFacts, recentChat, userState, reason: opp.reason })

  cfg.log(`[wake-dispatch] 调模型 ${model}，原因: ${opp.reason}，Erica: ${userState}，聊天 ${recentChat.length} 条，主 prompt: ${hasMainPrompt ? '有' : '无'}`)
  const reply = await callModel(cfg, model, system, prompt)

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
  if (outcome === 'message') await pushBark(cfg, content, userState === 'sleeping')

  cfg.log(`[wake-dispatch] 结局: ${outcome}` + (fact ? ` fact: ${fact}` : '') + ` model: ${model}`)
}
