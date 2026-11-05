// Wake 接着最近一次真实聊天醒来（2026-11-05 Erica：醒来的他不能是阉割版）。
//
// 平时聊天他看到的是 xiaoke 拼好的整份请求：xiaoke 的 system（提示词、记忆规则、时间树……）+ 几百条历史 + 工具结果。
// 上游入口（tap）每轮都把这份请求原样存进 exchanges/blobs。醒来时直接取最近一次「正常结束」的聊天请求，
// 接上他那一轮的回复，再把醒来说明作为新的一条 user 消息放在最后——他看到的和平时聊天是同一份上下文。
//
// 处理：
//   - system 里上次注入的「此刻」块（和后面的醒来块、群聊块）剪掉，换成现在的
//   - 工具调用 / 工具结果压成文字（醒来这一轮不带工具定义，带着原生工具消息有的站会报错）
//   - 图片引用换成 [图片]
//   - 思维链只在最后接上的那条回复里剥（历史里的上游入口已经剥过）
// 取不到（没有聊天记录、太久没聊、拼装失败）就返回 null，调用方退回旧做法。
import type { DB } from '../db.ts'
import { stripThink } from './dispatch.ts'

/** 「此刻」块在 system 里的起点（assembler/index.ts 的 sceneBlock 以它开头） */
export const SCENE_MARKER = '\n---\n# 此刻'

export interface ChatContinuation {
  system: string
  /** 不含 system，最后一条是他那一轮的回复 */
  history: any[]
  exchangeId: number
  at: string
  model: string | null
}

const textOfParts = (content: any): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p: any) => (p?.type === 'text' ? String(p.text ?? '') : '')).join('')
}

/** 内容里的图片引用换成文字，其余原样 */
function normalizeContent(content: any): any {
  if (!Array.isArray(content)) return content ?? ''
  const parts = content.map((p: any) => {
    if (p?.type === 'image_ref' || p?.type === 'image_url' || p?.image_url) return { type: 'text', text: '[图片]' }
    return p
  })
  return parts.every((p: any) => p?.type === 'text') ? parts.map((p: any) => p.text ?? '').join('') : parts
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

/** 把工具调用/结果压成文字。其余消息只做图片替换 */
export function flattenTools(messages: any[]): any[] {
  const out: any[] = []
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map((c: any) => `[调用工具 ${c?.function?.name ?? c?.name ?? '?'}：${clip(String(c?.function?.arguments ?? ''), 500)}]`)
      const text = [textOfParts(m.content).trim(), ...calls].filter(Boolean).join('\n')
      out.push({ role: 'assistant', content: text })
    } else if (m?.role === 'tool') {
      out.push({ role: 'user', content: `[工具 ${m.name ?? ''} 返回]\n${textOfParts(m.content)}` })
    } else if (m?.role === 'user' || m?.role === 'assistant') {
      out.push({ role: m.role, content: normalizeContent(m.content) })
    }
  }
  return out
}

/** 剪掉 system 末尾上次注入的「此刻」块（以及它后面追加的块） */
export function stripSceneBlock(system: string): string {
  const i = system.lastIndexOf(SCENE_MARKER)
  return (i >= 0 ? system.slice(0, i) : system).trimEnd()
}

export function loadChatContinuation(db: DB, opts: { maxAgeHours?: number; now?: Date } = {}): ChatContinuation | null {
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - (opts.maxAgeHours ?? 72) * 3600_000).toISOString()
  // 最近一次正常结束（不是中途调工具）的聊天请求。醒来自己不走上游入口，不会被选中
  const ex = db.prepare(`
    SELECT id, started_at, model, message_hashes, reply_content FROM exchanges
    WHERE tap = 'upstream' AND status = 'ok' AND finish_reason = 'stop'
      AND started_at > ? AND json_array_length(message_hashes) >= 2
    ORDER BY id DESC LIMIT 1
  `).get(since) as { id: number; started_at: string; model: string | null; message_hashes: string; reply_content: string | null } | undefined
  if (!ex) return null

  try {
    const get = db.prepare('SELECT text FROM blobs WHERE hash = ?')
    const msgs = (JSON.parse(ex.message_hashes) as string[]).map(h => {
      const row = get.get(h) as { text: string | null } | undefined
      if (!row?.text) throw new Error(`缺 blob ${h}`)
      return JSON.parse(row.text)
    })
    if (msgs[0]?.role !== 'system') return null
    const system = stripSceneBlock(textOfParts(msgs[0].content))
    const history = flattenTools(msgs.slice(1))
    const reply = stripThink(ex.reply_content ?? '')
    if (reply) history.push({ role: 'assistant', content: reply })
    if (!history.length) return null
    return { system, history, exchangeId: ex.id, at: ex.started_at, model: ex.model }
  } catch {
    return null
  }
}
