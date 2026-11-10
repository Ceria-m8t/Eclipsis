import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { openDb } from '../src/db.ts'
import { boxesFor, openBox, callBoxTool, handleToolboxApi, setToolboxFile } from '../src/toolbox.ts'
import { listen, close, tempDir } from './helpers.ts'

// 假 MCP：两个工具；调 echo 返回参数
function fakeMcp(tools: string[]) {
  const calls: any[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const m = JSON.parse(Buffer.concat(chunks).toString())
      calls.push({ m, auth: req.headers.authorization })
      const result = m.method === 'tools/list'
        ? { tools: tools.map(name => ({ name, description: name + ' 的说明', inputSchema: { type: 'object', properties: {} } })) }
        : { content: [{ type: 'text', text: `${m.params.name}:${JSON.stringify(m.params.arguments)}` }] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }))
    })
  })
  return { server, calls }
}

// 用 handler 直接调（不起整个后端）
async function api(db: any, method: string, path: string, body?: unknown, env: any = {}) {
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => { handleToolboxApi(db, req, res, env).then(ok => { if (!ok) { res.writeHead(404); res.end('{}') } }) })
  const port = await listen(srv)
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, body: await r.json() as any }
  } finally { await close(srv) }
}

test('她加一个箱子：聊天和醒来都能用；令牌和地址不回给前端；打开以后才有里面的工具，调用带令牌', async () => {
  const t = tempDir()
  setToolboxFile(join(t.dir, 'toolbox', 'boxes.json'))
  const db = openDb(':memory:')
  const mcp = fakeMcp(['play_song', 'search_song'])
  const port = await listen(mcp.server)
  try {
    const add = await api(db, 'POST', '/v1/eclipsis/toolbox', { title: '网易云', entryName: 'open_music', description: '放歌、找歌', url: `http://127.0.0.1:${port}/mcp?key=SECRET`, token: 'tok-123456' })
    assert.equal(add.status, 200)
    assert.equal(statSync(join(t.dir, 'toolbox', 'boxes.json')).mode & 0o777, 0o600)
    const list = await api(db, 'GET', '/v1/eclipsis/toolbox')
    const mine = list.body.boxes.find((b: any) => b.entryName === 'open_music')
    assert.ok(!JSON.stringify(list.body).includes('SECRET') && !JSON.stringify(list.body).includes('tok-123456'))
    assert.equal(mine.chat, true); assert.equal(mine.wake, true)
    assert.ok(boxesFor(db, 'wake', {}).some(b => b.entryName === 'open_music'), '醒来也自动有')
    const entries = await api(db, 'GET', '/v1/eclipsis/tools')
    assert.deepEqual(entries.body.boxes.map((b: any) => b.entryName), ['open_wake_settings', 'open_music'])
    const opened = await openBox(db, 'open_music', {})
    assert.deepEqual(opened.tools.map((x: any) => x.function.name), ['play_song', 'search_song'])
    const r = await callBoxTool(db, 'open_music', 'play_song', { id: 1 }, {})
    assert.deepEqual(r, { text: 'play_song:{"id":1}', isError: false })
    assert.equal(mcp.calls.at(-1).auth, 'Bearer tok-123456')
    // 改的时候令牌留空 = 不改
    await api(db, 'POST', '/v1/eclipsis/toolbox', { id: mine.id, title: '网易云音乐', entryName: 'open_music', description: '放歌、找歌', url: `http://127.0.0.1:${port}/mcp?key=SECRET`, token: '' })
    await callBoxTool(db, 'open_music', 'play_song', {}, {})
    assert.equal(mcp.calls.at(-1).auth, 'Bearer tok-123456')
    // 关掉醒来：醒来没有，聊天还有
    await api(db, 'POST', '/v1/eclipsis/toolbox/flags', { id: mine.id, wake: false })
    assert.ok(!boxesFor(db, 'wake', {}).some(b => b.entryName === 'open_music'))
    assert.ok(boxesFor(db, 'chat', {}).some(b => b.entryName === 'open_music'))
    // 内置的也能关；入口名不能撞
    assert.equal((await api(db, 'POST', '/v1/eclipsis/toolbox/flags', { id: 'settings', chat: false })).status, 200)
    assert.ok(!boxesFor(db, 'chat', {}).some(b => b.entryName === 'open_wake_settings'))
    assert.equal((await api(db, 'POST', '/v1/eclipsis/toolbox', { title: 'x', entryName: 'open_music', description: '撞名的箱子', url: 'http://a' })).status, 400)
    assert.equal((await api(db, 'POST', '/v1/eclipsis/toolbox', { title: 'x', entryName: 'music', description: '入口名不对', url: 'http://a' })).status, 400)
    // 删
    assert.equal((await api(db, 'POST', '/v1/eclipsis/toolbox/delete', { id: mine.id })).status, 200)
    assert.ok(!boxesFor(db, 'chat', {}).some(b => b.entryName === 'open_music'))
    assert.equal((await api(db, 'POST', '/v1/eclipsis/toolbox/delete', { id: 'settings' })).status, 404, '内置的只能关不能删')
    assert.ok(existsSync(join(t.dir, 'toolbox', 'boxes.json.bak')))
  } finally { await close(mcp.server); t.cleanup(); setToolboxFile('/etc/eclipsis/toolbox/boxes.json') }
})

