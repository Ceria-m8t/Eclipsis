// 上游入口对请求做的改动。每个改动都可以用开关单独关掉。
import { WAKE_MARKER, textOf } from './recorder.ts'

const RECENT_HEADING = '最近记录：'
export const WAKE_HISTORY_NOTE = '（当时附带的最近聊天记录已省略）'

// 以前每次唤醒的提示词都附了一份"最近记录"（平均 1.4 万字），xiaoke 把它们当历史补回来，
// 同一段聊天会被他看很多遍。这里把历史里那些旧唤醒提示的"最近记录"剪掉，只留开头的说明。
// 最后一条 user 不动：如果这次本身就是唤醒，他需要看那份记录。
export function stripWakeHistory(messages: any[]): { messages: any[]; stripped: number; savedChars: number } {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === 'user') { lastUser = i; break }
  let stripped = 0, savedChars = 0
  const out = messages.map((m, i) => {
    if (i === lastUser || m?.role !== 'user' || typeof m.content !== 'string') return m
    if (!textOf(m.content).includes(WAKE_MARKER)) return m
    const cut = m.content.indexOf(RECENT_HEADING)
    if (cut < 0) return m
    const content = m.content.slice(0, cut).trimEnd() + '\n\n' + WAKE_HISTORY_NOTE
    stripped++
    savedChars += m.content.length - content.length
    return { ...m, content }
  })
  return { messages: out, stripped, savedChars }
}

// 历史里他以前的思考（正文里 <think>…</think> / <thinking>…</thinking>）不再发回给他：每轮重新想，
// 也免得把"心里想过的"当成"说过的"。和前端 splitThink 同一条规则：没收尾的开头标签，后面都算思考。
// 只改 assistant 的文字；剪完什么都不剩、又没有工具调用的，保留原样（空回复有的中转站会报 400）。
const THINK_RE = /<(think|thinking)>[\s\S]*?(?:<\/\1>|$)/gi

function stripThinkText(text: string): string {
  return text.replace(THINK_RE, '\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function stripThinkHistory(messages: any[]): { messages: any[]; stripped: number; savedChars: number } {
  let stripped = 0, savedChars = 0
  const out = messages.map(m => {
    if (m?.role !== 'assistant') return m
    const hasTools = Array.isArray(m.tool_calls) && m.tool_calls.length > 0
    if (typeof m.content === 'string') {
      if (!/<think(ing)?>/i.test(m.content)) return m
      const content = stripThinkText(m.content)
      if (!content && !hasTools) return m
      stripped++
      savedChars += m.content.length - content.length
      return { ...m, content }
    }
    if (Array.isArray(m.content)) {
      let changed = false, saved = 0
      const parts = m.content.map((p: any) => {
        if (p?.type !== 'text' || typeof p.text !== 'string' || !/<think(ing)?>/i.test(p.text)) return p
        const text = stripThinkText(p.text)
        changed = true
        saved += p.text.length - text.length
        return { ...p, text }
      })
      if (!changed) return m
      const left = parts.some((p: any) => p?.type !== 'text' || (typeof p.text === 'string' && p.text.trim()))
      if (!left && !hasTools) return m
      stripped++
      savedChars += saved
      return { ...m, content: parts.filter((p: any) => p?.type !== 'text' || p.text) }
    }
    return m
  })
  return { messages: out, stripped, savedChars }
}
