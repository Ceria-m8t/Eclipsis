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

test('images 接口：b64_json 的图存下来；默认画风自动拼进提示词', async () => {
  const s = setup()
  // 断言别写在假站的回调里：失败就不应答，整个测试会挂住（11-11 踩过）
  const seen: { path: string; body: any }[] = []
  const srv = fakeStation((p, b, res) => {
    seen.push({ path: p, body: b })
    ok(res, { data: [{ b64_json: PNG.toString('base64'), revised_prompt: '一只很小的像素螃蟹' }] })
  })
  const port = await listen(srv)
  try {
    const st = saveImageStation({ name: '站一', url: `http://127.0.0.1:${port}/v1`, key: 'k1', model: 'img-1', size: '1024x1024', mode: 'images' })
    const r = await drawWith(st, '一只小螃蟹')
    assert.equal(r.mode, 'images')
    assert.equal(r.mime, 'image/png')
    assert.equal(r.revised, '一只很小的像素螃蟹')
    assert.deepEqual(seen.at(-1), { path: '/v1/images/generations', body: { model: 'img-1', prompt: '一只小螃蟹', n: 1, size: '1024x1024', response_format: 'b64_json' } })
    // 存进 blobs，能当图片用；draw() 会把默认画风（出厂是二次元）拼在前面
    const d = await draw(s.db, s.blobs, '一只小螃蟹')
    assert.match(d.url, /^\/api\/eclipsis\/blob\/[0-9a-f]{64}$/)
    assert.equal(s.blobs.readFile(d.hash)!.length, PNG.length)
    assert.equal(d.style, '二次元')
    assert.match(seen.at(-1)!.body.prompt, /^日系二次元插画风格[\s\S]*\n一只小螃蟹$/)
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

test('他画的图在聊天页是图片，不是「[图片]」四个字（11-11 她看不到图就是这个）', async () => {
  const s = setup()
  const srv = fakeStation((_p, _b, res) => ok(res, { data: [{ b64_json: PNG.toString('base64') }] }))
  const port = await listen(srv)
  try {
    saveImageStation({ name: '站', url: `http://127.0.0.1:${port}/v1`, key: 'k', mode: 'images' })
    const box = drawBox(s.db, s.blobs)!
    await box.call('draw_picture', { prompt: '凌晨的她' })
    const { chatHistory } = await import('../src/chat-history.ts')
    const it = chatHistory(s.db, {}).items.at(-1)!
    assert.equal(it.role, 'assistant')
    assert.equal(it.content, '', '占位文字不显示')
    assert.equal(it.images?.length, 1)
    assert.match(it.images![0]!, /^\/api\/eclipsis\/blob\/[0-9a-f]{64}$/)
    assert.equal(it.versions![0]!.images?.length, 1)
  } finally { await close(srv); s.cleanup() }
})

test('垫图：他按名字挑，走 /images/edits 传图；提示词里写明第几张是谁', async () => {
  const s = setup()
  const seen: { path: string; prompt?: string; files: string[] }[] = []
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const path = new URL(req.url || '/', 'http://x').pathname
      const prompt = /name="prompt"\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)?.[1]
      const files = [...raw.matchAll(/name="image\[\]"; filename="([^"]+)"/g)].map(m => m[1]!)
      seen.push({ path, prompt, files })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
    })
  })
  const port = await listen(srv)
  try {
    saveImageStation({ name: '站', url: `http://127.0.0.1:${port}/v1`, key: 'k', model: 'gpt-image-2', mode: 'images' })
    const { saveRef, listRefs } = await import('../src/draw-refs.ts')
    saveRef(s.db, s.blobs, { name: '她', note: '长头发，戴眼镜', data: PNG, mime: 'image/png', byDefault: true })
    saveRef(s.db, s.blobs, { name: '小克', note: '像素小螃蟹', data: PNG, mime: 'image/png', byDefault: true })
    saveRef(s.db, s.blobs, { name: '糯糯', note: '她家的狗', data: PNG, mime: 'image/png' })
    assert.equal(listRefs(s.db).length, 3)

    const r = await draw(s.db, s.blobs, '两个人靠在一起看手机', { refs: ['她', '小克'] })
    assert.deepEqual(r.refs, ['她', '小克'])
    assert.equal(seen.at(-1)!.path, '/v1/images/edits')
    assert.deepEqual(seen.at(-1)!.files, ['她.png', '小克.png'])
    assert.match(seen.at(-1)!.prompt!, /第 1 张是她（长头发，戴眼镜）；第 2 张是小克（像素小螃蟹）/)
    assert.match(seen.at(-1)!.prompt!, /别换人/)

    // 她自己点生图：默认垫图自动带上（她和小克，不含糯糯）
    const mine = await draw(s.db, s.blobs, '随便画一张', { useDefaultRefs: true })
    assert.deepEqual(mine.refs, ['她', '小克'])
    // 没垫图时还是走 generations
    const plain = await draw(s.db, s.blobs, '一片海')
    assert.deepEqual(plain.refs, [])
    assert.equal(seen.at(-1)!.path, '/v1/images/generations')
  } finally { await close(srv); s.cleanup() }
})

test('画风：默认那个自动用；能换默认；他也能临时指定', async () => {
  const s = setup()
  try {
    const { listStyles, saveStyle, setDefaultStyle, deleteStyle, composePrompt, findStyle, defaultStyle } = await import('../src/draw-refs.ts')
    const styles = listStyles(s.db)
    assert.deepEqual(styles.map(x => x.name), ['二次元', '真人', '像素'])
    assert.equal(defaultStyle(s.db)!.name, '二次元')
    // 换默认：只能有一个默认
    setDefaultStyle(s.db, 'photo')
    assert.equal(defaultStyle(s.db)!.name, '真人')
    assert.equal(listStyles(s.db).filter(x => x.isDefault).length, 1)
    // 加一个自己的
    const mine = saveStyle(s.db, { name: '水彩', prompt: '水彩画，湿画法，颜色互相渗', isDefault: true })
    assert.equal(defaultStyle(s.db)!.name, '水彩')
    assert.throws(() => saveStyle(s.db, { name: '水彩', prompt: 'x' }), /已经有一个/)
    assert.throws(() => saveStyle(s.db, { name: '没描述', prompt: '' }), /描述/)
    // 删掉默认的那个：自动挑一个顶上
    deleteStyle(s.db, mine.id)
    assert.ok(defaultStyle(s.db))
    // 按名字找，模糊也行
    assert.equal(findStyle(s.db, '二次')!.name, '二次元')
    assert.equal(findStyle(s.db, '不存在的'), null)
    // 拼提示词：画风在前，她那句在中间，垫图说明在后
    const out = composePrompt({ prompt: '她在看书', style: findStyle(s.db, '二次元'), refs: [] })
    assert.match(out, /^日系二次元[\s\S]*她在看书$/)
  } finally { s.cleanup() }
})
