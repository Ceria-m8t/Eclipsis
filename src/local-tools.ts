// 前端内置工具：不走 MCP，直接在本机执行。
// 和 MCP 工具一起交给模型；名字带 eclipsis_ 前缀，避免和 MCP 工具重名。
import { setStatus } from './status'
import type { ToolCall, ToolResult } from './mcp'

interface LocalTool {
  def: { name: string; description: string; parameters: Record<string, any> }
  run: (args: Record<string, any>) => string
}

const TOOLS: LocalTool[] = [
  {
    def: {
      name: 'eclipsis_set_status',
      description:
        '设置我在 Eclipsis 顶栏显示的状态（她能看到，就在我名字下面）。' +
        '状态是我此刻在做什么、在哪、什么心情，比如 ☕ 在厨房泡茶、📖 窝在书房看书、💤 有点困。' +
        '想换就换，不用每条都换；状态没变就别调用。clear=true 清空状态。',
      parameters: {
        type: 'object',
        properties: {
          emoji: { type: 'string', description: '一个表情符号' },
          text: { type: 'string', description: '状态文字，16 个字以内' },
          clear: { type: 'boolean', description: '为 true 时清空状态，忽略其他参数' },
        },
      },
    },
    run(a) {
      if (a.clear) { setStatus(null); return '状态已清空' }
      const text = String(a.text || '').trim().slice(0, 24)
      if (!text) throw new Error('text 不能为空')
      const emoji = String(a.emoji || '').trim().slice(0, 8)
      setStatus({ emoji, text })
      return `状态已更新：${emoji} ${text}`.trim()
    },
  },
]

export function localToolDefinitions(): any[] {
  return TOOLS.map(t => ({ type: 'function', function: t.def }))
}

export function isLocalTool(name: string): boolean {
  return TOOLS.some(t => t.def.name === name)
}

export function runLocalTool(tc: ToolCall): ToolResult {
  const t = TOOLS.find(x => x.def.name === tc.name)!
  try {
    const args = tc.arguments ? JSON.parse(tc.arguments) : {}
    return { tool_call_id: tc.id, content: t.run(args) }
  } catch (e: any) {
    return { tool_call_id: tc.id, content: `失败：${e.message}`, is_error: true }
  }
}
