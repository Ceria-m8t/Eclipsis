// 写记忆的唯一一条路（第二期）。两条线都走这里：
//   他随手记（memory_note）、夜里整理（digest）。
//
// 她 2026-11-12 定的是 **c：只有拿不准的进信箱，明确的直接进库**。
// 「明确」= 下面四条同时成立，缺一条就进信箱等她看一眼：
//   1. 主体唯一       —— 认得出这是谁的事（她最怕的那个错：把朋友的事认成她的事）
//   2. 有原话对得上   —— 指得回经历表里具体哪几句，不是凭空总结的
//   3. 查重不落灰区   —— ≥70% 走续接（接到已有那条上），55%–70% 这一段才拿不准
//   4. 只落一层       —— 不是既像长期事实又像当日状态
// 这四条是在定「拿不准」长什么样，不是给记忆设门槛：不满足的不会被丢掉，只是多她一道手。
//
// 另外两条硬规矩：
//   - `why`（为什么记）必填。库里 178 张 `hold` 有 175 张这个字段是空的，它空着就是流水账的入口。
//   - 事实和情绪两栏都收（双轨）。只有事实没有温度，就是她抱怨的那种流水账。
import type { DB } from '../db.ts'
import { tx } from '../db.ts'
import { ensureMemorySchema, type Grade, type Layer, type MemoryRow } from './schema.ts'
import { classify, guessSubject, overlap, synthCard } from './classify.ts'
import { bjDate } from './when.ts'

export const AMEND_AT = 0.70     // 这个以上算同一件事：接到已有那条上
export const UNSURE_AT = 0.55    // 这两条之间算「像但不一样」：进信箱
/**
 * 标题这一关（2026-11-12 第一次真跑之后加的）：夜里整理写的「通宵一整夜给他装感官」
 * 和 OB 搬来的「她通宵一整夜给我装感官」是同一夜，正文写法不同所以 2-gram 只有 40% 多，
 * **但标题重合 78%**。同一件事换个说法讲一遍，看标题比看正文准。
 */
export const TITLE_UNSURE_AT = 0.70

export interface MemoryDraft {
  title: string
  /** 事实那一栏：现场、原话、发生了什么 */
  fact: string
  /** 情绪那一栏：当时的语气、他的感觉。可以不填，但填了才是双轨 */
  feeling?: string
  /** 为什么记。必填 */
  why: string
  /** 谁的事。不填就按正文猜，猜不出来会退回去问 */
  subject?: string
  /** 哪一层。不填按规则判 */
  layer?: Layer
  tags?: string[]
  /** 回到原话的路：episodes.seq */
  evidence?: number[]
  thread?: string
  origin: 'note' | 'digest'
  /** 私密：不进群聊、不进外部 AI 的上下文，面板里默认折叠 */
  privacy?: string
  valence?: number
  arousal?: number
}

export type WriteOutcome =
  | { kind: 'written'; id: number; layer: Layer; subject: string; grade: Grade }
  | { kind: 'amended'; id: number; overlap: number; title: string }
  | { kind: 'inboxed'; candidateId: number; unsure: string; similarTo?: number; overlap?: number }
  | { kind: 'rejected'; reason: string }

/** 主体的内部写法 ← 他和她平时怎么说。people 表里的 aliases 也认 */
const SUBJECT_WORDS: Record<string, string[]> = {
  erica: ['她', 'erica', 'Erica', '她的', '我的主人', '老婆'],
  ai: ['我', '我自己', '他', '他自己', 'ai', '小克'],
  us: ['我们', '我们之间', '我们俩', '两个人'],
}

export function normalizeSubject(db: DB, raw: string | undefined): string | null {
  const v = String(raw ?? '').trim()
  if (!v) return null
  if (/^(erica|ai|us|unknown)$/.test(v)) return v
  if (/^person:[a-z0-9_-]+$/.test(v)) return v
  for (const [key, words] of Object.entries(SUBJECT_WORDS)) {
    if (words.some(w => w.toLowerCase() === v.toLowerCase())) return key
  }
  try {
    const rows = db.prepare('SELECT slug, name, aliases FROM people').all() as unknown as { slug: string; name: string; aliases: string }[]
    for (const r of rows) {
      let aliases: string[] = []
      try { aliases = JSON.parse(r.aliases) } catch { aliases = [] }
      if ([r.slug, r.name, ...aliases].some(a => String(a).toLowerCase() === v.toLowerCase())) return `person:${r.slug}`
    }
  } catch { /* people 表还没建就只认上面那几个 */ }
  return null
}

