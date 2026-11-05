// 醒来时的工具循环（2026-11-06）。
//
// 调模型 → 有工具调用就执行 → 把结果喂回 → 再调模型 → 直到他不再调工具（或到上限）。
// 他手边一直有：send_to_erica（发消息给她，发完不结束）+ 每个箱子的入口（open_*）。
// 打开一个箱子，下一轮起那个箱子的工具才出现在工具清单里。
//
// 纯逻辑：模型、发消息、箱子都由调用方注入（dispatch.ts），方便测试。
import type { ChatMessage, ModelResponse, ToolCall } from '../leto/responder.ts'
import { toOpenAITools } from '../leto/mcp-client.ts'
import type { WakeBox, ToolResult } from './boxes.ts'

export const SEND_TOOL = 'send_to_erica'

export type WakeModelResult = { ok: true; resp: ModelResponse } | { ok: false; error: string }

export interface WakeAgentDeps {
  boxes: WakeBox[]
  /** 调一次模型（重试由调用方处理）。tools 是 OpenAI function 定义 */
  callModel: (messages: ChatMessage[], tools: any[]) => Promise<WakeModelResult>
  /** 发一条给她。返回没发出去的原因（比如和最近发的太像、推送失败） */
  send: (text: string) => Promise<{ ok: true } | { ok: false; reason: string }>
  /** 最多调几轮模型，默认 30 */
  maxModelTurns?: number
  /** 一次醒来最多发几条，默认 5 */
  maxMessages?: number
  log?: (m: string) => void
}

export interface WakeAgentResult {
  /** 发出去了的每一条 */
  sent: string[]
  /** 他最后不再调工具时说的话（原样，没剥思维链） */
  finalText: string
  /** 调过的工具名，按顺序（含入口和 send_to_erica） */
  toolsUsed: string[]
  modelTurns: number
  /** 到了轮数上限还没停 */
  truncated: boolean
  /** 中途模型调用失败 / 回复被截断 */
  error?: string
}

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } })

export async function runWakeAgent(initial: ChatMessage[], deps: WakeAgentDeps): Promise<WakeAgentResult> {
  const log = deps.log ?? (() => {})
  const maxTurns = deps.maxModelTurns ?? 30
  const maxMessages = deps.maxMessages ?? 5

  const entries = new Map(deps.boxes.map(b => [b.entryName, b]))
  const owner = new Map<string, WakeBox>()   // 已打开箱子里的工具名 → 箱子
  const openedDefs: any[] = []
  const opened = new Set<string>()

  const baseDefs = [
    fn(SEND_TOOL, `发一条消息给她，会推送到她手机上。发完这次醒来不会结束，你还可以接着做别的；一次醒来最多发 ${maxMessages} 条。`,
      { text: { type: 'string', description: '要跟她说的话' } }, ['text']),
    ...deps.boxes.map(b => fn(b.entryName, b.entryDescription))
  ]

  const messages: ChatMessage[] = [...initial]
  const sent: string[] = []
  const toolsUsed: string[] = []
  let modelTurns = 0
  let finalText = ''
  let error: string | undefined
  let finished = false

  const runTool = async (tc: ToolCall): Promise<string> => {
    const name = tc.function.name
    let args: Record<string, unknown> = {}
    try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {} } catch { /* 当空参数，让工具自己报错 */ }

    if (name === SEND_TOOL) {
      const text = String(args.text ?? '').trim()
      if (!text) return '（没发：text 是空的）'
      if (sent.length >= maxMessages) return `（没发：这次醒来已经发了 ${sent.length} 条，到上限了）`
      const r = await deps.send(text)
      if (!r.ok) return `（没发出去：${r.reason}）`
      sent.push(text)
      return '发出去了，推送到了她手机上。'
    }

    const box = entries.get(name)
    if (box) {
      if (opened.has(box.id)) return `${box.entryName} 已经打开了，里面的工具可以直接用。`
      let tools
      try { tools = await box.listTools() } catch (e: any) { return `（打不开：${String(e?.message || e)}）` }
      const fresh = tools.filter(t => t.name !== SEND_TOOL && !entries.has(t.name) && !owner.has(t.name))
      for (const t of fresh) owner.set(t.name, box)
      openedDefs.push(...toOpenAITools(fresh))
      opened.add(box.id)
      log(`[wake-agent] 打开 ${box.id}：${fresh.length} 个工具`)
      return `打开了。现在可以用：${fresh.map(t => t.name).join('、') || '（里面是空的）'}`
    }

    const ob = owner.get(name)
    if (!ob) return `（没有 ${name} 这个工具。箱子里的工具要先用对应的 open_ 入口打开）`
    let r: ToolResult
    try { r = await ob.call(name, args) } catch (e: any) { return `（调用失败：${String(e?.message || e)}）` }
    return r.isError ? `（工具报错）${r.text}` : r.text
  }

  while (modelTurns < maxTurns) {
    modelTurns++
    const r = await deps.callModel(messages, [...baseDefs, ...openedDefs])
    if (!r.ok) { error = r.error; break }
    const resp = r.resp
    messages.push({ role: 'assistant', content: resp.content || null, ...(resp.toolCalls.length ? { tool_calls: resp.toolCalls } : {}) })

    if (resp.toolCalls.length === 0) {
      if (resp.finishReason === 'length') { error = '回复被截断'; break }
      finalText = resp.content || ''
      finished = true
      break
    }

    for (const tc of resp.toolCalls) {
      toolsUsed.push(tc.function.name)
      const result = await runTool(tc)
      log(`[wake-agent] ${tc.function.name} → ${result.slice(0, 80).replace(/\n/g, ' ')}`)
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result })
    }
  }

  const truncated = !finished && !error
  if (truncated) log(`[wake-agent] 到了 ${maxTurns} 轮上限还没停`)
  return { sent, finalText, toolsUsed, modelTurns, truncated, error }
}
