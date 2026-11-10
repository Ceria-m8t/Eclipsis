// 他的画笔（2026-11-11）：工具箱里的一个本地箱子，聊天和醒来都能用。
// 画出来的图直接当他的消息发给她（聊天页显示成图片），他拿到的只是一句「画好了」。
// 画图的站在设置页里配（image-station.ts），没配这个箱子就不出现。
import type { DB } from '../db.ts'
import type { BlobStore } from '../blobs.ts'
import type { McpTool } from '../leto/mcp-client.ts'
import { draw, recordHisImage } from '../draw.ts'
import { currentImageStation } from '../image-station.ts'
import type { WakeBox, ToolResult } from './boxes.ts'

const TOOLS: McpTool[] = [{
  name: 'draw_picture',
  description: '画一张图发给她。prompt 写清楚要画什么（画面、风格、颜色、情绪都可以写，中文英文都行）。'
    + '画好了直接出现在她的聊天里，我不用再贴链接。她没要求的时候也可以自己想画就画。',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '画什么，越具体越像' },
      size: { type: 'string', description: '尺寸，如 1024x1024 / 1024x1536，可不填' },
    },
    required: ['prompt'],
  },
}]

export function drawBox(db: DB, blobs: BlobStore, opts: { wakeId?: () => string | undefined } = {}): WakeBox | null {
  if (!currentImageStation()) return null        // 还没配画图的站
  const ok = (text: string): ToolResult => ({ text, isError: false })
  const fail = (text: string): ToolResult => ({ text, isError: true })
  return {
    id: 'draw', entryName: 'open_brush',
    entryDescription: '打开画笔：画一张图发给她（想画什么自己定；画好了直接出现在她的聊天里）。',
    listTools: async () => TOOLS,
    call: async (name, a) => {
      if (name !== 'draw_picture') return fail(`画笔里没有 ${name}`)
      const prompt = String(a.prompt ?? '').trim()
      if (!prompt) return fail('要写画什么')
      try {
        const r = await draw(db, blobs, prompt, { size: a.size ? String(a.size) : undefined })
        recordHisImage(db, r.hash, { prompt, wakeId: opts.wakeId?.() })
        return ok(`画好了，已经发给她了（${Math.round(r.bytes / 1024)}KB）。她现在就能在聊天里看到这张图。`)
      } catch (e: any) {
        return fail(`没画出来：${String(e?.message || e).slice(0, 200)}`)
      }
    },
  }
}
