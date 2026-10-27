import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinV1 } from '../src/config.ts'
import { parseSse, parseJson } from '../src/reply.ts'
import { openDb } from '../src/db.ts'
import { BlobStore } from '../src/blobs.ts'
import { sseChunk, tempDir } from './helpers.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

test('joinV1：目标写不写 /v1 都能拼对', () => {
  assert.equal(joinV1('https://a.com/v1', '/v1/chat/completions'), 'https://a.com/v1/chat/completions')
  assert.equal(joinV1('https://a.com/v1/', '/v1/models'), 'https://a.com/v1/models')
  assert.equal(joinV1('https://a.com', '/v1/chat/completions'), 'https://a.com/v1/chat/completions')
  assert.equal(joinV1('https://a.com/ai-relay/v1', '/v1/chat/completions'), 'https://a.com/ai-relay/v1/chat/completions')
  assert.equal(joinV1('http://127.0.0.1:3457/v1', '/v1/models?x=1'), 'http://127.0.0.1:3457/v1/models?x=1')
})

test('parseSse：文字、思考、分片的工具调用、[DONE]', () => {
  const text = [
    sseChunk({ role: 'assistant' }),
    sseChunk({ reasoning_content: '想' }),
    sseChunk({ content: '你' }),
    sseChunk({ content: '好' }),
    sseChunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'play', arguments: '{"a"' } }] }),
    sseChunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }),
    sseChunk({}, 'tool_calls'),
    'data: [DONE]\n\n'
  ].join('')
  const r = parseSse(text)
  assert.equal(r.content, '你好')
  assert.equal(r.thinking, '想')
  assert.deepEqual(r.toolCalls, [{ id: 'c1', name: 'play', arguments: '{"a":1}' }])
  assert.equal(r.finishReason, 'tool_calls')
  assert.equal(r.done, true)
})

test('parseJson：普通回复和错误', () => {
  const ok = parseJson(JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } }))
  assert.equal(ok.content, 'hi')
  assert.deepEqual(ok.usage, { total_tokens: 3 })
  const bad = parseJson(JSON.stringify({ error: { message: 'Invalid request' } }))
  assert.equal(bad.error, 'Invalid request')
})

test('BlobStore：图片拆成文件、同一条消息只存一份', () => {
  const { dir, cleanup } = tempDir()
  try {
    const db = openDb(':memory:')
    const blobs = new BlobStore(db, dir)
    const png = Buffer.from('fake-png-bytes').toString('base64')
    const msg = { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }, { type: 'text', text: '看' }] }
    const a = blobs.putMessage(msg)
    const b = blobs.putMessage(structuredClone(msg))
    assert.equal(a.hash, b.hash)
    assert.equal(a.images.length, 1)
    assert.equal(a.message.content[0].type, 'image_ref')
    assert.ok(existsSync(join(dir, a.images[0].slice(0, 2), a.images[0])))
    assert.ok(!blobs.getText(a.hash)!.includes(png), '消息 JSON 里不应再有 base64')
    const count = db.prepare("SELECT COUNT(*) AS n FROM blobs WHERE kind = 'message'").get() as { n: number }
    assert.equal(count.n, 1)
    assert.equal(msg.content[0].type, 'image_url', '不改原消息')
  } finally { cleanup() }
})
