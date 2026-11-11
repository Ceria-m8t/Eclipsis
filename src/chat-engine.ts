// 聊天引擎：拼上下文、流式解析、多轮工具调用
import { composePrompt } from './prompt-store'
import { type Settings, apiUrl, apiHeaders } from './settings'
import { heartMarker } from './chat-store'
import { boxEntries, entryDefinition, openBox, callBoxTool } from './toolbox'
import { type McpServer, type ToolCall, buildToolDefinitions, executeToolCall } from './mcp'
import { localToolDefinitions, isLocalTool, runLocalTool } from './local-tools'
import type { ChatMessage, MessageVersion, ToolEvent, ApiTurn } from './db'

// 一轮里最多连着用几次工具（设置页可调；每一次 = 给中转站多发一次请求）。
// 2026-11-11 Erica 报的：他在小镇逛到第 8 次就断在「到了商店。看看有什么卖的。」——
// 以前到上限是调完最后一个工具就收摊，结果她那边像话没说完，他也不知道为什么停。
const DEFAULT_TOOL_ROUNDS = 12
// 上限的上限。真正卡住的不是这个数，是 iOS 会把后台的网页进程杀掉（一轮 40 次请求 ≈ 五分钟以上），
// 以及按次计费时一轮就按次数花钱。转成原生壳（后台能跑、能推送）之后可以再往上放。
const MAX_TOOL_ROUNDS_CAP = 60

/** 到上限时挂在最后一条工具结果后面，让他自己把话收住（不是她说的） */
export const toolCapNote = (n: number) =>
  `〔系统提示，不是她说的：这一轮的工具用到上限了（${n} 次），接下来不能再调了。` +
  `用一两句话把现在的情况告诉她，这一轮就先结束；还想接着做就等她回你。〕`

// ===== token 估算 =====
// 不引入 tokenizer：中日韩字符约 1 token/字，其他约 4 字符/token。误差 ±20% 左右，用来截断够用。
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g) || []).length
  return Math.ceil(cjk + (text.length - cjk) / 4)
}
const IMAGE_TOKENS = 1000

// ===== 时间戳前缀 =====
// Dylan 网关靠 "（YYYY-MM-DD HH:mm）" 前缀建 timeline，界面上不显示
export function timeLabel(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `（${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}）`
}

// ===== 系统提示词 + 世界书 =====
export function buildSystemPrompt(): string {
  type Entry = { content: string; enabled: boolean; group: string; position: string; priority: number }
  let before: Entry[] = []
  let after: Entry[] = []
  try {
    const entries: Entry[] = JSON.parse(localStorage.getItem('worldbook') || '[]')
    const groups: Record<string, { enabled: boolean }> = JSON.parse(localStorage.getItem('worldbook-groups') || '{}')
    for (const e of entries) {
      if (!e.enabled || groups[e.group]?.enabled === false) continue
      ;(e.position === 'before' ? before : after).push(e)
    }
  } catch {}
  const byPri = (a: Entry, b: Entry) => (b.priority ?? 50) - (a.priority ?? 50)
  before.sort(byPri)
  after.sort(byPri)
  return [...before.map(e => e.content), composePrompt(), ...after.map(e => e.content)]
    .filter(Boolean).join('\n\n').trim()
}

// ===== 把本地消息转成 API 消息 =====
function userToApi(m: ChatMessage): any {
  // 心声拼在她这条的末尾（他隐约感知）；只有心声、嘴上什么都没说时正文是空的
  const heart = m.thought ? (m.content ? '\n\n' : '') + heartMarker(m.thought) : ''
  // 后端来的图片是 /api/eclipsis/blob/… 的地址，模型拿不到：发之前取回成 dataURL（imageData）；手机上刚选的图本来就是 dataURL
  const imgs = m.imageData?.length ? m.imageData : (m.images || []).filter(u => u.startsWith('data:'))
  // 原文里有「[图片]」占位行（第一次发时记下的），真图跟着发的时候去掉
  const raw = m.raw !== undefined && imgs.length ? m.raw.split('\n').filter(l => l.trim() !== '[图片]').join('\n') : m.raw
  const text = raw ?? timeLabel(m.createdAt) + (m.content || (m.thought ? '' : m.images?.length ? '（图片）' : '')) + heart
  if (!imgs.length) return { role: 'user', content: text }
  return {
    role: 'user',
    content: [
      ...imgs.map(url => ({ type: 'image_url', image_url: { url } })),
      { type: 'text', text }
    ]
  }
}

