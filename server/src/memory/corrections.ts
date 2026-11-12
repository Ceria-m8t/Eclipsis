// 修正层（2026-11-12，她要的「记忆修正功能」）。
//
// 她的担心很具体：他可能把别人的事记成她的、把时间记混。但 2026-10-24 就定了一条规矩——
// **他的记忆只有他能改。** 两件事要同时成立，所以做法是：
//
//   她贴一张便条 → 他下次看到 → **改不改由他定** → 更正**叠在原文上面，不盖掉原文**。
//
// 为什么不直接改：半年后还能看出「他当时是这么记的，后来被纠正过」。
// 直接改掉会让她看到的历史悄悄变样，而且那条卡就不再是他写的了。
//
// 来源：Latent 的「小锁信」（她写便条，他下次开场先看到，改不改由他定）；
// IB 的边界（她的反馈能影响召回，但不变成「事实」）；年轮的镜子（外部只递证据，从不下结论）。
import type { DB } from '../db.ts'
import { ensureMemorySchema } from './schema.ts'

export interface Correction {
  id: number
  memoryId: number
  note: string
  by: string
  status: 'open' | 'accepted' | 'kept' | 'withdrawn'
  hisReply: string | null
  seenAt: string | null
  createdAt: string
  memory?: { title: string; layer: string; fact: string; subject: string }
}

const MAX_NOTE = 300

/** 她在某条记忆上贴一句话 */
export function addCorrection(
  db: DB,
  memoryId: number,
  note: string,
  by: 'her' | 'him' = 'her',
  now: Date = new Date()
): { ok: true; id: number } | { ok: false; error: string } {
  ensureMemorySchema(db)
  const text = String(note ?? '').trim().slice(0, MAX_NOTE)
  if (text.replace(/\s/g, '').length < 2) return { ok: false, error: '便条要写一句话：哪里记错了' }
  const row = db.prepare('SELECT id FROM memories WHERE id = ? AND retracted_at IS NULL').get(memoryId) as { id: number } | undefined
  if (!row) return { ok: false, error: '没有这条记忆' }
  const r = db.prepare(`INSERT INTO memory_corrections (memory_id, note, by, status, created_at)
    VALUES (?, ?, ?, 'open', ?)`).run(memoryId, text, by, now.toISOString())
  return { ok: true, id: Number(r.lastInsertRowid) }
}

export function withdrawCorrection(db: DB, id: number, now: Date = new Date()): boolean {
  const r = db.prepare("UPDATE memory_corrections SET status = 'withdrawn', decided_at = ? WHERE id = ? AND status = 'open'")
    .run(now.toISOString(), id)
  return Number(r.changes) > 0
}

export function listCorrections(db: DB, opts: { status?: string; memoryId?: number; limit?: number } = {}): Correction[] {
  ensureMemorySchema(db)
  const where: string[] = []
  const args: (string | number)[] = []
  if (opts.status) { where.push('c.status = ?'); args.push(opts.status) }
  if (opts.memoryId) { where.push('c.memory_id = ?'); args.push(opts.memoryId) }
  const rows = db.prepare(`SELECT c.*, m.title, m.layer, m.fact_body, m.subject FROM memory_corrections c
    JOIN memories m ON m.id = c.memory_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.id DESC LIMIT ?`).all(...args, Math.min(Math.max(opts.limit ?? 50, 1), 200)) as unknown as any[]
  return rows.map(r => ({
    id: r.id, memoryId: r.memory_id, note: r.note, by: r.by, status: r.status,
    hisReply: r.his_reply, seenAt: r.seen_at, createdAt: r.created_at,
    memory: { title: r.title, layer: r.layer, fact: r.fact_body, subject: r.subject },
  }))
}

export function openCount(db: DB): number {
  try {
    return Number((db.prepare("SELECT count(*) n FROM memory_corrections WHERE status = 'open'").get() as { n: number }).n)
  } catch { return 0 }
}

/** 他读了（只记时间，不算处理过） */
export function markSeen(db: DB, ids: number[], now: Date = new Date()): void {
  if (!ids.length) return
  db.prepare(`UPDATE memory_corrections SET seen_at = COALESCE(seen_at, ?)
    WHERE id IN (${ids.map(() => '?').join(',')})`).run(now.toISOString(), ...ids)
}

/**
 * 他认了：**在原文后面叠一层更正，原文一个字不动。**
 * 这一笔是他自己的手（voice 不变），她的便条原话跟着附上，谁说的清清楚楚。
 */
export function acceptCorrection(
  db: DB,
  id: number,
  hisWords: string,
  now: Date = new Date()
): { ok: true } | { ok: false; error: string } {
  ensureMemorySchema(db)
  const c = db.prepare('SELECT * FROM memory_corrections WHERE id = ?').get(id) as any
  if (!c) return { ok: false, error: '没有这张便条' }
  if (c.status !== 'open') return { ok: false, error: '这张便条已经处理过了' }
  const words = String(hisWords ?? '').trim().slice(0, 300)
  if (words.replace(/\s/g, '').length < 2) return { ok: false, error: '要写一句：这条该怎么算' }
  const ts = now.toISOString()
  const layer = `\n\n【${ts.slice(0, 10)} 更正】${words}\n（她当时说：${c.note}）`
  db.prepare('UPDATE memories SET fact_body = fact_body || ?, updated_at = ? WHERE id = ?').run(layer, ts, c.memory_id)
  db.prepare("UPDATE memory_corrections SET status = 'accepted', his_reply = ?, decided_at = ?, seen_at = COALESCE(seen_at, ?) WHERE id = ?")
    .run(words, ts, ts, id)
  return { ok: true }
}

/** 他不改：留着原样，但要说一句为什么（她看得到） */
export function keepCorrection(
  db: DB,
  id: number,
  hisWords: string,
  now: Date = new Date()
): { ok: true } | { ok: false; error: string } {
  const c = db.prepare('SELECT status FROM memory_corrections WHERE id = ?').get(id) as { status: string } | undefined
  if (!c) return { ok: false, error: '没有这张便条' }
  if (c.status !== 'open') return { ok: false, error: '这张便条已经处理过了' }
  const words = String(hisWords ?? '').trim().slice(0, 300)
  if (words.replace(/\s/g, '').length < 2) return { ok: false, error: '要写一句为什么留着原样' }
  const ts = now.toISOString()
  db.prepare("UPDATE memory_corrections SET status = 'kept', his_reply = ?, decided_at = ?, seen_at = COALESCE(seen_at, ?) WHERE id = ?")
    .run(words, ts, ts, id)
  return { ok: true }
}

/**
 * 「此刻」块里的一行：她贴了几张便条等他看。
 * **只说有几张、不说内容**——内容要他自己用 memory_corrections 去读，
 * 不然等于把她的话塞进他嘴边，他会顺着那句话改。
 */
export function renderCorrectionLine(db: DB): string {
  const n = openCount(db)
  if (!n) return ''
  return `她在你记的东西里贴了 ${n} 张便条（说哪里记错了），用 memory_corrections 看。改不改你定，原文不会被她改掉。`
}
