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
