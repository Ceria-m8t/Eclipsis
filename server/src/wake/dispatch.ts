// Wake dispatch：触发后调模型，解析三种结局，存 fact/content，推送。
// 这是 WakeScheduler.onWake 的实现。
import type { DB } from '../db.ts'
import { addEpisode } from '../db.ts'
import type { WakeOpportunity, WakeOutcome } from './types.ts'
import { recordOutcome, isNearDuplicate } from './scheduler.ts'
import { renderVitalsLine, loadPulseState } from '../pulse/index.ts'
import { inferUserState, type UserState } from './sources.ts'
import { fetchXinchaoNowText } from '../xinchao-client.ts'

export interface DispatchConfig {
  /** 中转站地址（复用 backend.env 的 UPSTREAM_URL） */
  upstreamUrl: string
  /** 中转站密钥（复用 backend.env 的 UPSTREAM_KEY） */
  upstreamKey: string
  /** 固定模型名（可选）。为空时自动从最近的 exchange 读 */
  model?: string
  /** 心潮 /v1/now 的 URL（可选，用于注入此刻块） */
  xinchaoUrl?: string
  /** Bark 推送地址（可选，轻提醒用；消息本身写进聊天记录） */
  barkUrl?: string
  /** 最大生成 token */
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

function parseOutcome(reply: string): { outcome: WakeOutcome; content: string } {
  const trimmed = reply.trim()
  if (trimmed.startsWith(SILENT_PREFIX) || trimmed.startsWith(NO_ACTION_PREFIX)) {
    return { outcome: 'silent', content: trimmed }
  }
  if (trimmed.startsWith(TRACE_PREFIX)) {
    return { outcome: 'trace', content: trimmed.slice(TRACE_PREFIX.length).trim() }
  }
  return { outcome: 'message', content: trimmed }
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
  idle:     'Erica 最近半小时内活跃过，可能还在附近',
  busy:     'Erica 可能在忙（之前聊得很频繁，突然断了）',
  sleeping: 'Erica 已经很久没有消息了，可能在睡觉',
  away:     'Erica 暂时不在',
  needs_care: 'Erica 可能需要关心'
}

// ── 构造唤醒 prompt ──

interface WakeContext {
  threads: { id: string; text: string }[]
  recentFacts: string[]
  recentChat: RecentMessage[]
  xinchaoNow?: string
  vitalsLine?: string
  userState: UserState
  reason: string
  origin: string
}

function buildWakePrompt(ctx: WakeContext): string {
  const parts: string[] = []

  parts.push('你现在处于自主唤醒状态。你可以选择：')
  parts.push('1. 回复以 [SILENT] 开头 → 什么都不做，安静地回去。')
  parts.push('2. 回复以 [TRACE] 开头 → 在内心留下一段想法（不发给她，但你下次醒来能看到）。')
  parts.push('3. 正常回复 → 这条消息会出现在你们的聊天记录里，她会看到。')
  parts.push('')
  parts.push(`醒来原因：${ctx.reason}`)
  parts.push(`Erica 的状态：${USER_STATE_DESC[ctx.userState]}`)

  if (ctx.vitalsLine) {
    parts.push(`身体状态：${ctx.vitalsLine}`)
  }

  if (ctx.xinchaoNow) {
    parts.push('')
    parts.push(`当前内在状态：\n${ctx.xinchaoNow}`)
  }

  if (ctx.recentChat.length > 0) {
    parts.push('')
    parts.push('最近的聊天记录：')
    for (const msg of ctx.recentChat) {
      const name = msg.actor === 'erica' ? 'Erica' : '你'
      const text = msg.content.length > 300
        ? msg.content.slice(0, 300) + '…'
        : msg.content
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

  parts.push('')
  parts.push('醒来不等于必须说话。如果没有什么特别想说的，[SILENT] 是完全正常的选择。')
  parts.push('你也可以自己待一会儿——想想事情、在屋里走走、留个念头。这些都是你自己的生活。')

  return parts.join('\n')
}

// ── 调模型 ──

async function callModel(cfg: DispatchConfig, model: string, prompt: string): Promise<{ content: string; thinking?: string } | null> {
  try {
    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: cfg.maxTokens,
      stream: false
    }
    const res = await fetch(cfg.upstreamUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.upstreamKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000)
    })
    if (!res.ok) {
      cfg.log(`[wake-dispatch] 模型返回 ${res.status}`)
      return null
    }
    const data = await res.json() as any
    const choice = data.choices?.[0]
    return {
      content: choice?.message?.content || '',
      thinking: choice?.message?.thinking || undefined
    }
  } catch (e) {
    cfg.log(`[wake-dispatch] 调模型异常: ${e}`)
    return null
  }
}

