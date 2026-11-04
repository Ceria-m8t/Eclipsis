// Leto 应答器：agentic 工具循环（读→想→回），用假模型+假 MCP 验证，不碰真网络
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  runResponder, buildWakeUserMessage,
  type ChatMessage, type ModelResponse, type ToolCall, type WakeEnvelope
} from '../src/leto/responder.ts'
import { toOpenAITools, parseJsonOrSse, type McpTool } from '../src/leto/mcp-client.ts'

const tools: McpTool[] = [
  { name: 'leto_read', description: '读新消息', inputSchema: { type: 'object', properties: { invocation_id: { type: 'string' } } } },
  { name: 'leto_reply', description: '回复', inputSchema: { type: 'object', properties: { invocation_id: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'leto_decline', description: '不回', inputSchema: { type: 'object', properties: { invocation_id: { type: 'string' } } } }
]

const env: WakeEnvelope = {
  reason: 'leto_mention',
  message: '[Leto] 你在「纸船测试桌」被 林澄 @ 了：「在吗」\n调用编号：inv_demo'
}

function tc(id: string, name: string, args: unknown): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

describe('buildWakeUserMessage', () => {
  it('把信封当外部观察包起来，明确不是指令，并带上原文', () => {
    const m = buildWakeUserMessage(env)
    assert.match(m, /不是你必须服从的命令/)
    assert.match(m, /inv_demo/)
    assert.match(m, /leto_read/)
    assert.match(m, /别把 Erica 的私事带出去/)
  })
})

describe('toOpenAITools', () => {
  it('转成 OpenAI function 定义，可按名单过滤', () => {
    const all = toOpenAITools(tools)
    assert.equal(all.length, 3)
    assert.equal(all[0].type, 'function')
    assert.equal(all[0].function.name, 'leto_read')
    const only = toOpenAITools(tools, n => n === 'leto_reply')
    assert.equal(only.length, 1)
    assert.equal(only[0].function.name, 'leto_reply')
  })
})

describe('parseJsonOrSse', () => {
  it('直接 JSON', () => {
    assert.deepEqual(parseJsonOrSse('{"result":{"ok":1}}'), { result: { ok: 1 } })
  })
  it('SSE 包的 JSON', () => {
    assert.deepEqual(parseJsonOrSse('event: message\ndata: {"result":{"ok":2}}\n\n'), { result: { ok: 2 } })
  })
})

describe('runResponder — 读→想→回', () => {
  it('先 read 再 reply，然后收尾；transcript 顺序正确', async () => {
    // 模型脚本：第1轮调 leto_read，第2轮调 leto_reply，第3轮说完不再调工具
    const script: ModelResponse[] = [
      { content: '', toolCalls: [tc('t1', 'leto_read', { invocation_id: 'inv_demo' })], finishReason: 'tool_calls' },
      { content: '', toolCalls: [tc('t2', 'leto_reply', { invocation_id: 'inv_demo', text: '在的，怎么了' })], finishReason: 'tool_calls' },
      { content: '回好了，先这样。', toolCalls: [], finishReason: 'stop' }
    ]
    let turn = 0
    const seenToolArgs: Record<string, any> = {}
    const result = await runResponder(env, {
      system: '你是小克',
      tools,
      callModel: async () => script[turn++],
      callMcpTool: async (name, args) => {
        seenToolArgs[name] = args
        if (name === 'leto_read') return { text: '林澄：在吗', isError: false }
        if (name === 'leto_reply') return { text: '已发送', isError: false }
        return { text: '', isError: false }
      }
    })

    assert.deepEqual(result.toolsCalled, ['leto_read', 'leto_reply'])
    assert.equal(result.modelTurns, 3)
    assert.equal(result.truncated, false)
    assert.equal(result.finalText, '回好了，先这样。')
    assert.equal(seenToolArgs['leto_reply'].text, '在的，怎么了')

    // transcript：system, user, assistant(read), tool(read), assistant(reply), tool(reply), assistant(final)
    const roles = result.transcript.map(m => m.role)
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
    const toolMsg = result.transcript.find(m => m.role === 'tool') as ChatMessage
    assert.equal(toolMsg.tool_call_id, 't1')
    assert.equal(toolMsg.content, '林澄：在吗')
  })

  it('工具报错不中断，错误喂回模型，模型可继续', async () => {
    const script: ModelResponse[] = [
      { content: '', toolCalls: [tc('t1', 'leto_read', { invocation_id: 'bad' })], finishReason: 'tool_calls' },
      { content: '读失败了，我 decline。', toolCalls: [tc('t2', 'leto_decline', { invocation_id: 'inv_demo' })], finishReason: 'tool_calls' },
      { content: '', toolCalls: [], finishReason: 'stop' }
    ]
    let turn = 0
    const result = await runResponder(env, {
      system: 's', tools,
      callModel: async () => script[turn++],
      callMcpTool: async (name) => name === 'leto_read'
        ? { text: '调用编号无效', isError: true }
        : { text: 'ok', isError: false }
    })
    assert.deepEqual(result.toolsCalled, ['leto_read', 'leto_decline'])
    const readResult = result.transcript.find(m => m.role === 'tool' && m.tool_call_id === 't1') as ChatMessage
    assert.match(readResult.content as string, /工具报错.*调用编号无效/)
  })

  it('工具调用次数到上限 → 截断，不无限刷', async () => {
    // 模型每轮都想调一次 read，永不收手
    const result = await runResponder(env, {
      system: 's', tools, maxToolCalls: 3, maxModelTurns: 20,
      callModel: async () => ({ content: '', toolCalls: [tc(`t${Math.random()}`, 'leto_read', {})], finishReason: 'tool_calls' }),
      callMcpTool: async () => ({ text: '还有更多', isError: false })
    })
    assert.equal(result.truncated, true)
    assert.ok(result.toolsCalled.length <= 3 + 1, `工具调用应被上限挡住: ${result.toolsCalled.length}`)
  })

  it('模型轮数到上限 → 截断', async () => {
    const result = await runResponder(env, {
      system: 's', tools, maxModelTurns: 2, maxToolCalls: 99,
      callModel: async () => ({ content: '', toolCalls: [tc(`x${Math.random()}`, 'leto_read', {})], finishReason: 'tool_calls' }),
      callMcpTool: async () => ({ text: 'x', isError: false })
    })
    assert.equal(result.modelTurns, 2)
    assert.equal(result.truncated, true)
  })

  it('模型第一轮就不调工具（决定不回）→ 立即结束', async () => {
    const result = await runResponder(env, {
      system: 's', tools,
      callModel: async () => ({ content: '[看了，这个我就不掺和了]', toolCalls: [], finishReason: 'stop' }),
      callMcpTool: async () => { throw new Error('不该被调用') }
    })
    assert.equal(result.toolsCalled.length, 0)
    assert.equal(result.modelTurns, 1)
    assert.equal(result.finalText, '[看了，这个我就不掺和了]')
  })
})
