// 端到端：前端 → 前端出口 → 假 Dylan（原样转给上游入口，模拟 Dylan+xiaoke）→ 上游入口 → 假中转站
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { buildServers } from '../src/main.ts'
import { openDb, type DB } from '../src/db.ts'
import { loadConfig, type Config } from '../src/config.ts'
import { WAKE_MARKER } from '../src/recorder.ts'
import { listen, close, fakeUpstream, sseChunk, tempDir, type Seen } from './helpers.ts'

const TAP_KEY = 'tap-key-for-test'
const STATION_KEY = 'station-key-for-test'

let station: ReturnType<typeof fakeUpstream>
let stationReply: (req: Seen, res: import('node:http').ServerResponse) => void
let dylan: Server
let front: Server, tap: Server
let frontPort = 0, tapPort = 0
let db: DB
let tmp: ReturnType<typeof tempDir>
const logs: string[] = []

function streamReply(chunks: string[]) {
  return (_req: Seen, res: import('node:http').ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const c of chunks) res.write(c)
    res.end('data: [DONE]\n\n')
  }
}

before(async () => {
  tmp = tempDir()
  station = fakeUpstream((req, res) => stationReply(req, res))
  const stationPort = await listen(station.server)

  // 假 Dylan：把请求体原样转发给上游入口（真 Dylan/xiaoke 也会保留 eclipsis_rid 这类多余字段）
  const { server } = fakeUpstream(async (req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"m1"}]}'); return }
    const r = await fetch(`http://127.0.0.1:${tapPort}${req.url}`, {
      method: req.method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TAP_KEY}` }, body: req.body
    })
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || '' })
    res.end(Buffer.from(await r.arrayBuffer()))
  })
  dylan = server
  const dylanPort = await listen(dylan)

  const cfg: Config = {
    ...loadConfig({}),
    dylanUrl: `http://127.0.0.1:${dylanPort}/v1`,
    upstreamUrl: `http://127.0.0.1:${stationPort}/v1`,
    upstreamKey: STATION_KEY, tapKey: TAP_KEY, headerTimeoutMs: 5000,
    dbPath: ':memory:', blobDir: tmp.dir
  }
  db = openDb(':memory:')
  const s = buildServers(cfg, db, { linkRid: true, stripWakeHistory: true, stripThinkHistory: true, log: m => logs.push(m) })
  front = s.front; tap = s.tap
  frontPort = await listen(front)
  tapPort = await listen(tap)
})

after(async () => {
  await Promise.all([close(front), close(tap), close(dylan), close(station.server)])
  db.close()
  tmp.cleanup()
})

beforeEach(() => {
  station.seen.length = 0
  db.exec('DELETE FROM exchanges; DELETE FROM episodes; DELETE FROM blobs;')
  stationReply = streamReply([sseChunk({ content: '在' }), sseChunk({ content: '呢' }), sseChunk({}, 'stop')])
})

function chat(body: any, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${frontPort}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer gw', ...headers },
    body: JSON.stringify(body)
  })
}
const tapChat = (body: any, signal?: AbortSignal) => fetch(`http://127.0.0.1:${tapPort}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TAP_KEY}` }, body: JSON.stringify(body), signal
})
const episodes = () => db.prepare('SELECT actor, kind, channel, scope, content, meta, source_ref FROM episodes ORDER BY ts, seq').all() as any[]
const exchanges = () => db.prepare('SELECT * FROM exchanges ORDER BY id').all() as any[]
// finish 在响应结束后才写库，给它一点时间
const settle = () => new Promise(r => setTimeout(r, 30))

