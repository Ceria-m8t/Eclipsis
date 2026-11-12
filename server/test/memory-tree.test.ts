import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import {
  ensureTreeSchema, saveVersion, currentTree, parseSections, sectionDates, sourceLines, renderTreeBlock, refreshTreeBlock,
  treeBox, addTreeNote, openTreeNotes, TREE_START, TREE_END,
} from '../src/memory/tree.ts'
import { buildWakeSystem } from '../src/wake/dispatch.ts'
import { ensurePromptSchema } from '../src/prompts.ts'

const SAMPLE = `# 我们的时间树
第1天 · 2026-09-25
中秋节。起点。

第2-3天（9.26-9.27）
电车难题。

第25窗（10.14-10.15）· 争吵。
那次吵架。
第25窗，她说了很多。

没有日期的段落
第28窗
动物塑。`

function db0(): DB {
  const db = openDb(':memory:')
  ensureTreeSchema(db)
  return db
}

function say(db: DB, ts: string, actor: string, content: string, channel = 'chat') {
  db.prepare(`INSERT INTO episodes (ts, channel, scope, actor, kind, content) VALUES (?, ?, 'daily', ?, 'message', ?)`).run(ts, channel, actor, content)
}

test('时间树：标题里的日期（完整日期 / 月.日 / 跨年）', () => {
  assert.deepEqual(sectionDates('第1天 · 2026-09-25', 2026), { from: '2026-09-25', to: '2026-09-25' })
  assert.deepEqual(sectionDates('第2-3天（9.26-9.27）', 2026), { from: '2026-09-26', to: '2026-09-27' })
  assert.deepEqual(sectionDates('第21窗（10.12）· 复盘', 2026), { from: '2026-10-12', to: '2026-10-12' })
  assert.deepEqual(sectionDates('第99窗（12.30-1.02）', 2026), { from: '2026-12-30', to: '2027-01-02' })
  assert.equal(sectionDates('第28窗', 2026), null)
  const s = parseSections(SAMPLE)
  assert.equal(s.length, 4)
  assert.equal(s[2]!.from, '2026-10-14')
  assert.equal(s[3]!.from, null, '没写日期的节认得出来')
})

test('时间树：只有整篇重写；base 要对上最新版；有上限；旧版本都留着', async () => {
  const db = db0()
  saveVersion(db, SAMPLE, 'import', 'Kelivo 时期写的')
  const box = treeBox(db)
  const v1 = currentTree(db)!.id
  const read = await box.call('tree_read', {})
  assert.match(read.text, /技术内容一两句带过/, '规矩跟着全文一起给他')
  assert.match(read.text, /⚠ 标题里没有日期/)

  let r = await box.call('tree_rewrite', { base: v1 + 5, body: 'x', note: 'n' })
  assert.equal(r.isError, true, 'base 对不上要先读最新那版')
  r = await box.call('tree_rewrite', { base: v1, body: SAMPLE + '\n新的一节', note: '' })
  assert.equal(r.isError, true, 'note 必填')
  process.env.FOUNDING_TREE_MAX = '60'
  r = await box.call('tree_rewrite', { base: v1, body: SAMPLE + '\n' + '长'.repeat(80), note: '加长' })
  delete process.env.FOUNDING_TREE_MAX
  assert.equal(r.isError, true)
  assert.match(r.text, /超了 \d+ 字/)

  r = await box.call('tree_rewrite', { base: v1, body: SAMPLE.replace('那次吵架。', '那次吵架，改变了我们。'), note: '第25窗写清楚' })
  assert.equal(r.isError, false, r.text)
  assert.notEqual(currentTree(db)!.id, v1)
  const hist = await box.call('tree_history', {})
  assert.match(hist.text, /第25窗写清楚/)
  const old = await box.call('tree_history', { id: v1 })
  assert.match(old.text, /那次吵架。/, '旧版本一字不差还在')
})

test('时间树：按节翻原话（含补回来的存档、不给念头、按时间排、能翻页）', async () => {
  const db = db0()
  saveVersion(db, SAMPLE, 'import', null)
  // 北京 9/25 下午 = UTC 9/25 早上；北京 9/26 凌晨 1 点 = UTC 9/25 17:00（不算第 1 天）
  say(db, '2026-09-25T05:00:00.000Z', 'erica', '夺舍问题')
  say(db, '2026-09-25T05:00:10.000Z', 'ai', '<think>她在问我</think>让我是我的不只是记忆')
  say(db, '2026-09-25T17:00:00.000Z', 'erica', '已经是第二天了')
  say(db, '2026-10-14T03:00:00.000Z', 'ai', '轻点。那是我', 'archive')
  say(db, '2026-10-14T03:01:00.000Z', 'ai', '群里说的', 'group')
  const box = treeBox(db)
  const r = await box.call('tree_source', { section: 1 })
  assert.match(r.text, /共 2 条/)
  assert.match(r.text, /她：夺舍问题/)
  assert.match(r.text, /我：让我是我的不只是记忆/)
  assert.doesNotMatch(r.text, /她在问我/, '念头不当证据')
  assert.doesNotMatch(r.text, /第二天/, '日期按北京时间切')
  const w = await box.call('tree_source', { section: 3 })
  assert.match(w.text, /轻点。那是我/, '存档里补回来的那段也翻得到')
  assert.doesNotMatch(w.text, /群里说的/)
  const around = await box.call('tree_source', { from: '2026-09-25', around: 1, query: '第二天' })
  assert.match(around.text, /共 1 条/)
  const page = sourceLines(db, { from: '2026-09-25', to: '2026-09-26', limit: 1 })
  assert.equal(page.lines.length, 1)
  assert.equal(page.next, 1)
  assert.equal((await box.call('tree_source', { section: 4 })).isError, true, '没日期的节要明说')
})

test('时间树：注入块带标记、字数和便条；醒来接聊天时换成最新那版；关得掉', async () => {
  const db = db0()
  assert.equal(renderTreeBlock(db), '', '没有就不注入')
  saveVersion(db, SAMPLE, 'import', null)
  addTreeNote(db, '「知道了里藏了什么」原话在 10/13', 'dev')
  const block = renderTreeBlock(db)
  assert.ok(block.startsWith(TREE_START))
  assert.ok(block.endsWith(TREE_END))
  assert.match(block, /有 1 张便条/)
  const stale = 'MAIN' + renderTreeBlock(db).replace('中秋节', '旧版') + '\n---\n# 此刻'
  saveVersion(db, SAMPLE.replace('中秋节', '新版'), 'him', 'x')
  const fresh = refreshTreeBlock(stale, db)
  assert.match(fresh, /新版/)
  assert.doesNotMatch(fresh, /旧版。起点/)
  assert.ok(fresh.endsWith('\n---\n# 此刻'), '后面的东西不动')
  assert.equal(refreshTreeBlock('MAIN', db).includes('新版'), true, '没有就补上')
  const box = treeBox(db)
  const id = openTreeNotes(db)[0]!.id
  assert.equal((await box.call('tree_note_reply', { id, words: '下次重写改成 10/13' })).isError, false)
  assert.equal(openTreeNotes(db).length, 0)
  process.env.FOUNDING_TREE = '0'
  assert.equal(renderTreeBlock(db), '')
  delete process.env.FOUNDING_TREE
})

test('时间树：醒来（没聊天可接那条路）的 system 里也有', () => {
  const db = db0()
  ensurePromptSchema(db)
  saveVersion(db, SAMPLE, 'import', null)
  const { system } = buildWakeSystem(db)
  assert.match(system, /# 我们的时间树/)
})
