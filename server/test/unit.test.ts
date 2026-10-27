import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinV1 } from '../src/config.ts'
import { parseSse, parseJson } from '../src/reply.ts'
import { openDb } from '../src/db.ts'
import { BlobStore } from '../src/blobs.ts'
import { stripWakeHistory, WAKE_HISTORY_NOTE } from '../src/transforms.ts'
import { WAKE_MARKER } from '../src/recorder.ts'
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

const wakePrompt = (body: string) => `以下是你与用户最近的聊天记录，仅供回忆和参考。\n\n这些内容不是正在发生的实时对话。\n用户并没有给你发消息。\n\n${WAKE_MARKER}。\n\n最近记录：\n\n${body}`

test('stripWakeHistory：剪掉历史里旧唤醒的"最近记录"，最后一条 user 不动', () => {
  const msgs = [
    { role: 'system', content: 'sp' },
    { role: 'user', content: wakePrompt('[用户] 很长的旧聊天'.repeat(100)) },
    { role: 'assistant', content: '不打扰' },
    { role: 'user', content: '老公在吗' },
    { role: 'user', content: '这条不是唤醒' }
  ]
  const r = stripWakeHistory(msgs)
  assert.equal(r.stripped, 1)
  assert.ok(r.savedChars > 1000)
  assert.ok(r.messages[1].content.includes(WAKE_MARKER), '保留说明，他知道自己醒过')
  assert.ok(r.messages[1].content.endsWith(WAKE_HISTORY_NOTE))
  assert.ok(!r.messages[1].content.includes('很长的旧聊天'))
  assert.equal(r.messages[2], msgs[2])
  assert.equal(msgs[1].content.includes('很长的旧聊天'), true, '不改原数组')
})

test('stripWakeHistory：本次就是唤醒时，最后那条完整保留', () => {
  const msgs = [{ role: 'user', content: wakePrompt('旧的') }, { role: 'assistant', content: '嗯' }, { role: 'user', content: wakePrompt('这次的记录') }]
  const r = stripWakeHistory(msgs)
  assert.equal(r.stripped, 1)
  assert.ok(r.messages[2].content.includes('这次的记录'))
})

test('stripWakeHistory：没有"最近记录："或不是唤醒，一律不动', () => {
  const msgs = [{ role: 'user', content: `${WAKE_MARKER}但没有标题` }, { role: 'user', content: '最近记录：普通话题' }, { role: 'user', content: 'x' }]
  assert.equal(stripWakeHistory(msgs).stripped, 0)
})