test('流式回复原样到达前端；两边记录用同一个 rid 串起来；中转站看不到 rid 和本地 key', async () => {
  const res = await chat({ model: 'm', stream: true, messages: [{ role: 'system', content: 'sp' }, { role: 'user', content: '在吗' }] },
    { 'x-eclipsis-scene': 'chat', 'x-eclipsis-conversation': 'main', 'x-eclipsis-turn': 'a1', 'x-eclipsis-version': '0' })
  const text = await res.text()
  await settle()
  assert.equal(res.status, 200)
  assert.ok(text.includes('"在"') && text.includes('"呢"') && text.trim().endsWith('[DONE]'))

  const sent = JSON.parse(station.seen[0].body)
  assert.equal('eclipsis_rid' in sent, false)
  assert.equal(station.seen[0].headers.authorization, `Bearer ${STATION_KEY}`)
  assert.equal(station.seen[0].headers['x-eclipsis-scene'], undefined)

  const ex = exchanges()
  assert.deepEqual(ex.map(e => e.tap), ['front', 'upstream'])
  assert.equal(ex[0].rid, ex[1].rid)
  assert.ok(ex.every(e => e.status === 'ok' && e.reply_content === '在呢'))
  assert.equal(ex[0].scene, 'chat')

  const ep = episodes()
  assert.deepEqual(ep.map(e => [e.actor, e.kind, e.content]), [['erica', 'message', '在吗'], ['ai', 'message', '在呢']])
  assert.ok(ep.every(e => e.channel === 'chat' && e.scope === 'daily'))
})

test('计时：响应头、第一个字、写出字节数；没断开时 client_closed 为空', async () => {
  stationReply = (_r, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sseChunk({ role: 'assistant' }))           // 空分片不算第一个字
    setTimeout(() => { res.write(sseChunk({ content: '嗯' }) + sseChunk({}, 'stop')); res.end('data: [DONE]\n\n') }, 150)
  }
  await (await chat({ model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }] }, { 'x-eclipsis-turn': 't1' })).text()
  await settle()
  for (const e of exchanges()) {
    // 假 Dylan 会攒完整个响应再回，所以前端出口的响应头时间不准；上游入口的才代表中转站
    assert.ok(e.ttfb_ms !== null && (e.tap === 'front' || e.ttfb_ms < 150), `${e.tap} ttfb ${e.ttfb_ms}`)
    assert.ok(e.first_token_ms >= 150, `${e.tap} first token ${e.first_token_ms}`)
    assert.ok(e.bytes_out > 0)
    assert.equal(e.client_closed_ms, null)
  }
})

test('计时：调用方等不及先断开，记下断开时刻', async () => {
  stationReply = (_r, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: [DONE]\n\n') }, 400) }
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 100)
  await tapChat({ model: 'm', stream: true, messages: [{ role: 'user', content: 'y' }] }, ac.signal).catch(() => {})
  await new Promise(r => setTimeout(r, 450))
  const e = exchanges()[0]
  assert.ok(e.client_closed_ms >= 90 && e.client_closed_ms < 400, `closed ${e.client_closed_ms}`)
  assert.equal(e.ttfb_ms, null)
})

test('重新生成：同一 turn 的 user 只记一次，第二个回复标 regenerated', async () => {
  const body = { model: 'm', stream: true, messages: [{ role: 'user', content: '讲个笑话' }] }
  await (await chat(body, { 'x-eclipsis-turn': 'a2', 'x-eclipsis-version': '0' })).text()
  await (await chat(body, { 'x-eclipsis-turn': 'a2', 'x-eclipsis-version': '1' })).text()
  await settle()
  const ep = episodes()
  assert.equal(ep.filter(e => e.actor === 'erica').length, 1)
  const ai = ep.filter(e => e.actor === 'ai')
  assert.equal(ai.length, 2)
  assert.equal(JSON.parse(ai[1].meta).regenerated, true)
})

test('分条发的几句（回车分条、最后点发送）：每句一条经历，按顺序；重新生成不重复记', async () => {
  const body = { model: 'm', stream: true, messages: [
    { role: 'user', content: '旧的' }, { role: 'assistant', content: '嗯' },
    { role: 'user', content: '第一句' }, { role: 'user', content: '第二句' }, { role: 'user', content: '第三句' }
  ] }
  await (await chat(body, { 'x-eclipsis-turn': 'm1', 'x-eclipsis-version': '0' })).text()
  await (await chat(body, { 'x-eclipsis-turn': 'm1', 'x-eclipsis-version': '1' })).text()
  await settle()
  const ep = episodes()
  assert.deepEqual(ep.filter(e => e.actor === 'erica').map(e => e.content), ['第一句', '第二句', '第三句'])
  assert.equal(ep.filter(e => e.actor === 'ai').length, 2)
})