/** 查重：和库里活着的记忆比一遍（221 张暴力算，几毫秒） */
export function findSimilar(db: DB, text: string, opts: { exclude?: number } = {}): { row: MemoryRow; overlap: number } | null {
  const rows = db.prepare(`SELECT * FROM memories WHERE retracted_at IS NULL${opts.exclude ? ' AND id != ?' : ''}`)
  const all = (opts.exclude ? rows.all(opts.exclude) : rows.all()) as unknown as MemoryRow[]
  let best: { row: MemoryRow; overlap: number } | null = null
  for (const row of all) {
    const o = overlap(text, `${row.title}\n${row.fact_body}`)
    if (!best || o > best.overlap) best = { row, overlap: o }
  }
  return best && best.overlap >= UNSURE_AT ? best : null
}

/** 标题这一关：同一件事换个说法讲一遍，正文抓不到、标题抓得到 */
export function findSimilarTitle(db: DB, title: string, opts: { exclude?: number } = {}): { row: MemoryRow; overlap: number } | null {
  const t = String(title || '').trim()
  if (t.replace(/\s/g, '').length < 5) return null
  const rows = db.prepare(`SELECT * FROM memories WHERE retracted_at IS NULL AND title != ''${opts.exclude ? ' AND id != ?' : ''}`)
  const all = (opts.exclude ? rows.all(opts.exclude) : rows.all()) as unknown as MemoryRow[]
  let best: { row: MemoryRow; overlap: number } | null = null
  for (const row of all) {
    const o = overlap(t, row.title)
    if (!best || o > best.overlap) best = { row, overlap: o }
  }
  return best && best.overlap >= TITLE_UNSURE_AT ? best : null
}

const MIN_WHY = 4
const MIN_FACT = 10

/**
 * 写一条记忆。返回「进库了 / 接到旧的那条上了 / 进信箱了 / 退回去了」。
 * 退回去（rejected）只发生在他自己能马上补的事情上（没写为什么记、认不出是谁的事）——
 * 这时候他就在对话里，问他一句比替他猜好。
 */
