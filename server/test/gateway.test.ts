// 端到端：前端 → 前端出口 → 假 Dylan（原样转给上游入口，模拟 Dylan+xiaoke）→ 上游入口 → 假中转站
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { buildServers } from '../src/main.ts'
import { openDb, addEpisode, type DB } from '../src/db.ts'
import { loadConfig, type Config } from '../src/config.ts'
import { WAKE_MARKER } from '../src/recorder.ts'
import { chatHistory } from '../src/chat-history.ts'
import { forgetTurnScenes } from '../src/assembler/index.ts'
import { renderTodayLine } from '../src/assembler/history.ts'
import { listen, close, fakeUpstream, sseChunk, tempDir, type Seen } from './helpers.ts'

const TAP_KEY = 'tap-key-for-test'
const STATION_KEY = 'station-key-for-test'

let station: ReturnType<typeof fakeUpstream>
let stationReply: (req: Seen, res: import('node:http').ServerResponse) => void
let stationPortRef = 0
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
  station = fakeUpstream((req, res) => {
    // 模型列表：站自己的接口（后端的 /v1/models 会来问它）
    if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[{"id":"station-m"}]}'); return }
    stationReply(req, res)
  })
  const stationPort = await listen(station.server)
  stationPortRef = stationPort

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
    upstreamKey: STATION_KEY, tapKey: TAP_KEY, headerTimeoutMs: 5000, streamIdleMs: 1500, retry429DelaysMs: [50, 80],
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
const episodes = () => db.prepare('SELECT actor, kind, channel, scope, content, meta, source_ref, retracted_at, retract_reason FROM episodes WHERE retracted_at IS NULL ORDER BY ts, seq').all() as any[]
const allEpisodes = () => db.prepare('SELECT seq, actor, kind, content, retract_reason FROM episodes ORDER BY seq').all() as any[]
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

test('重新生成一条 Kelivo 来的回复（turn 是 e<seq>、她的话在别的键下记过）：她的话不再记一遍', async () => {
  const body = { model: 'm', stream: true, messages: [{ role: 'user', content: '（Kelivo 发的）在吗' }] }
  await (await chat(body, { 'x-eclipsis-turn': 'e123', 'x-eclipsis-version': '1' })).text()
  await settle()
  const ep = episodes()
  assert.equal(ep.filter(e => e.actor === 'erica').length, 0)
  assert.equal(ep.filter(e => e.actor === 'ai').length, 1)
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

test('上一轮失败/停掉了、她补了一句再发（新的 turn）：前面那几句不再记一遍；她真的连说两遍同一句也不丢', async () => {
  stationReply = (_r, res) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"boom"}}') }
  const first = { model: 'm', stream: true, messages: [{ role: 'user', content: '旧的' }, { role: 'assistant', content: '嗯' }, { role: 'user', content: '看图' }, { role: 'user', content: '[图片]\n（图片）' }] }
  await (await chat(first, { 'x-eclipsis-turn': 't1', 'x-eclipsis-version': '0' })).text()
  stationReply = streamReply([sseChunk({ content: '好' }), sseChunk({}, 'stop')])
  const second = { ...first, messages: [...first.messages, { role: 'user', content: '补一句' }, { role: 'user', content: '补一句' }] }
  await (await chat(second, { 'x-eclipsis-turn': 't2', 'x-eclipsis-version': '0' })).text()
  await settle()
  assert.deepEqual(episodes().filter(e => e.actor === 'erica').map(e => e.content), ['看图', '[图片]\n（图片）', '补一句', '补一句'])
})

test('工具调用：tool_call 和下一轮的 tool_result 都进经历；工具前后说的话合成一条回复', async () => {
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
  // 一轮里调工具 = 两次请求。两段话要合成一条回复：不然 versions.ts 会把它们当成同一轮的两个版本
  // （她那边出现 1/2 切换、只显示后半段；他那边前半段被当成被盖掉的版本剪掉）
  assert.deepEqual(episodes().map(e => [e.actor, e.kind, e.content]), [
    ['erica', 'message', '放歌'],
    ['ai', 'tool_call', 'play_song({"q":"晴天"})'],
    ['tool', 'tool_result', '正在播放：晴天'],
    ['ai', 'message', '我放首歌\n\n放好了']
  ])
  // 前半段那条软删掉了（证据还在库里）
  assert.deepEqual(allEpisodes().filter(e => e.retract_reason).map(e => [e.content, e.retract_reason]),
    [['我放首歌', 'tool_round']])
  // 她那边：一条回复、一个版本（没有 1/2 切换），工具还挂在这条上
  const items = chatHistory(db, {}).items.filter(i => i.role === 'assistant')
  assert.equal(items.length, 1)
  assert.equal(items[0]!.versions!.length, 1)
  assert.equal(items[0]!.content, '我放首歌\n\n放好了')
  assert.deepEqual(items[0]!.versions![0]!.tools.map(t => [t.name, t.result]), [['play_song', '正在播放：晴天']])
  assert.equal(items[0]!.active, undefined)
})

