// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { splitBubbles, renderMd } from '../src/markdown'
import { buildContext, generate, estimateTokens, timeLabel } from '../src/chat-engine'
import { buildToolDefinitions, type McpServer } from '../src/mcp'
import type { ChatMessage, MessageVersion } from '../src/db'
import { getSettings } from '../src/settings'

// ---------- 帮助函数 ----------
let seq = 0
function user(content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  seq++
  return { id: 'u' + seq, seq, role: 'user', createdAt: Date.UTC(2026, 9, 15, 6, seq), content, ...extra }
}
function ai(content: string, v: Partial<MessageVersion> = {}): ChatMessage {
  seq++
  return {
    id: 'a' + seq, seq, role: 'assistant', createdAt: Date.UTC(2026, 9, 15, 6, seq), content,
    versions: [{ content, createdAt: 0, ...v }], activeVersion: 0
  }
}

// 用一组 SSE 分片伪造一次流式响应
function sse(chunks: any[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  // 故意切成不对齐的小段，模拟网络分包
  const bytes = new TextEncoder().encode(body)
  const stream = new ReadableStream({
    start(ctrl) {
      for (let i = 0; i < bytes.length; i += 37) ctrl.enqueue(bytes.slice(i, i + 37))
      ctrl.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const delta = (d: any, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] })

beforeEach(() => { localStorage.clear(); seq = 0 })

// ---------- 气泡拆分 ----------
describe('splitBubbles', () => {
  it('普通文字按行拆', () => {
    expect(splitBubbles('你好\n今天怎么样\n\n我想你了')).toEqual(['你好', '今天怎么样', '我想你了'])
  })
  it('代码块整块不拆，内部空行保留', () => {
    expect(splitBubbles('看：\n```js\na\n\nb\n```\n好')).toEqual(['看：', '```js\na\n\nb\n```', '好'])
  })
  it('列表、表格、引用各自成块', () => {
    expect(splitBubbles('- 一\n- 二\n\n- 三\n完')).toEqual(['- 一\n- 二\n- 三', '完'])
    expect(splitBubbles('| a |\n|---|\n| 1 |\n后')).toEqual(['| a |\n|---|\n| 1 |', '后'])
    expect(splitBubbles('> x\n> y\n正文')).toEqual(['> x\n> y', '正文'])
  })
  it('标题跟着下一行', () => {
    expect(splitBubbles('## 标题\n内容\n下一行')).toEqual(['## 标题\n内容', '下一行'])
  })
  it('流式中未闭合的代码块自动补上结尾', () => {
    expect(splitBubbles('```py\nprint(1)')).toEqual(['```py\nprint(1)\n```'])
  })
})

describe('renderMd', () => {
  it('代码块带高亮和复制按钮', () => {
    const html = renderMd('```js\nconst a = 1\n```')
    expect(html).toContain('code-copy')
    expect(html).toContain('hljs-keyword')
  })
  it('过滤脚本', () => {
    expect(renderMd('<img src=x onerror=alert(1)><script>alert(1)</script>')).not.toMatch(/onerror|<script/)
  })
})

// ---------- 上下文 ----------
describe('buildContext', () => {
  it('user 消息带时间戳前缀，系统提示词在最前', () => {
    const c = buildContext([user('hi')], 100000)
    expect(c.messages[0].role).toBe('system')
    expect(c.messages[1].content).toMatch(/^（2026-10-15 \d{2}:\d{2}）hi$/)
  })
  it('超出预算时丢最旧的，且不会以 assistant 开头', () => {
    const h: ChatMessage[] = []
    for (let i = 0; i < 20; i++) { h.push(user('问题'.repeat(50))); h.push(ai('回答'.repeat(50))) }
    const c = buildContext(h, 1000)
    expect(c.droppedCount).toBeGreaterThan(0)
    expect(c.messages[1].role).toBe('user')
    expect(c.historyTokens).toBeLessThanOrEqual(1000)
    expect(h.length).toBe(40)   // 本地记录不受影响
  })
  it('带工具调用的回复按原轮次回放', () => {
    const m = ai('结果是 3', {
      tools: [{ id: 't1', name: 'add', args: '{}', status: 'done', result: '3' }],
      trail: [
        { content: '我算一下', tool_calls: [{ id: 't1', type: 'function', function: { name: 'add', arguments: '{"a":1,"b":2}' } }], tool_results: [{ tool_call_id: 't1', content: '3' }] },
        { content: '结果是 3' }
      ]
    })
    const c = buildContext([user('1+2'), m], 100000)
    expect(c.messages.slice(2).map((x: any) => x.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(c.messages[2].tool_calls[0].function.name).toBe('add')
    expect(c.messages[3].tool_call_id).toBe('t1')
  })
  it('图片转成 image_url 分片', () => {
    const c = buildContext([user('看', { images: ['data:image/jpeg;base64,xx'] })], 100000)
    expect(c.messages[1].content[0].type).toBe('image_url')
  })
})

describe('estimateTokens', () => {
  it('中文按字、英文按 4 字符估算', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })
})

describe('timeLabel', () => {
  it('符合网关 timeline 解析格式', () => {
    expect(timeLabel(new Date(2026, 0, 5, 9, 7).getTime())).toBe('（2026-01-05 09:07）')
  })
})

// ---------- 工具定义 ----------
describe('buildToolDefinitions', () => {
  it('输出 OpenAI function 格式，跳过停用的服务器和重名工具', () => {
    const servers: McpServer[] = [
      { id: 's1', name: 'a', url: '', token: '', enabled: true, tools: [
        { name: 'search', description: 'd', input_schema: { type: 'object', properties: { q: { type: 'string' } } }, serverId: 's1' },
        { name: 'noschema', description: '', input_schema: {}, serverId: 's1' }
      ] },
      { id: 's2', name: 'b', url: '', token: '', enabled: true, tools: [{ name: 'search', description: 'dup', input_schema: {}, serverId: 's2' }] },
      { id: 's3', name: 'c', url: '', token: '', enabled: false, tools: [{ name: 'off', description: '', input_schema: {}, serverId: 's3' }] }
    ]
    const defs = buildToolDefinitions(servers)
    expect(defs.map(d => d.function.name)).toEqual(['search', 'noschema'])
    expect(defs[0]).toMatchObject({ type: 'function', function: { parameters: { type: 'object' } } })
    expect(defs[1].function.parameters).toEqual({ type: 'object', properties: {} })
  })
})

// ---------- 生成流程（伪造网关 + MCP）----------
describe('generate', () => {
  const server: McpServer = {
    id: 'm', name: 'calc', url: 'http://mcp.test/mcp', token: 'tok', enabled: true,
    tools: [{ name: 'add', description: '', input_schema: { type: 'object' }, serverId: 'm' }]
  }

  it('工具调用：参数分片拼接（后续分片不带 id）→ 调 MCP → 第二轮回复', async () => {
    const requests: any[] = []
    let chatRound = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body)
      if (url.startsWith('http://mcp.test')) {
        if (body.method === 'initialize') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess1' } })
        }
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        expect(init.headers['Mcp-Session-Id']).toBe('sess1')
        expect(init.headers['Accept']).toContain('text/event-stream')
        expect(body.params).toEqual({ name: 'add', arguments: { a: 1, b: 2 } })
        // MCP 用 SSE 回包
        return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '3' }] } })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } })
      }
      requests.push(body)
      chatRound++
      if (chatRound === 1) {
        return sse([
          delta({ role: 'assistant', content: '我算一下' }),
          delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'add', arguments: '' } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: '{"a":1,' } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: '"b":2}' } }] }),
          delta({}, 'tool_calls')
        ])
      }
      return sse([delta({ content: '等于 3' }), delta({}, 'stop')])
    }))

    const v: MessageVersion = { content: '', createdAt: 0 }
    const updates: string[] = []
    await generate(getSettings(), [user('1+2=?')], [server], new AbortController().signal, v, { onUpdate: x => updates.push(x.content) })

    expect(requests).toHaveLength(2)
    expect(requests[0].tools[0].type).toBe('function')
    // 第二轮把 assistant(tool_calls) + tool 结果带上
    const tail = requests[1].messages.slice(-2)
    expect(tail[0]).toMatchObject({ role: 'assistant', content: '我算一下', tool_calls: [{ id: 'call_1', function: { name: 'add', arguments: '{"a":1,"b":2}' } }] })
    expect(tail[1]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '3' })

    expect(v.content).toBe('我算一下\n\n等于 3')
    expect(v.tools).toEqual([{ id: 'call_1', name: 'add', args: '{"a":1,"b":2}', status: 'done', result: '3', isError: false }])
    expect(v.trail).toHaveLength(2)
    expect(updates.length).toBeGreaterThan(2)
    vi.unstubAllGlobals()
  })

  it('同源 /api 时不发 Authorization（由 nginx 注入）', async () => {
    let headers: any
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      expect(url).toBe('/api/chat/completions')
      headers = init.headers
      return sse([delta({ content: 'hi' }), delta({}, 'stop')])
    }))
    const v: MessageVersion = { content: '', createdAt: 0 }
    await generate(getSettings(), [user('hi')], [], new AbortController().signal, v, { onUpdate: () => {} })
    expect(headers.Authorization).toBeUndefined()
    expect(v.content).toBe('hi')
    expect(v.trail).toBeUndefined()   // 没有工具调用时不存 trail
    vi.unstubAllGlobals()
  })

  it('网关报错时抛出带状态码的错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream down', { status: 502 })))
    const v: MessageVersion = { content: '', createdAt: 0 }
    await expect(generate(getSettings(), [user('hi')], [], new AbortController().signal, v, { onUpdate: () => {} }))
      .rejects.toThrow(/502/)
    vi.unstubAllGlobals()
  })
})