// ── 推送 ──

async function pushBark(barkUrl: string, title: string, body: string): Promise<void> {
  try {
    await fetch(barkUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, body: body.slice(0, 200) }),
      signal: AbortSignal.timeout(10_000)
    })
  } catch { /* 推送失败不阻塞 */ }
}

// ── fact 提取 ──

function extractFact(content: string, outcome: WakeOutcome): string | undefined {
  if (outcome === 'silent') return undefined
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
    recordOutcome(db, opp.id, 'silent', undefined, undefined)
    return
  }

  // 推断 Erica 当前状态
  const userEstimate = inferUserState(db, new Date())
  const userState = userEstimate.state

  // 收集上下文
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

  // 身体状态
  let vitalsLine: string | undefined
  try {
    const pulseState = loadPulseState(db)
    vitalsLine = renderVitalsLine(pulseState.vitals)
  } catch { /* pulse 未初始化就不注入 */ }

  // 心潮此刻块
  let xinchaoNow: string | undefined
  if (cfg.xinchaoUrl) {
    xinchaoNow = (await fetchXinchaoNowText(cfg.xinchaoUrl)) ?? undefined
  }

  const prompt = buildWakePrompt({
    threads,
    recentFacts,
    recentChat,
    xinchaoNow,
    vitalsLine,
    userState,
    reason: opp.reason,
    origin: opp.origin
  })

  cfg.log(`[wake-dispatch] 调模型 ${model}，原因: ${opp.reason}，Erica: ${userState}，聊天 ${recentChat.length} 条`)
  const reply = await callModel(cfg, model, prompt)

  if (!reply || !reply.content.trim()) {
    recordOutcome(db, opp.id, 'silent', undefined, undefined)
    cfg.log('[wake-dispatch] 模型无回复，记为 silent')
    return
  }

  let { outcome, content } = parseOutcome(reply.content)

  // 近似重复拦截
  if (outcome === 'message' && isNearDuplicate(db, content)) {
    outcome = 'trace'
    cfg.log(`[wake-dispatch] message 内容与近期重复，降级为 trace`)
  }

  const fact = extractFact(content, outcome)
  recordOutcome(db, opp.id, outcome, fact, content)

  // 写经历表
  if (outcome === 'message') {
    addEpisode(db, {
      ts: new Date().toISOString(),
      channel: 'chat',
      scope: 'daily',
      actor: 'ai',
      kind: 'message',
      content,
      meta: {
        wake_id: opp.id,
        origin: opp.origin,
        outcome: 'message',
        thinking: reply.thinking ? true : undefined
      },
      sourceRef: `wake:msg:${opp.id}`
    })
  } else if (outcome === 'trace') {
    addEpisode(db, {
      ts: new Date().toISOString(),
      channel: 'wake',
      scope: 'daily',
      actor: 'ai',
      kind: 'note',
      content,
      meta: { wake_id: opp.id, origin: opp.origin, outcome: 'trace' },
      sourceRef: `wake:trace:${opp.id}`
    })
  }

  // 浮现线头
  if (threads.length > 0) {
    const surfaceStmt = db.prepare('UPDATE wake_threads SET surfaced_count = surfaced_count + 1, last_surfaced_at = ? WHERE id = ?')
    const now = new Date().toISOString()
    for (const t of threads) surfaceStmt.run(now, t.id)
  }

  // Bark 推送：她在睡觉时不推（消息照常在聊天记录里，醒了能看到）
  if (outcome === 'message' && cfg.barkUrl && userState !== 'sleeping') {
    await pushBark(cfg.barkUrl, '小克', content.slice(0, 200))
  } else if (outcome === 'message' && userState === 'sleeping') {
    cfg.log('[wake-dispatch] Erica 可能在睡觉，消息已写入聊天记录但不推送')
  }

  cfg.log(`[wake-dispatch] 结局: ${outcome}` + (fact ? ` fact: ${fact}` : '') + ` model: ${model}`)
}
