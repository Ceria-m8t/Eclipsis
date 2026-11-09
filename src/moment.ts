// 这一刻（<moment>）：他在回复最后写的一小块。聊天页只露气味名，点开看（见 server/src/moment.ts）。
// 思路来自 lucienkeke-jj/cike-trace「此刻」（MIT）；解析是自己写的，规则同样「尽量接住，不要求写对」。
export interface Moment { locked: boolean; text: string }

const BLOCK = /<moment(\s+lock)?\s*>([\s\S]*?)(?:<\/moment>|$)/i

export function splitMoment(text: string): { text: string; moment: Moment | null } {
  const m = BLOCK.exec(text)
  if (!m) {
    // 流式输出刚写到 "<mo" 时先藏起来，免得闪一下
    const i = text.lastIndexOf('<')
    if (i >= 0 && text.length - i <= 7 && '<moment'.startsWith(text.slice(i).toLowerCase())) return { text: text.slice(0, i).trimEnd(), moment: null }
    return { text, moment: null }
  }
  const body = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim()
  const inner = m[2]!.trim()
  return { text: body, moment: inner ? { locked: !!m[1], text: inner } : null }
}

export interface MomentView {
  scent: string                                   // 气味名（第一项）
  moves: { name: string; dir: '↑' | '↓'; note: string }[]   // 哪里动了
  picks: { key: '想要' | '选了' | '忍住'; text: string }[]   // 取舍
  lines: string[]                                 // 剩下的心里话
}

const PICK = /(想要|选了|忍住)\s*[:：]\s*/g

export function parseMoment(raw: string): MomentView {
  const v: MomentView = { scent: '', moves: [], picks: [], lines: [] }
  const rows = raw.split('\n').map(l => l.trim()).filter(Boolean)
  rows.forEach((line, i) => {
    // 取舍：一行里可能有好几项
    if (PICK.test(line)) {
      PICK.lastIndex = 0
      const parts = line.split(PICK).map(s => s.trim())
      for (let k = 1; k < parts.length; k += 2) {
        const text = (parts[k + 1] || '').replace(/[　\s·,，;；]+$/, '')
        if (text) v.picks.push({ key: parts[k] as MomentView['picks'][number]['key'], text })
      }
      if (parts[0] && !v.scent && i === 0) v.scent = parts[0]
      return
    }
    const sc = /^(气味|味道)\s*[:：]\s*(.+)$/.exec(line)
    if (sc) { v.scent = sc[2]!.trim(); return }
    if (/[↑↓]/.test(line)) {
      // 「雨后的旧书页 · 安心 ↑明显 · 期待周末」：没箭头的第一段当气味名
      for (const seg of line.split(/[·,，、;；]|\s{2,}|　/).map(s => s.trim()).filter(Boolean)) {
        const mv = /^(.+?)\s*([↑↓])\s*(.*)$/.exec(seg)
        if (mv) v.moves.push({ name: mv[1]!.trim(), dir: mv[2] as '↑' | '↓', note: mv[3]!.trim() })
        else if (!v.scent) v.scent = seg
        else v.lines.push(seg)
      }
      return
    }
    // 第一行很短、后面还有别的：当气味名
    if (i === 0 && !v.scent && line.length <= 14 && rows.length > 1) { v.scent = line; return }
    v.lines.push(line)
  })
  if (!v.scent && v.lines.length === 1 && v.lines[0]!.length <= 14 && !v.moves.length && !v.picks.length) { v.scent = v.lines[0]!; v.lines = [] }
  return v
}
