// 记忆库（后端 server/src/memory/）：她这边只做两件事——沉淀信箱里「选入」或「跳过」。
// 记忆本身只有他能写（memory_note）和划掉；她改的只是「事情」那一栏。
const BASE = '/api/eclipsis/memory'

export interface MemoryStats {
  total: number
  byLayer: Partial<Record<'fact' | 'state' | 'bond', number>>
  byGrade: Partial<Record<'resident' | 'important' | 'normal', number>>
  bySubject: { subject: string; label: string; n: number }[]
  needsReview: number
  merged: number
  inbox: number
  private?: { episodes: number; memories: number }
  corrections: number
  relations: number
  digest: { runs: number; wrote: number; inboxed: number; skipped: number }
}

export interface Candidate {
  id: number
  origin: 'note' | 'digest' | string
  unsure: string
  thread: string | null
  similarTo: number | null
  similarTitle: string | null
  overlap: number | null
  evidence: number[]
  createdAt: string
  payload: {
    layer: 'fact' | 'state' | 'bond'
    subject: string
    subjectLabel: string
    title: string
    fact: string
    feeling: string | null
    why: string
    tags: string[]
  }
}

export interface MemoryItem {
  id: number
  bucket_id: string | null
  layer: 'fact' | 'state' | 'bond'
  subject: string
  subjectLabel: string
  title: string
  fact_body: string
  feeling: string | null
  why: string | null
  tags: string[]
  grade: string
  voice: string
  privacy: string
  thread: string | null
  needs_review: number
  review_note: string | null
  created_at: string
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path, { cache: 'no-store' })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((d as any).error || `HTTP ${r.status}`)
  return d as T
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((d as any).error || `HTTP ${r.status}`)
  return d as T
}

export const memoryStats = () => get<MemoryStats>('/stats')
export const memoryInbox = (status = 'inbox') => get<{ candidates: Candidate[] }>(`/inbox?status=${status}`)
export const memoryList = (q: { layer?: string; review?: boolean; limit?: number } = {}) => {
  const p = new URLSearchParams()
  if (q.layer) p.set('layer', q.layer)
  if (q.review) p.set('review', '1')
  p.set('limit', String(q.limit ?? 50))
  return get<{ memories: MemoryItem[]; inbox: number }>(`?${p}`)
}
export const decideCandidates = (ids: number[], action: 'accept' | 'skip') =>
  post<{ results: { id: number; ok: boolean; error?: string }[]; inbox: number }>('/inbox/decide', { ids, action })
export const setMemoryPrivate = (memoryId: number, isPrivate: boolean) =>
  post<{ ok: boolean; error?: string }>('/private', { memoryId, private: isPrivate })
export const retractMemory = (id: number, reason: string) => post<{ ok: true }>(`/${id}/retract`, { reason })

export interface Proposal {
  id: number
  memoryId: number
  kind: 'merge' | 'split' | 'relayer' | 'why' | 'retract'
  reason: string
  payload: any
  batch: string | null
  createdAt: string
  memory?: { title: string; layer: string; subjectLabel: string; fact: string; why: string | null; voice: string }
}

export const memoryProposals = () => get<{ proposals: Proposal[] }>('/proposals')
export const decideProposals = (ids: number[], action: 'take' | 'drop') =>
  post<{ results: { id: number; ok: boolean; error?: string }[]; open: number }>('/proposals/decide', { ids, action })
export const runRejudgeBatch = (limit = 20, layer?: string) =>
  post<{ batch: string; cards: number; proposals: number; skipped: number; rewrote: number; byKind: Record<string, number>; error?: string }>(
    '/rejudge', { limit, layer })

export interface MemoryDetail {
  memory: MemoryItem & { evidence: number[] }
  quotes: { seq: number; ts: string; actor: string; content: string }[]
  relations: { id: number; kind: string; kindLabel: string; reason: string; auto: number; other: { id: number; title: string } }[]
  corrections: { id: number; note: string; status: string; hisReply: string | null; createdAt: string }[]
}

