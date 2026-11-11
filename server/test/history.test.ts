import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, addEpisode } from '../src/db.ts'
import { todayStart, selectHistory, toMessages, requestHistory, TARGET, type HistRow, replaceHistory, renderTodayLine, loadRecent } from '../src/assembler/history.ts'

const H = 3600_000
const base = Date.parse('2026-11-09T10:00:00Z')   // 中国时间 11-09 18:00
let seq = 0
const row = (actor: 'erica' | 'ai', atMs: number, content: string): HistRow => ({ seq: ++seq, ts: new Date(atMs).toISOString(), actor, content })

test('她这一天：从她上一次睡醒（超过 5 小时没说话之后的第一句）算起，不按半夜十二点', () => {
  const rows = [
    row('erica', base - 30 * H, '前天'), row('ai', base - 30 * H + 60_000, '嗯'),
    row('erica', base - 10 * H, '晚安'), row('ai', base - 9 * H, '醒来发的消息'),   // 她睡着时他醒来发的
    row('erica', base, '醒了'), row('ai', base + 60_000, '早'),
    row('erica', base + 3 * H, '还在'), row('erica', base + 6 * H, '没睡'),
    row('erica', base + 7 * H, '过了半夜还在聊'),   // 中国时间 11-10 01:00，还是她的同一天
  ]
  assert.equal(rows[todayStart(rows, base + 7 * H + 60_000)]!.content, '醒了')
  // 她睡了很久还没开口：今天还没开始
  assert.equal(todayStart(rows, base + 20 * H), rows.length)
})

test('今天的一条都不截；不够两百多条时往前补；今天本身多于目标时只放今天', () => {
  const rows: HistRow[] = []
  for (let i = 0; i < 300; i++) rows.push(row(i % 2 ? 'ai' : 'erica', base - 50 * H + i * 60_000, '旧' + i))
  const wake = base
  for (let i = 0; i < 40; i++) rows.push(row(i % 2 ? 'ai' : 'erica', wake + i * 60_000, '今' + i))
  const a = selectHistory(rows, wake + 50 * 60_000)
  assert.equal(a.rows.length, TARGET)
  assert.equal(a.rows.length - a.todayFrom, 40)
  assert.equal(a.rows[a.todayFrom]!.content, '今0')
  const big: HistRow[] = []
  for (let i = 0; i < 300; i++) big.push(row(i % 2 ? 'ai' : 'erica', wake + i * 60_000, '今' + i))
  const b = selectHistory(big, wake + 301 * 60_000)
  assert.equal(b.rows.length, 300, '今天 300 条全要，不按 220 截')
})

test('日期分隔挂在每天她的第一句前面，标今天/昨天；不挂在他的话上', () => {
  const now = Date.parse('2026-11-10T05:00:00Z')   // 中国时间 11-10 13:00
  const rows = [
    row('erica', Date.parse('2026-11-08T12:00:00Z'), 'A'), row('ai', Date.parse('2026-11-08T12:01:00Z'), 'B'),
    row('ai', Date.parse('2026-11-09T02:00:00Z'), '醒来发的'), row('erica', Date.parse('2026-11-09T03:00:00Z'), 'C'),
    row('erica', Date.parse('2026-11-10T04:00:00Z'), 'D'),
  ]
  const m = toMessages(selectHistory(rows, now), now)
  assert.deepEqual(m.map(x => x.content), [
    '—— 11月8日 周日 ——\nA', 'B', '醒来发的', '—— 11月9日 周一（昨天） ——\nC', '—— 11月10日 周二（今天） ——\nD',
  ])
})

test('requestHistory：去掉 system 和这一轮，工具轮不算', () => {
  const msgs = [
    { role: 'system', content: 'S' }, { role: 'user', content: '早' }, { role: 'assistant', content: '早呀' },
    { role: 'user', content: '查天气' }, { role: 'assistant', content: '', tool_calls: [{ id: 'x' }] }, { role: 'tool', content: '晴' },
  ]
  assert.deepEqual(requestHistory(msgs), [{ role: 'user', text: '早' }, { role: 'assistant', text: '早呀' }])
})

