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


// 历史里旧消息的图片（base64 data URL）占大量 token。只保留最后 KEEP 条 user 消息里的图片，
// 更早的替换成 [图片] 占位。减少发给模型的 token 数，不影响记录（记录的是改动前的）。
const IMG_KEEP_RECENT = 4 // 保留最近 4 条 user 消息的图片

function replaceImages(content: any): { content: any; removed: number } {
  if (!Array.isArray(content)) return { content, removed: 0 }
  let removed = 0
  const out = content.map((p: any) => {
    if (p?.type === 'image_url' || p?.type === 'image') {
      removed++
      return { type: 'text', text: '[图片]' }
    }
    return p
  })
  return { content: out, removed }
}

export function stripOldImages(messages: any[]): { messages: any[]; stripped: number; savedChars: number } {
  // find last N user messages to keep images for
  const userIndices: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      userIndices.push(i)
      if (userIndices.length >= IMG_KEEP_RECENT) break
    }
  }
  const keep = new Set(userIndices)
  let stripped = 0, savedChars = 0
  const out = messages.map((m, i) => {
    if (keep.has(i)) return m
    if (!Array.isArray(m?.content)) return m
    const hasImg = m.content.some((p: any) => p?.type === 'image_url' || p?.type === 'image')
    if (!hasImg) return m
    const r = replaceImages(m.content)
    if (r.removed === 0) return m
    stripped += r.removed
    savedChars += JSON.stringify(m.content).length - JSON.stringify(r.content).length
    return { ...m, content: r.content }
  })
  return { messages: out, stripped, savedChars }
}

// ── 按时间排好再发给他 ──
// xiaoke 只"补缺"：Kelivo 自己带着几百条窗口历史，xiaoke 把这个窗口没有的（比如她在 Eclipsis 里说的）
// 插在 Kelivo 那段历史前面，不按时间。两边来回聊时，他看到的顺序就乱了（11-10 她问"能看到 Eclipsis 那条吗"，
// 那条被放在第 108 条，他以为是很早以前说的）。以后还会有别的副前端，所以这里统一按真实时间排一遍。
//   时间从哪来：经历表里同一条（角色 + 正文）记下的时间；她的消息找不到时用正文里的时间标记；
//   都没有的（比如他的回复没记上）跟在前一条后面。
//   不动的：开头的 system；结尾这一轮（她最后连着说的几句 + 后面的工具轮）。按一来一回整组挪，组里不拆。
export type TimeLookup = (role: 'user' | 'assistant', text: string) => number[]

const normText = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 她消息里的时间标记（中国时间）：Kelivo 的 <current_time>…，Eclipsis 的开头（YYYY-MM-DD HH:mm） */
export function timeTagOf(text: string): number | null {
  const k = /<current_time>\s*(?:\w{3}\s+)?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(text)
  const e = k ? null : /^\s*[（(](\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})[）)]/.exec(text)
  const m = k || e
  if (!m) return null
  const t = Date.parse(`${m[1]}T${m[2]!.length === 5 ? m[2] + ':00' : m[2]}+08:00`)
  return Number.isFinite(t) ? t : null
}

export function reorderByTime(messages: any[], lookup: TimeLookup): { messages: any[]; moved: number } {
  const n = messages.length
  let head = 0
  while (head < n && messages[head]?.role === 'system') head++
  // 结尾这一轮：从后往前越过工具轮，再越过她连着说的几句
  let tail = n
  while (tail > head && (messages[tail - 1]?.role === 'tool' || (messages[tail - 1]?.role === 'assistant' && Array.isArray(messages[tail - 1].tool_calls) && messages[tail - 1].tool_calls.length))) tail--
  while (tail > head && messages[tail - 1]?.role === 'user') tail--
  if (tail - head < 2) return { messages, moved: 0 }

  // 按"一来一回"分组：她连着说的几句 + 他的回复（含工具轮），整组一起挪，组里的先后不动。
  // （xiaoke 导入的老记录里，她的话和他的回复是一起提交的，时间几乎一样，单条排会把回复排到她前面）
  const units: { msgs: any[]; t: number; i: number }[] = []
  for (let i = head; i < tail; i++) {
    const m = messages[i]
    const startsTurn = m?.role === 'user' && (i === head || messages[i - 1]?.role !== 'user')
    if (!units.length || startsTurn) units.push({ msgs: [], t: NaN, i: units.length })
    units[units.length - 1]!.msgs.push(m)
  }
  const used = new Map<string, number>()   // 同样的话出现几次：按出现顺序一次用一个时间
  let prev = -Infinity
  const timeOf = (m: any): number | null => {
    const role = m?.role === 'user' || m?.role === 'assistant' ? m.role : null
    const text = role ? textOf(m.content) : ''
    if (!role || !text.trim()) return null
    const key = role + '|' + normText(text)
    const cands = lookup(role, text).slice().sort((a, b) => a - b)
    if (cands.length) {
      // 有好几个时间（同样的话说过好几次）：取不早于前一组的第一个，没有就按出现的次数取
      const k = used.get(key) ?? 0
      used.set(key, k + 1)
      return cands.find(c => c >= prev) ?? cands[Math.min(k, cands.length - 1)]!
    }
    return role === 'user' ? timeTagOf(text) : null
  }
  for (const u of units) {
    let t: number | null = null
    // 组的时间：她这几句里能对上的最晚那句（Kelivo 夹带的记忆注入那条时间不准，最后那句才是她真说的）；都没有就用他的回复
    for (const m of u.msgs) if (m?.role === 'user') { const x = timeOf(m); if (x !== null) t = t === null ? x : Math.max(t, x) }
    if (t === null) for (const m of u.msgs) if (m?.role === 'assistant') { const x = timeOf(m); if (x !== null) { t = x; break } }
    // 找不到时间的跟在前一组后面
    u.t = t ?? prev
    prev = u.t
  }
  const sorted = units.slice().sort((a, b) => (a.t - b.t) || (a.i - b.i))
  const moved = sorted.reduce((k, u, j) => k + (u.i !== j ? 1 : 0), 0)
  if (!moved) return { messages, moved: 0 }
  return { messages: [...messages.slice(0, head), ...sorted.flatMap(u => u.msgs), ...messages.slice(tail)], moved }
}