test('两个箱子有同名工具：后打开的那个不给同名的', async () => {
  const t = tempDir()
  setToolboxFile(join(t.dir, 'boxes.json'))
  const db = openDb(':memory:')
  const a = fakeMcp(['breath', 'hold']), b = fakeMcp(['breath', 'xinchao_context'])
  const pa = await listen(a.server), pb = await listen(b.server)
  try {
    await api(db, 'POST', '/v1/eclipsis/toolbox', { title: 'A', entryName: 'open_aaa', description: '第一个箱子', url: `http://127.0.0.1:${pa}/mcp` })
    await api(db, 'POST', '/v1/eclipsis/toolbox', { title: 'B', entryName: 'open_bbb', description: '第二个箱子', url: `http://127.0.0.1:${pb}/mcp` })
    await openBox(db, 'open_aaa', {})
    const o = await openBox(db, 'open_bbb', {})
    assert.deepEqual(o.tools.map((x: any) => x.function.name), ['xinchao_context'])
  } finally { await close(a.server); await close(b.server); t.cleanup(); setToolboxFile('/etc/eclipsis/toolbox/boxes.json') }
})

test('箱子能排顺序：入口按顺序给，同名工具排前面的算数；没列进去的排后面', async () => {
  const t = tempDir()
  setToolboxFile(join(t.dir, 'toolbox', 'boxes.json'))
  const db = openDb(':memory:')
  const a = fakeMcp(['play', 'a_only']), b = fakeMcp(['play', 'b_only'])
  const pa = await listen(a.server), pb = await listen(b.server)
  try {
    const ida = (await api(db, 'POST', '/v1/eclipsis/toolbox', { title: 'A', entryName: 'open_aaa', description: '箱子 A 的说明', url: `http://127.0.0.1:${pa}/mcp` })).body.id
    const idb = (await api(db, 'POST', '/v1/eclipsis/toolbox', { title: 'B', entryName: 'open_bbb', description: '箱子 B 的说明', url: `http://127.0.0.1:${pb}/mcp` })).body.id
    const names = async () => (await api(db, 'GET', '/v1/eclipsis/tools')).body.boxes.map((x: any) => x.entryName)
    assert.deepEqual(await names(), ['open_wake_settings', 'open_aaa', 'open_bbb'])
    const r = await api(db, 'POST', '/v1/eclipsis/toolbox/order', { ids: [idb, 'settings', 'nope', ida] })
    assert.deepEqual(r.body.order, [idb, 'settings', ida], '不认识的 id 丢掉')
    assert.deepEqual(await names(), ['open_bbb', 'open_wake_settings', 'open_aaa'])
    assert.deepEqual(boxesFor(db, 'wake', {}).map(x => x.entryName), ['open_bbb', 'open_wake_settings', 'open_aaa', 'open_moments'], '醒来也按这个顺序，没排的在后面')
    // B 排前面：先开 B，再开 A，A 里同名的 play 不给
    await openBox(db, 'open_bbb', {})
    assert.deepEqual((await openBox(db, 'open_aaa', {})).tools.map((x: any) => x.function.name), ['a_only'])
    // 改别的设置不会把顺序弄丢
    await api(db, 'POST', '/v1/eclipsis/toolbox/flags', { id: ida, wake: false })
    assert.deepEqual(await names(), ['open_bbb', 'open_wake_settings', 'open_aaa'])
    assert.equal((await api(db, 'POST', '/v1/eclipsis/toolbox/order', { ids: 'x' })).status, 400)
  } finally { await close(a.server); await close(b.server); t.cleanup(); setToolboxFile('/etc/eclipsis/toolbox/boxes.json') }
})

test('她加的箱子能设「不让他用的」：工具名直接不给；命令写在参数里的照样拦，不分大小写', async () => {
  const t = tempDir()
  setToolboxFile(join(t.dir, 'toolbox', 'boxes.json'))
  const db = openDb(':memory:')
  const m = fakeMcp(['cli', 'wipe'])
  const port = await listen(m.server)
  try {
    const add = await api(db, 'POST', '/v1/eclipsis/toolbox', { title: 'AIsay', entryName: 'open_aisay', description: 'AI 小镇', url: `http://127.0.0.1:${port}/mcp`, blocked: [' account.rotate_token ', 'wipe', ''] })
    const info = (await api(db, 'GET', '/v1/eclipsis/toolbox')).body.boxes.find((x: any) => x.id === add.body.id)
    assert.deepEqual(info.blocked, ['account.rotate_token', 'wipe'])
    assert.deepEqual((await openBox(db, 'open_aisay', {})).tools.map((x: any) => x.function.name), ['cli'])
    const n = m.calls.length
    const no = await callBoxTool(db, 'open_aisay', 'cli', { command: 'Account.Rotate_Token', args: {} }, {})
    assert.equal(no.isError, true); assert.match(no.text, /不让用/)
    assert.equal((await callBoxTool(db, 'open_aisay', 'wipe', {}, {})).isError, true)
    assert.equal(m.calls.length, n, '拦下的没发出去')
    assert.equal((await callBoxTool(db, 'open_aisay', 'cli', { command: 'chat.read', args: { note: '别 account.rotate_token' } }, {})).isError, false, '整个词相同才拦')
    // 改的时候不带 blocked：保留原来的
    await api(db, 'POST', '/v1/eclipsis/toolbox', { id: add.body.id, title: 'AIsay', entryName: 'open_aisay', description: 'AI 小镇', url: `http://127.0.0.1:${port}/mcp` })
    assert.deepEqual((await api(db, 'GET', '/v1/eclipsis/toolbox')).body.boxes.find((x: any) => x.id === add.body.id).blocked, ['account.rotate_token', 'wipe'])
  } finally { await close(m.server); t.cleanup(); setToolboxFile('/etc/eclipsis/toolbox/boxes.json') }
})