export const memoryDetail = (id: number) => get<MemoryDetail>(`/${id}`)
export const addCorrection = (memoryId: number, note: string) => post<{ ok: boolean; error?: string }>('/corrections', { memoryId, note })
export const listCorrections = (status?: string) =>
  get<{ corrections: any[]; open: number }>(`/corrections${status ? `?status=${status}` : ''}`)
export const withdrawCorrection = (id: number) => post<{ ok: boolean }>('/corrections', { id, withdraw: true })

export interface Quote { seq: number; ts: string; who: string; text: string; hits: string[] }

export interface RecallTry {
  mode: string
  query: string
  semantic: { used: boolean; cached: boolean; ms: number; why?: string }
  expanded: string[]
  quotes: Quote[]
  quoteSpan: { total: number; first: string | null; last: string | null }
  candidates: number
  picked: { id: number; title: string; layer: string; subject: string; score: number; lex: number | null; sem: number | null; hits: string[]; why: string; axis: { date: string; title: string }[] }[]
  rejected: { id: number; title: string; why: string }[]
  suppressed: Record<string, number>
  note: string
}

export interface RecallStats {
  mode: string
  total: number
  byState: Record<string, number>
  usedRate: number | null
  recent: { title: string; state: string; score: number | null; query: string; at: string }[]
}

export interface ReplayItem {
  at: string
  said: string
  replied: string
  picked: { id: number; title: string; score: number; lex: number; sem: number; why: string; axisLen: number }[]
  rejected: { title: string; why: string }[]
  quotes: number
  wouldUse: number
  empty: boolean
}

export const replayRecall = (turns = 20) =>
  post<{ turns: number; withPicks: number; empty: number; avgPicked: number; wouldUseRate: number | null; items: ReplayItem[] }>(
    '/replay', { turns })
export const graduation = () =>
  get<{ shadowDays: number | null; shadowTurns: number; spotChecked: number; wrongMarked: number; ready: boolean; missing: string[] }>('/graduation')
export const spotcheck = (query: string, verdict: 'right' | 'wrong' | 'meh', memoryId?: number, note?: string) =>
  post<{ ok: boolean; error?: string }>('/spotcheck', { query, verdict, memoryId, note })

export const vectorIndex = () => get<{ total: number; indexed: number; model: string | null; queryCache: number; configured: boolean }>('/index')
export const buildVectorIndex = () => post<{ total: number; missing: number; embedded: number; failed: number; ms: number; error?: string }>('/index', {})

export const searchQuotes = (q: string) =>
  get<{ query: string; expanded: string[]; span: { total: number; first: string | null }; quotes: Quote[] }>(`/quotes?q=${encodeURIComponent(q)}&limit=10`)
export const listAliases = () => get<{ aliases: { id: number; term: string; canonical: string }[] }>('/aliases')
export const addAlias = (term: string, canonical: string) => post<{ ok: boolean; error?: string }>('/aliases', { term, canonical })
export const removeAlias = (id: number) => post<{ ok: boolean }>('/aliases', { id, remove: true })

export const tryRecall = (q: string) => get<RecallTry>(`/recall?q=${encodeURIComponent(q)}`)
export const recallStats = () => get<RecallStats>('/deliveries')

export const KIND_NAMES: Record<string, string> = {
  merge: '合并', split: '拆开', relayer: '换层', why: '补「为什么记」', retract: '划掉',
}

/**
 * 时间一律过这里（2026-11-12 她问「时间不太对」）：后端存的是 UTC（带 Z），
 * 直接 slice 字符串等于把 UTC 念成北京时间，差 8 小时。
 */
export function when(iso: string | null | undefined, withYear = false): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return withYear ? `${d.getFullYear()}-${md}` : md
}

export function whenDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export const LAYER_NAMES: Record<string, string> = { fact: '事实', state: '近况', bond: '我们之间' }
