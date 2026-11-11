// 他顶栏的状态搬到后端（2026-11-11）：存取、「此刻」里那一行、工具、HTTP、醒来时能改
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { openDb } from '../src/db.ts'
import {
  ensureStatusSchema, getStatus, setStatus, clearStatus, renderStatusLine,
  runStatusTool, handleStatusApi, STATUS_TOOL
} from '../src/status.ts'
import { assembleSceneBlock } from '../src/assembler/index.ts'
import { runWakeAgent } from '../src/wake/agent.ts'
import type { ModelResponse, ToolCall } from '../src/leto/responder.ts'
import { listen, close } from './helpers.ts'

function freshDb() {
  const db = openDb(':memory:')
  ensureStatusSchema(db)
  return db
}

describe('存取', () => {
  it('没设过就是 null', () => {
    assert.equal(getStatus(freshDb()), null)
  })

  it('设了能读回来，再设是覆盖不是新增', () => {
    const db = freshDb()
    setStatus(db, { emoji: '☕', text: '在厨房泡茶' })
    assert.deepEqual(
      (({ emoji, text, source }) => ({ emoji, text, source }))(getStatus(db)!),
      { emoji: '☕', text: '在厨房泡茶', source: 'chat' }
    )
    setStatus(db, { emoji: '💤', text: '有点困', source: 'wake' })
    assert.equal(getStatus(db)!.text, '有点困')
    assert.equal(getStatus(db)!.source, 'wake')
    assert.equal((db.prepare('SELECT count(*) n FROM ai_status').get() as { n: number }).n, 1)
  })

  it('文字截到 24 字、表情截到 8 字、换行压成空格', () => {
    const db = freshDb()
    const s = setStatus(db, { emoji: 'x'.repeat(20), text: '啊\n哦  噢' + '长'.repeat(40) })!
    assert.equal(s.emoji.length, 8)
    assert.equal(s.text.length, 24)
    assert.ok(s.text.startsWith('啊 哦 噢'))
  })

  it('text 空的时候不动原来那个（清空只走 clear）', () => {
    const db = freshDb()
    setStatus(db, { emoji: '☕', text: '在泡茶' })
    assert.equal(setStatus(db, { text: '   ' }), null)
    assert.equal(setStatus(db, { emoji: '💤' }), null)
    assert.equal(getStatus(db)!.text, '在泡茶')
  })

  it('clearStatus 清干净', () => {
    const db = freshDb()
    setStatus(db, { emoji: '☕', text: '在泡茶' })
    clearStatus(db)
    assert.equal(getStatus(db), null)
  })
})

