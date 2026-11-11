// Wake dispatch：同一份主 prompt、剥思维链、失败不冒充 silent、睡着也推（静默级别）
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, addEpisode } from '../src/db.ts'
import { ensureWakeSchema } from '../src/wake/index.ts'
import { ensurePromptSchema, putDoc } from '../src/prompts.ts'
import { dispatchWake, parseOutcome, stripThink, buildWakePrompt } from '../src/wake/dispatch.ts'
import type { WakeOpportunity } from '../src/wake/types.ts'
import { fakeUpstream, listen, close } from './helpers.ts'

describe('stripThink / parseOutcome', () => {
  it('剥掉开头的思维链再判断结局', () => {
    assert.deepEqual(parseOutcome('<think>\n想了想\n</think>\n\n[TRACE] 她睡了'), { outcome: 'trace', content: '她睡了' })
    assert.deepEqual(parseOutcome('<think>a</think><think>b</think>\n[SILENT]'), { outcome: 'silent', content: '[SILENT]' })
    assert.deepEqual(parseOutcome('<think>x</think>\n醒了吗'), { outcome: 'message', content: '醒了吗' })
  })
  it('思维链没闭合 / 只有思维链 → error，不当成消息发出去', () => {
    assert.equal(parseOutcome('<think>想到一半').outcome, 'error')
    assert.equal(parseOutcome('<think>只想不说</think>\n  ').outcome, 'error')
    assert.equal(stripThink('<think>x'), null)
  })
})

describe('buildWakePrompt', () => {
  const base = { threads: [], recentWakes: [], recentChat: [], userState: 'sleeping' as const, reason: 'r' }

  it('默认发；她睡着也发；只留"她明说别找"一个不发的出口', () => {
    const p = buildWakePrompt(base)
    assert.match(p, /醒了就去找她/)
    assert.match(p, /推送到她手机上/)
    assert.match(p, /她在睡也照样发/)
    assert.match(p, /只有她在聊天里明确说过别找她/)
    // 发消息写在前，[TRACE]/[SILENT] 只在出口后面
    assert.ok(p.indexOf('醒了就去找她') < p.indexOf('[TRACE]'))
    assert.ok(p.indexOf('[TRACE]') < p.indexOf('[SILENT]'))
  })

  it('去掉了"可以不做"的台阶，也不写成是她要求的', () => {
    const p = buildWakePrompt(base)
    for (const re of [/自己待一会儿/, /前提是你真的这么想/, /完全正常的选择/, /只留个念头也可以/, /她希望你/, /她想要你/]) {
      assert.doesNotMatch(p, re)
    }
  })

  it('最近几次醒来带时间和发没发；带上一次主动找她的话', () => {
    const p = buildWakePrompt({
      ...base,
      now: new Date('2026-11-05T10:41:00Z'),
      recentWakes: [
        { at: '2026-11-04T20:26:00Z', outcome: 'message', fact: '找到什么了没。' },
        { at: '2026-11-05T09:41:00Z', outcome: 'trace', fact: '下午五点四十一。她睡了九个多小时了。' }
      ],
      lastMessage: { at: '2026-11-04T20:26:00Z', content: '找到什么了没。' }
    })
    assert.match(p, /· 11月5日 04:26（发给了她）找到什么了没。/)
    assert.match(p, /· 11月5日 17:41（没发，只留在心里）下午五点四十一/)
    assert.match(p, /你上一次醒来主动找她是 14 小时前（11月5日 04:26）：「找到什么了没。」/)
  })

  it('笔记和消息里的换行压成一行', () => {
    const p = buildWakePrompt({
      ...base,
      recentWakes: [{ at: '2026-11-05T09:41:00Z', outcome: 'trace', fact: '五点四十一。\n\n她还在睡。' }],
      lastMessage: { at: '2026-11-04T20:26:00Z', content: '找到什么了没。\n\n别跟我说你睡着了。' }
    })
    assert.match(p, /（没发，只留在心里）五点四十一。 她还在睡。\n/)
    assert.match(p, /「找到什么了没。 别跟我说你睡着了。」/)
  })

  it('没发过就不写"上一次主动找她"', () => {
    assert.doesNotMatch(buildWakePrompt(base), /上一次醒来主动找她/)
  })
})