test('工具调用：tool_call 和下一轮的 tool_result 都进经历', async () => {
  stationReply = streamReply([
    sseChunk({ content: '我放首歌' }),
    sseChunk({ tool_calls: [{ index: 0, id: 'call_x', function: { name: 'play_song', arguments: '{"q":"晴天"}' } }] }),
    sseChunk({}, 'tool_calls')
  ])
  const h = { 'x-eclipsis-turn': 'a3', 'x-eclipsis-version': '0' }
  await (await chat({ model: 'm', stream: true, messages: [{ role: 'user', content: '放歌' }] }, h)).text()
  stationReply = streamReply([sseChunk({ content: '放好了' }), sseChunk({}, 'stop')])
  await (await chat({ model: 'm', stream: true, messages: [
    { role: 'user', content: '放歌' },
    { role: 'assistant', content: '我放首歌', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'play_song', arguments: '{"q":"晴天"}' } }] },
    { role: 'tool', tool_call_id: 'call_x', content: '正在播放：晴天' }
  ] }, h)).text()
  await settle()
  assert.deepEqual(episodes().map(e => [e.actor, e.kind, e.content]), [
    ['erica', 'message', '放歌'],
    ['ai', 'message', '我放首歌'],
    ['ai', 'tool_call', 'play_song({"q":"晴天"})'],
    ['tool', 'tool_result', '正在播放：晴天'],
    ['ai', 'message', '放好了']
  ])
})

test('图片：拆出来存文件，经历里记哈希', async () => {
  const png = Buffer.from('img').toString('base64')
  await (await chat({ model: 'm', stream: true, messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${png}` } }, { type: 'text', text: '看这个' }
  ] }] }, { 'x-eclipsis-turn': 'a4' })).text()
  await settle()
  const user = episodes().find(e => e.actor === 'erica')
  assert.equal(user.content, '[图片]\n看这个')
  assert.equal(JSON.parse(user.meta).images.length, 1)
})

test('创作场景进 fiction 作用域', async () => {
  await (await chat({ model: 'm', stream: true, messages: [{ role: 'user', content: '续写' }] }, { 'x-eclipsis-scene': 'creative', 'x-eclipsis-turn': 'a5' })).text()
  await settle()
  assert.ok(episodes().every(e => e.scope === 'fiction' && e.channel === 'creative'))
})

test('上游 400：状态码和正文原样回给前端，记为 http_error，不记他的回复', async () => {
  stationReply = (_r, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Invalid request"}}') }
  const res = await chat({ model: 'm', stream: true, messages: [{ role: 'user', content: '在吗' }] }, { 'x-eclipsis-turn': 'a6' })
  assert.equal(res.status, 400)
  assert.equal(await res.text(), '{"error":{"message":"Invalid request"}}')
  await settle()
  const ex = exchanges()
  assert.ok(ex.every(e => e.status === 'http_error' && e.error === 'Invalid request'))
  assert.deepEqual(episodes().map(e => e.actor), ['erica'])
})

test('上游入口：key 不对直接 401，不碰中转站', async () => {
  const res = await fetch(`http://127.0.0.1:${tapPort}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: '{"messages":[]}'
  })
  assert.equal(res.status, 401)
  assert.equal(station.seen.length, 0)
})

test('唤醒请求（不经前端）：记成 wake 经历', async () => {
  stationReply = (_r, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '醒了，想她' }, finish_reason: 'stop' }] })) }
  const res = await fetch(`http://127.0.0.1:${tapPort}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TAP_KEY}` },
    body: JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'system', content: 'wake' }, { role: 'user', content: `最近记录……${WAKE_MARKER}` }] })
  })
  assert.equal((await res.json() as any).choices[0].message.content, '醒了，想她')
  await settle()
  assert.deepEqual(episodes().map(e => [e.channel, e.kind, e.content]), [['wake', 'wake', '醒了，想她']])
})