test('工具调用：中间她又说了话就是两轮，不合并', async () => {
  stationReply = streamReply([sseChunk({ content: '我放首歌' }), sseChunk({ tool_calls: [{ index: 0, id: 'c9', function: { name: 'play_song', arguments: '{}' } }] }), sseChunk({}, 'tool_calls')])
  const h = { 'x-eclipsis-turn': 'a3b', 'x-eclipsis-version': '0' }
  await (await chat({ model: 'm', stream: true, messages: [{ role: 'user', content: '放歌' }] }, h)).text()
  await settle()
  stationReply = streamReply([sseChunk({ content: '好' }), sseChunk({}, 'stop')])
  await (await chat({ model: 'm', stream: true, messages: [
    { role: 'user', content: '放歌' },
    { role: 'assistant', content: '我放首歌', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'play_song', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c9', content: 'ok' },
    { role: 'user', content: '算了' }
  ] }, { 'x-eclipsis-turn': 'a3c', 'x-eclipsis-version': '0' })).text()
  await settle()
  assert.deepEqual(episodes().filter(e => e.kind === 'message').map(e => [e.actor, e.content]), [
    ['erica', '放歌'], ['ai', '我放首歌'], ['erica', '算了'], ['ai', '好']
  ])
})

test('重新生成一个调了工具的轮次：两版各自合并，不混在一起', async () => {
  const h = (v: string) => ({ 'x-eclipsis-turn': 'a3d', 'x-eclipsis-version': v })
  for (const [v, pre, post] of [['0', '第一版前', '第一版后'], ['1', '第二版前', '第二版后']] as const) {
    stationReply = streamReply([sseChunk({ content: pre }), sseChunk({ tool_calls: [{ index: 0, id: 'c' + v, function: { name: 'play_song', arguments: '{}' } }] }), sseChunk({}, 'tool_calls')])
    await (await chat({ model: 'm', stream: true, messages: [{ role: 'user', content: '放歌' }] }, h(v))).text()
    await settle()
    stationReply = streamReply([sseChunk({ content: post }), sseChunk({}, 'stop')])
    await (await chat({ model: 'm', stream: true, messages: [
      { role: 'user', content: '放歌' },
      { role: 'assistant', content: pre, tool_calls: [{ id: 'c' + v, type: 'function', function: { name: 'play_song', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c' + v, content: 'ok' }
    ] }, h(v))).text()
    await settle()
  }
  assert.deepEqual(episodes().filter(e => e.actor === 'ai' && e.kind === 'message').map(e => e.content),
    ['第一版前\n\n第一版后', '第二版前\n\n第二版后'])
  // 这两条才是真的两个版本：她那边一条回复、能翻 1/2
  const it = chatHistory(db, {}).items.filter(i => i.role === 'assistant')
  assert.equal(it.length, 1)
  assert.equal(it[0]!.versions!.length, 2)
  assert.equal(it[0]!.content, '第二版前\n\n第二版后')
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

test('/v1/models：后端自己问当前这个站（不记录，答案记 5 分钟）', async () => {
  const res = await fetch(`http://127.0.0.1:${frontPort}/v1/models`)
  assert.deepEqual(await res.json(), { data: [{ id: 'station-m' }] })
  await settle()
  assert.equal(exchanges().length, 0)
  // 第二次走缓存：站那边不会再被问一遍
  const before = station.seen.filter(s => s.url === '/v1/models').length
  await fetch(`http://127.0.0.1:${frontPort}/v1/models`)
  assert.equal(station.seen.filter(s => s.url === '/v1/models').length, before)
  // fresh=1 重新问
  await fetch(`http://127.0.0.1:${frontPort}/v1/models?fresh=1`)
  assert.equal(station.seen.filter(s => s.url === '/v1/models').length, before + 1)
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

test('中转站开始输出后卡住（只吐一点就没动静）→ 上游入口按时断开，记成网络错误', async () => {
  stationReply = (_r, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sseChunk({ content: '在' }))
    // 之后再也不写、也不结束
  }
  const t0 = Date.now()
  const r = await fetch(`http://127.0.0.1:${tapPort}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TAP_KEY}` },
    body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: '在吗' }] })
  })
  await r.text().catch(() => '')   // 连接被入口断开
  const waited = Date.now() - t0
  assert.ok(waited >= 1400 && waited < 4000, `等了 ${waited}ms`)
  await new Promise(res => setTimeout(res, 100))
  const row = db.prepare("SELECT status, error FROM exchanges WHERE tap = 'upstream' ORDER BY id DESC LIMIT 1").get() as any
  assert.equal(row.status, 'network_error')
  assert.match(row.error, /2 秒没有任何输出，已断开/)
})

test('中转站回 429 → 上游入口隔一会儿自己重试，客户端拿到的是重试成功的回复', async () => {
  let n = 0
  stationReply = (_r, res) => {
    n++
    if (n === 1) { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"rate limited"}}'); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '在' }, finish_reason: 'stop' }] }))
  }
  const r = await fetch(`http://127.0.0.1:${tapPort}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TAP_KEY}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: '在吗' }] })
  })
  assert.equal(r.status, 200)
  assert.equal((await r.json() as any).choices[0].message.content, '在')
  assert.equal(n, 2)
  await new Promise(res => setTimeout(res, 50))
  const row = db.prepare("SELECT status FROM exchanges WHERE tap = 'upstream' ORDER BY id DESC LIMIT 1").get() as any
  assert.equal(row.status, 'ok')
})

test('中转站回 502 号池用完 / 503 → 也自己重试；500 不重试', async () => {
  for (const status of [502, 503]) {
    let n = 0
    stationReply = (_r, res) => {
      n++
      if (n === 1) { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":{"message":"All available accounts exhausted"}}'); return }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '在' }, finish_reason: 'stop' }] }))
    }
    const r = await fetch(`http://127.0.0.1:${tapPort}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TAP_KEY}` },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: '在吗' }] })
    })
    assert.equal(r.status, 200, String(status))
    assert.equal(n, 2, String(status))
  }
  let n = 0
  stationReply = (_r, res) => { n++; res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"boom"}}') }
  const r = await fetch(`http://127.0.0.1:${tapPort}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TAP_KEY}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: '在吗' }] })
  })
  assert.equal(r.status, 500)
  assert.equal(n, 1)
})

test('一直 429 → 重试两次还不行，才把 429 交给客户端', async () => {
  let n = 0
  stationReply = (_r, res) => { n++; res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"rate limited"}}') }
  const r = await fetch(`http://127.0.0.1:${tapPort}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TAP_KEY}` },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: '在吗' }] })
  })
  assert.equal(r.status, 429)
  assert.equal(n, 3)
})

