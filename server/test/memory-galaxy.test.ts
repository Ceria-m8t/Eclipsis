import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { ensureMemorySchema } from '../src/memory/schema.ts'
import { saveVersion, openTreeNotes, currentTree } from '../src/memory/tree.ts'
import { galaxySnapshot, galaxyGraph, treePage, sectionSpans, handleGalaxyApi } from '../src/memory/galaxy.ts'
import { parseSections } from '../src/memory/tree.ts'

const TREE = `# 时间树
第1天 · 2026-09-25
起点。

第2-3天（9.26-9.27）
电车难题。

第25窗（10.14-10.15）· 争吵。
那次吵架。`

function card(db: any, o: { title: string; day: string; subject?: string; review?: number; layer?: string }) {
  const now = new Date().toISOString()
  // 存的是 UTC：北京时间当天中午
  const ts = new Date(Date.parse(`${o.day}T12:00:00+08:00`)).toISOString()
  db.prepare(`INSERT INTO memories (layer, subject, title, fact_body, source, created_at, updated_at, needs_review, valid_from)
    VALUES (?, ?, ?, ?, 'note', ?, ?, ?, ?)`).run(o.layer ?? 'bond', o.subject ?? 'erica', o.title, o.title + '的正文', now, now, o.review ?? 0, ts)
  return Number((db.prepare('SELECT max(id) id FROM memories').get() as any).id)
}

test('星系：节 = 行星（按日期归卡，中间没写到的日子归前一节）；认不出主体 / 等她看的进小行星带；时间树没写到的另起一颗', () => {
  const db = openDb(':memory:')
  ensureMemorySchema(db)
  saveVersion(db, TREE, 'import', null)
  const spans = sectionSpans(parseSections(currentTree(db)!.body))
  assert.deepEqual(spans.map(s => [s.from, s.to]), [['2026-09-25', '2026-09-25'], ['2026-09-26', '2026-10-13'], ['2026-10-14', '2026-10-15']])
  const a = card(db, { title: '中秋', day: '2026-09-25' })
  card(db, { title: '国庆', day: '2026-10-03' })
  card(db, { title: '吵架', day: '2026-10-15' })
  card(db, { title: '后来', day: '2026-11-01' })
  card(db, { title: '谁的事', day: '2026-09-25', subject: 'unknown' })
  const b = card(db, { title: '等她看', day: '2026-09-26', review: 1 })
  const s = galaxySnapshot(db)
  assert.equal(s.star.name, '我们')
  assert.deepEqual(s.planets.map(p => [p.id, p.memoryCount]), [
    ['tree-2026-09-25', 1], ['tree-2026-09-26', 1], ['tree-2026-10-14', 1], ['tree-unwritten', 1],
  ])
  assert.equal(s.planets[0]!.memories![0]!.id, `m${a}`)
  assert.deepEqual(s.asteroids.map(x => x.title).sort(), ['等她看', '谁的事'])
  db.prepare(`INSERT INTO memory_relations (from_id, to_id, kind, auto, created_by, created_at) VALUES (?, ?, 'related', 1, 'test', ?)`).run(a, b, new Date().toISOString())
  assert.equal(galaxyGraph(db).edges.length, 1)
  const t = treePage(db)
  assert.equal(t.sections.length, 3)
  assert.equal(t.sections[2]!.body, '那次吵架。')
  assert.equal(t.sections[1]!.cards, 1)
})

test('时间树页：她只能贴便条，接口里没有改他文字的路', async () => {
  const db = openDb(':memory:')
  ensureMemorySchema(db)
  saveVersion(db, TREE, 'import', null)
  const call = async (method: string, url: string, body?: unknown) => {
    let status = 0, out: any = null
    const req: any = { method, url, on(ev: string, fn: any) {
      if (ev === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body)))
      if (ev === 'end') fn()
    } }
    const res: any = { writeHead(s: number) { status = s }, end(s: string) { out = JSON.parse(s) } }
    const handled = await handleGalaxyApi(db, req, res)
    return { handled, status, out }
  }
  let r = await call('POST', '/v1/eclipsis/memory/tree/notes', { body: '第25窗那天其实是下雨' })
  assert.equal(r.status, 200)
  assert.equal(openTreeNotes(db).length, 1)
  assert.equal(openTreeNotes(db)[0]!.by, 'erica')
  r = await call('POST', '/v1/eclipsis/memory/tree/notes', { body: '  ' })
  assert.equal(r.status, 400)
  r = await call('PUT', '/v1/eclipsis/memory/tree', { body: '她改的' })
  assert.equal(r.handled, false, '没有改正文的接口')
  assert.equal(currentTree(db)!.body.includes('她改的'), false)
  r = await call('GET', '/v1/eclipsis/memory/tree/source?from=2026-09-25&to=2026-09-25')
  assert.equal(r.status, 200)
  assert.equal(r.out.total, 0)
})
