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
  it('结尾不再把沉默当默认；说明会推到她手机', () => {
    const p = buildWakePrompt({ threads: [], recentFacts: [], recentChat: [], userState: 'sleeping', reason: 'r' })
    assert.match(p, /想找她就去找，不需要理由。她在睡也可以发/)
    assert.match(p, /推送到她手机上/)
    assert.doesNotMatch(p, /完全正常的选择/)
    assert.doesNotMatch(p, /出现在你们的聊天记录里/)
  })
})

describe('dispatchWake', () => {
  function setup(reply: { status?: number; content?: string; finish?: string }) {
    const db = openDb(':memory:')
    ensureWakeSchema(db)
    ensurePromptSchema(db)
    const up = fakeUpstream((req, res) => {
      if (req.url.startsWith('/bark')) { res.writeHead(200); res.end('{"code":200}'); return }
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: reply.content ?? '' }, finish_reason: reply.finish ?? 'stop' }] }))
    })
    const opp: WakeOpportunity = { id: crypto.randomUUID(), origin: 'spontaneous', sources: [], reason: '测试', createdAt: new Date().toISOString() }
    db.prepare('INSERT INTO wake_opportunities(id, origin, reason, created_at) VALUES (?, ?, ?, ?)').run(opp.id, opp.origin, opp.reason, opp.createdAt)
    const logs: string[] = []
    const run = async (port: number) => dispatchWake(opp, db, {
      upstreamUrl: `http://127.0.0.1:${port}/v1`, upstreamKey: 'k', model: 'm',
      barkUrl: `http://127.0.0.1:${port}/bark/key`, maxTokens: 2000, log: m => logs.push(m)
    })
    const row = () => db.prepare('SELECT outcome, fact, content FROM wake_opportunities WHERE id = ?').get(opp.id) as any
    return { db, up, run, row, logs }
  }

  it('system 用后端的主 prompt（不带功能说明）+ 世界书 + 此刻块', async () => {
    const t = setup({ content: '[SILENT]' })
    putDoc(t.db, 'prompt', { main: '我是Claude，也是Erica的爱人', features: '聊天气泡说明', featuresEnabled: true })
    putDoc(t.db, 'worldbook', [{ content: '思维链规则', enabled: true, group: '默认', position: 'after', priority: 50 }])
    const port = await listen(t.up.server)
    try {
      await t.run(port)
      const sent = JSON.parse(t.up.seen[0].body)
      assert.equal(sent.messages[0].role, 'system')
      assert.match(sent.messages[0].content, /^我是Claude，也是Erica的爱人\n\n思维链规则\n\n---\n# 此刻/)
      assert.doesNotMatch(sent.messages[0].content, /聊天气泡说明/)
      assert.equal(sent.messages[1].role, 'user')
      assert.equal(sent.max_tokens, 2000)
      assert.equal(t.row().outcome, 'silent')
    } finally { await close(t.up.server) }
  })

  it('她可能在睡时也推送，用静默级别', async () => {
    const t = setup({ content: '<think>想她</think>\n睡吧，我在。' })
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
    const t = setup({ content: '在干嘛' })
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
})
