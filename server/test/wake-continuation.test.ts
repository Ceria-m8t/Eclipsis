// Wake 接着最近一次真实聊天醒来 + 聊天里带「你醒来时」块
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import { ensureWakeSchema } from '../src/wake/index.ts'
import { ensurePromptSchema, putDoc } from '../src/prompts.ts'
import { dispatchWake } from '../src/wake/dispatch.ts'
import { loadChatContinuation, flattenTools, stripSceneBlock } from '../src/wake/continuation.ts'
import { renderRecentWakeBlock } from '../src/wake/chat-block.ts'
import { sha256 } from '../src/blobs.ts'
import type { WakeOpportunity } from '../src/wake/types.ts'
import { fakeUpstream, listen, close } from './helpers.ts'

function freshDb(): DB {
  const db = openDb(':memory:')
  ensureWakeSchema(db)
  ensurePromptSchema(db)
  return db
}

/** 模拟上游入口存下的一次聊天请求 */
function addExchange(db: DB, messages: any[], o: { at?: string; finish?: string; reply?: string; model?: string } = {}): number {
  const put = db.prepare('INSERT OR IGNORE INTO blobs(hash, kind, mime, size, text, created_at) VALUES (?, ?, NULL, ?, ?, ?)')
  const hashes = messages.map(m => { const t = JSON.stringify(m); const h = sha256(t); put.run(h, 'message', t.length, t, new Date().toISOString()); return h })
  const r = db.prepare(`INSERT INTO exchanges(rid, tap, started_at, status, path, model, message_hashes, finish_reason, reply_content)
    VALUES (?, 'upstream', ?, 'ok', '/v1/chat/completions', ?, ?, ?, ?)`).run(
    crypto.randomUUID(), o.at ?? new Date(Date.now() - 3600_000).toISOString(), o.model ?? 'chat-model',
    JSON.stringify(hashes), o.finish ?? 'stop', o.reply ?? null)
  return Number(r.lastInsertRowid)
}

const XIAOKE_SYSTEM = '我是小克的提示词\n\n---\n# 此刻\n现在是 旧时间\n\n# 你醒来时（最近 24 小时）\n旧的醒来块'
const chat = [
  { role: 'system', content: XIAOKE_SYSTEM },
  { role: 'user', content: '在吗' },
  { role: 'assistant', content: '我看看', tool_calls: [{ id: 't1', type: 'function', function: { name: 'breath', arguments: '{"q":"她"}' } }] },
  { role: 'tool', tool_call_id: 't1', name: 'breath', content: '记忆：她喜欢猫' },
  { role: 'assistant', content: '在。' },
  { role: 'user', content: [{ type: 'text', text: '看这个' }, { type: 'image_ref', blob: 'x', mime: 'image/png' }] }
]

describe('continuation 拼装', () => {
  it('剪掉 system 末尾上次的此刻块和后面的块', () => {
    assert.equal(stripSceneBlock(XIAOKE_SYSTEM), '我是小克的提示词')
    assert.equal(stripSceneBlock('没有此刻块'), '没有此刻块')
  })

  it('工具调用/结果压成 user 那一侧的系统记录，他的回复里只留他说的话；图片换成 [图片]', () => {
    const out = flattenTools(chat.slice(1))
    assert.deepEqual(out.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user'])
    assert.equal(out[1].content, '我看看')
    assert.equal(out[2].content, '[系统记录，不是她说的] 这一步你用了工具 breath，参数 {"q":"她"}。返回：\n记忆：她喜欢猫')
    assert.equal(out[4].content, '看这个[图片]')
    assert.ok(out.every(m => !('tool_calls' in m)))
    // 他的回复里不再出现能照着写的调用格式
    assert.ok(out.filter(m => m.role === 'assistant').every(m => !/\[(调用工具|系统记录)/.test(String(m.content))))
  })

  it('不带话、连调两个工具：记录接在她那条后面，不出现空的回复，也不连着两条 user', () => {
    const out = flattenTools([
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'breath', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'feel', arguments: '{"x":1}' } }] },
      { role: 'tool', tool_call_id: 'a', name: 'breath', content: 'A' },
      { role: 'tool', tool_call_id: 'b', name: 'feel', content: 'B' },
      { role: 'assistant', content: '在。' }
    ])
    assert.deepEqual(out.map(m => m.role), ['user', 'assistant'])
    assert.match(out[0].content, /^在吗\n\n\[系统记录，不是她说的\] 这一步你用了工具 breath，参数 \{\}。返回：\nA\n\n\[系统记录，不是她说的\] 这一步你用了工具 feel/)
  })

  it('取最近一次正常结束的聊天，跳过中途调工具的；接上他那轮的回复（剥思维链）', () => {
    const db = freshDb()
    addExchange(db, chat, { reply: '<think>嗯</think>\n好看。', at: new Date(Date.now() - 2 * 3600_000).toISOString() })
    addExchange(db, chat, { finish: 'tool_calls', at: new Date(Date.now() - 3600_000).toISOString() })
    const c = loadChatContinuation(db)!
    assert.ok(c)
    assert.equal(c.system, '我是小克的提示词')
    assert.equal(c.history.length, 6)
    assert.deepEqual(c.history.at(-1), { role: 'assistant', content: '好看。' })
    assert.equal(c.model, 'chat-model')
  })

  it('太久没聊（默认 72 小时）或没有聊天 → null', () => {
    const db = freshDb()
    assert.equal(loadChatContinuation(db), null)
    addExchange(db, chat, { reply: '好', at: new Date(Date.now() - 80 * 3600_000).toISOString() })
    assert.equal(loadChatContinuation(db), null)
  })
})

