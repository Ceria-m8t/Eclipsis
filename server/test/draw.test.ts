import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { openDb } from '../src/db.ts'
import { BlobStore } from '../src/blobs.ts'
import { drawWith, draw, recordHisImage } from '../src/draw.ts'
import { setImageStationFile, saveImageStation, switchImageStation, listImageStations, currentImageStation, deleteImageStation } from '../src/image-station.ts'
import { handleStationsApi } from '../src/stations-api.ts'
import { resetStationsForTest } from '../src/station.ts'
import { drawBox } from '../src/wake/draw-box.ts'
import { listen, close, tempDir } from './helpers.ts'

// 1×1 的 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')

function fakeStation(handler: (path: string, body: any, res: ServerResponse) => void) {
  return createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      let body: any = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch {}
      handler(new URL(req.url || '/', 'http://x').pathname, body, res)
    })
  })
}
const ok = (res: ServerResponse, body: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

function setup() {
  const t = tempDir()
  setImageStationFile(join(t.dir, 'image-stations.json'))
  resetStationsForTest(join(t.dir, 'stations.json'))     // 别读服务器上真的那份
  const db = openDb(':memory:')
  const blobs = new BlobStore(db, join(t.dir, 'blobs'))
  return { t, db, blobs, cleanup: () => { t.cleanup(); setImageStationFile('/etc/eclipsis/stations/image-stations.json') } }
}

test('images 接口：b64_json 的图存下来', async () => {
  const s = setup()
  const srv = fakeStation((p, b, res) => {
    assert.equal(p, '/v1/images/generations')
    assert.equal(b.prompt, '一只小螃蟹')
    assert.equal(b.size, '1024x1024')
    ok(res, { data: [{ b64_json: PNG.toString('base64'), revised_prompt: '一只很小的像素螃蟹' }] })
  })
  const port = await listen(srv)
  try {
    const st = saveImageStation({ name: '站一', url: `http://127.0.0.1:${port}/v1`, key: 'k1', model: 'img-1', size: '1024x1024', mode: 'images' })
    const r = await drawWith(st, '一只小螃蟹')
    assert.equal(r.mode, 'images')
    assert.equal(r.mime, 'image/png')
    assert.equal(r.revised, '一只很小的像素螃蟹')
    // 存进 blobs，能当图片用
    const d = await draw(s.db, s.blobs, '一只小螃蟹')
    assert.match(d.url, /^\/api\/eclipsis\/blob\/[0-9a-f]{64}$/)
    assert.equal(s.blobs.readFile(d.hash)!.length, PNG.length)
  } finally { await close(srv); s.cleanup() }
})

test('图片直链也认；chat 接口返图也认', async () => {
  const s = setup()
  const srv = fakeStation((p, _b, res) => {
    if (p === '/img/a.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return }
    if (p === '/v1/images/generations') return ok(res, { data: [{ url: `http://127.0.0.1:${PORT}/img/a.png` }] })
    if (p === '/v1/chat/completions') return ok(res, {
      choices: [{ message: { role: 'assistant', content: [{ type: 'text', text: '给你画好了' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }] } }],
    })
    res.writeHead(404); res.end('{}')
  })
  const PORT = await listen(srv)
  try {
    const a = saveImageStation({ name: '直链站', url: `http://127.0.0.1:${PORT}/v1`, key: 'k', mode: 'images' })
    assert.equal((await drawWith(a, 'x')).data.length, PNG.length)
    const b = saveImageStation({ name: '聊天站', url: `http://127.0.0.1:${PORT}/v1`, key: 'k', model: 'gemini-image', mode: 'chat' })
    const r = await drawWith(b, 'x')
    assert.equal(r.mode, 'chat')
    assert.equal(r.data.length, PNG.length)
  } finally { await close(srv); s.cleanup() }
})

test('mode=auto：images 不行就自动换 chat；两种都不行把两边的原因都说出来', async () => {
  const s = setup()
  const srv = fakeStation((p, _b, res) => {
    if (p === '/v1/images/generations') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"no such endpoint"}'); return }
    if (p === '/v1/chat/completions') return ok(res, { choices: [{ message: { content: `data:image/png;base64,${PNG.toString('base64')}` } }] })
    res.writeHead(404); res.end('{}')
  })
  const port = await listen(srv)
  try {
    const st = saveImageStation({ name: 'auto', url: `http://127.0.0.1:${port}/v1`, key: 'k', model: 'm', mode: 'auto' })
    assert.equal((await drawWith(st, 'x')).mode, 'chat')
    const dead = saveImageStation({ name: '都不行', url: `http://127.0.0.1:${port}/nope`, key: 'k', model: 'm', mode: 'auto' })
    await assert.rejects(() => drawWith(dead, 'x'), /两种调法都不行/)
  } finally { await close(srv); s.cleanup() }
})

test('画图的站：存、切、删、密钥不回前端', async () => {
  const s = setup()
  try {
    const a = saveImageStation({ name: '甲', url: 'https://a.test/v1', key: 'secret-a', model: 'm1' })
    const b = saveImageStation({ name: '乙', url: 'https://b.test/v1', key: 'secret-b', model: 'm2', size: '1024x1536' })
    const list = listImageStations()
    assert.equal(list.active, a.id, '第一个存的自动变成正在用的')
    assert.ok(!JSON.stringify(list).includes('secret-a'))
    assert.equal(currentImageStation()!.key, 'secret-a')
    switchImageStation(b.id)
    assert.equal(currentImageStation()!.name, '乙')
    // 改的时候密钥留空 = 不改
    saveImageStation({ id: b.id, name: '乙二', url: 'https://b.test/v1' })
    assert.equal(currentImageStation()!.key, 'secret-b')
    assert.equal(currentImageStation()!.name, '乙二')
    // 删掉正在用的：自动换到剩下的那个
    deleteImageStation(b.id)
    assert.equal(currentImageStation()!.id, a.id)
    assert.throws(() => saveImageStation({ name: '坏的', url: 'ftp://x', key: 'k' }), /http/)
    assert.throws(() => saveImageStation({ name: '坏尺寸', url: 'https://x.test', key: 'k', size: '大' }), /尺寸/)
  } finally { s.cleanup() }
})

test('他的画笔：画完直接记成他的消息；没配站就没有这个箱子', async () => {
  const s = setup()
  const srv = fakeStation((_p, _b, res) => ok(res, { data: [{ b64_json: PNG.toString('base64') }] }))
  const port = await listen(srv)
  try {
    assert.equal(drawBox(s.db, s.blobs), null, '没配画图的站 → 没有画笔')
    saveImageStation({ name: '站', url: `http://127.0.0.1:${port}/v1`, key: 'k', mode: 'images' })
    const box = drawBox(s.db, s.blobs)!
    assert.equal(box.entryName, 'open_brush')
    assert.deepEqual((await box.listTools()).map(t => t.name), ['draw_picture'])
    const r = await box.call('draw_picture', { prompt: '我们家的猫' })
    assert.equal(r.isError, false)
    assert.match(r.text, /画好了/)
    const ep = s.db.prepare(`SELECT content, meta FROM episodes WHERE actor = 'ai' ORDER BY seq DESC LIMIT 1`).get() as any
    assert.equal(ep.content, '[图片]')
    const meta = JSON.parse(ep.meta)
    assert.equal(meta.drawn, true)
    assert.equal(meta.prompt, '我们家的猫')
    assert.equal(meta.images.length, 1)
    assert.equal((await box.call('draw_picture', { prompt: '' })).isError, true)
    assert.equal((await box.call('什么工具', {})).isError, true)
  } finally { await close(srv); s.cleanup() }
})

test('站接口：聊天的站和画图的站各自一套，密钥打码', async () => {
  const s = setup()
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleStationsApi(s.db, req, res).then(okk => { if (!okk) { res.writeHead(404); res.end('{}') } })
  })
  const port = await listen(srv)
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    })
    return { status: r.status, body: await r.json() as any }
  }
  try {
    const add = await call('POST', '/v1/eclipsis/stations?kind=image', { name: '画图站', url: 'https://img.test/v1', key: 'img-secret', model: 'sd', mode: 'images' })
    assert.equal(add.status, 200)
    const list = await call('GET', '/v1/eclipsis/stations?kind=image')
    assert.equal(list.body.stations[0].name, '画图站')
    assert.ok(!JSON.stringify(list.body).includes('img-secret'))
    assert.equal(list.body.active, add.body.id)
    // 聊天的站是另一套，不受影响
    const chat = await call('GET', '/v1/eclipsis/stations')
    assert.deepEqual(chat.body.stations, [])
    // 切到一个不存在的站
    assert.equal((await call('POST', '/v1/eclipsis/stations/switch?kind=image', { id: 'nope' })).status, 400)
    assert.equal((await call('POST', '/v1/eclipsis/stations/delete?kind=image', { id: add.body.id })).status, 200)
    assert.deepEqual((await call('GET', '/v1/eclipsis/stations?kind=image')).body.stations, [])
  } finally { await close(srv); s.cleanup() }
})

test('recordHisImage：醒来时画的挂在那次醒来上', () => {
  const s = setup()
  try {
    recordHisImage(s.db, 'a'.repeat(64), { prompt: '夜里的海', wakeId: 'w9' })
    const ep = s.db.prepare(`SELECT channel, meta FROM episodes ORDER BY seq DESC LIMIT 1`).get() as any
    assert.equal(ep.channel, 'wake')
    assert.equal(JSON.parse(ep.meta).wake_id, 'w9')
  } finally { s.cleanup() }
})
