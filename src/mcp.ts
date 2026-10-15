// MCP (Model Context Protocol) client module
// Handles tool discovery, tool call forwarding, and result collection

export interface McpServer {
  id: string
  name: string
  url: string       // SSE or Streamable HTTP endpoint
  token: string     // Bearer token
  enabled: boolean
  tools: McpTool[]  // Discovered tools
}

export interface McpTool {
  name: string
  description: string
  input_schema: Record<string, any>
  serverId: string  // Which server this tool belongs to
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, any>
}

export interface ToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

const MCP_STORAGE_KEY = 'eclipsis-mcp-servers'

// Load servers from localStorage
export function loadMcpServers(): McpServer[] {
  try {
    const saved = localStorage.getItem(MCP_STORAGE_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return []
}

// Save servers to localStorage
export function saveMcpServers(servers: McpServer[]): void {
  localStorage.setItem(MCP_STORAGE_KEY, JSON.stringify(servers))
}

// Discover tools from an MCP server via /tools or SSE
export async function discoverTools(server: McpServer): Promise<McpTool[]> {
  // Try Streamable HTTP first (POST with method: tools/list)
  try {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${server.token}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      })
    })

    if (res.ok) {
      const contentType = res.headers.get('content-type') || ''

      if (contentType.includes('application/json')) {
        // Direct JSON response
        const data = await res.json()
        if (data.result?.tools) {
          return data.result.tools.map((t: any) => ({
            name: t.name,
            description: t.description || '',
            input_schema: t.inputSchema || t.input_schema || {},
            serverId: server.id
          }))
        }
      } else if (contentType.includes('text/event-stream')) {
        // SSE response - read events
        const text = await res.text()
        const lines = text.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6))
              if (data.result?.tools) {
                return data.result.tools.map((t: any) => ({
                  name: t.name,
                  description: t.description || '',
                  input_schema: t.inputSchema || t.input_schema || {},
                  serverId: server.id
                }))
              }
            } catch {}
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[MCP] Failed to discover tools from ${server.name}:`, e)
  }
  return []
}

// Execute a tool call against the appropriate MCP server
export async function executeToolCall(
  servers: McpServer[],
  toolCall: ToolCall
): Promise<ToolResult> {
  // Find which server has this tool
  let targetServer: McpServer | undefined
  for (const s of servers) {
    if (!s.enabled) continue
    if (s.tools.some(t => t.name === toolCall.name)) {
      targetServer = s
      break
    }
  }

  if (!targetServer) {
    return {
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content: `Tool "${toolCall.name}" not found on any connected MCP server`,
      is_error: true
    }
  }

  try {
    const res = await fetch(targetServer.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${targetServer.token}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: toolCall.name,
          arguments: toolCall.input
        }
      })
    })

    if (!res.ok) {
      const errText = await res.text()
      return {
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: `MCP error ${res.status}: ${errText}`,
        is_error: true
      }
    }

    const contentType = res.headers.get('content-type') || ''
    let resultData: any = null

    if (contentType.includes('text/event-stream')) {
      const text = await res.text()
      const lines = text.split('\n')
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            resultData = JSON.parse(line.slice(6))
          } catch {}
        }
      }
    } else {
      resultData = await res.json()
    }

    if (resultData?.result?.content) {
      // MCP returns content as array of content blocks
      const parts = resultData.result.content
      const textParts = parts
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
      return {
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: textParts.join('\n') || JSON.stringify(resultData.result)
      }
    }

    if (resultData?.error) {
      return {
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: `MCP error: ${resultData.error.message || JSON.stringify(resultData.error)}`,
        is_error: true
      }
    }

    return {
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content: JSON.stringify(resultData)
    }
  } catch (err: any) {
    return {
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content: `Network error: ${err.message}`,
      is_error: true
    }
  }
}

// Build Claude tools array from all enabled servers
export function buildToolDefinitions(servers: McpServer[]): any[] {
  const tools: any[] = []
  for (const s of servers) {
    if (!s.enabled) continue
    for (const t of s.tools) {
      tools.push({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema
      })
    }
  }
  return tools
}
