import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { openDb, addEpisode } from '../src/db.ts'
import { boxesFor, openBox, callBoxTool, handleToolboxApi, setToolboxFile } from '../src/toolbox.ts'
import { momentsBox } from '../src/wake/moments-box.ts'
import { listen, close, tempDir } from './helpers.ts'

function seed() {
  const db = openDb(':memory:')
  const ai = (seq: number, ts: string, content: string, meta: any = {}, channel = 'chat', kind = 'message', scope = 'daily') =>
    addEpisode(db, { ts, channel, scope, actor: 'ai', kind, content, meta, sourceRef: 's' + seq })
  ai(1, '2026-11-09T14:02:00.000Z', '<think>想想</think>好，你先去睡。\n<moment>\n气味：烤栗子\n</moment>', { turn: 't1', version: 0 })
  ai(2, '2026-11-09T15:00:00.000Z', '嗯。<moment lock>只给自己的</moment>', { turn: 't2', version: 0 })
  ai(3, '2026-11-09T15:01:00.000Z', '重来一版。<moment>新的那版</moment>', { turn: 't2', version: 1 })
  ai(4, '2026-11-10T01:34:00.000Z', '她还在睡。<moment lock>醒来时锁的</moment>', { wake_id: 'w1' }, 'wake', 'note')
  ai(5, '2026-11-10T02:00:00.000Z', '小说里的<moment>虚构</moment>', {}, 'creative', 'message', 'fiction')
  ai(6, '2026-11-10T03:00:00.000Z', '她删掉的<moment>删了</moment>', { turn: 't6' })
  db.prepare("UPDATE episodes SET retracted_at = '2026-11-10T04:00:00Z' WHERE source_ref = 's6'").run()
  ai(7, '2026-11-10T05:00:00.000Z', '没写这一刻的回复', { turn: 't7' })
  return db
}

test('「这一刻」箱子：新的在前，锁着的也给原文；重新生成只留最新一版；删掉的、创作中心的不给', async () => {
  const box = momentsBox(seed())
  const r = await box.call('moments_read', {})
  assert.equal(r.isError, false)
  const t = r.text
  assert.match(t, /^3 条/)
  assert.ok(t.indexOf('醒来时锁的') < t.indexOf('新的那版') && t.indexOf('新的那版') < t.indexOf('烤栗子'), '新的在前')
  assert.match(t, /11月10日 周二 09:34 · 醒来时 · 🔒锁着】\n醒来时锁的/)
  assert.match(t, /11月9日 周一 22:02 · 聊天里】\n气味：烤栗子\n（那时写的话开头：好，你先去睡。）/)
  for (const no of ['只给自己的', '虚构', '删了', '想想']) assert.ok(!t.includes(no), `不该有：${no}`)
  assert.ok(t.endsWith('再往前没有了。'))

  const locked = await box.call('moments_read', { locked_only: true })
  assert.match(locked.text, /^1 条/)
  assert.ok(locked.text.includes('醒来时锁的') && !locked.text.includes('烤栗子'))
})

test('「这一刻」箱子：翻页用 before；参数不对报错', async () => {
  const box = momentsBox(seed())
  const first = await box.call('moments_read', { limit: 1 })
  assert.match(first.text, /^1 条/)
  const before = /before 填 (\S+)/.exec(first.text)![1]!
  const next = await box.call('moments_read', { limit: 1, before })
  assert.ok(next.text.includes('新的那版') && !next.text.includes('醒来时锁的'))
  assert.equal((await box.call('moments_read', { before: '2026-11-01T00:00:00Z' })).text, '再往前没有了。')
  assert.equal((await box.call('moments_read', { before: '不是时间' })).isError, true)
  assert.equal((await box.call('moments_write', {})).isError, true)
  assert.equal((await momentsBox(openDb(':memory:')).call('moments_read', {})).text, '还没有写过这一刻。')
})

async function api(db: any, method: string, path: string, body?: unknown) {
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => { handleToolboxApi(db, req, res, {}).then(ok => { if (!ok) { res.writeHead(404); res.end('{}') } }) })
  const port = await listen(srv)
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, body: await r.json() as any }
  } finally { await close(srv) }
}

test('「这一刻」只在醒来时有：聊天里没有入口、打不开、调不了，聊天开关打不开；醒来开关能关', async () => {
  const t = tempDir()
  setToolboxFile(join(t.dir, 'toolbox', 'boxes.json'))
  const db = seed()
  try {
    assert.ok(boxesFor(db, 'wake', {}).some(b => b.entryName === 'open_moments'))
    assert.ok(!boxesFor(db, 'chat', {}).some(b => b.entryName === 'open_moments'))
    assert.ok(!(await api(db, 'GET', '/v1/eclipsis/tools')).body.boxes.some((b: any) => b.entryName === 'open_moments'))
    await assert.rejects(openBox(db, 'open_moments', {}))
    const call = await callBoxTool(db, 'open_moments', 'moments_read', {}, {})
    assert.equal(call.isError, true)
    assert.ok(!call.text.includes('烤栗子'))

    const info = (await api(db, 'GET', '/v1/eclipsis/toolbox')).body.boxes.find((b: any) => b.id === 'moments')
    assert.deepEqual([info.title, info.chat, info.wake, info.wakeOnly], ['这一刻', false, true, true])
    assert.equal((await api(db, 'POST', '/v1/eclipsis/toolbox/flags', { id: 'moments', chat: true })).status, 400)
    assert.ok(!boxesFor(db, 'chat', {}).some(b => b.entryName === 'open_moments'))
    assert.equal((await api(db, 'POST', '/v1/eclipsis/toolbox/flags', { id: 'moments', wake: false })).status, 200)
    assert.ok(!boxesFor(db, 'wake', {}).some(b => b.entryName === 'open_moments'))
    // 她也不能拿这个入口名加一个自己的箱子
    assert.equal((await api(db, 'POST', '/v1/eclipsis/toolbox', { title: 'x', entryName: 'open_moments', description: '撞名的箱子', url: 'http://a' })).status, 400)
  } finally { t.cleanup(); setToolboxFile('/etc/eclipsis/toolbox/boxes.json') }
})