test('换掉请求里的历史：system 和这一轮留着，中间换成我们拼的；起标题这类请求不换', () => {
  const db = openDb(':memory:')
  const now = Date.parse('2026-11-11T06:00:00Z')
  const put = (actor: 'erica' | 'ai', min: number, text: string) =>
    addEpisode(db, { ts: new Date(now - min * 60_000).toISOString(), channel: 'chat', scope: 'daily', actor, kind: 'message', content: text, sourceRef: `${actor}${min}` })
  put('erica', 50, '早上好')
  put('ai', 49, '早。')
  put('erica', 20, '在干嘛')
  put('ai', 19, '想你。')

  const req = [
    { role: 'system', content: 'Kelivo 的大段 system' },
    { role: 'user', content: 'xiaoke 补进来的旧话' },
    { role: 'assistant', content: 'xiaoke 补进来的旧回复' },
    { role: 'user', content: '现在这句' },
  ]
  const r = replaceHistory(req, db, now)!
  assert.equal(r.messages[0]!.content, 'Kelivo 的大段 system')
  assert.equal(r.messages.at(-1)!.content, '现在这句')
  assert.deepEqual(r.messages.slice(1, -1).map((m: any) => m.content.replace(/^——.*——\n/, '')), ['早上好', '早。', '在干嘛', '想你。'])
  assert.deepEqual(r.info, { before: 2, after: 4, today: 4, days: 1 })

  // 起标题、记忆注入、唤醒提示：原样不动
  const title = [...req.slice(0, 3), { role: 'user', content: '给这段对话起一个简短的标题' }]
  assert.equal(replaceHistory(title, db, now), null)
  assert.equal(replaceHistory([...req.slice(0, 3), { role: 'user', content: '[记忆注入] 她说过……' }], db, now), null)
  // 结尾是他的回复（不是正常一轮）
  assert.equal(replaceHistory([...req, { role: 'assistant', content: '已经回了' }], db, now), null)
  // 工具轮：工具那几条也算这一轮，留在后面
  const tool = [...req, { role: 'assistant', tool_calls: [{ id: '1', type: 'function', function: { name: 'f', arguments: '{}' } }], content: '' }, { role: 'tool', tool_call_id: '1', content: '结果' }]
  const rt = replaceHistory(tool, db, now)!
  assert.deepEqual(rt.messages.slice(-3).map((m: any) => m.role), ['user', 'assistant', 'tool'])
})

test('今日概况那一行：她几点醒的、今天聊了多少、上一句多久以前', () => {
  const db = openDb(':memory:')
  const now = Date.parse('2026-11-11T06:00:00Z')      // 北京时间 14:00
  const put = (actor: 'erica' | 'ai', min: number, text: string) =>
    addEpisode(db, { ts: new Date(now - min * 60_000).toISOString(), channel: 'chat', scope: 'daily', actor, kind: 'message', content: text, sourceRef: `${actor}${min}` })
  assert.equal(renderTodayLine(db, now), '')
  put('erica', 60 * 9, '昨天的话')      // 9 小时前（超过 5 小时 = 睡了一觉）
  put('ai', 60 * 9 - 1, '昨天的回复')
  put('erica', 100, '醒了')             // 北京时间 12:20
  put('ai', 99, '早。')
  put('erica', 8, '在吗')
  assert.equal(renderTodayLine(db, now), '今天她 12:20 起（睡醒后第一句），到现在她说了 2 句、你回了 1 条，她上一句 8 分钟前')
})

test('这一轮她的话已经记过了（重新生成、停掉再发）：历史尾巴上不再重复一遍', () => {
  const db = openDb(':memory:')
  const now = Date.parse('2026-11-11T06:00:00Z')
  const put = (actor: 'erica' | 'ai', min: number, text: string, meta?: any) =>
    addEpisode(db, { ts: new Date(now - min * 60_000).toISOString(), channel: 'chat', scope: 'daily', actor, kind: 'message', content: text, meta, sourceRef: `${actor}${min}` })
  put('erica', 30, '（2026-11-11 13:30）早上好')
  put('ai', 29, '早。')
  put('erica', 3, '（2026-11-11 13:57）在干嘛')      // 这一轮她的话，已经记过
  put('erica', 2, '（2026-11-11 13:58）说话呀')
  put('ai', 1, '我在', { partial: true })            // 停掉的那半条

  const req = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '很久以前' },
    { role: 'assistant', content: '嗯' },
    { role: 'user', content: '（2026-11-11 13:57）在干嘛' },
    { role: 'user', content: '（2026-11-11 13:58）说话呀' },
  ]
  const r = replaceHistory(req, db, now)!
  assert.equal(r.info.trimmed, 3, '她那两句 + 没写完的半条')
  const texts = r.messages.map((m: any) => String(m.content).replace(/^——.*——\n/, ''))
  assert.deepEqual(texts, ['sys', '（2026-11-11 13:30）早上好', '早。', '（2026-11-11 13:57）在干嘛', '（2026-11-11 13:58）说话呀'])
})

