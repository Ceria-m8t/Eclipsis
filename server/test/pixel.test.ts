import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePixel, splitPixel, renderPixel } from '../src/pixel.ts'

const art = (w: number, h: number) => JSON.stringify({
  w, h, palette: ['#0000', '#C8909A'], grid: Array.from({ length: w * h }, (_, i) => i % 2),
})

test('parsePixel：好的收下；w/h、palette、grid 哪里不对就说哪里', () => {
  const okr = parsePixel(art(2, 2))
  assert.ok('art' in okr)
  assert.deepEqual(okr.art, { w: 2, h: 2, palette: ['#0000', '#C8909A'], grid: [0, 1, 0, 1] })
  const bad = (s: string) => {
    const r = parsePixel(s)
    assert.ok('error' in r, s.slice(0, 40))
    return (r as { error: string }).error
  }
  assert.match(bad('{坏的'), /JSON 不合法/)
  assert.match(bad('{"w":0,"h":2,"palette":["#0000"],"grid":[]}'), /正整数/)
  assert.match(bad('{"w":65,"h":2,"palette":["#0000"],"grid":[]}'), /最多 64/)
  assert.match(bad('{"w":2,"h":2,"palette":[],"grid":[0,0,0,0]}'), /palette/)
  assert.match(bad('{"w":2,"h":2,"palette":["红"],"grid":[0,0,0,0]}'), /不是 #RGB/)
  assert.match(bad('{"w":2,"h":2,"palette":["#0000"],"grid":[0,0,0]}'), /应该有 4 个数（2×2）/)
  assert.match(bad('{"w":2,"h":2,"palette":["#0000"],"grid":[0,0,0,5]}'), /不在 palette 范围内/)
  // 三位、四位、八位十六进制都认
  assert.ok('art' in parsePixel('{"w":1,"h":1,"palette":["#f0f"],"grid":[0]}'))
  assert.ok('art' in parsePixel('{"w":1,"h":1,"palette":["#ff00ff80"],"grid":[0]}'))
})

test('splitPixel：块拆出来、正文里不留；画坏了留一句原因；没闭合的不当正文发出去', () => {
  const r = splitPixel(`给你画了个小东西。\n\n[[PIXEL]]${art(2, 2)}[[/PIXEL]]\n\n喜欢吗。`)
  assert.equal(r.text, '给你画了个小东西。\n\n喜欢吗。')
  assert.equal(r.arts.length, 1)
  assert.deepEqual(r.errors, [])
  assert.equal(r.unclosed, false)

  // 一条回复里两块
  const two = splitPixel(`[[PIXEL]]${art(1, 1)}[[/PIXEL]]和[[PIXEL]]${art(2, 1)}[[/PIXEL]]`)
  assert.equal(two.arts.length, 2)
  assert.equal(two.text, '和')

  // 画坏了：正文里留原因，他下一轮看得到
  const bad = splitPixel('看这个 [[PIXEL]]{"w":2,"h":2,"palette":["#0000"],"grid":[0,0,0]}[[/PIXEL]]')
  assert.equal(bad.arts.length, 0)
  assert.match(bad.text, /〔像素小画没画成：grid 应该有 4 个数（2×2），现在是 3 个〕/)
  assert.equal(bad.errors.length, 1)

  // 没闭合（流式写一半被截断）：半截 JSON 不进正文
  const cut = splitPixel('给你画\n[[PIXEL]]{"w":16,"h":16,"palette":["#0000"')
  assert.equal(cut.unclosed, true)
  assert.equal(cut.arts.length, 0)
  assert.doesNotMatch(cut.text, /palette/)
  assert.match(cut.text, /没画完/)

  // 没有块的回复原样
  const plain = splitPixel('就是普通一句话')
  assert.equal(plain.text, '就是普通一句话')
  assert.equal(plain.arts.length, 0)
})

test('renderPixel：出一张放大的 PNG，格子颜色对得上', async () => {
  const one = { w: 2, h: 1, palette: ['#0000', '#ff0000'], grid: [0, 1] }
  const png = await renderPixel(one, { scale: 4 })
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '是 PNG')
  // IHDR 里的宽高 = 格子数 × scale
  assert.equal(png.readUInt32BE(16), 8)
  assert.equal(png.readUInt32BE(20), 4)
  // 大一点的也能画，默认 scale 让长边约 512
  const big = await renderPixel({ w: 16, h: 16, palette: ['#0000', '#123456'], grid: Array(256).fill(1) })
  assert.ok(big.length > 100)
  assert.equal(big.readUInt32BE(16), 16 * 32 > 512 ? 16 * 32 : 16 * Math.max(6, Math.round(512 / 16)))
})

test('记录时：块从正文拆掉、渲染成图挂在那条经历上，聊天页按图片显示', async () => {
  const { openDb } = await import('../src/db.ts')
  const { BlobStore } = await import('../src/blobs.ts')
  const { Recorder } = await import('../src/recorder.ts')
  const { attachPixelArt } = await import('../src/pixel-attach.ts')
  const { chatHistory } = await import('../src/chat-history.ts')
  const { tempDir } = await import('./helpers.ts')
  const t = tempDir()
  const db = openDb(':memory:')
  const blobs = new BlobStore(db, `${t.dir}/blobs`)
  try {
    const pending: { seq: number; arts: any[] }[] = []
    const rec = new Recorder(db, blobs, { onPixelArt: (seq, arts) => pending.push({ seq, arts }) })
    const ctx = rec.start({
      tap: 'front', rid: 'r-pix', linked: false, path: '/v1/chat/completions',
      headers: { 'x-eclipsis-scene': 'chat', 'x-eclipsis-turn': 't1' },
      body: { messages: [{ role: 'user', content: '画个心给我' }] },
    })
    rec.finish(ctx, {
      httpStatus: 200, contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ choices: [{ delta: { content: `给你。\n\n[[PIXEL]]${art(2, 2)}[[/PIXEL]]\n\n小小的。` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      timing: { ttfbMs: 1, firstTokenMs: 1, clientClosedMs: null, bytesOut: 1 },
    })
    const ep = db.prepare(`SELECT seq, content, meta FROM episodes WHERE actor = 'ai' ORDER BY seq DESC LIMIT 1`).get() as any
    assert.equal(ep.content, '给你。\n\n小小的。', '正文里没有那段 JSON')
    assert.equal(JSON.parse(ep.meta).pixel, 1)
    assert.deepEqual(pending.map(x => x.seq), [ep.seq])

    // 渲染挂上去
    await attachPixelArt(db, blobs, pending[0]!.seq, pending[0]!.arts)
    const after = db.prepare('SELECT meta FROM episodes WHERE seq = ?').get(ep.seq) as any
    const images = JSON.parse(after.meta).images as string[]
    assert.equal(images.length, 1)
    assert.equal(blobs.readImage(images[0]!)!.mime, 'image/png')

    const item = chatHistory(db, {}).items.at(-1)!
    assert.equal(item.role, 'assistant')
    assert.equal(item.content, '给你。\n\n小小的。')
    assert.equal(item.images?.length, 1)
  } finally { t.cleanup() }
})
