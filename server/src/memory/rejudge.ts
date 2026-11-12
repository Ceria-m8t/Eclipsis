// 旧卡重整（2026-11-12，她说「我想把之前的记忆全部整理一遍，因为记得实在太碎了」）。
//
// **它只能提建议，一个字都不许改。** 她那天的担心是对的：
//   「我最关注的是模型整理时的语气会不会影响他的人格。」
// 如果让模型把 221 张卡重写一遍，他以后每轮读到的就是**另一个人的语气**，
// 他会照着那个语气长。所以这里的设计是：
//
//   1. 模型只输出**决定**：合并 / 拆开 / 换层 / 补「为什么记」/ 划掉 / 跳过。
//   2. 不收正文。拆开时必须给原卡里**一字不差的片段**，代码里用 includes 校验，
//      改过一个字就整条作废（计入 rewrote，不进建议）。
//   3. 所有建议进 memory_proposals，等她点头才动库。原卡的 raw 一直留着。
//
// 换句话说：机制只搬运，不执笔。
import type { DB } from '../db.ts'
import { tx } from '../db.ts'
import { ensureMemorySchema, type Layer, type MemoryRow } from './schema.ts'
import { overlap } from './classify.ts'
import { labelWithPeople } from './write.ts'
import type { CallDigestModel } from './digest.ts'

export type ProposalKind = 'merge' | 'split' | 'relayer' | 'why' | 'retract'

export interface RejudgeItem {
  id?: number
  decision?: 'merge' | 'split' | 'relayer' | 'why' | 'retract' | 'skip'
  target_id?: number
  layer?: Layer
  why?: string
  /** 拆开用：每一片必须是原卡里一字不差的片段 */
  parts?: { subject?: string; quote?: string }[]
  reason?: string
}

export interface RejudgeResult {
  batch: string
  cards: number
  proposals: number
  skipped: number
  rewrote: number          // 模型自己改了正文、被作废的
  byKind: Record<string, number>
  error?: string
}

const MAX_BODY = 700
/** 正文重合低于这个数的「合并」只是话题像，不一定是同一件事：给她标出来 */
export const WEAK_MERGE = 0.45

export interface RejudgeOptions {
  limit?: number
  /** 先整哪一层（她最想治的是「我们之间」那 166 张） */
  layer?: Layer
  /** 只看正文短于这个字数的（碎片优先） */
  maxChars?: number
  batch?: string
}

