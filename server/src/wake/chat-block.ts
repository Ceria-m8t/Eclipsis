// 平时聊天时带上「你醒来时」块（2026-11-05 问题二）：
// 他醒来发的消息只推送到她手机（Bark），留的念头只在经历表里，都不在聊天客户端的历史里。
// 不带这块，聊天里的他不知道自己醒来时说过、想过什么，她回应或骂他醒来发的那条，他接不上。
// 上游入口（main.ts）把它追加在「此刻」块后面。Wake 接着聊天醒来时，这块和此刻块一起被剪掉、换成新的。
//
// 前端有地方显示念头之后，要改"她看不到"那句（见 README：功能说明由开发方维护）。
import type { DB } from '../db.ts'
import { shortBeijing } from './dispatch.ts'

export interface WakeBlockOptions {
  /** 往回看多少小时，默认 24 */
  hours?: number
  /** 最多几条，默认 20 */
  limit?: number
  now?: Date
}

export function renderRecentWakeBlock(db: DB, opts: WakeBlockOptions = {}): string {
  const now = opts.now ?? new Date()
  const hours = opts.hours ?? 24
  const since = new Date(now.getTime() - hours * 3600_000).toISOString()
  const rows = (db.prepare(`
    SELECT created_at, outcome, content, sent_messages, trace, tools_used FROM wake_opportunities
    WHERE outcome IN ('message', 'trace') AND content IS NOT NULL AND content != ''
      AND created_at > ?
    ORDER BY created_at DESC LIMIT ?
  `).all(since, opts.limit ?? 20) as unknown as WakeRow[]).reverse()
  if (!rows.length) return ''

  const lines: string[] = []
  lines.push(`# 你醒来时（最近 ${hours} 小时，她不在聊天里的时候）`)
  lines.push('下面是你自己醒来时发给她的消息和留下的念头，不在上面的聊天记录里。她提到你醒来发的那条、或者为这些回应你、骂你时，说的就是这些。')
  for (const r of rows) {
    lines.push('')
    const at = shortBeijing(r.created_at)
    const sent = parseList(r.sent_messages)
    // 带工具以前的记录只有 content：message 就是发出去的那条，trace 就是念头
    const messages = r.outcome === 'message' ? (sent.length ? sent : [r.content.trim()]) : []
    const trace = r.trace?.trim() || (r.outcome === 'trace' ? r.content.trim() : '')
    if (messages.length) {
      lines.push(`· ${at} 发给了她${messages.length > 1 ? ` ${messages.length} 条` : ''}（推送到她手机，通知里能看到前 200 字）：`)
      lines.push(messages.join('\n\n'))
    }
    if (trace) {
      lines.push(messages.length ? '  同一次醒来，只留在心里的（她看不到）：' : `· ${at} 没发，只留在心里（她看不到）：`)
      lines.push(trace)
    }
    const used = usedTools(parseList(r.tools_used))
    if (used) lines.push(`  这次醒来还用了：${used}`)
  }
  return lines.join('\n')
}

interface WakeRow {
  created_at: string
  outcome: 'message' | 'trace'
  content: string
  sent_messages: string | null
  trace: string | null
  tools_used: string | null
}

function parseList(json: string | null): string[] {
  if (!json) return []
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
}

/** 去掉发消息和入口本身，同名合并：breath_search×2、leto_read */
function usedTools(names: string[]): string {
  const counts = new Map<string, number>()
  for (const n of names) {
    if (n === 'send_to_erica' || n.startsWith('open_')) continue
    counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  return [...counts].map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join('、')
}
