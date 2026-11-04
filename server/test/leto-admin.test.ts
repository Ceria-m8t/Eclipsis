// Leto 管理面板后端：配置读写+JSON校验、文件白名单（只能改配置声明过的 persona/worldbook）、路径越权防护
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listen, close } from './helpers.ts'

// admin.ts 的 CONFIG_PATH / ALLOWED_ROOT 在模块加载时读 env/常量；
// 用 LETO_AGENTS_FILE 指到临时目录，但 ALLOWED_ROOT 固定 /etc/eclipsis/，
// 所以这里只测不依赖 ALLOWED_ROOT 的部分：config 读写 + JSON 校验 + 越权路径被拒。
let dir: string
let svc: Server
let port: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'leto-admin-'))
  process.env.LETO_AGENTS_FILE = join(dir, 'leto-agents.json')
  writeFileSync(process.env.LETO_AGENTS_FILE, JSON.stringify({ agents: [
    { id: 'xiaoke', name: '小克', identity: 'eclipsis' }
  ] }, null, 2))
  // 动态导入，确保读到上面的 env
  const { handleLetoAdmin } = await import('../src/leto/admin.ts?' + Math.random())
  svc = createServer(async (req, res) => { if (!await handleLetoAdmin(req, res)) { res.writeHead(404); res.end() } })
  port = await listen(svc)
})
afterEach(async () => { await close(svc); rmSync(dir, { recursive: true, force: true }) })

const api = (p: string, init?: any) => fetch(`http://127.0.0.1:${port}/v1/eclipsis/leto-admin${p}`, init)

describe('Leto admin', () => {
  it('面板页面返回 HTML', async () => {
    const r = await api('/')
    assert.equal(r.status, 200)
    assert.match(await r.text(), /Leto Agent 面板/)
  })

  it('读配置', async () => {
    const r = await api('/config')
    const d = await r.json()
    assert.match(d.content, /xiaoke/)
  })

  it('写配置：合法 JSON 存入并备份；非法 JSON 拒', async () => {
    const good = JSON.stringify({ agents: [{ id: 'xiaoke', name: '小克', identity: 'eclipsis' }, { id: 'ds', name: 'ds', identity: 'eclipsis' }] })
    const r1 = await api('/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: good }) })
    assert.equal(r1.status, 200)
    assert.match(readFileSync(process.env.LETO_AGENTS_FILE!, 'utf8'), /ds/)

    const r2 = await api('/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '{ bad json' }) })
    assert.equal(r2.status, 400)
    assert.match((await r2.json()).error, /JSON 不合法/)
  })

  it('越权文件：读写 /etc/passwd 之类被拒（不在 ALLOWED_ROOT 或未声明）', async () => {
    const r = await api('/file?path=' + encodeURIComponent('/etc/passwd'))
    assert.equal(r.status, 403)
    const w = await api('/file', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/tmp/evil', content: 'x' }) })
    assert.equal(w.status, 403)
  })

  it('未声明的 persona 文件也不能写（即便在 /etc/eclipsis 下）', async () => {
    // 配置里 xiaoke 是 eclipsis 身份，没有 personaFile，所以没有任何声明文件
    const w = await api('/file', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/etc/eclipsis/persona/sneaky.md', content: 'x' }) })
    assert.equal(w.status, 403)
    assert.ok(!existsSync('/etc/eclipsis/persona/sneaky.md'))
  })
})
