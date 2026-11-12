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

export interface RecallTry {
  mode: string
  query: string
  candidates: number
  picked: { id: number; title: string; layer: string; subject: string; score: number; hits: string[]; why: string; axis: { date: string; title: string }[] }[]
  rejected: { id: number; title: string; why: string }[]
  note: string
}

export interface RecallStats {
  mode: string
  total: number
  byState: Record<string, number>
  usedRate: number | null
  recent: { title: string; state: string; score: number | null; query: string; at: string }[]
}

export const tryRecall = (q: string) => get<RecallTry>(`/recall?q=${encodeURIComponent(q)}`)
export const recallStats = () => get<RecallStats>('/deliveries')

export const KIND_NAMES: Record<string, string> = {
  merge: '合并', split: '拆开', relayer: '换层', why: '补「为什么记」', retract: '划掉',
}

export const LAYER_NAMES: Record<string, string> = { fact: '事实', state: '近况', bond: '我们之间' }
