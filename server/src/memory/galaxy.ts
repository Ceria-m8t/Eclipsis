// 星系（前端 3D 星系用的数据）+ 时间树页的接口。2026-11-13。
//
// 星系的形状照星域图谱（Observatory-Ridge, MIT）的 RidgeSnapshot：
//   恒星 = 我们
//   行星 = 时间树的每一节（他亲手写的奠基主干），越早离恒星越近
//   卫星 = 那一节那段日子里的记忆卡
//   小行星带 = 主体没认出来 / 等她看一眼的卡（不确定就留在外面，不硬塞进哪一颗）
//   时间树还没写到的日子 → 一颗「还没写进时间树」的行星（明说是空着的，不假装归好了）
// 只读：这里不改记忆库、不改时间树一个字。
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DB } from '../db.ts'
import { ensureMemorySchema } from './schema.ts'
import {
  currentTree, parseSections, listVersions, getVersion, openTreeNotes, addTreeNote, sourceLines, ensureTreeSchema,
  sourceDays, sourceSearch, TREE_MAX, RULES, type Section,
} from './tree.ts'
import { bjDate } from './when.ts'

export interface GalaxyMemory { id: string; title: string; date?: string; category?: string; preview?: string; heat?: number; planetId?: string | null }
export interface GalaxyPlanet { id: string; name: string; definition?: string; archetype?: 'rocky' | 'oceanic' | 'gas' | 'ice' | 'volcanic'; rank: number; memoryCount: number; memories?: GalaxyMemory[] }
export interface GalaxySnapshot { star: { name: string; definition?: string }; planets: GalaxyPlanet[]; asteroids: GalaxyMemory[] }

const CANON = /^(erica|ai|us|person:[\w-]+)$/
const ARCH = ['rocky', 'oceanic', 'gas', 'ice', 'volcanic'] as const
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const LAYER_LABEL: Record<string, string> = { fact: '事实', state: '近况', bond: '我们之间' }

interface CardRow {
  id: number; title: string; fact_body: string; layer: string; subject: string; grade: string
  needs_review: number; arousal: number | null; day: string | null
}

/** 每一节管哪几天：从它开始那天，到下一节开始的前一天（中间没写到的日子归前一节）；最后一节只管到它自己的结束日 */
export function sectionSpans(secs: Section[]): { sec: Section; from: string; to: string }[] {
  const dated = secs.filter(s => s.from).sort((a, b) => a.from!.localeCompare(b.from!))
  return dated.map((s, i) => {
    const next = dated[i + 1]
    const to = next ? addDays(next.from!, -1) : s.to!
    return { sec: s, from: s.from!, to: to < s.to! ? s.to! : to }
  })
}

function sectionBody(body: string, title: string): string {
  const lines = body.split('\n')
  const i = lines.findIndex(l => l.trim() === title)
  if (i < 0) return ''
  const out: string[] = []
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j]!.trim()
    if (/^第[\d０-９\-–~～、]+[天窗](?![，,。：:])/.test(t)) break
    out.push(lines[j]!)
  }
  return out.join('\n').trim()
}