export function writeMemory(db: DB, draft: MemoryDraft, now: Date = new Date(), opts: { forceInbox?: string } = {}): WriteOutcome {
  ensureMemorySchema(db)
  const ts = now.toISOString()
  const fact = String(draft.fact ?? '').trim()
  const why = String(draft.why ?? '').trim()
  const title = String(draft.title ?? '').trim() || fact.slice(0, 24)
  const feeling = String(draft.feeling ?? '').trim()

  if (fact.replace(/\s/g, '').length < MIN_FACT) return { kind: 'rejected', reason: '正文太短了，把当时的现场写下来：谁说了什么、发生了什么。' }
  if (why.replace(/\s/g, '').length < MIN_WHY) {
    return { kind: 'rejected', reason: '要写「为什么记这条」。写不出来的，大概率本来就不用记。' }
  }

  const body = `${title}\n${fact}${feeling ? '\n' + feeling : ''}`
  const card = synthCard({ title, body: fact, created: ts, tags: draft.tags, valence: draft.valence, arousal: draft.arousal })
  const c = classify(card)

  // 1. 主体唯一
  let subject = normalizeSubject(db, draft.subject)
  const guessed = guessSubject(card)
  if (!subject) {
    if (guessed.subject === 'unknown') {
      return { kind: 'rejected', reason: '这条是谁的事？写清楚主体（她 / 我自己 / 我们 / 某个人的名字），别让以后的我把别人的事记成她的。' }
    }
    subject = guessed.subject
  }
  const mixed = guessed.mixedWith.length > 0

  // 2. 有原话对得上
  const evidence = (draft.evidence ?? []).filter(n => Number.isInteger(n) && n !== 0)  // 负数 seq = 从 Kelivo 补回的最早几天

  // 3. 查重
  const similar = findSimilar(db, body)
  const layer: Layer = draft.layer ?? c.layer

  // ≥70%：同一件事，接到已有那条上，不新建
  if (similar && similar.overlap >= AMEND_AT) {
    const row = similar.row
    let tags: string[] = []
    try { tags = JSON.parse(row.tags) } catch { tags = [] }
    const merged = [...new Set([...tags, ...(draft.tags ?? [])])]
    const addition = `\n\n（${bjDate(ts)} 又记了一次）${fact}${feeling ? '\n' + feeling : ''}`
    let ev: number[] = []
    try { ev = JSON.parse((row as unknown as { evidence?: string }).evidence || '[]') } catch { ev = [] }
    db.prepare(`UPDATE memories SET fact_body = fact_body || ?, tags = ?, evidence = ?, updated_at = ?,
        why = COALESCE(NULLIF(why, ''), ?) WHERE id = ?`)
      .run(addition, JSON.stringify(merged), JSON.stringify([...new Set([...ev, ...evidence])]), ts, why, row.id)
    return { kind: 'amended', id: row.id, overlap: similar.overlap, title: row.title }
  }

  // 4. 两头沾
  const bothLayers = c.signals.strongFact && c.signals.state

  // 正文不像、标题很像：同一件事换了说法，不自己合并，交给她看一眼
  const sameTitle = similar ? null : findSimilarTitle(db, title)

  const unsure: string[] = []
  if (sameTitle) unsure.push(`标题和已有的「${sameTitle.row.title}」像${Math.round(sameTitle.overlap * 100)}%，可能是同一件事换了说法`)
  if (mixed) unsure.push(`一条里混着${[subject, ...guessed.mixedWith].map(labelOf).join(' 和 ')}的事`)
  if (!evidence.length) unsure.push('没有原话对得上（指不回具体哪几句）')
  if (similar) unsure.push(`和已有的「${similar.row.title}」像${Math.round(similar.overlap * 100)}%，但不一样`)
  if (bothLayers) unsure.push('既像长期事实又像当日状态，分不清该放哪一层')
  // 他（或夜里整理）自己说了放哪一层，就按他说的——规则认不出不算「拿不准」。
  // 只有**没人说**、规则也认不出时，才是我们在猜，那就该她看一眼。
  if (!draft.layer && c.needsReview && !mixed) unsure.push(c.reviewNote || '规则认不出该放哪一层')
  if (opts.forceInbox) unsure.unshift(opts.forceInbox)

  const payload = {
    layer, subject, title, fact, feeling: feeling || null, why, privacy: draft.privacy === 'private' ? 'private' : 'normal',
    tags: draft.tags ?? [], valence: draft.valence ?? null, arousal: draft.arousal ?? null,
    validFrom: layer === 'fact' ? ts : null,
  }

  if (unsure.length) {
    const r = db.prepare(`INSERT INTO memory_candidates
      (origin, status, payload, unsure, evidence, thread, similar_to, overlap, created_at)
      VALUES (?, 'inbox', ?, ?, ?, ?, ?, ?, ?)`)
      .run(draft.origin, JSON.stringify(payload), unsure.join('；'), JSON.stringify(evidence),
        draft.thread ?? null, (similar ?? sameTitle)?.row.id ?? null, (similar ?? sameTitle)?.overlap ?? null, ts)
    return {
      kind: 'inboxed', candidateId: Number(r.lastInsertRowid), unsure: unsure.join('；'),
      similarTo: (similar ?? sameTitle)?.row.id, overlap: (similar ?? sameTitle)?.overlap,
    }
  }

  const id = insertMemory(db, { ...payload, evidence, thread: draft.thread ?? null, source: draft.origin }, ts)
  return { kind: 'written', id, layer, subject, grade: 'normal' }
}

interface InsertInput {
  layer: Layer
  subject: string
  title: string
  fact: string
  feeling: string | null
  why: string
  tags: string[]
  valence: number | null
  arousal: number | null
  validFrom: string | null
  evidence: number[]
  thread: string | null
  source: string
  privacy?: string
  /** 谁的笔。他随手记 = him；夜里整理 = machine（注入时情绪那半不给） */
  voice?: string
}

