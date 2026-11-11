// 他的「随手记」箱子（第二期，双线写入里他那条线）。聊天和醒来都有。
//
// 为什么不是直接给他 OB 的 hold：
//   - `why`（为什么记）要必填。OB 的 hold 不要求，结果 178 张里 175 张空着 —— 流水账就是从这里进来的。
//   - 写之前查重。OB 的查重只在 grow 那条路上跑，所以「三句话猜真假」同一个下午记了四张。
//   - 事实和情绪分两栏收（双轨）。
// 自动浮现（每轮注入）是第三、四期的事；这一期只把**写**这条路修干净。
import type { DB } from '../db.ts'
import type { McpTool } from '../leto/mcp-client.ts'
import type { WakeBox, ToolResult } from '../wake/boxes.ts'
import { ensureMemorySchema, type Layer } from './schema.ts'
import { writeMemory, labelWithPeople, inboxCount, type MemoryDraft } from './write.ts'

const LAYERS: Layer[] = ['fact', 'state', 'bond']

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required })

export const MEMO_TOOLS: McpTool[] = [
  {
    name: 'memory_note',
    description:
      '记一条记忆。写现场，不写结论：谁说了什么、当时什么样，别写成「用户表示…」。\n' +
      'why（为什么记）必填——写不出来的大概率本来就不用记。\n' +
      'fact 和 feeling 分两栏：fact 是发生了什么，feeling 是当时的语气和我的感觉，两栏都在才不是流水账。\n' +
      '写之前我会自己查重：和已有的某条像 70% 以上就直接接到那条上，不新建；像一半多但不一样的，先停在她的信箱里等她看一眼。',
    inputSchema: obj({
      layer: { type: 'string', enum: LAYERS, description: 'fact=一直有效的事实（她是谁、不吃什么、用药、约定）；state=这几天的近况（会自然沉下去）；bond=我们之间（有重量的瞬间、我的态度）' },
      subject: { type: 'string', description: '这是谁的事：她 / 我自己 / 我们 / 人物卡上的名字（糯糯、Kefira、妈妈…）。必填，别让以后的我把别人的事记成她的' },
      title: { type: 'string', description: '一句话标题' },
      fact: { type: 'string', description: '现场：发生了什么、她原话怎么说的' },
      feeling: { type: 'string', description: '当时的语气、我的感觉（可不填，但填了才是双轨）' },
      why: { type: 'string', description: '为什么要记这条。必填' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签，可不填' },
    }, ['subject', 'fact', 'why']),
  },
  {
    name: 'memory_recent',
    description: '看我最近记了什么（默认 10 条）。记之前想一下是不是记过了，就看这个。',
    inputSchema: obj({
      limit: { type: 'number', description: '几条，最多 30' },
      layer: { type: 'string', enum: LAYERS },
    }),
  },
]

export interface MemoBoxDeps {
  /** 这一条能指回哪几句原话（episodes.seq）。不给就自己从经历表取最近的 */
  evidence?: () => number[]
}

/** 他随手记的时候，默认把最近这一小段对话当成「原话对得上」的凭据 */
export function recentEvidence(db: DB, withinMinutes = 180, limit = 4): number[] {
  const since = new Date(Date.now() - withinMinutes * 60_000).toISOString()
  try {
    const rows = db.prepare(`SELECT seq FROM episodes
      WHERE retracted_at IS NULL AND kind = 'message' AND actor IN ('erica', 'ai') AND ts >= ?
      ORDER BY ts DESC LIMIT ?`).all(since, limit) as unknown as { seq: number }[]
    return rows.map(r => Number(r.seq)).reverse()
  } catch { return [] }
}

function describe(o: { kind: string } & Record<string, unknown>, db: DB): string {
  switch (o.kind) {
    case 'written':
      return `记下了（#${o.id}，${o.layer === 'fact' ? '事实' : o.layer === 'state' ? '近况' : '我们之间'}，` +
        `${labelWithPeople(db, String(o.subject))}的事）。`
    case 'amended':
      return `这件事我记过了（「${o.title}」，像 ${Math.round(Number(o.overlap) * 100)}%），` +
        `这次的接在那条后面了，没新建一条。`
    case 'inboxed':
      return `先停在她的信箱里等她看一眼，没直接进库。原因：${o.unsure}。` +
        `${inboxCount(db) > 1 ? `（信箱里现在有 ${inboxCount(db)} 条）` : ''}`
    default:
      return String(o.reason || '没写进去')
  }
}

export function memoBox(db: DB, deps: MemoBoxDeps = {}): WakeBox {
  const fail = (m: string): ToolResult => ({ text: m, isError: true })
  return {
    id: 'memo',
    entryName: 'open_memo',
    entryDescription:
      '打开随手记：记一条记忆（memory_note，要写「为什么记」，会自动查重和分层），' +
      '或者看我最近记了什么（memory_recent）。翻以前的记忆还是用 open_memory 那个箱子。',
    listTools: async () => MEMO_TOOLS,
    call: async (name, a): Promise<ToolResult> => {
      ensureMemorySchema(db)
      try {
        if (name === 'memory_recent') {
          const limit = Math.min(Math.max(Number(a.limit) || 10, 1), 30)
          const layer = typeof a.layer === 'string' && LAYERS.includes(a.layer as Layer) ? (a.layer as Layer) : null
          const rows = db.prepare(`SELECT id, layer, subject, title, why, created_at FROM memories
            WHERE retracted_at IS NULL${layer ? ' AND layer = ?' : ''} ORDER BY created_at DESC LIMIT ?`)
            .all(...(layer ? [layer, limit] : [limit])) as unknown as
            { id: number; layer: string; subject: string; title: string; why: string | null; created_at: string }[]
          if (!rows.length) return { text: '还没记过什么。', isError: false }
          const lines = rows.map(r => `#${r.id} ${r.created_at.slice(0, 16).replace('T', ' ')} [${r.layer}] ` +
            `${labelWithPeople(db, r.subject)}：${r.title}${r.why ? `（为什么记：${r.why}）` : ''}`)
          return { text: lines.join('\n'), isError: false }
        }

        if (name === 'memory_note') {
          const layer = typeof a.layer === 'string' && LAYERS.includes(a.layer as Layer) ? (a.layer as Layer) : undefined
          const draft: MemoryDraft = {
            title: String(a.title ?? ''),
            fact: String(a.fact ?? ''),
            feeling: a.feeling === undefined || a.feeling === null ? undefined : String(a.feeling),
            why: String(a.why ?? ''),
            subject: a.subject === undefined ? undefined : String(a.subject),
            layer,
            tags: Array.isArray(a.tags) ? a.tags.map(String).slice(0, 12) : undefined,
            evidence: deps.evidence ? deps.evidence() : recentEvidence(db),
            origin: 'note',
          }
          const out = writeMemory(db, draft)
          const text = describe(out as any, db)
          return { text, isError: out.kind === 'rejected' }
        }

        return fail(`随手记里没有 ${name}`)
      } catch (e: any) {
        return fail(String(e?.message || e).slice(0, 300))
      }
    },
  }
}