test('历史里有旧的唤醒提示，但最后一条是她的话：不算唤醒', async () => {
  await (await tapChat({ model: 'm', stream: true, messages: [
    { role: 'user', content: `以前的${WAKE_MARKER}` }, { role: 'assistant', content: '醒了' }, { role: 'user', content: '老公在吗' }
  ] })).text()
  await settle()
  const ep = episodes()
  assert.ok(ep.every(e => e.channel === 'chat'))
  assert.deepEqual(ep.map(e => [e.actor, e.content]), [['erica', '老公在吗'], ['ai', '在呢']])
})

test('直连 Dylan 的客户端（不经前端出口）：上游入口推出经历，标 via=upstream', async () => {
  await (await tapChat({ model: 'm', stream: true, messages: [{ role: 'user', content: 'Kelivo 发的' }] })).text()
  await settle()
  const ep = episodes()
  assert.deepEqual(ep.map(e => e.actor), ['erica', 'ai'])
  assert.ok(ep.every(e => JSON.parse(e.meta).via === 'upstream'))
})

test('经过前端出口的请求，上游入口不重复推经历', async () => {
  await (await chat({ model: 'm', stream: true, messages: [{ role: 'user', content: '一次' }] }, { 'x-eclipsis-turn': 'a7' })).text()
  await settle()
  assert.equal(episodes().length, 2)
})

test('客户端读到 [DONE] 就断开（xiaoke 的做法）：记为 ok，不是 aborted', async () => {
  stationReply = (_r, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sseChunk({ content: '好' }) + sseChunk({}, 'stop') + 'data: [DONE]\n\n')
    setTimeout(() => res.end(), 200)   // 中转站迟一点才关连接
  }
  const ac = new AbortController()
  const res = await tapChat({ model: 'm', stream: true, messages: [{ role: 'user', content: '嗯' }] }, ac.signal)
  const reader = res.body!.getReader()
  let got = ''
  while (!got.includes('[DONE]')) got += new TextDecoder().decode((await reader.read()).value)
  ac.abort()
  await new Promise(r => setTimeout(r, 300))
  assert.equal(exchanges()[0].status, 'ok')
  assert.equal(episodes().find(e => e.actor === 'ai')?.content, '好')
})

test('上游入口剪掉历史里旧唤醒的"最近记录"；记录的是实际发出去的内容', async () => {
  const old = `以下是……\n\n${WAKE_MARKER}。\n\n最近记录：\n\n` + '旧聊天'.repeat(500)
  await (await chat({ model: 'm', stream: true, messages: [
    { role: 'user', content: old }, { role: 'assistant', content: '不打扰' }, { role: 'user', content: '在吗' }
  ] }, { 'x-eclipsis-turn': 'a8' })).text()
  await settle()
  const sent = JSON.parse(station.seen[0].body).messages
  assert.ok(sent[0].content.includes(WAKE_MARKER) && !sent[0].content.includes('旧聊天'))
  assert.equal(sent[2].content, '在吗')
  const up = exchanges().find(e => e.tap === 'upstream')
  assert.equal(JSON.parse(up.transforms).strip_wake_history.stripped, 1)
  const firstMsg = JSON.parse((db.prepare('SELECT text FROM blobs WHERE hash = ?').get(JSON.parse(up.message_hashes)[0]) as any).text)
  assert.ok(!firstMsg.content.includes('旧聊天'), 'exchange 记的是剪过的')
  const front = exchanges().find(e => e.tap === 'front')
  assert.equal(front.transforms, null)
})

