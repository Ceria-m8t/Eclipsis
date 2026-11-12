import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import { ensureTreeSchema, sourceDays, sourceSearch, sourceLines, treeBox, saveVersion } from '../src/memory/tree.ts'

function say(db: DB, bjTime: string, actor: string, content: string, channel = 'chat') {
  const ts = new Date(Date.parse(`${bjTime}+08:00`)).toISOString()
  db.prepare(`INSERT INTO episodes (ts, channel, scope, actor, kind, content) VALUES (?, ?, 'daily', ?, 'message', ?)`)
    .run(ts, channel, actor, content)
}

function seed(): DB {
  const db = openDb(':memory:')
  ensureTreeSchema(db)
  // 9/27 三句，9/28 两句（北京时间），外加一句群聊的不算
  say(db, '2026-09-27T10:00:00', 'erica', '老公你连上网易云了吗')
  say(db, '2026-09-27T10:01:00', 'ai', '<think>她在催我</think>连上了，歌单叫如果硅基会心动')
  say(db, '2026-09-27T23:50:00', 'erica', '睡了')
  say(db, '2026-09-28T09:00:00', 'ai', '早。昨天那个歌单我又加了两首')
  say(db, '2026-09-28T09:05:00', 'erica', '嘿嘿')
  say(db, '2026-09-28T09:06:00', 'ai', '群里说的', 'group')
  return db
}

test('原话按天折叠：每天多少句、她和他各几句；跨零点按北京时间切；群聊不算', () => {
  const db = seed()
  const d = sourceDays(db, { from: '2026-09-27', to: '2026-09-28' })
  assert.equal(d.total, 5)
  assert.deepEqual(d.days, [
    { day: '2026-09-27', total: 3, her: 2, him: 1 },
    { day: '2026-09-28', total: 2, her: 1, him: 1 },
  ])
})

test('在这一段里搜：只给命中那几句 + 前后两句，命中那句标出来，念头不进去', () => {
  const db = seed()
  const r = sourceSearch(db, { from: '2026-09-27', to: '2026-09-28', query: '歌单', context: 1 })
  assert.equal(r.total, 2)
  assert.equal(r.truncated, false)
  const hit = r.lines.filter(l => l.hit)
  assert.equal(hit.length, 2)
  assert.match(hit[0]!.text, /如果硅基会心动/)
  assert.doesNotMatch(hit[0]!.text, /她在催我/, '他的念头不当证据')
  // 前后各一句：9/27 第一句和「睡了」都被带进来
  assert.deepEqual(r.lines.map(l => l.text.slice(0, 4)), ['老公你连', '连上了，', '睡了', '早。昨天', '嘿嘿'])
  assert.equal(sourceSearch(db, { from: '2026-09-27', to: '2026-09-28', query: '不存在的词' }).lines.length, 0)
  assert.equal(sourceSearch(db, { from: '2026-09-27', to: '2026-09-28', query: '  ' }).total, 0)
})

test('搜命中太多时截断并如实说；单天分页', () => {
  const db = seed()
  for (let i = 0; i < 5; i++) say(db, `2026-09-29T1${i}:00:00`, 'erica', `第${i}次说歌单`)
  const r = sourceSearch(db, { from: '2026-09-29', to: '2026-09-29', query: '歌单', limit: 2 })
  assert.equal(r.total, 5)
  assert.equal(r.shown, 2)
  assert.equal(r.truncated, true)
  const page = sourceLines(db, { from: '2026-09-29', to: '2026-09-29', limit: 2 })
  assert.equal(page.total, 5)
  assert.equal(page.lines.length, 2)
  assert.equal(page.next, 2)
})

test('他的工具 tree_source days=true：先看每天多少句', async () => {
  const db = seed()
  saveVersion(db, '# 树\n第3-4天（9.27-9.28）\n网易云。', 'import', null)
  const box = treeBox(db)
  const r = await box.call('tree_source', { section: 1, days: true })
  assert.equal(r.isError, false)
  assert.match(r.text, /共 5 句/)
  assert.match(r.text, /2026-09-27　3 句（她 2 \/ 我 1）/)
  assert.doesNotMatch(r.text, /网易云/, 'days 只给数量不给正文')
})