function activeVersion(m: ChatMessage): MessageVersion | undefined {
  return m.versions?.[m.activeVersion ?? 0]
}

function assistantToApi(m: ChatMessage): any[] {
  const v = activeVersion(m)
  if (v?.trail?.length) {
    // 有工具调用：按原样回放每一轮
    const out: any[] = []
    for (const t of v.trail) {
      if (t.tool_calls?.length) {
        out.push({ role: 'assistant', content: t.content || '', tool_calls: t.tool_calls })
        for (const r of t.tool_results || []) out.push({ role: 'tool', tool_call_id: r.tool_call_id, content: r.content })
      } else if (t.content) {
        out.push({ role: 'assistant', content: t.content })
      }
    }
    return out
  }
  const content = v?.content ?? m.content
  return content ? [{ role: 'assistant', content }] : []
}

function msgTokens(apiMsgs: any[]): number {
  let n = 0
  for (const m of apiMsgs) {
    if (typeof m.content === 'string') n += estimateTokens(m.content)
    else if (Array.isArray(m.content)) {
      for (const p of m.content) n += p.type === 'text' ? estimateTokens(p.text) : IMAGE_TOKENS
    }
    if (m.tool_calls) n += estimateTokens(JSON.stringify(m.tool_calls))
    n += 4
  }
  return n
}

export interface BuiltContext {
  messages: any[]
  historyTokens: number
  systemTokens: number
  droppedCount: number   // 因超出预算没发出去的旧消息条数（本地记录不受影响）
}

// 从最新往回取，直到超出预算。只影响发给模型的内容，不删本地记录。
export function buildContext(history: ChatMessage[], budget: number): BuiltContext {
  const system = buildSystemPrompt()
  const groups: any[][] = []
  let used = 0
  let i = history.length - 1
  for (; i >= 0; i--) {
    const m = history[i]
    if (m.error && !activeVersion(m)?.content) continue
    const api = m.role === 'user' ? [userToApi(m)] : assistantToApi(m)
    if (!api.length) continue
    const t = msgTokens(api)
    if (used + t > budget && groups.length > 0) break
    used += t
    groups.unshift(api)
  }
  // 开头不能是孤立的 assistant/tool，从第一条 user 开始
  let flat = groups.flat()
  const firstUser = flat.findIndex(m => m.role === 'user')
  if (firstUser > 0) flat = flat.slice(firstUser)
  return {
    messages: [{ role: 'system', content: system }, ...flat],
    historyTokens: used,
    systemTokens: estimateTokens(system),
    droppedCount: Math.max(0, i + 1)
  }
}

// ===== 流式请求 =====
interface StreamResult {
  content: string
  thinking: string
  toolCalls: ToolCall[]
  finishReason: string
}

// 告诉后端这一轮在哪个场景、属于哪条回复。只在走同源 /api 时带：
// 直连其他 API 时带自定义 header 会触发跨域预检
export interface TurnMeta {
  scene: string          // chat / room / creative / game / work …
  conversation: string
  turn: string           // 这条 assistant 消息的 id（重新生成时不变）
  version: number        // 第几个版本（重新生成 +1）
}

export function turnHeaders(settings: Settings, meta?: TurnMeta): Record<string, string> {
  if (!meta || settings.apiBase) return {}
  return {
    'X-Eclipsis-Scene': meta.scene,
    'X-Eclipsis-Conversation': meta.conversation,
    'X-Eclipsis-Turn': meta.turn,
    'X-Eclipsis-Version': String(meta.version)
  }
}