test('BYPASS_XIAOKE=1：前端出口直接连中转站，一轮只记一行，加工照样做，经历表照样记', async () => {
  const db2 = openDb(':memory:')
  const cfg: Config = {
    ...loadConfig({}),
    dylanUrl: 'http://127.0.0.1:1/v1',            // 故意指向不存在的 xiaoke：真走它就会 502
    upstreamUrl: `http://127.0.0.1:${stationPortRef}/v1`, upstreamKey: STATION_KEY,
    bypassXiaoke: true, dbPath: ':memory:', blobDir: tmp.dir, headerTimeoutMs: 5000,
  }
  // 经历表里先有点历史，好让「换成我们拼的那份」有东西可换
  for (let i = 0; i < 30; i++) {
    addEpisode(db2, { ts: new Date(Date.now() - (60 - i) * 60_000).toISOString(), channel: 'chat', scope: 'daily',
      actor: i % 2 ? 'ai' : 'erica', kind: 'message', content: `第 ${i} 句`, sourceRef: 'h' + i })
  }
  const s = buildServers(cfg, db2, { assembler: true, stripThinkHistory: true, log: () => {} })
  const port = await listen(s.front)
  const prevOur = process.env.OUR_HISTORY
  process.env.OUR_HISTORY = '1'
  try {
    stationReply = streamReply([sseChunk({ content: '直连' }), sseChunk({ content: '成功' }), sseChunk({}, 'stop')])
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-eclipsis-scene': 'chat', 'x-eclipsis-turn': 't-bypass' },
      body: JSON.stringify({ model: 'm', stream: true, messages: [
        { role: 'system', content: '她的 system' },
        { role: 'user', content: '很久以前' }, { role: 'assistant', content: '嗯' },
        { role: 'user', content: '直连测试' },
      ] }),
    })
    assert.equal(res.status, 200)
    await res.text()
    await settle()

    // 发到站的那份：key 换成了站的，历史换成我们的，此刻块注入了
    const sent = JSON.parse(station.seen.at(-1)!.body)
    assert.equal(station.seen.at(-1)!.headers.authorization, `Bearer ${STATION_KEY}`)
    assert.equal(sent.messages.at(-1).content, '直连测试')
    assert.match(sent.messages[0].content, /她的 system/)
    assert.match(sent.messages[0].content, /# 此刻/)
    assert.ok(sent.messages.length > 20, `历史换成了我们的（${sent.messages.length} 条）`)

    // 一轮只记一行（不再是 front + upstream 两行），而且标了 to_station
    const rows = db2.prepare('SELECT tap, status, transforms FROM exchanges').all() as any[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0].tap, 'front')
    assert.equal(rows[0].status, 'ok')
    const tf = JSON.parse(rows[0].transforms)
    assert.equal(tf.to_station, true)
    assert.ok(tf.our_history, '历史是我们拼的')
    assert.ok(tf.assembler_v1, '此刻块进去了')

    // 她这句和他的回复都进了经历表
    const eps = db2.prepare(`SELECT actor, content FROM episodes WHERE source_ref LIKE 'front:%' ORDER BY seq DESC LIMIT 2`).all() as any[]
    assert.deepEqual(eps.map(e => `${e.actor}:${e.content}`), ['ai:直连成功', 'erica:直连测试'])
  } finally {
    if (prevOur === undefined) delete process.env.OUR_HISTORY; else process.env.OUR_HISTORY = prevOur
    await close(s.front); await close(s.tap)
  }
})

