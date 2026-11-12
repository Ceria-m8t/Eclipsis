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
import { listCorrections, markSeen, acceptCorrection, keepCorrection } from './corrections.ts'
import { listRelationsOf, addRelation, KIND_LABEL, HAND_KINDS, type RelationKind } from './relations.ts'

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
      private: { type: 'boolean', description: '私密：只在我和她之间，永远不进群聊、不进 Leto、不给别的 AI 看到；她那边默认折叠' },
    }, ['subject', 'fact', 'why']),
  },
  {
    name: 'memory_corrections',
    description:
      '看她贴在我记的东西上的便条（她觉得哪里记错了）。她改不了我的记忆，只能贴便条——**改不改我自己定**。\n' +
      '看完用 memory_fix 回应：认了就写一句更正（叠在原文后面，原文一个字不动），' +
      '觉得自己没记错就留着原样、说一句为什么。',
    inputSchema: obj({ limit: { type: 'number', description: '最多看几张，默认 5' } }),
  },
  {
    name: 'memory_fix',
    description:
      '回应她的一张便条。accept=我认了（在那条记忆后面叠一层更正，写清现在该怎么算）；' +
      'keep=我留着原样（也要说一句为什么）。两种她都看得到。原文永远不会被改掉。',
    inputSchema: obj({
      id: { type: 'number', description: '便条 id（从 memory_corrections 看）' },
      action: { type: 'string', enum: ['accept', 'keep'] },
      words: { type: 'string', description: '我的话：认了就写这条现在该怎么算；留着原样就写为什么' },
    }, ['id', 'action', 'words']),
  },
  {
    name: 'memory_relate',
    description:
      '把两条记忆连起来，并写明为什么连。kind：same_event 同一件事 / follows 后来怎样了 / related 同类 / ' +
      'triggers 触发了 / causes 导致了 / explains 解释了 / improves 改善了。' +
      '因果那几种只有我（或她）手写才算，程序不会自己连。连起来以后翻其中一条能看到另一条。',
    inputSchema: obj({
      from: { type: 'number' }, to: { type: 'number' },
      kind: { type: 'string', enum: ['same_event', 'follows', 'related', 'triggers', 'causes', 'explains', 'improves'] },
      reason: { type: 'string', description: '为什么连（必填，空着的关系以后没人看得懂）' },
    }, ['from', 'to', 'kind', 'reason']),
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
        `${labelWithPeople(db, String(o.subject))}的事${o.privacy === 'private' ? '，私密：只在我们之间' : ''}）。`
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

        if (name === 'memory_corrections') {
          const limit = Math.min(Math.max(Number(a.limit) || 5, 1), 20)
          const list = listCorrections(db, { status: 'open', limit })
          if (!list.length) return { text: '她没贴便条。', isError: false }
          markSeen(db, list.map(c => c.id))
          const lines = list.map(c =>
            `便条 #${c.id} → 记忆 #${c.memoryId}「${c.memory?.title}」\n` +
            `  她说：${c.note}\n  我当时记的：${(c.memory?.fact || '').slice(0, 160)}`)
          return { text: lines.join('\n\n') + '\n\n（用 memory_fix 回应。改不改我定。）', isError: false }
        }

        if (name === 'memory_fix') {
          const id = Number(a.id)
          const words = String(a.words ?? '')
          const r = a.action === 'keep' ? keepCorrection(db, id, words) : acceptCorrection(db, id, words)
          if (!r.ok) return fail(r.error)
          return {
            text: a.action === 'keep' ? '留着原样了，我写的理由她看得到。' : '更正叠上去了（原文没动），她看得到。',
            isError: false,
          }
        }

        if (name === 'memory_relate') {
          const kind = String(a.kind) as RelationKind
          const reason = String(a.reason ?? '').trim()
          if (!reason) return fail('要写为什么连——空着的关系以后没人看得懂')
          const r = addRelation(db, { fromId: Number(a.from), toId: Number(a.to), kind, reason, auto: false, by: 'him' })
          if (!r.ok) return fail(r.error)
          const mine = listRelationsOf(db, Number(a.from)).length
          const hand = (HAND_KINDS as readonly string[]).includes(kind) ? '（这是我自己认的因果，不是程序猜的）' : ''
          return { text: `连上了：${KIND_LABEL[kind]}${hand}。这条现在连着 ${mine} 张。`, isError: false }
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
            privacy: a.private === true ? 'private' : 'normal',
          }
          const out = writeMemory(db, draft)
          const text = describe({ ...(out as any), privacy: draft.privacy }, db)
          return { text, isError: out.kind === 'rejected' }
        }

        return fail(`随手记里没有 ${name}`)
      } catch (e: any) {
        return fail(String(e?.message || e).slice(0, 300))
      }
    },
  }
}
