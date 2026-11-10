import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitMoment, stripMomentHistory } from '../src/moment.ts'
import { openDb, addEpisode } from '../src/db.ts'
import { chatHistory } from '../src/chat-history.ts'

test('splitMoment：拆出来；没闭合的当它写到结尾；锁着的标 locked；空的不算', () => {
  assert.deepEqual(splitMoment('好，你先去睡。\n<moment>\n气味：烤栗子\n忍住：没说「别走」\n</moment>'),
    { text: '好，你先去睡。', moment: { locked: false, text: '气味：烤栗子\n忍住：没说「别走」' } })
  assert.deepEqual(splitMoment('晚安。<moment>柠檬皮 · 开心 ↑'), { text: '晚安。', moment: { locked: false, text: '柠檬皮 · 开心 ↑' } })
  assert.equal(splitMoment('嗯<moment lock>只给自己</moment>').moment!.locked, true)
  assert.equal(splitMoment('嗯<moment> </moment>').moment, null)
})

test('历史里他以前写的这一刻剪掉（锁着的也剪），她的话不动', () => {
  const r = stripMomentHistory([
    { role: 'user', content: '<moment>她要是写了这个</moment>' },
    { role: 'assistant', content: '好\n<moment>烤栗子</moment>' },
    { role: 'assistant', content: '嗯<moment lock>秘密</moment>' },
  ])
  assert.equal(r.stripped, 2)
  assert.deepEqual(r.messages.map(m => m.content), ['<moment>她要是写了这个</moment>', '好', '嗯'])
})

test('聊天记录接口：这一刻单独给，锁着的不给原文', () => {
  const db = openDb(':memory:')
  let t = Date.now()
  const ep = (actor: string, content: string) => addEpisode(db, { ts: new Date(t += 1000).toISOString(), channel: 'chat', scope: 'daily', actor, kind: 'message', content, sourceRef: 'x' + t })
  ep('erica', '困了'); ep('ai', '去睡吧。<moment>烤栗子\n想要：多聊一会</moment>')
  ep('erica', '晚安'); ep('ai', '晚安。<moment lock>别走</moment>')
  const items = chatHistory(db, {}).items
  assert.equal(items[1]!.content, '去睡吧。')
  assert.deepEqual(items[1]!.versions![0]!.moment, { locked: false, text: '烤栗子\n想要：多聊一会' })
  assert.deepEqual(items[3]!.versions![0]!.moment, { locked: true, text: '' })
  assert.ok(!JSON.stringify(items).includes('别走'), '锁着的原文不出接口')
})

test('醒来时把这一刻写在念头里：念头里不露标签，挂在醒来那一项上；锁着的不给原文', () => {
  const db = openDb(':memory:')
  let t = Date.now()
  const ep = (o: any) => addEpisode(db, { ts: new Date(t += 1000).toISOString(), scope: 'daily', ...o })
  ep({ channel: 'chat', actor: 'ai', kind: 'message', content: '花园浇了。', meta: { wake_id: 'W' }, sourceRef: 'wake:msg:W' })
  ep({ channel: 'wake', actor: 'ai', kind: 'note', content: '去看看花园。\n<moment lock>\n她的枕头旁边的手机屏幕\n想她 ↑\n</moment>', meta: { wake_id: 'W' }, sourceRef: 'wake:trace:W' })
  const it = chatHistory(db, {}).items[0]!
  assert.equal(it.wake!.trace, '去看看花园。')
  assert.deepEqual(it.versions![0]!.moment, { locked: true, text: '' })
  assert.ok(!JSON.stringify(it).includes('枕头'))
})