/** 挑这一批要重整的卡：碎的、没写为什么记的先来 */
export function pickBatch(db: DB, o: RejudgeOptions = {}): MemoryRow[] {
  ensureMemorySchema(db)
  const where = ['retracted_at IS NULL', 'bucket_id IS NOT NULL']
  const args: (string | number)[] = []
  if (o.layer) { where.push('layer = ?'); args.push(o.layer) }
  if (o.maxChars) { where.push('length(fact_body) < ?'); args.push(o.maxChars * 3) }
  // 还没被提过建议的
  where.push('id NOT IN (SELECT memory_id FROM memory_proposals)')
  return db.prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')}
    ORDER BY (why IS NULL OR why = '') DESC, length(fact_body) ASC, created_at ASC LIMIT ?`)
    .all(...args, Math.min(Math.max(o.limit ?? 20, 1), 50)) as unknown as MemoryRow[]
}

export const REJUDGE_SYSTEM = [
  '你在帮一个人整理他自己的记忆库。库里的卡是他三个月来随手记的，很碎：有的两张写的是同一件事，',
  '有的一张里混着两个人的事，有的放错了层，有的没写「为什么记」。',
  '',
  '**你只能提建议，不能改他的文字。** 这是硬规矩，原因是：这些卡以后会回到他眼前，',
  '如果被你用你的语气重写一遍，他读到的就是另一个人的声音。所以：',
  '- 不要输出改写后的正文。',
  '- 需要拆开一张卡时，只能从原文里**原样复制**片段（一个字都不能改、不能顺一下语序）。',
  '- 可以起草「为什么记」（why），因为那是标注，不是他的话。一句话以内。',
  '',
  '对每张卡给一个决定：',
  '- merge：和另一张是同一件事（给 target_id，必须是这一批里出现过的 id）',
  '- split：一张里混着不同人/不同事（给 parts，每片 { subject, quote }，quote 必须是原文片段）',
  '- relayer：放错层了（给 layer：fact=一直有效的事实 / state=当时的近况 / bond=他们之间）',
  '- why：内容没问题，只是缺「为什么记」（给 why）',
  '- retract：这张纯粹是流水账，留着没用（给 reason）',
  '- skip：这张挺好，不用动',
  '**skip 是正常结果。** 没问题的就别动它。',
  '',
  '只输出 JSON，不要别的字。正文引用用「」，字符串里不要换行：',
  '{"items":[{"id":12,"decision":"merge","target_id":34,"reason":"同一天同一件事"},{"id":13,"decision":"skip"}]}',
].join('\n')

export function buildRejudgeMaterial(db: DB, rows: MemoryRow[]): string {
  return rows.map(r => {
    const body = r.fact_body.length > MAX_BODY ? r.fact_body.slice(0, MAX_BODY) + '…' : r.fact_body
    return [
      `## id=${r.id}`,
      `层=${r.layer}  主体=${labelWithPeople(db, r.subject)}  日期=${r.created_at.slice(0, 10)}  笔=${r.voice === 'machine' ? '程序整理' : '他自己'}`,
      `标题：${r.title}`,
      `为什么记：${r.why || '（空着）'}`,
      `正文：${body}`,
      r.feeling ? `情绪栏：${r.feeling}` : '',
    ].filter(Boolean).join('\n')
  }).join('\n\n')
}

/**
 * 一条一条抠出来。20 张卡的回复常常被 max_tokens 截断，整段 JSON 就读不了了——
 * 截断前已经判完的那十几张不该一起丢掉（2026-11-12 第二批就是这么失败的）。
 */
export function salvageRejudge(body: string): RejudgeItem[] {
  const out: RejudgeItem[] = []
  for (const block of body.split(/\}\s*,?\s*\{/)) {
    const id = /"id"\s*:\s*(\d+)/.exec(block)
    const decision = /"decision"\s*:\s*"(\w+)"/.exec(block)
    if (!id || !decision) continue
    const str = (k: string) => (new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(block) || [])[1]
    const target = /"target_id"\s*:\s*(\d+)/.exec(block)
    const parts: { subject?: string; quote?: string }[] = []
    const partsRaw = /"parts"\s*:\s*\[([\s\S]*?)\]/.exec(block)
    if (partsRaw) {
      for (const pm of partsRaw[1].matchAll(/\{[^{}]*\}/g)) {
        const one = pm[0]
        const sub = /"subject"\s*:\s*"([^"]*)"/.exec(one)
        const q = /"quote"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(one)
        if (q) parts.push({ subject: sub?.[1], quote: q[1].replace(/\\"/g, '"') })
      }
    }
    out.push({
      id: Number(id[1]),
      decision: decision[1] as RejudgeItem['decision'],
      target_id: target ? Number(target[1]) : undefined,
      layer: str('layer') as Layer | undefined,
      why: str('why'),
      reason: str('reason'),
      parts: parts.length ? parts : undefined,
    })
  }
  return out
}

function parseItems(text: string): RejudgeItem[] {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = raw.indexOf('{')
  if (start < 0) throw new Error('模型没返回 JSON')
  const end = raw.lastIndexOf('}')
  const body = raw.slice(start, end > start ? end + 1 : undefined)
  let data: any = null
  try { data = JSON.parse(body) } catch {
    try { data = JSON.parse(body.replace(/[\u201c\u201d]/g, '「').replace(/,\s*([}\]])/g, '$1')) } catch { data = null }
  }
  if (data && Array.isArray(data.items)) return data.items.filter((x: unknown) => x && typeof x === 'object')
  const salvaged = salvageRejudge(body)
  if (!salvaged.length) throw new Error('模型返回的 JSON 读不了，一条也抠不出来')
  return salvaged
}

