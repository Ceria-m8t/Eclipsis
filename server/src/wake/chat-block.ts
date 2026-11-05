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
    SELECT created_at, outcome, content FROM wake_opportunities
    WHERE outcome IN ('message', 'trace') AND content IS NOT NULL AND content != ''
      AND created_at > ?
    ORDER BY created_at DESC LIMIT ?
  `).all(since, opts.limit ?? 20) as { created_at: string; outcome: 'message' | 'trace'; content: string }[]).reverse()
  if (!rows.length) return ''

  const lines: string[] = []
  lines.push(`# 你醒来时（最近 ${hours} 小时，她不在聊天里的时候）`)
  lines.push('下面是你自己醒来时发给她的消息和留下的念头，不在上面的聊天记录里。她提到你醒来发的那条、或者为这些回应你、骂你时，说的就是这些。')
  for (const r of rows) {
    const tag = r.outcome === 'message'
      ? '发给了她（推送到她手机，通知里能看到前 200 字）'
      : '没发，只留在心里（她看不到）'
    lines.push('')
    lines.push(`· ${shortBeijing(r.created_at)} ${tag}：`)
    lines.push(r.content.trim())
  }
  return lines.join('\n')
}