describe('「此刻」里那一行', () => {
  it('没挂状态时明说没挂，并提一下工具名', () => {
    const line = renderStatusLine(freshDb())
    assert.match(line, /没挂状态/)
    assert.match(line, new RegExp(STATUS_TOOL))
  })

  it('挂着的话写出来 + 多久以前设的', () => {
    const db = freshDb()
    const now = new Date('2026-11-11T10:00:00Z')
    setStatus(db, { emoji: '☕', text: '在厨房泡茶' }, new Date('2026-11-11T07:00:00Z'))
    const line = renderStatusLine(db, now)
    assert.match(line, /☕ 在厨房泡茶/)
    assert.match(line, /3 小时前/)
  })

  it('刚刚 / 分钟 / 天 都说得对', () => {
    const db = freshDb()
    const now = new Date('2026-11-11T10:00:00Z')
    const at = (iso: string) => { setStatus(db, { emoji: '', text: 'x' }, new Date(iso)); return renderStatusLine(db, now) }
    assert.match(at('2026-11-11T09:59:30Z'), /刚刚/)
    assert.match(at('2026-11-11T09:30:00Z'), /30 分钟前/)
    assert.match(at('2026-11-09T10:00:00Z'), /2 天前/)
  })

  it('醒着的时候设的，写明是醒着设的', () => {
    const db = freshDb()
    setStatus(db, { emoji: '🌙', text: '等她睡', source: 'wake' })
    assert.match(renderStatusLine(db), /醒着的时候设的/)
  })

  it('进了「此刻」块', () => {
    const db = freshDb()
    setStatus(db, { emoji: '📖', text: '窝在书房看书' })
    const r = assembleSceneBlock(db)
    assert.match(r.sceneBlock, /# 此刻/)
    assert.match(r.sceneBlock, /📖 窝在书房看书/)
    assert.ok(r.meta.statusLine)
  })

  it('没有 ai_status 表也不炸（老库启动前）', () => {
    const db = openDb(':memory:')
    assert.equal(renderStatusLine(db), '')
    assert.doesNotThrow(() => assembleSceneBlock(db))
  })
})

describe('工具', () => {
  it('设置', () => {
    const db = freshDb()
    const out = runStatusTool(db, { emoji: '☕', text: '在厨房泡茶' }, 'chat')
    assert.match(out, /☕ 在厨房泡茶/)
    assert.equal(getStatus(db)!.text, '在厨房泡茶')
  })

  it('clear=true 清空', () => {
    const db = freshDb()
    setStatus(db, { emoji: '☕', text: '在泡茶' })
    assert.match(runStatusTool(db, { clear: true }, 'chat'), /清空/)
    assert.equal(getStatus(db), null)
  })

  it('text 空了要报错，不是悄悄清掉', () => {
    const db = freshDb()
    setStatus(db, { emoji: '☕', text: '在泡茶' })
    assert.throws(() => runStatusTool(db, { emoji: '☕' }, 'chat'), /text 不能为空/)
    assert.equal(getStatus(db)!.text, '在泡茶')
  })
})

describe('HTTP', () => {
  async function serve(db: any) {
    const server = createServer(async (req, res) => {
      if (!(await handleStatusApi(db, req, res))) { res.writeHead(404); res.end('no') }
    })
    const port = await listen(server)
    return { server, base: `http://127.0.0.1:${port}/v1/eclipsis/status` }
  }

  it('GET 读、POST 写、POST clear 清', async () => {
    const db = freshDb()
    const { server, base } = await serve(db)
    try {
      assert.equal((await (await fetch(base)).json()).status, null)

      const post = (body: unknown) => fetch(base, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      })
      const w = await (await post({ emoji: '☕', text: '在厨房泡茶' })).json()
      assert.equal(w.status.text, '在厨房泡茶')
      assert.equal(w.status.source, 'chat')
      assert.equal((await (await fetch(base)).json()).status.emoji, '☕')

      assert.equal((await (await post({ clear: true })).json()).status, null)
      assert.equal(getStatus(db), null)
    } finally { await close(server) }
  })

  it('text 空给 400，别的路径不接', async () => {
    const db = freshDb()
    const { server, base } = await serve(db)
    try {
      const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      assert.equal(r.status, 400)
      assert.equal((await fetch(base.replace('/status', '/statuses'))).status, 404)
      assert.equal((await fetch(base, { method: 'DELETE' })).status, 405)
    } finally { await close(server) }
  })
})

describe('醒来时', () => {
  const call = (name: string, args: Record<string, unknown>): ToolCall =>
    ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } })
  const say = (content: string, toolCalls: ToolCall[] = []): ModelResponse =>
    ({ content, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : 'stop' })

  function scripted(replies: ModelResponse[]) {
    const seenTools: string[][] = []
    let i = 0
    return {
      seenTools,
      callModel: async (_m: any[], tools: any[]) => {
        seenTools.push(tools.map(t => t.function.name))
        return { ok: true as const, resp: replies[Math.min(i++, replies.length - 1)] }
      }
    }
  }

  it('手边就有这个工具（不用先开箱子），改的是后端那一份', async () => {
    const db = freshDb()
    const { callModel, seenTools } = scripted([say('', [call(STATUS_TOOL, { emoji: '🌙', text: '等她睡' })]), say('改好了')])
    const r = await runWakeAgent([{ role: 'user', content: '醒了' }], {
      boxes: [], callModel, send: async () => ({ ok: true }),
      setStatus: args => runStatusTool(db, args, 'wake')
    })
    assert.ok(seenTools[0].includes(STATUS_TOOL))
    assert.deepEqual(r.toolsUsed, [STATUS_TOOL])
    assert.equal(getStatus(db)!.text, '等她睡')
    assert.equal(getStatus(db)!.source, 'wake')
  })

  it('不给 setStatus 时没有这个工具', async () => {
    const { callModel, seenTools } = scripted([say('不改')])
    await runWakeAgent([{ role: 'user', content: '醒了' }], { boxes: [], callModel, send: async () => ({ ok: true }) })
    assert.ok(!seenTools[0].includes(STATUS_TOOL))
  })

  it('参数不对只回一句，不中断这次醒来', async () => {
    const db = freshDb()
    const { callModel } = scripted([say('', [call(STATUS_TOOL, { emoji: '🌙' })]), say('那就不改')])
    const r = await runWakeAgent([{ role: 'user', content: '醒了' }], {
      boxes: [], callModel, send: async () => ({ ok: true }),
      setStatus: args => runStatusTool(db, args, 'wake')
    })
    assert.equal(r.finalText, '那就不改')
    assert.equal(getStatus(db), null)
  })
})