function insertMemory(db: DB, o: InsertInput, ts: string): number {
  const r = db.prepare(`INSERT INTO memories
    (layer, subject, title, fact_body, feeling, why, tags, grade, valence, arousal, valid_from,
     source, voice, privacy, evidence, thread, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'normal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(o.layer, o.subject, o.title, o.fact, o.feeling, o.why, JSON.stringify(o.tags),
      o.valence, o.arousal, o.validFrom, o.source, o.voice ?? (o.source === 'digest' ? 'machine' : 'him'),
      o.privacy === 'private' ? 'private' : 'normal',
      JSON.stringify(o.evidence), o.thread, ts, ts)
  return Number(r.lastInsertRowid)
}

const SUBJECT_LABEL: Record<string, string> = { erica: '她', ai: '他自己', us: '你们', unknown: '认不出是谁' }

export function labelOf(subject: string): string {
  if (SUBJECT_LABEL[subject]) return SUBJECT_LABEL[subject]
  return subject.startsWith('person:') ? subject.slice(7) : subject
}

/** 人物卡的名字（给她看的信箱里显示「糯糯」而不是 person:nuonuo） */
export function labelWithPeople(db: DB, subject: string): string {
  if (!subject.startsWith('person:')) return labelOf(subject)
  try {
    const row = db.prepare('SELECT name FROM people WHERE slug = ?').get(subject.slice(7)) as { name: string } | undefined
    return row?.name || labelOf(subject)
  } catch { return labelOf(subject) }
}

// ── 沉淀信箱：她只做「选入 / 跳过」两个动作 ──

export interface Candidate {
  id: number
  origin: string
  status: string
  unsure: string
  thread: string | null
  similarTo: number | null
  similarTitle?: string | null
  overlap: number | null
  evidence: number[]
  createdAt: string
  payload: {
    layer: Layer; subject: string; subjectLabel: string; title: string; fact: string
    feeling: string | null; why: string; tags: string[]
  }
}

export function listInbox(db: DB, opts: { status?: string; limit?: number } = {}): Candidate[] {
  ensureMemorySchema(db)
  const status = opts.status ?? 'inbox'
  const rows = db.prepare(`SELECT c.*, m.title AS similar_title FROM memory_candidates c
    LEFT JOIN memories m ON m.id = c.similar_to
    WHERE c.status = ? ORDER BY c.created_at DESC LIMIT ?`)
    .all(status, Math.min(Math.max(opts.limit ?? 50, 1), 200)) as unknown as any[]
  return rows.map(r => {
    const p = JSON.parse(r.payload)
    return {
      id: r.id, origin: r.origin, status: r.status, unsure: r.unsure, thread: r.thread,
      similarTo: r.similar_to, similarTitle: r.similar_title ?? null, overlap: r.overlap,
      evidence: JSON.parse(r.evidence || '[]'), createdAt: r.created_at,
      payload: { ...p, subjectLabel: labelWithPeople(db, p.subject), tags: p.tags ?? [] },
    }
  })
}

/**
 * 她点「选入」或「跳过」。
 * 选入时可以改（她改的是**事情**那一栏：主体、层、标题、正文、为什么）——
 * 人格那一层她只能划掉不能替他写，那是另一条路，不走这里。
 */
export function decideCandidate(
  db: DB,
  id: number,
  action: 'accept' | 'skip',
  edits: Partial<{ layer: Layer; subject: string; title: string; fact: string; feeling: string; why: string; tags: string[] }> = {},
  by: 'her' | 'him' = 'her',
  now: Date = new Date()
): { ok: true; memoryId?: number } | { ok: false; error: string } {
  ensureMemorySchema(db)
  const ts = now.toISOString()
  const row = db.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id) as any
  if (!row) return { ok: false, error: '没有这一条' }
  if (row.status !== 'inbox') return { ok: false, error: '这一条已经处理过了' }

  if (action === 'skip') {
    db.prepare("UPDATE memory_candidates SET status = 'skipped', decided_at = ?, decided_by = ? WHERE id = ?").run(ts, by, id)
    return { ok: true }
  }

  const p = JSON.parse(row.payload)
  const subject = edits.subject ? normalizeSubject(db, edits.subject) : p.subject
  if (!subject) return { ok: false, error: '主体看不懂（她 / 他自己 / 我们 / 人物卡上的名字）' }
  const layer: Layer = (edits.layer ?? p.layer) as Layer
  if (!['fact', 'state', 'bond'].includes(layer)) return { ok: false, error: 'layer 只能是 fact / state / bond' }

  return tx(db, () => {
    const memoryId = insertMemory(db, {
      layer, subject,
      title: (edits.title ?? p.title) || '',
      fact: edits.fact ?? p.fact,
      feeling: edits.feeling ?? p.feeling ?? null,
      why: edits.why ?? p.why,
      tags: edits.tags ?? p.tags ?? [],
      valence: p.valence ?? null, arousal: p.arousal ?? null,
      validFrom: layer === 'fact' ? (p.validFrom ?? ts) : null,
      privacy: p.privacy,
      evidence: JSON.parse(row.evidence || '[]'),
      thread: row.thread,
      source: row.origin,
    }, ts)
    db.prepare("UPDATE memory_candidates SET status = 'accepted', decided_at = ?, decided_by = ?, memory_id = ? WHERE id = ?")
      .run(ts, by, memoryId, id)
    return { ok: true as const, memoryId }
  })
}

export function inboxCount(db: DB): number {
  try {
    return Number((db.prepare("SELECT count(*) n FROM memory_candidates WHERE status = 'inbox'").get() as { n: number }).n)
  } catch { return 0 }
}