test('今日概况：「她上一句」算的是她，不是他自己刚说的半截话', () => {
  const db2 = openDb(':memory:')
  const now = Date.parse('2026-11-12T00:10:00Z')
  const t = (min: number) => new Date(now - min * 60_000).toISOString()
  addEpisode(db2, { ts: t(40), channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: '在吗', sourceRef: 'x:u1' })
  addEpisode(db2, { ts: t(39), channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message', content: '在', sourceRef: 'x:a1' })
  addEpisode(db2, { ts: t(20), channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: '我有点焦虑', sourceRef: 'x:u2' })
  // 他刚说的半截话（工具轮里「上一句」以前指的就是这条）
  addEpisode(db2, { ts: t(0), channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message', content: '焦虑什么', sourceRef: 'x:a2' })
  const line = renderTodayLine(db2, now)
  assert.match(line, /她上一句 20 分钟前/)
  assert.doesNotMatch(line, /上一句 刚刚/)
})

// 一轮里几次请求（他调工具）：此刻冻住 + 工具结果后面挑明她还没法回
test('工具轮：「此刻」在一轮里冻住，工具结果后面挑明她还没法回', async () => {
  forgetTurnScenes()
  const db2 = openDb(':memory:')
  const cfg: Config = {
    ...loadConfig({}),
    dylanUrl: 'http://127.0.0.1:1/v1',
    upstreamUrl: `http://127.0.0.1:${stationPortRef}/v1`, upstreamKey: STATION_KEY,
    bypassXiaoke: true, dbPath: ':memory:', blobDir: tmp.dir, headerTimeoutMs: 5000,
  }
  for (let i = 0; i < 10; i++) {
    addEpisode(db2, { ts: new Date(Date.now() - (60 - i) * 60_000).toISOString(), channel: 'chat', scope: 'daily',
      actor: i % 2 ? 'ai' : 'erica', kind: 'message', content: `第 ${i} 句`, sourceRef: 'f' + i })
  }
  const s = buildServers(cfg, db2, { assembler: true, stripThinkHistory: true, log: () => {} })
  const port = await listen(s.front)
  const h = { 'content-type': 'application/json', 'x-eclipsis-scene': 'chat', 'x-eclipsis-turn': 'frozen1', 'x-eclipsis-version': '0' }
  const post = (messages: any[]) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: h, body: JSON.stringify({ model: 'm', stream: true, messages })
  })
  try {
    stationReply = streamReply([
      sseChunk({ content: '焦虑什么。吃完饭了吗。' }),
      sseChunk({ tool_calls: [{ index: 0, id: 'ct1', function: { name: 'open_town', arguments: '{}' } }] }),
      sseChunk({}, 'tool_calls')
    ])
    await (await post([{ role: 'system', content: 'sp' }, { role: 'user', content: '我有点焦虑' }])).text()
    await settle()
    // 工具轮：她在界面上插不进话
    stationReply = streamReply([sseChunk({ content: '小镇开了。' }), sseChunk({}, 'stop')])
    await (await post([
      { role: 'system', content: 'sp' }, { role: 'user', content: '我有点焦虑' },
      { role: 'assistant', content: '焦虑什么。吃完饭了吗。', tool_calls: [{ id: 'ct1', type: 'function', function: { name: 'open_town', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'ct1', content: '打开了，里面有：home' }
    ])).text()
    await settle()

    const sent = station.seen.filter(x => !x.url.startsWith('/v1/models')).slice(-2).map(x => JSON.parse(x.body))
    assert.match(sent[0].messages[0].content, /# 此刻/)
    // 同一轮两次请求的 system 一模一样（他不会看到时间和条数在一轮里跳；以后开 prompt caching 才有前缀可缓存）
    assert.equal(sent[1].messages[0].content, sent[0].messages[0].content)
    // 工具结果后面那句
    const toolMsg = sent[1].messages.at(-1)
    assert.equal(toolMsg.role, 'tool')
    assert.match(toolMsg.content, /^打开了，里面有：home/)
    assert.match(toolMsg.content, /你还在同一轮里/)
    assert.match(toolMsg.content, /不是她不理你/)
    // 第一次请求（最后一条是她的话）不加这句
    assert.doesNotMatch(JSON.stringify(sent[0].messages), /你还在同一轮里/)
    assert.equal(JSON.parse((db2.prepare('SELECT transforms FROM exchanges ORDER BY id DESC LIMIT 1').get() as any).transforms).tool_round_note, true)

    // 换一轮：重新算
    stationReply = streamReply([sseChunk({ content: '嗯' }), sseChunk({}, 'stop')])
    await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { ...h, 'x-eclipsis-turn': 'frozen2' },
      body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'system', content: 'sp' }, { role: 'user', content: '在吗' }] })
    })).text()
    await settle()
    const next = JSON.parse(station.seen.filter(x => !x.url.startsWith('/v1/models')).at(-1)!.body)
    assert.match(next.messages[0].content, /# 此刻/)
    assert.doesNotMatch(JSON.stringify(next.messages), /你还在同一轮里/)
  } finally {
    await close(s.front); await close(s.tap)
  }
})

