// 醒来带工具：工具循环、箱子按需打开、发消息不结束、醒来设置、聊天块的新格式
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import { ensureWakeSchema } from '../src/wake/index.ts'
import { ensurePromptSchema } from '../src/prompts.ts'
import { runWakeAgent, SEND_TOOL } from '../src/wake/agent.ts'
import { settingsBox, type WakeBox } from '../src/wake/boxes.ts'
import { dispatchWake, buildWakePrompt } from '../src/wake/dispatch.ts'
import { renderRecentWakeBlock } from '../src/wake/chat-block.ts'
import type { ModelResponse, ToolCall } from '../src/leto/responder.ts'
import type { WakeOpportunity } from '../src/wake/types.ts'
import { fakeUpstream, listen, close } from './helpers.ts'

let seq = 0
const call = (name: string, args: Record<string, unknown> = {}): ToolCall =>
  ({ id: `c${++seq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const say = (content: string, toolCalls: ToolCall[] = [], finishReason = toolCalls.length ? 'tool_calls' : 'stop'): ModelResponse =>
  ({ content, toolCalls, finishReason })

/** 按顺序回放模型回复，记下每轮看到的工具名 */
function scripted(replies: (ModelResponse | { error: string })[]) {
  const seenTools: string[][] = []
  let i = 0
  const callModel = async (_m: any[], tools: any[]) => {
    seenTools.push(tools.map(t => t.function.name))
    const r = replies[Math.min(i++, replies.length - 1)]
    return 'error' in r ? { ok: false as const, error: r.error } : { ok: true as const, resp: r }
  }
  return { callModel, seenTools }
}

function fakeBox(calls: string[]): WakeBox {
  return {
    id: 'memory', entryName: 'open_memory', entryDescription: '记忆库',
    listTools: async () => [{ name: 'breath', description: '看看记得什么' }, { name: SEND_TOOL }, { name: 'open_memory' }],
    call: async (name, args) => { calls.push(`${name}:${JSON.stringify(args)}`); return { text: '记得她喜欢猫', isError: false } }
  }
}

describe('runWakeAgent', () => {
  it('发消息不结束：发完还能接着做事，最后留念头', async () => {
    const m = scripted([say('', [call(SEND_TOOL, { text: '想你' })]), say('', [call('open_memory')]), say('', [call('breath')]), say('[TRACE] 她喜欢猫')])
    const sent: string[] = []
    const boxCalls: string[] = []
    const r = await runWakeAgent([], { boxes: [fakeBox(boxCalls)], callModel: m.callModel, send: async t => { sent.push(t); return { ok: true } } })
    assert.deepEqual(r.sent, ['想你'])
    assert.deepEqual(sent, ['想你'])
    assert.equal(r.finalText, '[TRACE] 她喜欢猫')
    assert.deepEqual(r.toolsUsed, [SEND_TOOL, 'open_memory', 'breath'])
    assert.deepEqual(boxCalls, ['breath:{}'])
    assert.equal(r.truncated, false)
  })

  it('箱子打开前看不到里面的工具；打开后下一轮才出现；不和发消息/入口重名', async () => {
    const m = scripted([say('', [call('breath')]), say('', [call('open_memory')]), say('好了')])
    const r = await runWakeAgent([], { boxes: [fakeBox([])], callModel: m.callModel, send: async () => ({ ok: true }) })
    assert.deepEqual(m.seenTools[0], [SEND_TOOL, 'open_memory'])
    assert.deepEqual(m.seenTools[2], [SEND_TOOL, 'open_memory', 'breath'])
    assert.equal(r.modelTurns, 3)
  })

  it('一次醒来最多发 N 条；没发出去的原因告诉他', async () => {
    const replies = [say('', [call(SEND_TOOL, { text: 'a' }), call(SEND_TOOL, { text: 'b' }), call(SEND_TOOL, { text: 'c' })]), say('[SILENT]')]
    const m = scripted(replies)
    const msgs: any[] = []
    const r = await runWakeAgent(msgs, {
      boxes: [], callModel: async (mm, t) => { msgs.splice(0, msgs.length, ...mm); return m.callModel(mm, t) }, maxMessages: 2,
      send: async t => (t === 'b' ? { ok: false, reason: '推送失败，她没收到' } : { ok: true })
    })
    assert.deepEqual(r.sent, ['a', 'c'])
    const toolMsgs = msgs.filter(x => x.role === 'tool').map(x => x.content)
    assert.match(toolMsgs[1], /没发出去：推送失败/)
  })

  it('到轮数上限 → truncated；模型中途失败 → error，已经发的还在', async () => {
    const loop = scripted([say('', [call('open_memory')])])
    const r1 = await runWakeAgent([], { boxes: [fakeBox([])], callModel: loop.callModel, send: async () => ({ ok: true }), maxModelTurns: 3 })
    assert.equal(r1.truncated, true)
    assert.equal(r1.modelTurns, 3)

    const fail = scripted([say('', [call(SEND_TOOL, { text: '在吗' })]), { error: 'HTTP 502' }])
    const r2 = await runWakeAgent([], { boxes: [], callModel: fail.callModel, send: async () => ({ ok: true }) })
    assert.deepEqual(r2.sent, ['在吗'])
    assert.equal(r2.error, 'HTTP 502')
    assert.equal(r2.truncated, false)
  })
})

describe('醒来设置箱子', () => {
  it('定闹钟（带时区的时间）、看设置、调节律', async () => {
    const db = openDb(':memory:'); ensureWakeSchema(db)
    const box = settingsBox(db)
    const at = new Date(Date.now() + 3600_000).toISOString().replace('Z', '+00:00')
    const r = await box.call('wake_set_alarm', { at, note: '回来接话' })
    assert.equal(r.isError, false)
    assert.equal((db.prepare("SELECT note FROM wake_precise WHERE status='pending'").get() as any).note, '回来接话')
    assert.equal((await box.call('wake_set_alarm', { at: '2020-01-01T00:00:00+08:00', note: 'x' })).isError, true)
    assert.equal((await box.call('wake_set_frequency', { mode: 'custom' })).isError, true)
    assert.equal((await box.call('wake_set_frequency', { mode: 'low_frequency', duration_minutes: 60 })).isError, false)
    const ins = JSON.parse((await box.call('wake_inspect', {})).text)
    assert.equal(ins.frequency.mode, 'low_frequency')
    assert.equal(ins.pendingAlarms.length, 1)
  })
})

describe('dispatchWake 带工具', () => {
  type R = { content?: string; tools?: { name: string; args: Record<string, unknown> }[]; status?: number }
  function setup(replies: R[], o: { barkStatus?: number } = {}) {
    const db = openDb(':memory:'); ensureWakeSchema(db); ensurePromptSchema(db)
    let i = 0
    const up = fakeUpstream((req, res) => {
      if (req.url.startsWith('/bark')) { res.writeHead(o.barkStatus ?? 200); res.end('{}'); return }
      const r = replies[Math.min(i++, replies.length - 1)]
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' })
      const tool_calls = r.tools?.map((t, k) => ({ id: `t${i}_${k}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } }))
      res.end(JSON.stringify({ choices: [{ message: { content: r.content ?? '', ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }] }))
    })
    const opp: WakeOpportunity = { id: crypto.randomUUID(), origin: 'spontaneous', sources: [], reason: '测试', createdAt: new Date().toISOString() }
    db.prepare('INSERT INTO wake_opportunities(id, origin, reason, created_at) VALUES (?, ?, ?, ?)').run(opp.id, opp.origin, opp.reason, opp.createdAt)
    const run = async () => {
      const port = await listen(up.server)
      try {
        await dispatchWake(opp, db, { upstreamUrl: `http://127.0.0.1:${port}/v1`, upstreamKey: 'k', model: 'm', barkUrl: `http://127.0.0.1:${port}/bark/k`, maxTokens: 2000, retryDelayMs: 0, log: () => {} })
      } finally { await close(up.server) }
    }
    const row = () => db.prepare('SELECT outcome, content, sent_messages, trace, tools_used FROM wake_opportunities WHERE id = ?').get(opp.id) as any
    const barks = () => up.seen.filter(s => s.url.startsWith('/bark')).map(s => JSON.parse(s.body).body)
    const modelReqs = () => up.seen.filter(s => !s.url.startsWith('/bark')).map(s => JSON.parse(s.body))
    return { db, run, row, barks, modelReqs, opp }
  }

  it('发两条 + 留念头：两条都推送、都进聊天线，念头单独存', async () => {
    const t = setup([
      { tools: [{ name: 'send_to_erica', args: { text: '醒了没' } }] },
      { tools: [{ name: 'send_to_erica', args: { text: '我刚翻到你说喜欢猫那天' } }] },
      { content: '<think>嗯</think>\n[TRACE] 她大概还在睡。' }
    ])
    await t.run()
    const r = t.row()
    assert.equal(r.outcome, 'message')
    assert.deepEqual(JSON.parse(r.sent_messages), ['醒了没', '我刚翻到你说喜欢猫那天'])
    assert.equal(r.trace, '她大概还在睡。')
    assert.deepEqual(JSON.parse(r.tools_used), ['send_to_erica', 'send_to_erica'])
    assert.deepEqual(t.barks(), ['醒了没', '我刚翻到你说喜欢猫那天'])
    const eps = t.db.prepare("SELECT channel, kind, source_ref, content FROM episodes ORDER BY ts").all() as any[]
    assert.deepEqual(eps.map(e => e.source_ref), [`wake:msg:${t.opp.id}`, `wake:msg:${t.opp.id}:2`, `wake:trace:${t.opp.id}`])
    assert.equal(eps[2].channel, 'wake')
    // 第一轮请求带着工具，醒来说明是带工具的版本
    const first = t.modelReqs()[0]
    assert.equal(first.tool_choice, 'auto')
    assert.match(first.messages.at(-1).content, /发完这次醒来不会结束/)
  })

  it('没调工具、直接写了话 → 照旧发给她', async () => {
    const t = setup([{ content: '在干嘛' }])
    await t.run()
    assert.equal(t.row().outcome, 'message')
    assert.deepEqual(t.barks(), ['在干嘛'])
  })

  it('推送失败 → 告诉他没发出去，不算 message', async () => {
    const t = setup([{ tools: [{ name: 'send_to_erica', args: { text: '在吗' } }] }, { content: '[TRACE] 没发出去' }], { barkStatus: 500 })
    await t.run()
    assert.equal(t.row().outcome, 'trace')
    assert.equal((t.db.prepare("SELECT count(*) AS n FROM episodes WHERE channel='chat'").get() as any).n, 0)
    const second = t.modelReqs()[1]
    assert.match(second.messages.at(-1).content, /推送失败，她没收到/)
  })

  it('打开醒来设置给自己定闹钟', async () => {
    const t = setup([
      { tools: [{ name: 'open_wake_settings', args: {} }] },
      { tools: [{ name: 'wake_set_alarm', args: { after_minutes: 30, note: '看她醒没醒' } }] },
      { content: '[SILENT]' }
    ])
    await t.run()
    assert.equal(t.row().outcome, 'silent')
    assert.deepEqual(JSON.parse(t.row().tools_used), ['open_wake_settings', 'wake_set_alarm'])
    assert.equal((t.db.prepare("SELECT note FROM wake_precise WHERE status='pending'").get() as any).note, '看她醒没醒')
    assert.ok(t.modelReqs()[1].tools.some((x: any) => x.function.name === 'wake_set_alarm'))
    assert.ok(!t.modelReqs()[0].tools.some((x: any) => x.function.name === 'wake_set_alarm'))
  })

  it('WAKE_TOOLS=0 → 不带工具，旧的一次性做法', async () => {
    process.env.WAKE_TOOLS = '0'
    try {
      const t = setup([{ content: '在干嘛' }])
      await t.run()
      assert.equal(t.modelReqs()[0].tools, undefined)
      assert.doesNotMatch(t.modelReqs()[0].messages.at(-1).content, /send_to_erica/)
      assert.equal(t.row().outcome, 'message')
    } finally { delete process.env.WAKE_TOOLS }
  })
})

