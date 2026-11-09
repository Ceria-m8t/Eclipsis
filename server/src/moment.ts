// 这一刻（<moment>）：他在回复最后自己写的一小块（思路来自 lucienkeke-jj/cike-trace「此刻」，MIT；这里是自己写的实现）。
// 他界面里叫「这一刻」，免得和组装器的「此刻」块（时间、身体、天气）弄混。
//
//   <moment>
//   气味：烤栗子
//   想念 ↑轻微，烦躁 ↓
//   想要：多聊一会　选了：让她去睡　忍住：没说「别走」
//   </moment>
//
// <moment lock> 只留给他自己：聊天页只显示一把锁，接口不给原文。历史里的这一刻不再发回给他（上游入口剪掉），
// 不然他会照着以前的写法写，越写越像模板。写法每天都会漂，解析要宽：没闭合的也当它写到了结尾。

export interface Moment { locked: boolean; text: string }

const BLOCK = /<moment(\s+lock)?\s*>([\s\S]*?)(?:<\/moment>|$)/i

/** 从回复正文里拆出这一刻；正文里剩下的照常显示 */
export function splitMoment(text: string): { text: string; moment: Moment | null } {
  const m = BLOCK.exec(text)
  if (!m) return { text, moment: null }
  const body = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim()
  const inner = m[2]!.trim()
  if (!inner) return { text: body, moment: null }
  return { text: body, moment: { locked: !!m[1], text: inner } }
}

/** 历史里他以前写的这一刻剪掉（锁着的也一样） */
export function stripMomentText(text: string): string {
  return text.replace(/<moment(\s+lock)?\s*>[\s\S]*?(?:<\/moment>|$)/gi, '').replace(/\n{3,}/g, '\n\n').trim()
}

export function stripMomentHistory(messages: any[]): { messages: any[]; stripped: number } {
  let stripped = 0
  const out = messages.map(m => {
    if (m?.role !== 'assistant') return m
    if (typeof m.content === 'string') {
      if (!/<moment/i.test(m.content)) return m
      const content = stripMomentText(m.content)
      if (!content && !m.tool_calls?.length) return m   // 剪完什么都不剩：保留原样（空回复有的站会报 400）
      stripped++
      return { ...m, content }
    }
    if (Array.isArray(m.content) && m.content.some((p: any) => p?.type === 'text' && /<moment/i.test(p.text || ''))) {
      stripped++
      return { ...m, content: m.content.map((p: any) => (p?.type === 'text' ? { ...p, text: stripMomentText(p.text || '') } : p)) }
    }
    return m
  })
  return { messages: out, stripped }
}