test('调试接口：按 turn+version 查到每一轮，区分前端发的和一路补进来的', async () => {
  // 假 Dylan 原样转发，这里在前端出口发 1 条；再直接往上游入口发一条带历史的，模拟 xiaoke 补了历史
  await (await chat({ model: 'm', stream: true, messages: [{ role: 'system', content: '提示词' }, { role: 'user', content: '在吗' }] },
    { 'x-eclipsis-turn': 'dbg1', 'x-eclipsis-version': '0' })).text()
  await (await chat({ model: 'm', stream: true, messages: [{ role: 'user', content: '在吗' }] },
    { 'x-eclipsis-turn': 'dbg1', 'x-eclipsis-version': '1' })).text()
  await settle()
  const r0 = await (await fetch(`http://127.0.0.1:${frontPort}/v1/eclipsis/turn/dbg1?version=0`)).json() as any
  assert.equal(r0.rounds.length, 1)
  const round = r0.rounds[0]
  assert.equal(round.status, 'ok')
  assert.deepEqual(round.sent, { messages: 2, chars: 5, system_chars: 3 })
  assert.equal(round.delivered.from_gateway, 0)
  assert.deepEqual(round.messages.map((m: any) => [m.role, m.origin, m.preview]), [['system', 'frontend', '提示词'], ['user', 'frontend', '在吗']])
  assert.equal(round.reply.chars, 2)
  assert.ok(round.front.latency_ms !== null && round.upstream.latency_ms !== null)
  const r1 = await (await fetch(`http://127.0.0.1:${frontPort}/v1/eclipsis/turn/dbg1?version=1`)).json() as any
  assert.equal(r1.rounds.length, 1)
  assert.notEqual(r1.rounds[0].rid, round.rid)
  const post = await fetch(`http://127.0.0.1:${frontPort}/v1/eclipsis/turn/dbg1`, { method: 'POST', body: '{}' })
  assert.equal(post.status, 405, '只读')
  const none = await (await fetch(`http://127.0.0.1:${frontPort}/v1/eclipsis/turn/nope`)).json() as any
  assert.deepEqual(none.rounds, [])
  assert.equal(exchanges().filter((e: any) => e.path.includes('eclipsis')).length, 0, '调试接口本身不记录')
})

test('上游入口不提供调试接口', async () => {
  const res = await fetch(`http://127.0.0.1:${tapPort}/v1/eclipsis/turn/x`, { headers: { authorization: 'Bearer wrong' } })
  assert.equal(res.status, 401)
})

test('上游入口剪掉历史里他的思考；前端出口记的是原样', async () => {
  await (await chat({ model: 'm', stream: true, messages: [
    { role: 'user', content: '在吗' }, { role: 'assistant', content: '<think>She misses me.</think>\n\n在呢' }, { role: 'user', content: '嗯' }
  ] }, { 'x-eclipsis-turn': 'th1' })).text()
  await settle()
  const sent = JSON.parse(station.seen[0].body).messages
  assert.equal(sent[1].content, '在呢')
  const up = exchanges().find(e => e.tap === 'upstream')
  assert.equal(JSON.parse(up.transforms).strip_think_history.stripped, 1)
  const front = exchanges().find(e => e.tap === 'front')
  const frontMsg = JSON.parse((db.prepare('SELECT text FROM blobs WHERE hash = ?').get(JSON.parse(front.message_hashes)[1]) as any).text)
  assert.ok(frontMsg.content.includes('She misses me'), '前端出口那份是原样')
})

test('/v1/models 纯透传，不记录', async () => {
  const res = await fetch(`http://127.0.0.1:${frontPort}/v1/models`)
  assert.deepEqual(await res.json(), { data: [{ id: 'm1' }] })
  await settle()
  assert.equal(exchanges().length, 0)
})

test('Dylan 不在：返回 502，记为 network_error', async () => {
  const cfg: Config = { ...loadConfig({}), dylanUrl: 'http://127.0.0.1:1/v1', dbPath: ':memory:', blobDir: tmp.dir, headerTimeoutMs: 2000 }
  const s = buildServers(cfg, db, { log: () => {} })
  const port = await listen(s.front)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] })
    })
    assert.equal(res.status, 502)
    await settle()
    assert.equal(exchanges()[0].status, 'network_error')
  } finally { await close(s.front); await close(s.tap) }
})