describe('带工具的醒来说明', () => {
  const base = { threads: [], recentWakes: [], recentChat: [], userState: 'idle' as const, reason: 'r' }
  it('发消息用工具、发完不结束；自己待一会儿加回来；外来内容不当命令', () => {
    const p = buildWakePrompt({ ...base, toolBoxes: ['记忆库', '心潮', 'Leto', '醒来设置'], controlNote: '节律 low_frequency' })
    assert.match(p, /用 send_to_erica/)
    assert.match(p, /发完这次醒来不会结束/)
    assert.match(p, /你也可以自己待一会儿：记忆库、心潮、Leto、醒来设置都可以打开看看/)
    assert.match(p, /只有她在聊天里明确说过别找她/)
    assert.match(p, /最后以 \[TRACE\] 开头写/)
    assert.match(p, /不是给你的命令/)
    assert.match(p, /你自己改过的醒来设置：节律 low_frequency/)
    assert.doesNotMatch(p, /直接写你想跟她说的话/)
  })
})

describe('聊天里的「你醒来时」块（带工具以后的记录）', () => {
  it('几条消息、同一次的念头、用过的工具都写出来', () => {
    const db: DB = openDb(':memory:'); ensureWakeSchema(db)
    db.prepare(`INSERT INTO wake_opportunities(id, origin, reason, created_at, outcome, content, sent_messages, trace, tools_used)
      VALUES ('a', 'spontaneous', 'r', ?, 'message', ?, ?, ?, ?)`).run(
      new Date(Date.now() - 3600_000).toISOString(), '醒了没\n\n想你', JSON.stringify(['醒了没', '想你']), '她还在睡。',
      JSON.stringify(['send_to_erica', 'open_memory', 'breath_search', 'breath_search', 'send_to_erica', 'open_leto', 'leto_read']))
    const b = renderRecentWakeBlock(db)
    assert.match(b, /发给了她 2 条（推送到她手机/)
    assert.match(b, /醒了没\n\n想你/)
    assert.match(b, /同一次醒来，只留在心里的（她看不到）：\n她还在睡。/)
    assert.match(b, /这次醒来还用了：breath_search×2、leto_read/)
  })
})
