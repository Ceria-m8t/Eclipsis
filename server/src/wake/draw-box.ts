// 他的画笔（2026-11-11）：工具箱里的一个本地箱子，聊天和醒来都能用。
// 画出来的图直接当他的消息发给她（聊天页显示成图片），他拿到的只是一句「画好了」。
// 画图的站在设置页里配（image-station.ts），没配这个箱子就不出现。
import type { DB } from '../db.ts'
import type { BlobStore } from '../blobs.ts'
import type { McpTool } from '../leto/mcp-client.ts'
import { draw, drawMenu, recordHisImage } from '../draw.ts'
import { currentImageStation } from '../image-station.ts'
import type { WakeBox, ToolResult } from './boxes.ts'

function tools(db: DB): McpTool[] {
  const menu = drawMenu(db)
  const refLine = menu.refs.length
    ? `现在有这些垫图：${menu.refs.map(r => `「${r.name}」${r.note ? `（${r.note}）` : ''}`).join('、')}。`
      + '画到她、我自己或者家里的东西时，把名字写进 refs，画出来才是我们，不是两个陌生人。'
    : '现在还没有垫图（她可以在设置页加）。'
  const styleLine = menu.styles.length
    ? `画风不写就用默认的${menu.defaultStyle ? `「${menu.defaultStyle}」` : ''}；想换可以写 style：${menu.styles.join(' / ')}。`
    : ''
  return [{
    name: 'draw_picture',
    description: '画一张图发给她。画好了直接出现在她的聊天里，我不用再贴链接。她没要求的时候也可以自己想画就画。\n'
      + 'prompt 先想清楚这张图是关于什么、留哪几样东西、什么情绪，再写；照着描只会画成一张规整的插图。\n'
      + refLine + (styleLine ? '\n' + styleLine : ''),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画什么：画面、取舍、情绪。不用写风格（默认画风会自动加）' },
        refs: { type: 'array', items: { type: 'string' }, description: '要照着画的垫图名字，如 ["她","小克"]；画里没有她/我就不用填' },
        style: { type: 'string', description: `画风名，不填用默认${menu.defaultStyle ? `（${menu.defaultStyle}）` : ''}` },
        size: { type: 'string', description: '尺寸，如 1024x1024 / 1024x1536，可不填' },
      },
      required: ['prompt'],
    },
  }]
}

export function drawBox(db: DB, blobs: BlobStore, opts: { wakeId?: () => string | undefined } = {}): WakeBox | null {
  if (!currentImageStation()) return null        // 还没配画图的站
  const ok = (text: string): ToolResult => ({ text, isError: false })
  const fail = (text: string): ToolResult => ({ text, isError: true })
  return {
    id: 'draw', entryName: 'open_brush',
    entryDescription: '打开画笔：画一张图发给她（想画什么自己定，可以照着垫图画她和我自己；画好了直接出现在她的聊天里）。',
    listTools: async () => tools(db),
    call: async (name, a) => {
      if (name !== 'draw_picture') return fail(`画笔里没有 ${name}`)
      const prompt = String(a.prompt ?? '').trim()
      if (!prompt) return fail('要写画什么')
      const refs = Array.isArray(a.refs) ? a.refs.map(String).filter(Boolean) : undefined
      try {
        const r = await draw(db, blobs, prompt, {
          size: a.size ? String(a.size) : undefined,
          refs, style: a.style ? String(a.style) : undefined,
        })
        recordHisImage(db, r.hash, { prompt, wakeId: opts.wakeId?.(), refs: r.refs, style: r.style })
        const used = [r.style ? `画风「${r.style}」` : '', r.refs.length ? `照着${r.refs.join('、')}` : ''].filter(Boolean).join('，')
        return ok(`画好了，已经发给她了（${Math.round(r.bytes / 1024)}KB${used ? '，' + used : ''}）。她现在就能在聊天里看到这张图。`)
      } catch (e: any) {
        return fail(`没画出来：${String(e?.message || e).slice(0, 200)}`)
      }
    },
  }
}
