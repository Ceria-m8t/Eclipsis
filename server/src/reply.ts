// 从上游响应里解析出回复（OpenAI 格式：SSE 流或普通 JSON）。只用于记录，不影响转发。
export interface ToolCallRec { id: string; name: string; arguments: string }

export interface Reply {
  content: string
  thinking: string
  toolCalls: ToolCallRec[]
  finishReason: string | null
  usage: unknown
  error: string | null
  done: boolean          // SSE 收到了 [DONE] 或 finish_reason；JSON 解析成功
}

const empty = (): Reply => ({ content: '', thinking: '', toolCalls: [], finishReason: null, usage: null, error: null, done: false })

function errorText(e: any): string {
  if (!e) return ''
  if (typeof e === 'string') return e
  return e.message || JSON.stringify(e)
}

export function parseSse(text: string): Reply {
  const out = empty()
  const calls = new Map<number, ToolCallRec>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') { out.done = true; continue }
    let obj: any
    try { obj = JSON.parse(data) } catch { continue }
    if (obj.error) out.error = errorText(obj.error)
    if (obj.usage) out.usage = obj.usage
    const choice = obj.choices?.[0]
    if (!choice) continue
    const d = choice.delta || choice.message || {}
    const think = d.reasoning_content ?? d.reasoning ?? d.thinking
    if (typeof think === 'string') out.thinking += think
    if (typeof d.content === 'string') out.content += d.content
    for (const tc of d.tool_calls || []) {
      const idx = tc.index ?? calls.size
      const cur = calls.get(idx) || { id: '', name: '', arguments: '' }
      if (tc.id) cur.id = tc.id
      if (tc.function?.name) cur.name += tc.function.name
      if (tc.function?.arguments) cur.arguments += tc.function.arguments
      calls.set(idx, cur)
    }
    if (choice.finish_reason) { out.finishReason = choice.finish_reason; out.done = true }
  }
  out.toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c).filter(c => c.name)
  return out
}

export function parseJson(text: string): Reply {
  const out = empty()
  let obj: any
  try { obj = JSON.parse(text) } catch { out.error = text.slice(0, 2000); return out }
  if (obj.error) { out.error = errorText(obj.error); return out }
  const choice = obj.choices?.[0]
  const msg = choice?.message || {}
  out.content = typeof msg.content === 'string' ? msg.content : ''
  const think = msg.reasoning_content ?? msg.reasoning ?? msg.thinking
  out.thinking = typeof think === 'string' ? think : ''
  out.toolCalls = (msg.tool_calls || []).map((tc: any) => ({
    id: tc.id || '', name: tc.function?.name || '', arguments: tc.function?.arguments || ''
  })).filter((c: ToolCallRec) => c.name)
  out.finishReason = choice?.finish_reason ?? null
  out.usage = obj.usage ?? null
  out.done = true
  return out
}

export function parseReply(contentType: string, text: string): Reply {
  return contentType.includes('text/event-stream') || /^\s*data:/.test(text) ? parseSse(text) : parseJson(text)
}