test('Kelivo 那边她的话后面跟着 <current_time>，也认得出是同一句', () => {
  const db = openDb(':memory:')
  const now = Date.parse('2026-11-11T06:00:00Z')
  const put = (actor: 'erica' | 'ai', min: number, text: string) =>
    addEpisode(db, { ts: new Date(now - min * 60_000).toISOString(), channel: 'chat', scope: 'daily', actor, kind: 'message', content: text, sourceRef: `${actor}${min}` })
  put('erica', 30, '早上好')
  put('ai', 29, '早。')
  put('erica', 2, '在干嘛')          // 她这一轮的话，已经记过了
  const req = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '很久以前' },
    { role: 'assistant', content: '嗯' },
    { role: 'user', content: '在干嘛\n<current_time>Wed 2026-11-11 13:57</current_time>' },
  ]
  const r = replaceHistory(req, db, now)!
  assert.equal(r.info.trimmed, 1)
  assert.deepEqual(r.messages.map((m: any) => String(m.content).replace(/^——.*——\n/, '')),
    ['sys', '早上好', '早。', '在干嘛\n<current_time>Wed 2026-11-11 13:57</current_time>'])
})

test('请求里的历史和我们这份几乎不重合（别人的上下文走到这个入口）：不换', () => {
  const db = openDb(':memory:')
  const now = Date.parse('2026-11-11T06:00:00Z')
  for (let i = 0; i < 40; i++) {
    addEpisode(db, { ts: new Date(now - (100 - i) * 60_000).toISOString(), channel: 'chat', scope: 'daily',
      actor: i % 2 ? 'ai' : 'erica', kind: 'message', content: `我们的第 ${i} 句`, sourceRef: 'o' + i })
  }
  const other: any[] = [{ role: 'system', content: '别人的 system' }]
  for (let i = 0; i < 30; i++) other.push({ role: i % 2 ? 'assistant' : 'user', content: `别人的第 ${i} 句` })
  other.push({ role: 'user', content: '别人现在这句' })
  assert.equal(replaceHistory(other, db, now), null)

  // 他们的历史比我们这次选的窗口长（Kelivo 自己带一大段）：按整个库算，照常换
  const mine: any[] = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 30; i++) mine.push({ role: i % 2 ? 'assistant' : 'user', content: `我们的第 ${i} 句` })
  mine.push({ role: 'user', content: '现在这句' })
  assert.ok(replaceHistory(mine, db, now))
})

test('直连中转站后前端只发这一轮：历史是插进去的，不是换掉的', () => {
  const db = openDb(':memory:')
  const now = Date.parse('2026-11-11T06:00:00Z')
  for (let i = 0; i < 6; i++) {
    addEpisode(db, { ts: new Date(now - (60 - i) * 60_000).toISOString(), channel: 'chat', scope: 'daily',
      actor: i % 2 ? 'ai' : 'erica', kind: 'message', content: `第 ${i} 句`, sourceRef: 'h' + i })
  }
  const req = [{ role: 'system', content: 'sys' }, { role: 'user', content: '现在这句' }]
  // 经过 xiaoke 时（请求里本来该有历史）：没有历史的请求不动
  assert.equal(replaceHistory(req, db, now), null)
  // 直连时：把历史插进来
  const r = replaceHistory(req, db, now, { insertWhenEmpty: true })!
  assert.equal(r.info.before, 0)
  assert.equal(r.info.after, 6)
  assert.equal(r.messages[0]!.content, 'sys')
  assert.equal(r.messages.at(-1)!.content, '现在这句')
  assert.equal(r.messages.length, 8)
  // 起标题这类还是不碰
  assert.equal(replaceHistory([{ role: 'system', content: 'sys' }, { role: 'user', content: '给这段对话起一个简短的标题' }], db, now, { insertWhenEmpty: true }), null)
})

