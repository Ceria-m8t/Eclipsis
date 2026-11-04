// Leto 端到端：入站端点 → dispatch → 应答器 → 写群聊经历。假上游 + 假 Leto MCP，不碰真网络。
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { openDb, type DB } from '../src/db.ts'
import { ensurePromptSchema } from '../src/prompts.ts'
import { handleLetoApi, type LetoApiDeps } from '../src/leto/index.ts'
import { buildXiaokeSystem, coreToolsOnly, type LetoAgent } from '../src/leto/agent.ts'
import { listen, close } from './helpers.ts'

// 一个假的"上游中转站 + Leto MCP"二合一服务：按路径分流
function fakeServices(opts: {
  tools: { name: string; description?: string; inputSchema?: any }[]
  modelScript: any[]           // 每次 /chat/completions 依次返回
  mcpResults: Record<string, any>  // tools/call name → result
}): { server: Server; modelCalls: any[]; mcpCalls: any[] } {
  const modelCalls: any[] = []
  const mcpCalls: any[] = []
  let modelTurn = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const payload = body ? JSON.parse(body) : {}
      if (req.url?.includes('/chat/completions')) {
        modelCalls.push(payload)
        const r = opts.modelScript[modelTurn++] ?? { choices: [{ message: { content: '' }, finish_reason: 'stop' }] }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r))
        return
      }
      if (req.url?.endsWith('/mcp')) {
        const method = payload.method
        if (method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: opts.tools } }))
          return
        }
        if (method === 'tools/call') {
          mcpCalls.push(payload.params)
          const name = payload.params?.name
          const result = opts.mcpResults[name] ?? { content: [{ type: 'text', text: 'ok' }] }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
          return
        }
      }
      res.writeHead(404); res.end('{}')
    })
  })
  return { server, modelCalls, mcpCalls }
}

const tools = [
  { name: 'leto_read', description: '读', inputSchema: { type: 'object', properties: { invocation_id: { type: 'string' } } } },
  { name: 'leto_reply', description: '回', inputSchema: { type: 'object', properties: { invocation_id: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'leto_moment_post', description: '发朋友圈', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }
]

function toolCall(id: string, name: string, args: unknown) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

let db: DB
beforeEach(() => { db = openDb(':memory:'); ensurePromptSchema(db) })

function deps(port: number, ingestKey = 'local-secret'): LetoApiDeps {
  const agent: LetoAgent = {
    id: 'xiaoke', name: '小克', token: 'lmt_fake',
    buildSystem: buildXiaokeSystem, allowTool: coreToolsOnly, model: 'test-model'
  }
  return {
    agents: [agent],
    ingestKey,
    dispatchConfig: {
      letoBaseUrl: `http://127.0.0.1:${port}`,
      upstreamUrl: `http://127.0.0.1:${port}/v1`,
      upstreamKey: 'k',
      maxTokens: 1000, maxToolCalls: 12, maxModelTurns: 8,
      log: () => {}
    },
    log: () => {}
  }
}

async function post(port: number, body: unknown, key = 'local-secret'): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/eclipsis/leto/wake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  })
  return { status: res.status, json: await res.json() }
}

describe('Leto 入站端点 鉴权与校验', () => {
  it('未配置 ingestKey → 503', async () => {
    const svc = createServer(async (req, res) => { await handleLetoApi(deps(0, ''), db, req, res) })
    const port = await listen(svc)
    try {
      const r = await post(port, { agent: 'xiaoke', reason: 'leto_mention', message: 'x' })
      assert.equal(r.status, 503)
    } finally { await close(svc) }
  })

  it('密钥不对 → 401；缺字段 → 400；未知 agent → 404', async () => {
    const svc = createServer(async (req, res) => { await handleLetoApi(deps(1234), db, req, res) })
    const port = await listen(svc)
    try {
      assert.equal((await post(port, { agent: 'xiaoke', reason: 'r', message: 'm' }, 'wrong')).status, 401)
      assert.equal((await post(port, { agent: 'xiaoke' })).status, 400)
      assert.equal((await post(port, { agent: 'unknown', reason: 'r', message: 'm' })).status, 404)
    } finally { await close(svc) }
  })
})

describe('Leto 端到端 读→回→写经历', () => {
  it('小克 read 再 reply，回复落进 channel=group，入站唤醒也记一条', async () => {
    const svc = fakeServices({
      tools,
      modelScript: [
        { choices: [{ message: { content: '', tool_calls: [toolCall('t1', 'leto_read', { invocation_id: 'inv_demo' })] }, finish_reason: 'tool_calls' }] },
        { choices: [{ message: { content: '', tool_calls: [toolCall('t2', 'leto_reply', { invocation_id: 'inv_demo', text: '在的，刚看到' })] }, finish_reason: 'tool_calls' }] },
        { choices: [{ message: { content: '回完了。' }, finish_reason: 'stop' }] }
      ],
      mcpResults: {
        leto_read: { content: [{ type: 'text', text: '林澄：在吗' }] },
        leto_reply: { content: [{ type: 'text', text: '已发送 1 条' }] }
      }
    })
    const port = await listen(svc.server)
    // 后端 API 服务器（和假上游/MCP 不同端口，但 dispatchConfig 指向假服务端口）
    const apiSvc = createServer(async (req, res) => { await handleLetoApi(deps(port), db, req, res) })
    const apiPort = await listen(apiSvc)
    try {
      const r = await post(apiPort, {
        agent: 'xiaoke', reason: 'leto_mention',
        message: '[Leto] 你在「纸船测试桌」被 林澄 @ 了：「在吗」\n调用编号：inv_demo'
      })
      assert.equal(r.status, 200)
      assert.equal(r.json.ok, true)
      assert.deepEqual(r.json.toolsCalled, ['leto_read', 'leto_reply'])

      // 模型拿到的工具：coreToolsOnly 过滤掉 leto_moment_post
      const sentTools = (svc.modelCalls[0].tools || []).map((t: any) => t.function.name)
      assert.ok(sentTools.includes('leto_read'))
      assert.ok(!sentTools.includes('leto_moment_post'), '朋友圈工具不该暴露')

      // 经历：一条入站唤醒(system/leto_wake) + 一条回复(ai/message)，都在 group
      const eps = db.prepare(`SELECT channel, scope, actor, kind, content FROM episodes ORDER BY seq`).all() as any[]
      const wake = eps.find(e => e.kind === 'leto_wake')
      const reply = eps.find(e => e.kind === 'message' && e.actor === 'ai')
      assert.ok(wake, '应记入站唤醒')
      assert.equal(wake.channel, 'group')
      assert.ok(reply, '应记他的回复')
      assert.equal(reply.channel, 'group')
      assert.equal(reply.scope, 'group')
      assert.equal(reply.content, '在的，刚看到')
    } finally { await close(svc.server); await close(apiSvc) }
  })

  it('模型调用失败 → 502（桥会重试一次）', async () => {
    const svc = createServer((_req, res) => { res.writeHead(500); res.end('boom') })
    const port = await listen(svc)
    const apiSvc = createServer(async (req, res) => { await handleLetoApi(deps(port), db, req, res) })
    const apiPort = await listen(apiSvc)
    try {
      // tools/list 会先失败 → dispatch 抛错 → 502
      const r = await post(apiPort, { agent: 'xiaoke', reason: 'leto_mention', message: 'x\n调用编号：inv_x' })
      assert.equal(r.status, 502)
      assert.equal(r.json.ok, false)
    } finally { await close(svc); await close(apiSvc) }
  })
})
