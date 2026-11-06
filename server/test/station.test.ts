// 换站：存几个站、点一下就切，不用重启；切站后模型怎么选
import { describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { openDb, type DB } from '../src/db.ts'
import { loadConfig, type Config } from '../src/config.ts'
import { buildServers } from '../src/main.ts'
import { handleLetoAdmin } from '../src/leto/admin.ts'
import {
  resetStationsForTest, currentStation, saveStation, switchStation, deleteStation, listStations,
  bindStationToConfig, chooseModel, findStation
} from '../src/station.ts'
import { fakeUpstream, listen, close, tempDir } from './helpers.ts'

const tmp = tempDir()
after(() => tmp.cleanup())
let file = ''
let n = 0
beforeEach(() => {
  file = join(tmp.dir, `stations-${++n}.json`)
  resetStationsForTest(file, { url: 'https://old.example/v1', key: 'old-key-123456' })
})

describe('存站 / 切站', () => {
  it('没存过：用 backend.env 那个；第一次存时把它也存进来叫「原来的站」，还用它', () => {
    assert.equal(currentStation().url, 'https://old.example/v1')
    assert.equal(existsSync(file), false)
    const s = saveStation({ name: '神秘破甲', url: 'https://new.example/v1/', key: 'new-key-abcdef', defaultModel: '[神秘破甲]claude-opus-4-6' })
    const f = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(f.active, 'env')
    assert.deepEqual(f.stations.map((x: any) => x.name), ['原来的站（backend.env）', '神秘破甲'])
    assert.equal(findStation(s.id)!.url, 'https://new.example/v1', '末尾的 / 去掉')
    assert.equal(currentStation().url, 'https://old.example/v1')
    assert.equal(statSync(file).mode & 0o777, 0o600, '密钥文件只有 root 能读')
  })

  it('切过去立刻生效；绑定过的 cfg 每次读都是现在的站；能切回去', () => {
    const cfg = { upstreamUrl: 'x', upstreamKey: 'y' }
    bindStationToConfig(cfg)
    assert.equal(cfg.upstreamUrl, 'https://old.example/v1')
    const s = saveStation({ name: 'B', url: 'https://b.example/v1', key: 'kb-0000000' })
    switchStation(s.id)
    assert.equal(cfg.upstreamUrl, 'https://b.example/v1')
    assert.equal(cfg.upstreamKey, 'kb-0000000')
    switchStation('env')
    assert.equal(cfg.upstreamUrl, 'https://old.example/v1')
  })

  it('修改时密钥留空 = 不改；面板上看到的密钥打码', () => {
    const s = saveStation({ name: 'B', url: 'https://b.example/v1', key: 'secret-key-9999' })
    saveStation({ id: s.id, name: 'B2', url: 'https://b2.example/v1', key: '' })
    assert.equal(findStation(s.id)!.key, 'secret-key-9999')
    assert.equal(findStation(s.id)!.name, 'B2')
    const view = listStations()
    assert.ok(view.stations.every(x => !x.key.includes('secret-key')))
    assert.equal(view.stations.find(x => x.id === s.id)!.key, 'secr…9999')
  })

  it('正在用的不能删；地址不对、没密钥都报错', () => {
    const s = saveStation({ name: 'B', url: 'https://b.example/v1', key: 'kb-0000000' })
    switchStation(s.id)
    assert.throws(() => deleteStation(s.id), /正在用的站不能删/)
    deleteStation('env')
    assert.equal(listStations().stations.length, 1)
    assert.throws(() => saveStation({ name: 'C', url: 'ftp://x', key: 'k' }), /http/)
    assert.throws(() => saveStation({ name: 'C', url: 'https://c.example', key: '' }), /密钥/)
  })
})

describe('切站后用哪个模型', () => {
  const addEx = (db: DB, model: string, at: string) =>
    db.prepare(`INSERT INTO exchanges(rid, tap, started_at, status, path, model) VALUES (?, 'upstream', ?, 'ok', '/v1/chat/completions', ?)`).run(crypto.randomUUID(), at, model)

  it('切站后还没聊过 → 新站的默认模型；聊过了 → 跟着聊天；新站没填默认 → 还用聊天的', () => {
    const db = openDb(':memory:')
    addEx(db, 'old-model', '2026-11-07T01:00:00.000Z')
    assert.equal(chooseModel(db), 'old-model')
    const s = saveStation({ name: 'B', url: 'https://b.example/v1', key: 'kb-0000000', defaultModel: 'b-model' })
    switchStation(s.id, new Date('2026-11-07T02:00:00.000Z'))
    assert.equal(chooseModel(db), 'b-model')
    addEx(db, '[B]opus', '2026-11-07T02:05:00.000Z')
    assert.equal(chooseModel(db), '[B]opus')

    const s2 = saveStation({ name: 'C', url: 'https://c.example/v1', key: 'kc-0000000' })
    switchStation(s2.id, new Date('2026-11-07T03:00:00.000Z'))
    assert.equal(chooseModel(db), '[B]opus')
  })
})

describe('上游入口不重启就跟着换', () => {
  it('切站后下一条聊天请求就发到新站、用新站的密钥', async () => {
    const a = fakeUpstream((_r, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[{"message":{"content":"A"},"finish_reason":"stop"}]}') })
    const b = fakeUpstream((_r, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[{"message":{"content":"B"},"finish_reason":"stop"}]}') })
    const pa = await listen(a.server), pb = await listen(b.server)
    resetStationsForTest(file, { url: `http://127.0.0.1:${pa}/v1`, key: 'key-a-000000' })
    const cfg: Config = { ...loadConfig({}), tapKey: 'tk', dbPath: ':memory:', blobDir: tmp.dir }
    bindStationToConfig(cfg)
    const db = openDb(':memory:')
    const { front, tap } = buildServers(cfg, db, {})
    const tp = await listen(tap)
    const ask = async () => (await (await fetch(`http://127.0.0.1:${tp}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tk' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: '在吗' }] })
    })).json()).choices[0].message.content
    try {
      assert.equal(await ask(), 'A')
      const s = saveStation({ name: 'B', url: `http://127.0.0.1:${pb}/v1`, key: 'key-b-000000' })
      switchStation(s.id)
      assert.equal(await ask(), 'B')
      assert.equal(b.seen[0].headers.authorization, 'Bearer key-b-000000')
    } finally {
      await close(tap); front.close(); await close(a.server); await close(b.server)
    }
  })
})

describe('管理面板的换站接口', () => {
  async function panel() {
    const srv = createServer((req, res) => { void handleLetoAdmin(req, res) })
    const port = await listen(srv)
    const call = (method: string, route: string, body?: any) => fetch(`http://127.0.0.1:${port}/v1/eclipsis/leto-admin/${route}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
    }).then(async r => ({ status: r.status, data: await r.json() as any }))
    return { call, done: () => close(srv) }
  }

  it('存 → 列（打码）→ 切 → 正在用的不能删', async () => {
    const p = await panel()
    try {
      const saved = await p.call('PUT', 'stations', { name: '晚舟', url: 'https://wz.example/v1', key: 'wz-key-123456', defaultModel: 'claude-opus-4-6' })
      assert.equal(saved.status, 200)
      const list = await p.call('GET', 'stations')
      assert.equal(list.data.active, 'env')
      assert.equal(list.data.stations.length, 2)
      assert.ok(!JSON.stringify(list.data).includes('wz-key-123456'))
      const sw = await p.call('POST', 'stations/switch', { id: saved.data.id })
      assert.equal(sw.data.current.name, '晚舟')
      assert.equal(currentStation().url, 'https://wz.example/v1')
      const del = await p.call('DELETE', `stations?id=${saved.data.id}`)
      assert.equal(del.status, 500)
      assert.match(del.data.error, /正在用的站不能删/)
    } finally { await p.done() }
  })

  it('用存着的密钥列模型、自检（不用再输密钥）', async () => {
    const st = fakeUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (req.url.endsWith('/models')) { res.end('{"data":[{"id":"b"},{"id":"a"}]}'); return }
      res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'get_time', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }))
    })
    const sp = await listen(st.server)
    const p = await panel()
    try {
      const saved = await p.call('PUT', 'stations', { name: 'T', url: `http://127.0.0.1:${sp}/v1`, key: 'tk-0000000', defaultModel: 'a' })
      const models = await p.call('POST', 'stations/models', { id: saved.data.id })
      assert.deepEqual(models.data.models, ['a', 'b'])
      const test = await p.call('POST', 'stations/test', { id: saved.data.id })
      assert.equal(test.data.ok, true)
      assert.equal(st.seen.at(-1)!.headers.authorization, 'Bearer tk-0000000')
    } finally { await p.done(); await close(st.server) }
  })
})
