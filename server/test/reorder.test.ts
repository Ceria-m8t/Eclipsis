import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reorderByTime, timeTagOf, type TimeLookup } from '../src/transforms.ts'

const T = (hm: string) => Date.parse(`2026-11-10T${hm}:00+08:00`)
function lookupFrom(rows: [string, string, number][]): TimeLookup {
  return (role, text) => rows.filter(r => r[0] === role && r[1].replace(/\s+/g, ' ').trim() === text.replace(/\s+/g, ' ').trim()).map(r => r[2])
}
const u = (c: string) => ({ role: 'user', content: c })
const a = (c: string, extra: any = {}) => ({ role: 'assistant', content: c, ...extra })

test('timeTagOf：Kelivo 的 <current_time>、Eclipsis 的开头时间', () => {
  assert.equal(timeTagOf('在吗\n<current_time>Tue 2026-11-10 03:03:16</current_time>'), Date.parse('2026-11-10T03:03:16+08:00'))
  assert.equal(timeTagOf('（2026-11-10 02:35）老公'), T('02:35'))
  assert.equal(timeTagOf('没有时间'), null)
})

test('xiaoke 插在前面的 Eclipsis 那段，按时间挪到 Kelivo 历史里该在的位置；system 和结尾这一轮不动', () => {
  const msgs = [
    { role: 'system', content: 'S' },
    u('（2026-11-10 02:35）在 Eclipsis'), a('看到了'),          // xiaoke 补的（其实是 02:35 的）
    u('早上好 <current_time>Tue 2026-11-10 01:00:00</current_time>'), a('早'),   // Kelivo 窗口历史
    u('凌晨三点 <current_time>Tue 2026-11-10 02:50:00</current_time>'), a('嗯'),
    u('能看到 Eclipsis 那条吗 <current_time>Tue 2026-11-10 03:03:16</current_time>'),   // 这一轮
  ]
  const lookup = lookupFrom([['assistant', '看到了', T('02:36')], ['assistant', '早', T('01:01')], ['assistant', '嗯', T('02:51')]])
  const r = reorderByTime(msgs, lookup)
  assert.deepEqual(r.messages.map(m => m.content.slice(0, 6)), ['S', '早上好 <c', '早', '（2026-', '看到了', '凌晨三点 <', '嗯', '能看到 Ec'])
  assert.ok(r.moved > 0)
})

test('工具调用和结果跟着那条回复走；找不到时间的跟在前一条后面；已经排好的不动', () => {
  const msgs = [
    u('（2026-11-10 02:00）查天气'), a('', { tool_calls: [{ id: 'c' }] }), { role: 'tool', tool_call_id: 'c', content: '晴' }, a('晴天'),
    u('（2026-11-10 02:10）好'),
  ]
  const r = reorderByTime(msgs, () => [])
  assert.equal(r.moved, 0)
  assert.equal(r.messages, msgs)
})

test('结尾这一轮正在调工具：整段留在最后', () => {
  const msgs = [
    u('（2026-11-10 02:40）后来的'), a('嗯'),
    u('（2026-11-10 01:00）早先的'), a('早'),
    u('（2026-11-10 03:00）这轮'), a('', { tool_calls: [{ id: 'x' }] }), { role: 'tool', tool_call_id: 'x', content: 'ok' },
  ]
  const r = reorderByTime(msgs, () => [])
  assert.deepEqual(r.messages.map(m => m.content), ['（2026-11-10 01:00）早先的', '早', '（2026-11-10 02:40）后来的', '嗯', '（2026-11-10 03:00）这轮', '', 'ok'])
})