test('站不回响应头：立刻重发一次；第二次通了就当这一轮正常（11-11 她画图那轮就是这么丢的）', async () => {
  let hit = 0
  stationReply = (_r, res) => {
    hit++
    if (hit === 1) return                 // 第一次：装死，一个字节都不回
    streamReply([sseChunk({ content: '画好了' }), sseChunk({}, 'stop')])(_r, res)
  }
  const cfg: Config = {
    ...loadConfig({}),
    upstreamUrl: `http://127.0.0.1:${stationPortRef}/v1`, upstreamKey: STATION_KEY, tapKey: TAP_KEY,
    headerTimeoutMs: 600, headerTimeoutRetries: 1, dbPath: ':memory:', blobDir: tmp.dir,
  }
  const db2 = openDb(':memory:')
  const s = buildServers(cfg, db2, { log: () => {} })
  const port = await listen(s.tap)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TAP_KEY}` },
      body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: '画一张' }] }),
    })
    assert.equal(r.status, 200)
    assert.match(await r.text(), /画好了/)
    assert.equal(hit, 2, '发了两次')
    await settle()
    const rows = db2.prepare('SELECT status FROM exchanges').all() as any[]
    assert.deepEqual(rows.map(x => x.status), ['ok'], '只记一行，而且是成功的')
  } finally { await close(s.front); await close(s.tap) }
})

test('站一直不回：重试过了还是报错，记成网络错误', async () => {
  stationReply = () => { /* 永远不回 */ }
  const cfg: Config = {
    ...loadConfig({}),
    upstreamUrl: `http://127.0.0.1:${stationPortRef}/v1`, upstreamKey: STATION_KEY, tapKey: TAP_KEY,
    headerTimeoutMs: 400, headerTimeoutRetries: 1, dbPath: ':memory:', blobDir: tmp.dir,
  }
  const db2 = openDb(':memory:')
  const s = buildServers(cfg, db2, { log: () => {} })
  const port = await listen(s.tap)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TAP_KEY}` },
      body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'x' }] }),
    })
    assert.equal(r.status, 502)
    await settle()
    const row = db2.prepare('SELECT status, error FROM exchanges').get() as any
    assert.equal(row.status, 'network_error')
    assert.match(row.error, /响应头超时/)
  } finally { await close(s.front); await close(s.tap) }
})