export function galaxySnapshot(db: DB): GalaxySnapshot {
  ensureMemorySchema(db)
  const tree = currentTree(db)
  const spans = tree ? sectionSpans(parseSections(tree.body)) : []
  const cards = db.prepare(`
    SELECT id, title, fact_body, layer, subject, grade, needs_review, arousal,
      date(datetime(COALESCE(valid_from, json_extract(raw, '$.ob.created'), created_at)), '+8 hours') AS day
    FROM memories WHERE retracted_at IS NULL AND merged_into IS NULL
    ORDER BY day, id`).all() as unknown as CardRow[]

  const toMemory = (c: CardRow, planetId: string | null): GalaxyMemory => ({
    id: `m${c.id}`,
    title: c.title || c.fact_body.slice(0, 18),
    date: c.day ?? undefined,
    category: LAYER_LABEL[c.layer] ?? c.layer,
    preview: c.fact_body.replace(/\s+/g, ' ').slice(0, 90),
    heat: c.grade === 'resident' ? 1 : c.grade === 'important' ? 0.75 : Math.max(0.25, Math.min(0.6, c.arousal ?? 0.4)),
    planetId,
  })

  const planets: GalaxyPlanet[] = spans.map((s, i) => ({
    id: `tree-${s.from}`,
    name: s.sec.title.replace(/[。.]$/, ''),
    definition: (tree ? sectionBody(tree.body, s.sec.title) : '').split('\n')[0]!.slice(0, 80),
    archetype: ARCH[i % ARCH.length],
    rank: i + 1,
    memoryCount: 0,
    memories: [],
  }))
  const lastTo = spans.length ? spans[spans.length - 1]!.to : null
  const later: GalaxyPlanet = {
    id: 'tree-unwritten', name: lastTo ? `${lastTo.slice(5).replace('-', '.')} 以后 · 时间树还没写到这里` : '时间树还没写',
    definition: '这段日子的记忆卡先绕着这颗转，等他把时间树写到这里，它们会落到对应的那一节。',
    archetype: 'ice', rank: planets.length + 1, memoryCount: 0, memories: [],
  }
  const asteroids: GalaxyMemory[] = []
  for (const c of cards) {
    if (c.needs_review || !CANON.test(c.subject)) { asteroids.push(toMemory(c, null)); continue }
    const span = c.day ? spans.find(s => c.day! >= s.from && c.day! <= s.to) : undefined
    const planet = span ? planets.find(p => p.id === `tree-${span.from}`)! : (c.day && spans.length && c.day < spans[0]!.from ? planets[0]! : later)
    planet.memories!.push(toMemory(c, planet.id))
    planet.memoryCount++
  }
  if (later.memoryCount) planets.push(later)
  return {
    star: { name: '我们', definition: '从 2026-09-25 中秋那天开始。行星是他写的时间树，卫星是那段日子的记忆。' },
    planets,
    asteroids,
  }
}

export function galaxyGraph(db: DB): { nodes: GalaxyMemory[]; edges: { source: string; target: string; weight?: number }[] } {
  const snap = galaxySnapshot(db)
  const nodes = [...snap.planets.flatMap(p => p.memories ?? []), ...snap.asteroids]
  const have = new Set(nodes.map(n => n.id))
  const edges = (db.prepare(`SELECT from_id, to_id, score FROM memory_relations WHERE removed_at IS NULL`).all() as { from_id: number; to_id: number; score: number | null }[])
    .map(r => ({ source: `m${r.from_id}`, target: `m${r.to_id}`, weight: r.score == null ? 0.5 : Math.max(0.1, Math.min(1, r.score)) }))
    .filter(e => have.has(e.source) && have.has(e.target) && e.source !== e.target)
  return { nodes, edges }
}

/** 时间树页：现在这版、各节（带日期、字数、那几天有多少条原话、几张卡）、便条 */
export function treePage(db: DB) {
  ensureTreeSchema(db)
  const cur = currentTree(db)
  const snap = galaxySnapshot(db)
  const count = db.prepare(`SELECT count(*) n FROM episodes WHERE retracted_at IS NULL AND kind = 'message' AND actor IN ('erica','ai')
    AND scope = 'daily' AND channel IN ('chat','archive') AND ts >= ? AND ts < ?`)
  const utc = (d: string, end = false) => new Date(Date.parse(`${d}T00:00:00Z`) - 8 * 3600_000 + (end ? 86_400_000 : 0)).toISOString()
  const sections = cur ? parseSections(cur.body).map(s => ({
    index: s.index, title: s.title, from: s.from, to: s.to, chars: s.chars,
    body: sectionBody(cur.body, s.title),
    quotes: s.from ? Number((count.get(utc(s.from), utc(s.to!, true)) as { n: number }).n) : 0,
    planetId: s.from ? `tree-${s.from}` : null,
    cards: s.from ? (snap.planets.find(p => p.id === `tree-${s.from}`)?.memoryCount ?? 0) : 0,
  })) : []
  return {
    current: cur ? { id: cur.id, chars: cur.chars, max: TREE_MAX(), author: cur.author, note: cur.note, created_at: cur.created_at, day: bjDate(cur.created_at), body: cur.body } : null,
    sections,
    versions: listVersions(db),
    notes: db.prepare('SELECT * FROM founding_tree_notes ORDER BY id DESC LIMIT 50').all(),
    open_notes: openTreeNotes(db).length,
    rules: RULES,
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
function readJson(req: IncomingMessage, max = 16 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { reject(new Error('请求太大')); req.destroy(); return } chunks.push(c) })
    req.on('end', () => { try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : {}) } catch { reject(new Error('请求体不是合法 JSON')) } })
    req.on('error', reject)
  })
}

