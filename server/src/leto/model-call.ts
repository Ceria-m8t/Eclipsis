// Leto 应答器的真实模型调用：OpenAI chat/completions（非流式），带工具。
// 复用 Wake 的 upstreamUrl/upstreamKey（backend.env 的 UPSTREAM_URL/KEY）。
// 解析 tool_calls，交给 responder 的循环。
import type { CallModel, ChatMessage, ModelResponse, ToolCall } from './responder.ts'

export interface ModelCallConfig {
  upstreamUrl: string
  upstreamKey: string
  model: string
  maxTokens: number
  timeoutMs?: number
  log?: (msg: string) => void
}

/** 从上游非流式响应里解析出 content + tool_calls */
export function parseModelResponse(data: any): ModelResponse {
  const choice = data?.choices?.[0]
  const msg = choice?.message ?? {}
  const content = typeof msg.content === 'string' ? msg.content : ''
  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
  const toolCalls: ToolCall[] = rawCalls
    .filter((tc: any) => tc?.function?.name)
    .map((tc: any, i: number) => ({
      id: String(tc.id || `call_${i}`),
      type: 'function' as const,
      function: {
        name: String(tc.function.name),
        arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {})
      }
    }))
  return {
    content,
    toolCalls,
    finishReason: choice?.finish_reason ?? null,
    thinking: msg.thinking || msg.reasoning_content || undefined
  }
}

/** 造一个绑定了上游配置的 CallModel，交给 runResponder */
export function makeCallModel(cfg: ModelCallConfig): CallModel {
  const log = cfg.log ?? (() => {})
  return async (messages: ChatMessage[], tools: any[]): Promise<ModelResponse> => {
    const body: any = {
      model: cfg.model,
      messages,
      max_tokens: cfg.maxTokens,
      stream: false
    }
    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    const res = await fetch(cfg.upstreamUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.upstreamKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 120_000)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`模型 HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
    }
    const data = await res.json()
    const parsed = parseModelResponse(data)
    log(`[leto-model] finish=${parsed.finishReason} tools=${parsed.toolCalls.length} content=${parsed.content.slice(0, 60)}`)
    return parsed
  }
}
