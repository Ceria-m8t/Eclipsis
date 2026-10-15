// MCP (Model Context Protocol) 客户端
// 走 Streamable HTTP：先 initialize 拿 session，再 tools/list、tools/call。
// 工具定义输出为 OpenAI function calling 格式（网关是 /chat/completions）。

export interface McpServer {
  id: string
  name: string
  url: string       // Streamable HTTP 端点
  token: string     // Bearer token，可留空
  enabled: boolean
  tools: McpTool[]  // 已发现的工具
}

export interface McpTool {
  name: string
  description: string
  input_schema: Record<string, any>
  serverId: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: string   // 模型给的原始 JSON 字符串
}

export interface ToolResult {
  tool_call_id: string
  content: string
  is_error?: boolean
}

const MCP_STORAGE_KEY = 'eclipsis-mcp-servers'
const MAX_RESULT_CHARS = 20000   // 单次工具结果上限，防止一次塞爆上下文

export function loadMcpServers(): McpServer[] {
  try {
    const saved = localStorage.getItem(MCP_STORAGE_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return []
}

export function saveMcpServers(servers: McpServer[]): void {
  localStorage.setItem(MCP_STORAGE_KEY, JSON.stringify(servers))
}

// ===== JSON-RPC 传输 =====
const sessions = new Map<string, string>()   // serverId -> Mcp-Session-Id
let rpcId = 1

function headersFor(server: McpServer): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    // 规范要求同时接受两种，缺了这个不少服务器会直接 406
    'Accept': 'application/json, text/event-stream'
  }
  if (server.token) h['Authorization'] = `Bearer ${server.token}`
  const sid = sessions.get(server.id)
  if (sid) h['Mcp-Session-Id'] = sid
  return h
}

async function readRpcResponse(res: Response, id: number): Promise<any> {
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('text/event-stream')) {
    const text = await res.text()
    let last: any = null
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      try {
        const data = JSON.parse(line.slice(5).trim())
        if (data.id === id) return data
        last = data
      } catch {}
    }
    return last
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

async function rpc(server: McpServer, method: string, params: any, notify = false): Promise<any> {
  const id = rpcId++
  const body = notify
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id, method, params }
  const res = await fetch(server.url, { method: 'POST', headers: headersFor(server), body: JSON.stringify(body) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) sessions.set(server.id, sid)
  if (notify) {
    // 读掉响应体，连接才能被复用
    await res.text().catch(() => {})
    return null
  }
  if (res.status === 404 && sessions.has(server.id)) {
    // session 过期：清掉，交给上层重新初始化
    sessions.delete(server.id)
    throw new SessionExpired()
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await readRpcResponse(res, id)
  if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error))
  return data?.result
}

class SessionExpired extends Error {}

const initialized = new Set<string>()

async function ensureInit(server: McpServer): Promise<void> {
  if (initialized.has(server.id)) return
  try {
    await rpc(server, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'eclipsis', version: '0.1.0' }
    })
    await rpc(server, 'notifications/initialized', {}, true)
  } catch (e) {
    // 有些简易 MCP 不实现 initialize，直接继续尝试
    console.warn(`[MCP] ${server.name} initialize 失败，跳过：`, e)
  }
  initialized.add(server.id)
}

async function call(server: McpServer, method: string, params: any): Promise<any> {
  await ensureInit(server)
  try {
    return await rpc(server, method, params)
  } catch (e) {
    if (e instanceof SessionExpired) {
      initialized.delete(server.id)
      await ensureInit(server)
      return await rpc(server, method, params)
    }
    throw e
  }
}

// ===== 对外接口 =====
export async function discoverTools(server: McpServer): Promise<McpTool[]> {
  initialized.delete(server.id)
  sessions.delete(server.id)
  try {
    const result = await call(server, 'tools/list', {})
    return (result?.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
      serverId: server.id
    }))
  } catch (e) {
    console.warn(`[MCP] 获取 ${server.name} 工具列表失败：`, e)
    return []
  }
}

export async function executeToolCall(servers: McpServer[], tc: ToolCall): Promise<ToolResult> {
  const server = servers.find(s => s.enabled && s.tools.some(t => t.name === tc.name))
  if (!server) {
    return { tool_call_id: tc.id, content: `工具 "${tc.name}" 不在任何已启用的 MCP 上`, is_error: true }
  }

  let args: Record<string, any> = {}
  try {
    args = tc.arguments ? JSON.parse(tc.arguments) : {}
  } catch {
    return { tool_call_id: tc.id, content: `参数不是合法 JSON：${tc.arguments}`, is_error: true }
  }

  try {
    const result = await call(server, 'tools/call', { name: tc.name, arguments: args })
    const parts: any[] = result?.content || []
    let text = parts
      .map(p => p.type === 'text' ? p.text : p.type === 'image' ? '[图片]' : JSON.stringify(p))
      .join('\n')
    if (!text) text = JSON.stringify(result ?? null)
    if (text.length > MAX_RESULT_CHARS) {
      text = text.slice(0, MAX_RESULT_CHARS) + `\n…[结果过长，已截断，原长 ${text.length} 字]`
    }
    return { tool_call_id: tc.id, content: text, is_error: !!result?.isError }
  } catch (e: any) {
    return { tool_call_id: tc.id, content: `调用失败：${e.message}`, is_error: true }
  }
}

// OpenAI function calling 格式
export function buildToolDefinitions(servers: McpServer[]): any[] {
  const seen = new Set<string>()
  const tools: any[] = []
  for (const s of servers) {
    if (!s.enabled) continue
    for (const t of s.tools) {
      if (seen.has(t.name)) continue   // 同名工具只保留第一个
      seen.add(t.name)
      tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema && Object.keys(t.input_schema).length
            ? t.input_schema
            : { type: 'object', properties: {} }
        }
      })
    }
  }
  return tools
}
