import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import { ensureMemorySchema } from '../src/memory/schema.ts'
import { ensureTreeSchema, saveVersion } from '../src/memory/tree.ts'
import { panelData } from '../src/memory/panel.ts'

function card(db: DB, o: { title: string; layer?: string; day?: string; review?: number; source?: string; dropped?: boolean }) {
  const now = new Date().toISOString()
  const ts = o.day ? new Date(Date.parse(`${o.day}T12:00:00+08:00`)).toISOString() : now
  db.prepare(`INSERT INTO memories (layer, subject, title, fact_body, source, created_at, updated_at, needs_review, valid_from, retracted_at)
    VALUES (?, 'erica', ?, 'x', ?, ?, ?, ?, ?, ?)`)
    .run(o.layer ?? 'bond', o.title, o.source ?? 'note', now, now, o.review ?? 0, ts, o.dropped ? now : null)
}

function panel(db: DB) {
  ensureMemorySchema(db)
  ensureTreeSchema(db)
  return panelData(db)
}

test('面板：四个分区按「谁写的」分，机制状态不占格子', () => {
  const db = openDb(':memory:')
  const d = panel(db)
  assert.deepEqual(d.sections.map(s => s.title), ['聊天里来的', '他自己写的', '他认得的', '收着的'])
  const names = d.sections.flatMap(s => s.cells.map(c => c.name))
  for (const want of ['记忆卡', '线', '流水账', '周总结', '时间树', '他写的', '他做的', '柜子', '日记', '梦', '信息卡', '别名', '细节卡', '原话', '等你看一眼', '沉淀信箱', '归档']) {
    assert.ok(names.includes(want), `少了格子：${want}`)
  }
  for (const bad of ['错题本', '关系边', '毕业条件', '召回']) {
    assert.ok(!names.includes(bad), `${bad} 不该占格子（机制状态压到底下那一行）`)
  }
  assert.ok(d.health.some(h => h.label === '召回'), '召回进「在运转吗」那一行')
})

test('面板：空的照样摆出来并写明还没做', () => {
  const db = openDb(':memory:')
  const cells = panel(db).sections.flatMap(s => s.cells)
  const todo = cells.filter(c => c.todo).map(c => c.name)
  assert.deepEqual(todo, ['流水账', '周总结', '日记', '梦', '细节卡'])
  for (const c of todo) assert.match(cells.find(x => x.name === c)!.note ?? "", /还没/)
  assert.equal(cells.find(c => c.name === '记忆卡')!.n, 0, '一张卡都没有就是 0，不藏')
})

test('面板：数的是活着的卡，划掉的算归档；分层写在备注里', () => {
  const db = openDb(':memory:')
  ensureMemorySchema(db)
  card(db, { title: 'a', layer: 'fact' })
  card(db, { title: 'b', layer: 'bond' })
  card(db, { title: 'c', layer: 'bond', review: 1 })
  card(db, { title: 'd', dropped: true })
  card(db, { title: 'e', source: 'digest' })
  const cells = panel(db).sections.flatMap(s => s.cells)
  assert.equal(cells.find(c => c.name === '记忆卡')!.n, 4)
  assert.match(cells.find(c => c.name === '记忆卡')!.note!, /事实 1 · 近况 0 · 我们之间 3/)
  assert.equal(cells.find(c => c.name === '归档')!.n, 1)
  assert.equal(cells.find(c => c.name === '夜里整理写的')!.n, 1)
  assert.ok(cells.find(c => c.name === '等你看一眼')!.n >= 1)
})

test('面板：时间树的节数和字数；最近 30 天每天几张，今天在最后', () => {
  const db = openDb(':memory:')
  ensureMemorySchema(db)
  ensureTreeSchema(db)
  saveVersion(db, '# 树\n第1天 · 2026-09-25\n起点。\n\n第2-3天（9.26-9.27）\n电车。', 'import', null)
  card(db, { title: '今天的' })
  const d = panelData(db)
  const tree = d.sections.flatMap(s => s.cells).find(c => c.name === '时间树')!
  assert.equal(tree.n, 2)
  assert.equal(tree.unit, '节')
  assert.match(tree.note!, /\/ 8000 字/)
  assert.equal(d.daily.length, 30)
  assert.equal(d.daily.at(-1)!.n, 1, '今天记的那张算在最后一格')
  assert.ok(d.head.sentence.includes('写成 1 张卡'))
})