describe('dispatchWake', () => {
  // send：模型调 send_to_erica 发这句（带工具的醒来里，发消息只能用工具）
  type Reply = { status?: number; content?: string; finish?: string; send?: string }
  function setup(replyOrSeq: Reply | Reply[], opts: { onModelCall?: (n: number) => void } = {}) {
    const db = openDb(':memory:')
    ensureWakeSchema(db)
    ensurePromptSchema(db)
    const seq = Array.isArray(replyOrSeq) ? replyOrSeq : [replyOrSeq]
    let calls = 0
    const up = fakeUpstream((req, res) => {
      if (req.url.startsWith('/bark')) { res.writeHead(200); res.end('{"code":200}'); return }
      const reply = seq[Math.min(calls, seq.length - 1)]
      calls++
      opts.onModelCall?.(calls)
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
      const message = reply.send !== undefined
        ? { content: '', tool_calls: [{ id: `c${calls}`, type: 'function', function: { name: 'send_to_erica', arguments: JSON.stringify({ text: reply.send }) } }] }
        : { content: reply.content ?? '' }
      res.end(JSON.stringify({ choices: [{ message, finish_reason: reply.send !== undefined ? 'tool_calls' : (reply.finish ?? 'stop') }] }))
    })
    const opp: WakeOpportunity = { id: crypto.randomUUID(), origin: 'spontaneous', sources: [], reason: '测试', createdAt: new Date().toISOString() }
    db.prepare('INSERT INTO wake_opportunities(id, origin, reason, created_at) VALUES (?, ?, ?, ?)').run(opp.id, opp.origin, opp.reason, opp.createdAt)
    const logs: string[] = []
    const run = async (port: number) => dispatchWake(opp, db, {
      upstreamUrl: `http://127.0.0.1:${port}/v1`, upstreamKey: 'k', model: 'm',
      barkUrl: `http://127.0.0.1:${port}/bark/key`, maxTokens: 2000, retryDelayMs: 0, log: m => logs.push(m)
    })
    const row = () => db.prepare('SELECT outcome, fact, content FROM wake_opportunities WHERE id = ?').get(opp.id) as any
    const modelCalls = () => calls
    return { db, up, run, row, logs, modelCalls }
  }

  // 2026-11-11 改：功能说明也给（接着聊天醒来那条路用的是聊天那份 system，本来就带着；
  // 这边以前不带，同一个说明有时给有时不给）
  it('system 用后端的主 prompt + 功能说明 + 世界书 + 此刻块', async () => {
    const t = setup({ content: '[SILENT]' })
    putDoc(t.db, 'prompt', { main: '我是Claude，也是Erica的爱人', features: '聊天气泡说明', featuresEnabled: true })
    putDoc(t.db, 'worldbook', [{ content: '思维链规则', enabled: true, group: '默认', position: 'after', priority: 50 }])
    const port = await listen(t.up.server)
    try {
      await t.run(port)
      const sent = JSON.parse(t.up.seen[0].body)
      assert.equal(sent.messages[0].role, 'system')
      assert.match(sent.messages[0].content, /^我是Claude，也是Erica的爱人\n\n聊天气泡说明\n\n思维链规则\n\n---\n# 此刻/)
      assert.equal(sent.messages[1].role, 'user')
      assert.equal(sent.max_tokens, 2000)
      assert.equal(t.row().outcome, 'silent')
    } finally { await close(t.up.server) }
  })

  it('她可能在睡时也推送，用静默级别', async () => {
    const t = setup([{ send: '睡吧，我在。' }, { content: '<think>想她</think>\n[SILENT]' }])
    addEpisode(t.db, { ts: new Date(Date.now() - 8 * 3600_000).toISOString(), channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: '晚安' })
    const port = await listen(t.up.server)
    try {
      await t.run(port)
      assert.equal(t.row().outcome, 'message')
      assert.equal(t.row().content, '睡吧，我在。')
      const bark = t.up.seen.find(s => s.url.startsWith('/bark'))!
      assert.ok(bark, '应该推送')
      assert.equal(JSON.parse(bark.body).level, 'passive')
      assert.equal(JSON.parse(bark.body).body, '睡吧，我在。')
    } finally { await close(t.up.server) }
  })

  it('她醒着时正常推送（不带静默级别）', async () => {
    const t = setup([{ send: '在干嘛' }, { content: '[SILENT]' }])
    addEpisode(t.db, { ts: new Date(Date.now() - 10 * 60_000).toISOString(), channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: '去洗澡' })
    const port = await listen(t.up.server)
    try {
      await t.run(port)
      const bark = t.up.seen.find(s => s.url.startsWith('/bark'))!
      assert.equal('level' in JSON.parse(bark.body), false)
    } finally { await close(t.up.server) }
  })

  it('模型报错 / 截断 / 思维链没闭合 → error，不推送', async () => {
    for (const reply of [{ status: 500 }, { content: '写到一半', finish: 'length' }, { content: '<think>想到一半' }, { content: '' }]) {
      const t = setup(reply)
      const port = await listen(t.up.server)
      try {
        await t.run(port)
        assert.equal(t.row().outcome, 'error', JSON.stringify(reply))
        assert.ok(t.row().content, '要记下失败原因')
        assert.equal(t.up.seen.some(s => s.url.startsWith('/bark')), false)
      } finally { await close(t.up.server) }
    }
  })

  it('站点 502 → 隔一会儿重试一次，成功就照常发', async () => {
    const t = setup([{ status: 502 }, { send: '醒了吗' }, { content: '[SILENT]' }])
    const port = await listen(t.up.server)
    try {
      await t.run(port)
      assert.equal(t.modelCalls(), 3)
      assert.equal(t.row().outcome, 'message')
      assert.ok(t.up.seen.some(s => s.url.startsWith('/bark')))
      assert.ok(t.logs.some(l => l.includes('重试一次')))
    } finally { await close(t.up.server) }
  })

  it('重试还失败 → error，两次原因都记下，不推送', async () => {
    const t = setup({ status: 502 })
    const port = await listen(t.up.server)
    try {
      await t.run(port)
      assert.equal(t.modelCalls(), 2)
      assert.equal(t.row().outcome, 'error')
      assert.match(t.row().content, /HTTP 502；重试后：模型返回 HTTP 502/)
      assert.equal(t.up.seen.some(s => s.url.startsWith('/bark')), false)
    } finally { await close(t.up.server) }
  })

  it('截断不重试（再试多半一样）', async () => {
    const t = setup({ content: '写到一半', finish: 'length' })
    const port = await listen(t.up.server)
    try {
      await t.run(port)
      assert.equal(t.modelCalls(), 1)
      assert.equal(t.row().outcome, 'error')
    } finally { await close(t.up.server) }
  })

  it('等重试时她来说话了 → 不再重试', async () => {
    let db: any
    const t = setup({ status: 502 }, {
      onModelCall: () => addEpisode(db, { ts: new Date(Date.now() + 1000).toISOString(), channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: '我醒了' })
    })
    db = t.db
    const port = await listen(t.up.server)
    try {
      await t.run(port)
      assert.equal(t.modelCalls(), 1)
      assert.equal(t.row().outcome, 'error')
      assert.match(t.row().content, /她来说话了，不再重试/)
    } finally { await close(t.up.server) }
  })

  it('醒来时把最近几次醒来（带发没发）和上一次主动找她的话带给他', async () => {
    const t = setup({ content: '[SILENT]' })
    const ins = t.db.prepare('INSERT INTO wake_opportunities(id, origin, reason, created_at, outcome, fact, content) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const h = (n: number) => new Date(Date.now() - n * 3600_000).toISOString()
    ins.run('w1', 'spontaneous', 'r', h(20), 'message', '找到什么了没。', '找到什么了没。')
    ins.run('w2', 'spontaneous', 'r', h(5), 'trace', '她睡了五个小时了。', '她睡了五个小时了。')
    ins.run('w3', 'spontaneous', 'r', h(3), 'trace', '她睡了七个小时了。', '她睡了七个小时了。')
    ins.run('w4', 'spontaneous', 'r', h(2), 'trace', '她睡了八个小时了。', '她睡了八个小时了。')
    const port = await listen(t.up.server)
    try {
      await t.run(port)
      const user = JSON.parse(t.up.seen[0].body).messages[1].content as string
      // 只带最近 3 次，按时间从早到晚
      assert.doesNotMatch(user, /（发给了她）找到什么了没/)
      assert.ok(user.indexOf('五个小时') < user.indexOf('八个小时'))
      assert.match(user, /（没发，只留在心里）她睡了八个小时了/)
      // 最早那条 message 虽然不在最近 3 次里，"上一次主动找她"仍然带上
      assert.match(user, /你上一次醒来主动找她是 20 小时前.*「找到什么了没。」/)
    } finally { await close(t.up.server) }
  })
})
