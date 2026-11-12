// 关系边（2026-11-12）。卡片现在是一座座孤岛：召回捞到「她不爱过生日」里的某一张，
// 看不到这件事半年里其实浮现过 5 次。关系边是把它们连起来的第一步。
//
// 形状抄「缝合怪」那张图最要紧的一条：**每条关系都要写明为什么连。**
// 但也因此要诚实分级：
//   - OB 原来的 292 条 relation_links 全是**按相似度自动连的**（auto=1，连 label 都是空的），
//     搬进来只敢标 related / same_event / follows，理由写「OB 按相似度自动连的（0.74）」。
//   - triggers（触发）/ causes（导致）/ explains（解释）/ improves（改善）这几种带因果的，
//     **只有他或她手写才算**。程序不猜因果——猜错了就是替他编故事。
import type { DB } from '../db.ts'
import { tx } from '../db.ts'
import { ensureMemorySchema } from './schema.ts'

/** 七种关系。前三种程序可以连，后四种只能人手写 */
export const AUTO_KINDS = ['same_event', 'follows', 'related'] as const
export const HAND_KINDS = ['triggers', 'causes', 'explains', 'improves'] as const
export type RelationKind = (typeof AUTO_KINDS)[number] | (typeof HAND_KINDS)[number]

export const KIND_LABEL: Record<RelationKind, string> = {
  same_event: '同一件事',
  follows: '后来怎样了',
  related: '同类',
  triggers: '触发了',
  causes: '导致了',
  explains: '解释了',
  improves: '改善了',
}

/** OB 的四种 type → 我们的三种（只到这里，不往因果上靠） */
const OB_KIND: Record<string, RelationKind> = {
  same_event: 'same_event',
  continuation_of: 'follows',
  continues: 'follows',
  related_to: 'related',
}

export interface Relation {
  id: number
  fromId: number
  toId: number
  kind: RelationKind
  label: string
  reason: string
  score: number | null
  auto: number
  createdBy: string
  createdAt: string
  /** 另一头那张卡（listRelationsOf 会填） */
  other?: { id: number; title: string; layer: string; createdAt: string }
}