async function streamOnce(
  settings: Settings, body: any, signal: AbortSignal,
  onText: (delta: string) => void, onThinking: (delta: string) => void,
  meta?: TurnMeta
): Promise<StreamResult> {
  const res = await fetch(apiUrl(settings, '/chat/completions'), {
    method: 'POST', headers: { ...apiHeaders(settings), ...turnHeaders(settings, meta) }, body: JSON.stringify(body), signal
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`[${res.status}] ${t.slice(0, 500)}`)
  }
  if (!res.body) throw new Error('响应没有内容')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const out: StreamResult = { content: '', thinking: '', toolCalls: [], finishReason: '' }
  // 流里的 tool_calls 按 index 拼接；后续分片不一定带 id
  const calls = new Map<number, { id: string; name: string; args: string }>()

  const handle = (data: string) => {
    if (data === '[DONE]') return
    let parsed: any
    try { parsed = JSON.parse(data) } catch { return }
    if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error))
    const choice = parsed.choices?.[0]
    if (!choice) return
    const d = choice.delta || choice.message || {}
    const think = d.reasoning_content ?? d.reasoning ?? d.thinking
    if (typeof think === 'string' && think) { out.thinking += think; onThinking(think) }
    if (typeof d.content === 'string' && d.content) { out.content += d.content; onText(d.content) }
    for (const tc of d.tool_calls || []) {
      const idx = tc.index ?? calls.size
      const cur = calls.get(idx) || { id: '', name: '', args: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name += tc.function.name
      if (tc.function?.arguments) cur.args += tc.function.arguments
      calls.set(idx, cur)
    }
    if (choice.finish_reason) out.finishReason = choice.finish_reason
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const t = line.trim()
      if (t.startsWith('data:')) handle(t.slice(5).trim())
    }
  }
  if (buffer.trim().startsWith('data:')) handle(buffer.trim().slice(5).trim())

  out.toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, c]) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.name, arguments: c.args || '{}' }))
    .filter(c => c.name)
  return out
}

// ===== 一次完整生成（含多轮工具调用）=====
export interface GenerateCallbacks {
  onUpdate: (v: MessageVersion) => void   // 每次有新内容都回调，v 是同一个对象
}

