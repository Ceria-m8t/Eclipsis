// 一轮聊完 → 把"她说/他回"交给心潮判互动；心潮调模型走后端的内部转发口
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { BlobStore } from '../src/blobs.ts'
import { Recorder, lastHerTurn } from '../src/recorder.ts'
import { notifyXinchaoExchange, buildExchangeText, resetPresenceThrottle } from '../src/xinchao-client.ts'
import { handleLlmRelay, LLM_RELAY_PATH } from '../src/llm-relay.ts'
import { createServer } from 'node:http'
import { fakeUpstream, listen, close, tempDir } from './helpers.ts'

describe('Recorder.onTurnComplete', () => {
  const tmp = tempDir()
  after(() => tmp.cleanup())
  function setup() {
    const db = openDb(':memory:')
    const calls: [string, string][] = []
    const rec = new Recorder(db, new BlobStore(db, tmp.dir), { onTurnComplete: (h, s) => calls.push([h, s]) })
    const turn = (messages: any[], reply: any, turnId = crypto.randomUUID()) => {
      const ctx = rec.start({ tap: 'front', rid: crypto.randomUUID(), linked: false, path: '/v1/chat/completions',
        headers: { 'x-eclipsis-scene': 'chat', 'x-eclipsis-conversation': 'c1', 'x-eclipsis-turn': turnId }, body: { model: 'm', messages } })
      rec.finish(ctx, { httpStatus: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: reply, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop' }] }), aborted: false })
    }
    return { calls, turn }
  }

  it('说完一轮：她连发的几句 + 他回的（去掉思维链和时间标记）', () => {
    const t = setup()
    t.turn([{ role: 'system', content: 's' }, { role: 'user', content: '（2026-11-07 02:40）在吗' }, { role: 'user', content: '我回来了<current_time>Sat</current_time>' }],
      { role: 'assistant', content: '<think>嗯</think>\n在。' })
    assert.deepEqual(t.calls, [['在吗\n我回来了', '在。']])
  })

  it('他中途调工具那次不算；工具跑完说完的那次，她的话往前找', () => {
    const t = setup()
    const base = [{ role: 'user', content: '帮我查一下' }]
    t.turn(base, { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }] })
    assert.equal(t.calls.length, 0)
    t.turn([...base, { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'a', content: 'ok' }],
      { role: 'assistant', content: '查到了' })
    assert.deepEqual(t.calls, [['帮我查一下', '查到了']])
  })

  it('lastHerTurn：没有 user 就是空', () => {
    assert.equal(lastHerTurn([{ role: 'system', content: 's' }]), '')
  })
})

describe('notifyXinchaoExchange', () => {
  it('发 exchange（她说：… 他回：…），8 分钟内只发一次', async () => {
    resetPresenceThrottle()
    const up = fakeUpstream((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
    const port = await listen(up.server)
    try {
      assert.equal(await notifyXinchaoExchange(`http://127.0.0.1:${port}`, '想你了', '我也是', { now: 1_000_000 }), true)
      assert.equal(await notifyXinchaoExchange(`http://127.0.0.1:${port}`, '还在吗', '在', { now: 1_000_000 + 5 * 60_000 }), false)
      assert.equal(await notifyXinchaoExchange(`http://127.0.0.1:${port}`, '还在吗', '在', { now: 1_000_000 + 9 * 60_000 }), true)
      const b = JSON.parse(up.seen[0].body)
      assert.equal(up.seen[0].url, '/v1/conversation-event')
      assert.equal(b.exchange, '她说：想你了 他回：我也是')
      assert.equal(b.interaction_type, undefined)
      assert.equal(up.seen.length, 2)
    } finally { await close(up.server); resetPresenceThrottle() }
  })
  it('超长的截断', () => {
    const t = buildExchangeText('她'.repeat(800), '他'.repeat(2000))
    assert.ok(t.length <= 3 + 500 + 4 + 900)
  })
})

describe('内部模型转发口', () => {
  async function setup(relayKey = 'rk') {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO exchanges(rid, tap, started_at, status, path, model) VALUES ('r', 'upstream', ?, 'ok', '/v1/chat/completions', 'chat-model')`).run(new Date().toISOString())
    const station = fakeUpstream((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[{"message":{"content":"ok"}}]}') })
    const sp = await listen(station.server)
    const srv = createServer(async (req, res) => {
      if (!(await handleLlmRelay({ upstreamUrl: `http://127.0.0.1:${sp}/v1`, upstreamKey: 'station-key', relayKey }, db, req, res))) { res.writeHead(404); res.end() }
    })
    const port = await listen(srv)
    const post = (body: any, key = 'rk') => fetch(`http://127.0.0.1:${port}${LLM_RELAY_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) })
    return { db, station, post, done: async () => { await close(srv); await close(station.server) } }
  }

  it('转给现在的中转站；model=auto 跟最近一次聊天；不记进 exchanges', async () => {
    const t = await setup()
    try {
      const r = await t.post({ model: 'auto', messages: [{ role: 'user', content: 'x' }], stream: true })
      assert.equal(r.status, 200)
      assert.match(await r.text(), /"ok"/)
      const sent = JSON.parse(t.station.seen[0].body)
      assert.equal(sent.model, 'chat-model')
      assert.equal(sent.stream, false)
      assert.equal(t.station.seen[0].headers.authorization, 'Bearer station-key')
      assert.equal((t.db.prepare('SELECT count(*) AS n FROM exchanges').get() as any).n, 1)
    } finally { await t.done() }
  })

  it('密钥不对 → 401；没配密钥 → 不开', async () => {
    const t = await setup()
    try { assert.equal((await t.post({ messages: [] }, 'wrong')).status, 401) } finally { await t.done() }
    const t2 = await setup('')
    try { assert.equal((await t2.post({ messages: [] }, '')).status, 404) } finally { await t2.done() }
  })
})
