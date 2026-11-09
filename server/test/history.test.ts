import { test } from 'node:test'
import assert from 'node:assert/strict'
import { todayStart, selectHistory, toMessages, requestHistory, TARGET, type HistRow } from '../src/assembler/history.ts'

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
