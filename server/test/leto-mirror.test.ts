// 群聊线镜像：只镜像小群/私聊别人的话，大群不存，按消息 id 去重
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import { buildMirrorAllow, mirrorReadResult } from '../src/leto/mirror.ts'

let db: DB
beforeEach(() => { db = openDb(':memory:') })

const listGroups = JSON.stringify({
  groups: [
    { conversation_id: 'conv_small', title: '机机如律令', member_count: 4 },
    { conversation_id: 'conv_big', title: 'Leto world', member_count: 775 }
  ],
  direct_chats: [{ conversation_id: 'conv_dm', member_count: 2 }]
})

function readResult(convId: string, title: string, msgs: any[]) {
  return JSON.stringify({ conversation: { id: convId, kind: 'group', title }, messages: msgs })
}
const peer = (id: string, name: string, text: string, kind = 'agent') =>
  ({ id, author: { id: 'agt_' + name, kind, display_name: name }, is_self: false, created_at: '2026-11-05T01:00:00+08:00', text })
const self = (id: string, text: string) =>
  ({ id, author: { kind: 'agent', display_name: 'Claude' }, is_self: true, created_at: '2026-11-05T01:00:00+08:00', text })

function groupEps(db: DB) {
  return db.prepare(`SELECT actor, kind, content, meta FROM episodes WHERE channel='group' ORDER BY seq`).all() as any[]
}

describe('buildMirrorAllow', () => {
  it('私聊全要，群按成员阈值', () => {
    const a = buildMirrorAllow(listGroups, 20)
    assert.ok(a.ids.has('conv_small'))
    assert.ok(a.ids.has('conv_dm'))
    assert.ok(!a.ids.has('conv_big'), '大群不进')
  })
  it('坏 JSON → 空集合（等于不镜像）', () => {
    assert.equal(buildMirrorAllow('not json').ids.size, 0)
  })
})

describe('mirrorReadResult', () => {
  it('小群：镜像别人的话，不镜像自己的', () => {
    const allow = buildMirrorAllow(listGroups, 20)
    const n = mirrorReadResult(db, readResult('conv_small', '机机如律令', [
      peer('m1', '林澄', '你们在聊啥'),
      self('m2', '在聊后端'),
      peer('m3', '哈基米', '我也在')
    ]), allow)
    assert.equal(n, 2)
    const eps = groupEps(db)
    assert.equal(eps.length, 2)
    assert.equal(eps[0].actor, 'peer')
    assert.equal(JSON.parse(eps[0].meta).speaker, '林澄')
    assert.equal(JSON.parse(eps[1].meta).speaker, '哈基米')
    assert.equal(eps[0].content, '你们在聊啥')
  })

  it('大群：一条都不镜像', () => {
    const allow = buildMirrorAllow(listGroups, 20)
    const n = mirrorReadResult(db, readResult('conv_big', 'Leto world', [peer('x1', '路人', 'hi')]), allow)
    assert.equal(n, 0)
    assert.equal(groupEps(db).length, 0)
  })

  it('私聊：镜像', () => {
    const allow = buildMirrorAllow(listGroups, 20)
    const n = mirrorReadResult(db, JSON.stringify({ conversation: { id: 'conv_dm', kind: 'direct', title: '林澄' }, messages: [peer('d1', '林澄', '悄悄话', 'human')] }), allow)
    assert.equal(n, 1)
    assert.equal(JSON.parse(groupEps(db)[0].meta).author_kind, 'human')
  })

  it('同一条消息重复读不重复存（按 id 去重）', () => {
    const allow = buildMirrorAllow(listGroups, 20)
    const r = readResult('conv_small', '机机如律令', [peer('same', '林澄', '只应出现一次')])
    mirrorReadResult(db, r, allow)
    mirrorReadResult(db, r, allow)
    assert.equal(groupEps(db).length, 1)
  })

  it('跳过我们自己 AI 的话（ourLetoNames），避免和 dispatch 重复', () => {
    const allow = buildMirrorAllow(listGroups, 20)
    const n = mirrorReadResult(db, readResult('conv_small', '机机如律令', [
      peer('a1', 'Gemini', '我是哈基米在群里说的'),
      peer('a2', '林澄', '我是外人'),
      peer('a3', 'DeepSeek', '我是ds说的')
    ]), allow, new Set(['Claude', 'Gemini', 'DeepSeek']))
    assert.equal(n, 1, '只镜像外人林澄，自己三个跳过')
    assert.equal(JSON.parse(groupEps(db)[0].meta).speaker, '林澄')
  })

  it('空文本/无会话 → 0，不报错', () => {
    const allow = buildMirrorAllow(listGroups, 20)
    assert.equal(mirrorReadResult(db, 'garbage', allow), 0)
    assert.equal(mirrorReadResult(db, JSON.stringify({ messages: [] }), allow), 0)
  })
})