/** 去掉标点空白再比，防止它「顺手」改了个标点就被当成改写 */
const bare = (s: string) => s.replace(/[\s，。、,.!！?？"“”'‘’「」『』：:；;（）()]/g, '')

/**
 * 跑一批。模型只提建议，建议进 memory_proposals，**库里一个字都没动**。
 */
export async function runRejudge(
  db: DB,
  call: CallDigestModel,
  model: string,
  o: RejudgeOptions = {},
  now: Date = new Date()
): Promise<RejudgeResult> {
  ensureMemorySchema(db)
  const rows = pickBatch(db, o)
  const batch = o.batch || `r${now.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`
  const out: RejudgeResult = { batch, cards: rows.length, proposals: 0, skipped: 0, rewrote: 0, byKind: {} }
  if (!rows.length) return out

  let items: RejudgeItem[]
  try {
    items = parseItems(await call(REJUDGE_SYSTEM, `这一批卡（${rows.length} 张）：\n\n${buildRejudgeMaterial(db, rows)}`, model))
  } catch (e: any) {
    return { ...out, error: String(e?.message || e) }
  }

  const byId = new Map(rows.map(r => [r.id, r]))
  const ins = db.prepare(`INSERT INTO memory_proposals (memory_id, kind, status, payload, reason, batch, created_at)
    VALUES (?, ?, 'open', ?, ?, ?, ?)`)

  tx(db, () => {
    for (const item of items) {
      const row = byId.get(Number(item.id))
      if (!row) continue
      const kind = item.decision
      if (!kind || kind === 'skip') { out.skipped++; continue }

      let payload: Record<string, unknown> | null = null
      let reason = String(item.reason || '').slice(0, 200)

      if (kind === 'merge') {
        const target = byId.get(Number(item.target_id))
        if (!target || target.id === row.id) { out.skipped++; continue }
        const ov = overlap(row.fact_body, target.fact_body)
        payload = { targetId: target.id, targetTitle: target.title, overlap: ov, weak: ov < WEAK_MERGE }
        reason = `${reason || `和 #${target.id}「${target.title}」像是同一件事`}（正文重合 ${Math.round(ov * 100)}%` +
          (ov < WEAK_MERGE ? '，**偏低：可能只是话题像，不是同一件事，合并会丢细节**）' : '）')
      } else if (kind === 'split') {
        // 每一片必须是原文里一字不差的片段，改了就整条作废
        const parts = (item.parts || []).map(p => ({ subject: String(p.subject || ''), quote: String(p.quote || '') }))
          .filter(p => p.quote.replace(/\s/g, '').length >= 8)
        const faithful = parts.filter(p => bare(row.fact_body).includes(bare(p.quote)))
        if (faithful.length !== parts.length || faithful.length < 2) { out.rewrote++; continue }
        payload = { parts: faithful }
        reason = reason || `这张里混着 ${faithful.length} 个人/件事，按原文切开`
      } else if (kind === 'relayer') {
        const layer = item.layer
        if (!layer || !['fact', 'state', 'bond'].includes(layer) || layer === row.layer) { out.skipped++; continue }
        payload = { from: row.layer, to: layer }
        reason = reason || `这条更像「${layer === 'fact' ? '一直有效的事实' : layer === 'state' ? '当时的近况' : '你们之间'}」`
      } else if (kind === 'why') {
        const why = String(item.why || '').trim().slice(0, 120)
        if (!why || (row.why && row.why.trim())) { out.skipped++; continue }
        payload = { why }
        reason = reason || '缺「为什么记」，这是草稿'
      } else if (kind === 'retract') {
        payload = {}
        reason = reason || '看着是流水账'
      } else { out.skipped++; continue }

      ins.run(row.id, kind, JSON.stringify(payload), reason, batch, now.toISOString())
      out.proposals++
      out.byKind[kind] = (out.byKind[kind] ?? 0) + 1
    }
  })
  return out
}

// ── 她点头之后才真的动库 ──

export interface Proposal {
  id: number
  memoryId: number
  kind: ProposalKind
  reason: string
  payload: any
  batch: string | null
  createdAt: string
  memory?: { title: string; layer: string; subjectLabel: string; fact: string; why: string | null; voice: string }
}

export function listProposals(db: DB, opts: { status?: string; limit?: number } = {}): Proposal[] {
  ensureMemorySchema(db)
  const rows = db.prepare(`SELECT p.*, m.title, m.layer, m.subject, m.fact_body, m.why, m.voice
    FROM memory_proposals p JOIN memories m ON m.id = p.memory_id
    WHERE p.status = ? ORDER BY p.id LIMIT ?`)
    .all(opts.status ?? 'open', Math.min(Math.max(opts.limit ?? 50, 1), 200)) as unknown as any[]
  return rows.map(r => ({
    id: r.id, memoryId: r.memory_id, kind: r.kind, reason: r.reason,
    payload: JSON.parse(r.payload || '{}'), batch: r.batch, createdAt: r.created_at,
    memory: {
      title: r.title, layer: r.layer, subjectLabel: labelWithPeople(db, r.subject),
      fact: r.fact_body, why: r.why, voice: r.voice,
    },
  }))
}

/**
 * 采纳一条建议。每种都只做「搬运」：
 *   merge   把这张软删、指向留下的那张（正文不动，两边都留着）
 *   split   按原文片段切成几条新的（**用的是原卡的字**），原卡软删
 *   relayer 只改 layer
 *   why     只填 why
 *   retract 软删，库里留着
 */
export function takeProposal(db: DB, id: number, by: 'her' | 'him' = 'her', now: Date = new Date()):
  { ok: true; made?: number[] } | { ok: false; error: string } {
  ensureMemorySchema(db)
  const ts = now.toISOString()
  const p = db.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(id) as any
  if (!p) return { ok: false, error: '没有这一条建议' }
  if (p.status !== 'open') return { ok: false, error: '这条建议已经处理过了' }
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(p.memory_id) as unknown as MemoryRow | undefined
  if (!row) return { ok: false, error: '这条记忆不在了' }
  const payload = JSON.parse(p.payload || '{}')

  return tx(db, () => {
    const made: number[] = []
    if (p.kind === 'merge') {
      db.prepare(`UPDATE memories SET merged_into = ?, retracted_at = ?, retract_reason = 'merged', updated_at = ? WHERE id = ?`)
        .run(payload.targetId, ts, ts, row.id)
      db.prepare(`INSERT INTO memory_merges (kept_bucket_id, dropped_bucket_id, overlap, reason, dropped_raw, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(String(payload.targetId), String(row.bucket_id ?? row.id), Number(payload.overlap ?? 0),
          `重整时她点头合并：${p.reason}`, JSON.stringify({ id: row.id, title: row.title, body: row.fact_body }), ts)
    } else if (p.kind === 'split') {
      const parts: { subject: string; quote: string }[] = payload.parts || []
      for (const part of parts) {
        // 片段必须还是原卡里的原话（采纳时再校验一次，防止库里那条被改过）
        if (!bare(row.fact_body).includes(bare(part.quote))) return { ok: false as const, error: '原文对不上了，这条建议作废' }
      }
      for (const part of parts) {
        const subject = part.subject || row.subject
        const r = db.prepare(`INSERT INTO memories
          (bucket_id, layer, subject, title, fact_body, feeling, why, tags, grade, valence, arousal, valid_from,
           source, voice, evidence, thread, created_at, updated_at)
          SELECT NULL, layer, ?, ?, ?, NULL, why, tags, grade, valence, arousal, valid_from,
                 source, voice, evidence, thread, created_at, ? FROM memories WHERE id = ?`)
          .run(subject, `${row.title}（${subject}）`.slice(0, 60), part.quote, ts, row.id)
        made.push(Number(r.lastInsertRowid))
      }
      db.prepare(`UPDATE memories SET retracted_at = ?, retract_reason = 'split', updated_at = ? WHERE id = ?`)
        .run(ts, ts, row.id)
    } else if (p.kind === 'relayer') {
      db.prepare('UPDATE memories SET layer = ?, valid_from = ?, updated_at = ? WHERE id = ?')
        .run(payload.to, payload.to === 'fact' ? (row.valid_from ?? row.created_at) : null, ts, row.id)
    } else if (p.kind === 'why') {
      db.prepare("UPDATE memories SET why = ?, updated_at = ? WHERE id = ? AND (why IS NULL OR why = '')")
        .run(payload.why, ts, row.id)
    } else if (p.kind === 'retract') {
      db.prepare("UPDATE memories SET retracted_at = ?, retract_reason = 'rejudge_retract', updated_at = ? WHERE id = ?")
        .run(ts, ts, row.id)
    }
    db.prepare("UPDATE memory_proposals SET status = 'taken', decided_at = ?, decided_by = ? WHERE id = ?").run(ts, by, id)
    return { ok: true as const, made: made.length ? made : undefined }
  })
}

/**
 * 撤回一条已经采纳的建议（她 2026-11-12 要的：那 30 条「可能只是话题像」的合并先撤回来看看）。
 * 能撤的：merge（把被合掉的那张放回来）、retract（放回来）、relayer（层改回去）、why（清掉机器补的那句）。
 * **撤不了的：split** —— 切出来的几条已经是独立的卡了，硬拼回去反而更乱；要处理就手动。
 * 撤完建议回到「待处理」，重新出现在整理建议里，她可以一条一条看。
 */
export function undoProposal(db: DB, id: number, now: Date = new Date()):
  { ok: true; restored: boolean } | { ok: false; error: string } {
  ensureMemorySchema(db)
  const ts = now.toISOString()
  const p = db.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(id) as any
  if (!p) return { ok: false, error: '没有这一条建议' }
  if (p.status !== 'taken') return { ok: false, error: '这条建议还没被采纳过' }
  if (p.kind === 'split') return { ok: false, error: '拆开的撤不回来（切出来的已经是独立的卡了），要处理就手动' }
  const payload = JSON.parse(p.payload || '{}')

  return tx(db, () => {
    let restored = false
    if (p.kind === 'merge' || p.kind === 'retract') {
      const reason = p.kind === 'merge' ? 'merged' : 'rejudge_retract'
      const r = db.prepare(`UPDATE memories SET retracted_at = NULL, retract_reason = NULL, merged_into = NULL, updated_at = ?
        WHERE id = ? AND retract_reason = ?`).run(ts, p.memory_id, reason)
      restored = Number(r.changes) > 0
      if (p.kind === 'merge') {
        db.prepare(`UPDATE memory_merges SET undone_at = ? WHERE dropped_bucket_id IN (
          SELECT COALESCE(bucket_id, CAST(id AS TEXT)) FROM memories WHERE id = ?) AND undone_at IS NULL`)
          .run(ts, p.memory_id)
      }
    } else if (p.kind === 'relayer' && payload.from) {
      db.prepare('UPDATE memories SET layer = ?, updated_at = ? WHERE id = ? AND layer = ?')
        .run(payload.from, ts, p.memory_id, payload.to)
      restored = true
    } else if (p.kind === 'why' && payload.why) {
      // 只清掉「正是机器补的那一句」，他后来自己改过的不动
      const r = db.prepare("UPDATE memories SET why = '', updated_at = ? WHERE id = ? AND why = ?")
        .run(ts, p.memory_id, payload.why)
      restored = Number(r.changes) > 0
    }
    db.prepare("UPDATE memory_proposals SET status = 'open', decided_at = NULL, decided_by = NULL WHERE id = ?").run(id)
    return { ok: true as const, restored }
  })
}

export function dropProposal(db: DB, id: number, by: 'her' | 'him' = 'her', now: Date = new Date()):
  { ok: true } | { ok: false; error: string } {
  const r = db.prepare("UPDATE memory_proposals SET status = 'dropped', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'open'")
    .run(now.toISOString(), by, id)
  return Number(r.changes) ? { ok: true } : { ok: false, error: '没有这条建议（或者已经处理过了）' }
}