export async function generate(
  settings: Settings,
  history: ChatMessage[],
  servers: McpServer[],
  signal: AbortSignal,
  version: MessageVersion,   // 由调用方创建并持有：中途停止或出错时已生成的部分不会丢
  cb: GenerateCallbacks,
  meta?: TurnMeta
): Promise<BuiltContext> {
  const ctx = buildContext(history, settings.contextTokens)
  const messages = [...ctx.messages]
  // 工具：后端工具箱的入口（打开了才有里面的工具，和醒来同一份）→ 设置页里直接连的旧 MCP → 前端内置（状态等）
  // 直连别的 API（设置里填了 apiBase）时没有后端，不给箱子
  const entries = settings.apiBase ? [] : await boxEntries()
  const entryOf = new Map(entries.map(b => [b.entryName, b]))
  const boxToolOwner = new Map<string, string>()   // 打开过的箱子里的工具名 → 箱子入口
  const tools: any[] = [...entries.map(entryDefinition), ...buildToolDefinitions(servers), ...localToolDefinitions()]
  version.content = ''
  version.thinking = ''
  version.tools = []
  version.trail = []
  const emit = () => cb.onUpdate(version)

  // 打开一个箱子：这一轮接下来都能用里面的工具（和旧 MCP 撞名的，以箱子里的为准）
  async function openBoxForTurn(c: ToolCall) {
    if ([...boxToolOwner.values()].includes(c.name)) return { tool_call_id: c.id, content: '这个箱子已经开着了，里面的工具直接用。' }
    try {
      const r = await openBox(c.name)
      for (const def of r.tools) {
        const name = def.function?.name
        if (!name || entryOf.has(name)) continue
        const i = tools.findIndex(t => t.function?.name === name)
        if (i >= 0) tools.splice(i, 1)
        tools.push(def)
        boxToolOwner.set(name, c.name)
      }
      const names = r.tools.map((d: any) => d.function?.name).filter(Boolean)
      return { tool_call_id: c.id, content: names.length ? `打开了「${r.title}」，里面有：${names.join('、')}。下一步直接调用它们。` : `「${r.title}」里现在没有能用的工具。` }
    } catch (e: any) {
      return { tool_call_id: c.id, content: `打不开：${e.message}`, is_error: true }
    }
  }
  async function runBoxTool(c: ToolCall) {
    let args: Record<string, unknown> = {}
    try { args = c.arguments ? JSON.parse(c.arguments) : {} } catch { return { tool_call_id: c.id, content: `参数不是合法 JSON：${c.arguments}`, is_error: true } }
    try {
      const r = await callBoxTool(boxToolOwner.get(c.name)!, c.name, args)
      const text = r.text.length > 20000 ? r.text.slice(0, 20000) + `\n…[结果过长，已截断，原长 ${r.text.length} 字]` : r.text
      return { tool_call_id: c.id, content: text || '（没有返回内容）', is_error: r.isError }
    } catch (e: any) {
      return { tool_call_id: c.id, content: `调用失败：${e.message}`, is_error: true }
    }
  }

  const maxRounds = Math.min(Math.max(Math.round(settings.toolRounds || DEFAULT_TOOL_ROUNDS), 1), MAX_TOOL_ROUNDS_CAP)
  for (let round = 0; round < maxRounds; round++) {
    // 到上限的这一轮不再给工具，只让他说话收尾（round > 0：第一轮永远给工具）
    const wrapUp = round > 0 && round === maxRounds - 1
    if (wrapUp) {
      const last = messages[messages.length - 1]
      if (last?.role === 'tool' && typeof last.content === 'string') last.content += `\n\n${toolCapNote(maxRounds - 1)}`
    }
    const body: any = { model: settings.model, messages, stream: true }
    if (tools.length && !wrapUp) body.tools = tools

    // 多轮之间用空行隔开，展示时会拆成不同气泡
    if (round > 0 && version.content && !version.content.endsWith('\n\n')) version.content += '\n\n'

    const r = await streamOnce(settings, body, signal,
      d => { version.content += d; emit() },
      d => { version.thinking += d; emit() },
      meta)

    const turn: ApiTurn = { content: r.content }
    if (!r.toolCalls.length) {
      version.trail!.push(turn)
      break
    }

    turn.tool_calls = r.toolCalls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } }))
    turn.tool_results = []
    messages.push({ role: 'assistant', content: r.content || '', tool_calls: turn.tool_calls })

    for (const c of r.toolCalls) {
      const ev: ToolEvent = { id: c.id, name: c.name, args: c.arguments, status: 'running' }
      version.tools!.push(ev)
      emit()
      const res = entryOf.has(c.name) ? await openBoxForTurn(c)
        : boxToolOwner.has(c.name) ? await runBoxTool(c)
        : isLocalTool(c.name) ? await runLocalTool(c) : await executeToolCall(servers, c)
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      ev.result = res.content
      ev.isError = res.is_error
      ev.status = res.is_error ? 'error' : 'done'
      turn.tool_results.push({ tool_call_id: c.id, content: res.content })
      messages.push({ role: 'tool', tool_call_id: c.id, content: res.content })
      emit()
    }
    version.trail!.push(turn)

    // 收尾那一轮没给工具，正常不会走到这儿；真走到了（站无视 tools 照样调）就留一句
    if (round === maxRounds - 1) {
      version.content += `\n\n（工具用到上限 ${maxRounds} 次了，先停在这里）`
      emit()
    }
  }

  finalizeVersion(version)
  return ctx
}

// 收尾：去掉空字段。中途停止时也调用
export function finalizeVersion(v: MessageVersion) {
  v.content = (v.content || '').trim()
  if (!v.tools?.length) { delete v.tools; delete v.trail }
  if (!v.thinking) delete v.thinking
}
