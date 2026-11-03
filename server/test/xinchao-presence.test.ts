// 她每发一条新消息 → 通知心潮"她来了"
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { BlobStore } from '../src/blobs.ts'
import { Recorder } from '../src/recorder.ts'
import { notifyXinchaoPresence, resetPresenceThrottle } from '../src/xinchao-client.ts'
import { fakeUpstream, listen, close, tempDir } from './helpers.ts'

function chatBody(...userTexts: string[]) {
  return { model: 'm', messages: [{ role: 'system', content: 's' }, ...userTexts.map(t => ({ role: 'user', content: t }))] }
}

describe('Recorder.onEricaMessage', () => {
  const tmp = tempDir()
  after(() => tmp.cleanup())

  function setup() {
    const db = openDb(':memory:')
    const calls: string[] = []
    const rec = new Recorder(db, new BlobStore(db, tmp.dir), { onEricaMessage: t => calls.push(t) })
    return { rec, calls }
  }
  const start = (rec: Recorder, body: any, extra: Record<string, string> = {}) => rec.start({
    tap: 'front', rid: crypto.randomUUID(), linked: false, path: '/v1/chat/completions',
    headers: { 'x-eclipsis-scene': 'chat', 'x-eclipsis-conversation': 'c1', 'x-eclipsis-turn': 't1', ...extra }, body
  })

  it('新消息触发一次，连发几句合成一次', () => {
    const { rec, calls } = setup()
    start(rec, chatBody('在吗', '我回来了'))
    assert.deepEqual(calls, ['在吗\n我回来了'])
  })

  it('同一轮重新生成不再触发', () => {
    const { rec, calls } = setup()
    start(rec, chatBody('在吗'), { 'x-eclipsis-version': '0' })
    start(rec, chatBody('在吗'), { 'x-eclipsis-version': '1' })
    assert.equal(calls.length, 1)
  })

  it('结尾是工具结果时不触发', () => {
    const { rec, calls } = setup()
    start(rec, { model: 'm', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'a', content: 'ok' }] }, { 'x-eclipsis-turn': 't2' })
    assert.equal(calls.length, 0)
  })

  it('回调抛错不影响记录', () => {
    const db = openDb(':memory:')
    const rec = new Recorder(db, new BlobStore(db, tmp.dir), { onEricaMessage: () => { throw new Error('boom') } })
    assert.doesNotThrow(() => start(rec, chatBody('hi')))
  })
})

describe('notifyXinchaoPresence', () => {
  it('带密钥 POST /v1/conversation-event，不带 interaction_type；20 秒内只发一次', async () => {
    const up = fakeUpstream((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
    const port = await listen(up.server)
    const prev = process.env.XINCHAO_TOKEN
    process.env.XINCHAO_TOKEN = 'tok'
    try {
      resetPresenceThrottle()
      const url = `http://127.0.0.1:${port}`
      assert.equal(await notifyXinchaoPresence(url, '  我   回来了 ', { now: 1_000_000 }), true)
      assert.equal(await notifyXinchaoPresence(url, '还有一句', { now: 1_010_000 }), false)
      assert.equal(await notifyXinchaoPresence(url, '过了一会', { now: 1_030_000 }), true)
      assert.equal(up.seen.length, 2)
      const first = up.seen[0]
      assert.equal(first.method, 'POST')
      assert.equal(first.url, '/v1/conversation-event')
      assert.equal(first.headers.authorization, 'Bearer tok')
      const body = JSON.parse(first.body)
      assert.equal(body.recent, '我 回来了')
      assert.equal('interaction_type' in body, false)
      assert.match(body.event_id, /^eclipsis:\d+$/)
    } finally {
      if (prev === undefined) delete process.env.XINCHAO_TOKEN; else process.env.XINCHAO_TOKEN = prev
      resetPresenceThrottle()
      await close(up.server)
    }
  })
})
