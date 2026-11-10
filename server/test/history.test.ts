import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, addEpisode } from '../src/db.ts'
import { todayStart, selectHistory, toMessages, requestHistory, TARGET, type HistRow, replaceHistory, renderTodayLine } from '../src/assembler/history.ts'

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
  assert.equal(renderTodayLine(db, now), '今天她 12:20 起（睡醒后第一句），到现在她说了 2 句、你回了 1 条，上一句 8 分钟前')
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