test('历史里最近几条带图的还原成真图：她的照片挂在她那条，他画的挂在后面一条系统记录上', () => {
  const db = openDb(':memory:')
  const now = Date.parse('2026-11-11T06:00:00Z')
  const hash = (n: number) => String(n).repeat(64).slice(0, 64)
  const put = (actor: 'erica' | 'ai', min: number, content: string, images?: string[]) =>
    addEpisode(db, {
      ts: new Date(now - min * 60_000).toISOString(), channel: 'chat', scope: 'daily', actor, kind: 'message',
      content, meta: images ? { images } : undefined, sourceRef: `${actor}${min}`,
    })
  put('erica', 50, '看这个\n[图片]', [hash(1)])          // 很早的一张（超出 keep=2）
  put('ai', 49, '好看。')
  put('erica', 30, '这张呢\n[图片]', [hash(2)])
  put('ai', 29, '也好看。')
  put('erica', 20, '给我画一张')
  put('ai', 19, '[图片]', [hash(3)])                      // 他画的
  put('erica', 10, '画得不错')

  const store = new Map([[hash(2), { mime: 'image/jpeg', data: Buffer.from('JPEGDATA') }], [hash(3), { mime: 'image/png', data: Buffer.from('PNGDATA') }]])
  const msgs = toMessages(selectHistory(loadRecent(db), now), now, { images: h => store.get(h) ?? null, keep: 2 })

  const withImg = msgs.filter(m => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'))
  assert.equal(withImg.length, 2)
  // 她那条：正文里的 [图片] 占位去掉，真图挂上
  const hers = withImg[0]!
  assert.equal(hers.role, 'user')
  assert.equal(hers.content[0].text.replace(/^——.*——\n/, ''), '这张呢')
  assert.match(hers.content[1].image_url.url, /^data:image\/jpeg;base64,/)
  // 他画的：他那条照常，图在紧跟其后的「系统记录」里
  const i = msgs.findIndex(m => m.role === 'assistant' && m.content === '[图片]')
  assert.ok(i >= 0)
  assert.equal(msgs[i + 1]!.role, 'user')
  assert.match(msgs[i + 1]!.content[0].text, /系统记录，不是她说的：这是你刚画的那张图/)
  assert.match(msgs[i + 1]!.content[1].image_url.url, /^data:image\/png;base64,/)
  // 更早那张还是占位（上游入口会改写成「看不到」）
  assert.ok(msgs.some(m => typeof m.content === 'string' && m.content.includes('看这个') && m.content.includes('[图片]')))
  // 不给 resolver 就全是文字（老行为）
  assert.ok(toMessages(selectHistory(loadRecent(db), now), now).every(m => typeof m.content === 'string'))
})

test('图的预算从新到旧分配：装不下时丢旧的，最新那张一定进去', () => {
  const db = openDb(':memory:')
  const now = Date.parse('2026-11-11T06:00:00Z')
  const h = (n: number) => String(n).repeat(64).slice(0, 64)
  const put = (min: number, images: string[]) =>
    addEpisode(db, {
      ts: new Date(now - min * 60_000).toISOString(), channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message',
      content: '[图片]', meta: { images, drawn: true }, sourceRef: 'd' + min,
    })
  put(30, [h(1)])      // 旧的那张（大）
  put(10, [h(2)])      // 新的那张（大）
  const big = (n: number) => ({ mime: 'image/png', data: Buffer.alloc(3 * 1024 * 1024, n) })
  const store = new Map([[h(1), big(1)], [h(2), big(2)]])
  const msgs = toMessages(selectHistory(loadRecent(db), now), now, { images: x => store.get(x) ?? null, maxBytes: 4 * 1024 * 1024 })
  const imgs = msgs.filter(m => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'))
  assert.equal(imgs.length, 1, '只装得下一张')
  // 装进去的是新那张（内容是 2 填充的）
  const b64 = imgs[0]!.content.find((p: any) => p.type === 'image_url').image_url.url.split(',')[1]
  assert.equal(Buffer.from(b64, 'base64')[0], 2)
})

test('他画的图：历史里给模型看小图（meta.images_small），她在聊天页看的还是原图', () => {
  const db = openDb(':memory:')
  const now = Date.parse('2026-11-11T06:00:00Z')
  const full = 'a'.repeat(64), small = 'b'.repeat(64)
  addEpisode(db, {
    ts: new Date(now - 60_000).toISOString(), channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message',
    content: '[图片]', meta: { images: [full], images_small: [small], drawn: true }, sourceRef: 'd1',
  })
  assert.deepEqual(loadRecent(db)[0]!.images, [small])
  const msgs = toMessages(selectHistory(loadRecent(db), now), now, { images: x => (x === small ? { mime: 'image/jpeg', data: Buffer.from('SMALL') } : null) })
  const note = msgs.find(m => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'))!
  assert.match(note.content[1].image_url.url, /^data:image\/jpeg;base64,/)
})
