// 聊天引擎：拼上下文、流式解析、多轮工具调用
import { composePrompt } from './prompt-store'
import { type Settings, apiUrl, apiHeaders } from './settings'
import { type McpServer, type ToolCall, buildToolDefinitions, executeToolCall } from './mcp'
import { localToolDefinitions, isLocalTool, runLocalTool } from './local-tools'
import type { ChatMessage, MessageVersion, ToolEvent, ApiTurn } from './db'

const MAX_TOOL_ROUNDS = 8

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
  const text = timeLabel(m.createdAt) + (m.content || (m.images?.length ? '（图片）' : ''))
  if (!m.images?.length) return { role: 'user', content: text }
  return {
    role: 'user',
    content: [
      ...m.images.map(url => ({ type: 'image_url', image_url: { url } })),
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

async function streamOnce(
  settings: Settings, body: any, signal: AbortSignal,
  onText: (delta: string) => void, onThinking: (delta: string) => void
): Promise<StreamResult> {
  const res = await fetch(apiUrl(settings, '/chat/completions'), {
    method: 'POST', headers: apiHeaders(settings), body: JSON.stringify(body), signal
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
  cb: GenerateCallbacks
): Promise<BuiltContext> {
  const ctx = buildContext(history, settings.contextTokens)
  const messages = [...ctx.messages]
  // MCP 工具在前，前端内置工具（状态等）在后
  const tools = [...buildToolDefinitions(servers), ...localToolDefinitions()]
  version.content = ''
  version.thinking = ''
  version.tools = []
  version.trail = []
  const emit = () => cb.onUpdate(version)

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const body: any = { model: settings.model, messages, stream: true }
    if (tools.length) body.tools = tools

    // 多轮之间用空行隔开，展示时会拆成不同气泡
    if (round > 0 && version.content && !version.content.endsWith('\n\n')) version.content += '\n\n'

    const r = await streamOnce(settings, body, signal,
      d => { version.content += d; emit() },
      d => { version.thinking += d; emit() })

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
      const res = isLocalTool(c.name) ? runLocalTool(c) : await executeToolCall(servers, c)
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      ev.result = res.content
      ev.isError = res.is_error
      ev.status = res.is_error ? 'error' : 'done'
      turn.tool_results.push({ tool_call_id: c.id, content: res.content })
      messages.push({ role: 'tool', tool_call_id: c.id, content: res.content })
      emit()
    }
    version.trail!.push(turn)

    if (round === MAX_TOOL_ROUNDS - 1) {
      version.content += `\n\n（工具调用已连续 ${MAX_TOOL_ROUNDS} 轮，先停在这里）`
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
