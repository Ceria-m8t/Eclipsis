// Leto MCP 客户端：连 Leto 的 /mcp（标准 Streamable HTTP，JSON-RPC over HTTP），
// 做 tools/list 和 tools/call。无状态，一次调用一条 HTTP 请求。
//
// 说明：bridge.mjs 用 node:http 而非 fetch，是因为它同时开着一条长 SSE 唤醒流，
// undici 的 HTTP/2 多路复用会把带 body 的请求排在长流后面发不出去。
// 应答器进程里**没有**那条长流（长流在独立的 bridge 进程里），所以这里用 fetch 没问题。

export interface McpTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** 一次 tools/call 的结果：text 是拼好的文本内容，isError 表示工具报错 */
export interface McpCallResult {
  text: string
  isError: boolean
  raw: unknown
}

export interface LetoMcpConfig {
  /** Leto 基址，如 https://leto.sarl（会拼上 /mcp） */
  baseUrl: string
  /** 该 Agent 的机器令牌 lmt_…；为空就不带 Authorization（比如心潮用路径里的令牌） */
  token: string
  /** 完整的 MCP 地址；给了就不用 baseUrl 拼（Wake 连记忆库、心潮用） */
  url?: string
  /** 报错里显示的名字，默认 Leto */
  label?: string
  /** 单次请求超时（毫秒），默认 20000 */
  timeoutMs?: number
}

const JSONRPC = '2.0'

function endpoint(cfg: LetoMcpConfig): string {
  return cfg.url || cfg.baseUrl.replace(/\/+$/, '') + '/mcp'
}

async function rpc(cfg: LetoMcpConfig, method: string, params: Record<string, unknown>): Promise<any> {
  const body = JSON.stringify({ jsonrpc: JSONRPC, id: 1, method, params })
  const label = cfg.label ?? 'Leto'
  const res = await fetch(endpoint(cfg), {
    method: 'POST',
    headers: {
      ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body,
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 20_000)
  })
  if (!res.ok) throw new Error(`${label} MCP ${method}: HTTP ${res.status}`)
  const text = await res.text()
  // Leto 回 JSON；个别实现会用 SSE 包一层 data:，这里都兜住
  const parsed = parseJsonOrSse(text)
  if (parsed.error) throw new Error(`${label} MCP ${method}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`)
  return parsed.result
}

/** 优先当 JSON 解析；失败时尝试从 SSE（data: 行）里抠出 JSON-RPC */
export function parseJsonOrSse(text: string): any {
  const t = text.trim()
  try { return JSON.parse(t) } catch { /* 往下试 SSE */ }
  const dataLines = t.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''))
  const joined = dataLines.join('\n').trim()
  if (joined) return JSON.parse(joined)
  throw new Error('Leto MCP 回包既不是 JSON 也不是可解析的 SSE')
}

/** 列出 Leto 当前所有工具 */
export async function listTools(cfg: LetoMcpConfig): Promise<McpTool[]> {
  const result = await rpc(cfg, 'tools/list', {})
  const tools = result?.tools
  if (!Array.isArray(tools)) throw new Error('Leto MCP tools/list 没返回 tools 数组')
  return tools.map((t: any) => ({
    name: String(t.name),
    description: t.description ? String(t.description) : undefined,
    inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} }
  }))
}

/** 调一个工具，返回拼好的文本内容 */
export async function callTool(cfg: LetoMcpConfig, name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
  const result = await rpc(cfg, 'tools/call', { name, arguments: args })
  const content = Array.isArray(result?.content) ? result.content : []
  const text = content
    .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
    .map((item: any) => item.text)
    .join('\n')
  return { text, isError: !!result?.isError, raw: result }
}

/** 把 Leto 的 MCP 工具转成 OpenAI chat/completions 的 function 定义 */
export function toOpenAITools(tools: McpTool[], allow?: (name: string) => boolean): any[] {
  return tools
    .filter(t => (allow ? allow(t.name) : true))
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.inputSchema ?? { type: 'object', properties: {} }
      }
    }))
}