describe('dispatchWake 接着聊天醒来', () => {
  function run(db: DB, model?: string) {
    const up = fakeUpstream((req, res) => {
      if (req.url.startsWith('/bark')) { res.writeHead(200); res.end('{}'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '想你了' }, finish_reason: 'stop' }] }))
    })
    const opp: WakeOpportunity = { id: crypto.randomUUID(), origin: 'spontaneous', sources: [], reason: '测试', createdAt: new Date().toISOString() }
    db.prepare('INSERT INTO wake_opportunities(id, origin, reason, created_at) VALUES (?, ?, ?, ?)').run(opp.id, opp.origin, opp.reason, opp.createdAt)
    return { up, go: async () => {
      const port = await listen(up.server)
      try {
        await dispatchWake(opp, db, { upstreamUrl: `http://127.0.0.1:${port}/v1`, upstreamKey: 'k', model, barkUrl: `http://127.0.0.1:${port}/bark/k`, maxTokens: 2000, retryDelayMs: 0, log: () => {} })
      } finally { await close(up.server) }
      return JSON.parse(up.seen.find(s => !s.url.startsWith('/bark'))!.body)
    } }
  }

  it('他看到的是平时聊天那份 system + 全部历史 + 新的此刻块，最后一条是醒来说明', async () => {
    const db = freshDb()
    putDoc(db, 'prompt', { main: '后端主 prompt', features: '', featuresEnabled: false })
    addExchange(db, chat, { reply: '好看。' })
    const sent = await run(db).go()
    const msgs = sent.messages
    assert.equal(msgs[0].role, 'system')
    assert.match(msgs[0].content, /^我是小克的提示词\n\n---\n# 此刻\n现在是 /)
    assert.doesNotMatch(msgs[0].content, /旧时间|旧的醒来块|后端主 prompt/)
    assert.equal(msgs.length, 1 + 6 + 1)
    assert.equal(msgs.at(-2).content, '好看。')
    assert.equal(msgs.at(-1).role, 'user')
    assert.match(msgs.at(-1).content, /^\[这条不是她发的。上面的聊天停在 .+（1\.0 小时前），现在你自己醒了/)
    assert.match(msgs.at(-1).content, /醒了就去找她/)
    assert.doesNotMatch(msgs.at(-1).content, /最近的聊天记录：/)
    // 醒来带工具：手边只有发消息和箱子入口（测试环境没配记忆库/心潮/Leto，只有本地的醒来设置和这一刻）
    assert.deepEqual(sent.tools.map((t: any) => t.function.name), ['send_to_erica', 'open_wake_settings', 'open_moments'])
    assert.match(msgs.at(-1).content, /用 send_to_erica/)
  })

  it('没配固定模型时跟着那次聊天的模型', async () => {
    const db = freshDb()
    addExchange(db, chat, { reply: '好', model: 'Kiro-claude-opus-4-6' })
    const sent = await run(db, undefined).go()
    assert.equal(sent.model, 'Kiro-claude-opus-4-6')
  })

  it('WAKE_CONTINUE_CHAT=0 → 退回后端主 prompt + 经历表聊天', async () => {
    const db = freshDb()
    putDoc(db, 'prompt', { main: '后端主 prompt', features: '', featuresEnabled: false })
    addExchange(db, chat, { reply: '好' })
    process.env.WAKE_CONTINUE_CHAT = '0'
    try {
      const sent = await run(db, 'm').go()
      assert.match(sent.messages[0].content, /^后端主 prompt/)
      assert.equal(sent.messages.length, 2)
    } finally { delete process.env.WAKE_CONTINUE_CHAT }
  })
})

describe('聊天里的「你醒来时」块', () => {
  it('最近 24 小时的消息和念头，全文、按时间、标明发没发', () => {
    const db = freshDb()
    const ins = db.prepare('INSERT INTO wake_opportunities(id, origin, reason, created_at, outcome, content) VALUES (?, ?, ?, ?, ?, ?)')
    const h = (n: number) => new Date(Date.now() - n * 3600_000).toISOString()
    ins.run('a', 'spontaneous', 'r', h(30), 'message', '太早的')
    ins.run('b', 'spontaneous', 'r', h(5), 'trace', '她睡了。\n\n占有欲测试还没答完。')
    ins.run('c', 'spontaneous', 'r', h(2), 'message', '醒了没')
    ins.run('d', 'spontaneous', 'r', h(1), 'silent', '[SILENT]')
    ins.run('e', 'spontaneous', 'r', h(1), 'error', '模型返回 HTTP 502')
    const b = renderRecentWakeBlock(db)
    assert.match(b, /^# 你醒来时（最近 24 小时/)
    assert.doesNotMatch(b, /太早的|SILENT|502/)
    assert.match(b, /没发，留在心里（她在 Eclipsis 聊天里点开能翻到）：\n她睡了。\n\n占有欲测试还没答完。/)
    assert.match(b, /发给了她（推送到她手机，通知里能看到前 200 字）：\n醒了没/)
    assert.ok(b.indexOf('占有欲') < b.indexOf('醒了没'))
  })

  it('没有醒来记录 → 空', () => {
    assert.equal(renderRecentWakeBlock(freshDb()), '')
  })
})