/** /v1/eclipsis/memory/galaxy[/graph]、/v1/eclipsis/memory/tree[/version|/source|/notes]。她这边只能看、贴便条，改不了他写的字 */
export async function handleGalaxyApi(db: DB, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://local')
  const p = url.pathname
  if (p === '/v1/eclipsis/memory/galaxy' && req.method === 'GET') { json(res, 200, galaxySnapshot(db)); return true }
  if (p === '/v1/eclipsis/memory/galaxy/graph' && req.method === 'GET') { json(res, 200, galaxyGraph(db)); return true }
  if (p === '/v1/eclipsis/memory/tree' && req.method === 'GET') { json(res, 200, treePage(db)); return true }
  if (p === '/v1/eclipsis/memory/tree/version' && req.method === 'GET') {
    const v = getVersion(db, Number(url.searchParams.get('id')))
    v ? json(res, 200, v) : json(res, 404, { error: '没有这一版' })
    return true
  }
  // 一节覆盖好几天：先按天给数量，她点哪天看哪天（她说「原话太多了」）
  if (p === '/v1/eclipsis/memory/tree/source/days' && req.method === 'GET') {
    const from = url.searchParams.get('from') || ''
    const to = url.searchParams.get('to') || from
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) { json(res, 400, { error: '要给 from/to（YYYY-MM-DD）' }); return true }
    json(res, 200, sourceDays(db, { from, to }))
    return true
  }
  // 在这一段里搜一个词：只给命中那几句 + 前后各两句上下文
  if (p === '/v1/eclipsis/memory/tree/source/search' && req.method === 'GET') {
    const from = url.searchParams.get('from') || ''
    const to = url.searchParams.get('to') || from
    const q = (url.searchParams.get('q') || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) { json(res, 400, { error: '要给 from/to（YYYY-MM-DD）' }); return true }
    if (!q) { json(res, 400, { error: '要给搜什么（q）' }); return true }
    if (q.length > 60) { json(res, 400, { error: '搜的词太长了' }); return true }
    json(res, 200, sourceSearch(db, { from, to, query: q, context: 2, limit: 40 }))
    return true
  }
  if (p === '/v1/eclipsis/memory/tree/source' && req.method === 'GET') {
    const from = url.searchParams.get('from') || ''
    const to = url.searchParams.get('to') || from
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) { json(res, 400, { error: '要给 from/to（YYYY-MM-DD）' }); return true }
    json(res, 200, sourceLines(db, { from, to, offset: Number(url.searchParams.get('offset')) || 0, limit: 80, maxChars: 40_000, perLine: 2000, query: url.searchParams.get('q') || undefined }))
    return true
  }
  if (p === '/v1/eclipsis/memory/tree/notes' && req.method === 'POST') {
    const body = await readJson(req)
    const text = typeof body?.body === 'string' ? body.body.trim() : ''
    if (!text) { json(res, 400, { error: '便条是空的' }); return true }
    if (text.length > 1000) { json(res, 400, { error: '便条太长了（最多 1000 字）' }); return true }
    json(res, 200, { id: addTreeNote(db, text, 'erica') })
    return true
  }
  return false
}