export function addRelation(
  db: DB,
  o: { fromId: number; toId: number; kind: RelationKind; reason?: string; score?: number; auto?: boolean; by?: string },
  now: Date = new Date()
): { ok: true; id: number; created: boolean } | { ok: false; error: string } {
  ensureMemorySchema(db)
  if (o.fromId === o.toId) return { ok: false, error: '不能连到自己' }
  if (!(AUTO_KINDS as readonly string[]).includes(o.kind) && !(HAND_KINDS as readonly string[]).includes(o.kind)) {
    return { ok: false, error: `没有 ${o.kind} 这种关系` }
  }
  const auto = o.auto ?? false
  if (auto && (HAND_KINDS as readonly string[]).includes(o.kind)) {
    return { ok: false, error: '因果类的关系（触发/导致/解释/改善）只能他或她手写，程序不许自动连' }
  }
  const exists = db.prepare('SELECT id FROM memories WHERE id IN (?, ?) AND retracted_at IS NULL').all(o.fromId, o.toId) as unknown as unknown[]
  if (exists.length < 2) return { ok: false, error: '两头的记忆要都在' }
  const r = db.prepare(`INSERT OR IGNORE INTO memory_relations (from_id, to_id, kind, reason, score, auto, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(o.fromId, o.toId, o.kind, (o.reason ?? '').slice(0, 200), o.score ?? null, auto ? 1 : 0, o.by ?? (auto ? 'ob' : 'him'), now.toISOString())
  if (!Number(r.changes)) {
    // 已经连过了（同一对、同一种）：不当成新连的，免得重复跑时数字虚高
    const old = db.prepare('SELECT id FROM memory_relations WHERE from_id = ? AND to_id = ? AND kind = ?').get(o.fromId, o.toId, o.kind) as { id: number }
    return { ok: true, id: old.id, created: false }
  }
  return { ok: true, id: Number(r.lastInsertRowid), created: true }
}

export function removeRelation(db: DB, id: number, now: Date = new Date()): boolean {
  const r = db.prepare('UPDATE memory_relations SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(now.toISOString(), id)
  return Number(r.changes) > 0
}

/** 一张卡连着哪些（两个方向都算） */
export function listRelationsOf(db: DB, memoryId: number): Relation[] {
  ensureMemorySchema(db)
  const rows = db.prepare(`SELECT r.*, m.id AS other_id, m.title AS other_title, m.layer AS other_layer, m.created_at AS other_created
    FROM memory_relations r
    JOIN memories m ON m.id = CASE WHEN r.from_id = ? THEN r.to_id ELSE r.from_id END
    WHERE (r.from_id = ? OR r.to_id = ?) AND r.removed_at IS NULL AND m.retracted_at IS NULL
    ORDER BY r.auto ASC, r.score DESC NULLS LAST, r.id`)
    .all(memoryId, memoryId, memoryId) as unknown as any[]
  return rows.map(r => ({
    id: r.id, fromId: r.from_id, toId: r.to_id, kind: r.kind, label: KIND_LABEL[r.kind as RelationKind] || r.kind,
    reason: r.reason, score: r.score, auto: r.auto, createdBy: r.created_by, createdAt: r.created_at,
    other: { id: r.other_id, title: r.other_title, layer: r.other_layer, createdAt: r.other_created },
  }))
}

/** 「一起亮」：和这张直接连着的几张（星河记忆树那个效果要的就是这个） */
export function neighbors(db: DB, memoryId: number, limit = 6): { id: number; title: string; kind: string; reason: string }[] {
  return listRelationsOf(db, memoryId).slice(0, limit).map(r => ({
    id: r.other!.id, title: r.other!.title, kind: r.label, reason: r.reason,
  }))
}

export interface ExtractReport {
  cards: number
  edges: number
  inserted: number
  skipped: number
  missing: number        // 指向的卡不在我们库里（被合并掉或没搬进来）
  byKind: Record<string, number>
}

/**
 * 把 OB 的 relation_links 从 raw 里抽出来。只读 raw，可反复跑。
 * 全部标 auto=1，理由写清楚是「按相似度自动连的」——它们**不是**他自己认的关系。
 */
export function extractObRelations(db: DB, now: Date = new Date()): ExtractReport {
  ensureMemorySchema(db)
  const rows = db.prepare(`SELECT id, bucket_id, raw FROM memories
    WHERE raw IS NOT NULL AND bucket_id IS NOT NULL`).all() as unknown as { id: number; bucket_id: string; raw: string }[]
  const byBucket = new Map<string, number>()
  for (const r of rows) byBucket.set(r.bucket_id, r.id)
  // 被合并掉的卡：两头都要跟着走。
  // 只改「指过去」那一头是不够的 —— 她 11-12 采纳了 48 条合并之后，有 101 条边的**出发点**
  // 是被合掉的那张卡，不跟着走就全丢了（合并的本意是「这两张是同一件事」，边当然要留给活着的那张）。
  const merged = db.prepare('SELECT bucket_id, merged_into FROM memories WHERE merged_into IS NOT NULL AND bucket_id IS NOT NULL')
    .all() as unknown as { bucket_id: string; merged_into: number }[]
  const survivor = new Map<number, number>()
  for (const m of merged) {
    byBucket.set(m.bucket_id, m.merged_into)
    const from = rows.find(r => r.bucket_id === m.bucket_id)?.id
    if (from) survivor.set(from, m.merged_into)
  }
  /** 一路跟到还活着的那张（防止 A→B→C 的链） */
  const resolve = (id: number, depth = 0): number => {
    const next = survivor.get(id)
    return next && depth < 5 ? resolve(next, depth + 1) : id
  }

  const out: ExtractReport = { cards: 0, edges: 0, inserted: 0, skipped: 0, missing: 0, byKind: {} }
  tx(db, () => {
    for (const row of rows) {
      let links: any[] = []
      try { links = JSON.parse(row.raw)?.ob?.relation_links ?? [] } catch { links = [] }
      if (!Array.isArray(links) || !links.length) continue
      out.cards++
      const fromId = resolve(row.id)
      for (const link of links) {
        out.edges++
        if (link?.status && link.status !== 'active') { out.skipped++; continue }
        const target = byBucket.get(String(link?.target_bucket_id ?? ''))
        if (!target) { out.missing++; continue }
        const toId = resolve(target)
        if (toId === fromId) { out.skipped++; continue }
        const kind = OB_KIND[String(link?.type ?? '')] ?? 'related'
        const score = typeof link?.score === 'number' ? link.score : null
        const label = String(link?.label ?? '').trim()
        const reason = label || `OB 按相似度自动连的${score ? `（${score.toFixed(2)}）` : ''}，不是他自己认的关系`
        const r = addRelation(db, { fromId, toId, kind, reason, score: score ?? undefined, auto: true, by: 'ob' }, now)
        if (r.ok && r.created) {
          out.inserted++
          out.byKind[kind] = (out.byKind[kind] ?? 0) + 1
        } else out.skipped++
      }
    }
  })
  return out
}

/** 给他看的一小段：这张卡连着哪几张（召回时跟着递，第三期用） */
export function renderNeighbors(db: DB, memoryId: number, limit = 3): string {
  const ns = neighbors(db, memoryId, limit)
  if (!ns.length) return ''
  return ns.map(n => `· ${n.kind}：「${n.title}」${n.reason ? `（${n.reason}）` : ''}`).join('\n')
}
