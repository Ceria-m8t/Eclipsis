// 「这一刻」箱子（2026-11-11，Erica 定）：醒来时让他翻自己以前写的这一刻，锁着的、没锁的都能看。
//
// 历史里的这一刻每轮都剪掉（moment.ts，免得照着以前的写法越写越像模板），所以平时他看不到自己写过什么。
// 这个箱子让他自己想翻的时候去翻。
//
// 只在醒来时有（wakeOnly）：聊天里的工具是从她手机上调的，结果会回到手机、记进经历表、显示在聊天页折叠的工具里，
// 锁着的就不再是锁着的了。醒来在服务器上跑，只记用了哪些工具，不记结果。
// 她删掉的消息（retracted_at）里的不给；创作中心（fiction）的不给。
import type { DB } from '../db.ts'
import type { McpTool } from '../leto/mcp-client.ts'
import { splitMoment } from '../moment.ts'
import { splitThink } from '../chat-history.ts'
import type { WakeBox, ToolResult } from './boxes.ts'

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 北京时间，如 "11月9日 周一 22:02" */
function beijing(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000)
  const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEK[d.getUTCDay()]} ${hh}:${mm}`
}

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

const TOOLS: McpTool[] = [{
  name: 'moments_read',
  description: '翻我以前写的这一刻（聊天和醒来时写在最后的那一小块），新的在前。锁着的也在里面，标了 🔒。' +
    '翻到的内容只有我自己看得到；写进念头或发给她的话她翻得到。现在要写这一刻，照此刻的感觉写，不用照着以前的格式。',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: '要几条，默认 8，最多 20' },
      before: { type: 'string', description: '只看这个时间以前的（往前翻页用，填上次结果最后给的时间）' },
      locked_only: { type: 'boolean', description: 'true = 只看锁着的' },
    },
    required: [],
  },
}]

interface Row { seq: number; ts: string; channel: string; content: string; meta: string | null }

export function readMoments(db: DB, o: { limit?: number; before?: string; lockedOnly?: boolean } = {}): string {
  const limit = Math.min(20, Math.max(1, Math.floor(o.limit ?? 8)))
  const rows = db.prepare(`
    SELECT seq, ts, channel, content, meta FROM episodes
    WHERE actor = 'ai' AND kind IN ('message', 'note') AND scope = 'daily' AND channel IN ('chat', 'room', 'wake')
      AND retracted_at IS NULL AND content LIKE '%<moment%' ${o.before ? 'AND ts < ?' : ''}
    ORDER BY ts DESC, seq DESC LIMIT 400
  `).all(...(o.before ? [o.before] : [])) as unknown as Row[]

  const seenTurn = new Set<string>()
  const out: { ts: string; text: string }[] = []
  for (const r of rows) {
    let meta: any = {}
    try { meta = r.meta ? JSON.parse(r.meta) : {} } catch {}
    // 重新生成过的一轮只留最新那一版（倒着翻，先碰到的就是最新的）
    if (typeof meta.turn === 'string' && meta.turn) {
      if (seenTurn.has(meta.turn)) continue
      seenTurn.add(meta.turn)
    }
    const { body } = splitThink(r.content)
    const mo = splitMoment(body)
    if (!mo.moment) continue
    if (o.lockedOnly && !mo.moment.locked) continue
    const where = r.channel === 'wake' ? '醒来时' : '聊天里'
    const head = `【${beijing(r.ts)} · ${where}${mo.moment.locked ? ' · 🔒锁着' : ''}】`
    const ctx = mo.text ? `\n（那时写的话开头：${oneLine(mo.text, 50)}）` : ''
    out.push({ ts: r.ts, text: `${head}\n${mo.moment.text}${ctx}` })
    if (out.length > limit) break
  }
  if (!out.length) return o.before ? '再往前没有了。' : (o.lockedOnly ? '还没有锁着的这一刻。' : '还没有写过这一刻。')
  const more = out.length > limit
  const shown = out.slice(0, limit)
  const tail = more ? `\n\n还有更早的：before 填 ${shown.at(-1)!.ts}` : '\n\n再往前没有了。'
  return `${shown.length} 条（新的在前）：\n\n${shown.map(x => x.text).join('\n\n')}${tail}`
}

export function momentsBox(db: DB): WakeBox {
  const ok = (text: string): ToolResult => ({ text, isError: false })
  const fail = (text: string): ToolResult => ({ text, isError: true })
  return {
    id: 'moments', entryName: 'open_moments', wakeOnly: true,
    entryDescription: '打开「这一刻」：翻我以前在回复最后写的这一刻（气味、↑↓、想要/选了/忍住），锁着的也能看。',
    listTools: async () => TOOLS,
    call: async (name, a) => {
      if (name !== 'moments_read') return fail(`「这一刻」里没有 ${name}`)
      let before: string | undefined
      if (a.before !== undefined && a.before !== null && a.before !== '') {
        const d = new Date(String(a.before))
        if (Number.isNaN(d.getTime())) return fail('before 看不懂，填上次结果最后给的时间')
        before = d.toISOString()
      }
      const limit = typeof a.limit === 'number' && Number.isFinite(a.limit) ? a.limit : undefined
      try { return ok(readMoments(db, { limit, before, lockedOnly: a.locked_only === true })) }
      catch (e: any) { return fail(String(e?.message || e)) }
    },
  }
}
