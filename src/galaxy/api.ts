// 星系 + 时间树页的数据（后端 server/src/memory/galaxy.ts）。她这边只读、贴便条，改不了他写的字。
const BASE = '/api/eclipsis/memory'

export interface GMemory { id: string; title: string; date?: string; category?: string; preview?: string; heat?: number; planetId?: string | null }
export interface GPlanet { id: string; name: string; definition?: string; archetype?: 'rocky' | 'oceanic' | 'gas' | 'ice' | 'volcanic'; rank: number; memoryCount: number; memories?: GMemory[] }
export interface GSnapshot { star: { name: string; definition?: string }; planets: GPlanet[]; asteroids: GMemory[] }
export interface GGraph { nodes: GMemory[]; edges: { source: string; target: string; weight?: number }[] }
export interface TreeSection { index: number; title: string; from: string | null; to: string | null; chars: number; body: string; quotes: number; planetId: string | null; cards: number }
export interface TreeVersionInfo { id: number; chars: number; author: string; note: string | null; created_at: string }
export interface TreeNote { id: number; body: string; by: string; created_at: string; reply: string | null; replied_at: string | null }
export interface TreePage {
  current: { id: number; chars: number; max: number; author: string; note: string | null; created_at: string; day: string; body: string } | null
  sections: TreeSection[]
  versions: TreeVersionInfo[]
  notes: TreeNote[]
  open_notes: number
  rules: string[]
}
export interface SourcePage { from: string; to: string; total: number; offset: number; lines: string[]; next: number | null }
export interface DayCount { day: string; total: number; her: number; him: number }
export interface SourceLine { ts: string; who: 'her' | 'him'; text: string; day: string; hit?: boolean }
export interface SearchPage { total: number; shown: number; lines: SourceLine[]; truncated: boolean }
export interface QuoteHit { seq: number; ts: string; day: string; who: 'her' | 'him'; text: string }
export interface QuoteSearch {
  hits: QuoteHit[]; total: number; exact: boolean; offset: number; next: number | null
  index: { indexed: number; total: number; behind: number }
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path, { cache: 'no-store' })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  return r.json()
}

export const loadGalaxy = () => get<GSnapshot>('/galaxy')
export const loadGraph = () => get<GGraph>('/galaxy/graph')
export const loadTree = () => get<TreePage>('/tree')
export const loadVersion = (id: number) => get<TreeVersionInfo & { body: string }>(`/tree/version?id=${id}`)
export const loadSource = (from: string, to: string, offset = 0) =>
  get<SourcePage>(`/tree/source?from=${from}&to=${to}&offset=${offset}&limit=80`)
export const loadDays = (from: string, to: string) => get<{ total: number; days: DayCount[] }>(`/tree/source/days?from=${from}&to=${to}`)
export const searchSource = (from: string, to: string, q: string) =>
  get<SearchPage>(`/tree/source/search?from=${from}&to=${to}&q=${encodeURIComponent(q)}`)

/** 全库找一句原话（细目层的全文索引，不再只扫最近 4000 条） */
export const searchQuotes = (q: string, o: { who?: 'her' | 'him'; offset?: number } = {}) =>
  get<QuoteSearch>(`/quotes/search?q=${encodeURIComponent(q)}${o.who ? `&who=${o.who}` : ''}${o.offset ? `&offset=${o.offset}` : ''}`)
export const quoteAround = (seq: number) => get<{ lines: QuoteHit[] }>(`/quotes/around?seq=${seq}&n=3`)

export async function postNote(body: string): Promise<{ id: number }> {
  const r = await fetch(BASE + '/tree/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  return r.json()
}
