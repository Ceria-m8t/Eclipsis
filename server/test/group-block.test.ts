// 最近群聊块：给小克 Eclipsis 聊天注入统一群聊线，带说话人
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, addEpisode, type DB } from '../src/db.ts'
import { renderRecentGroupBlock } from '../src/assembler/index.ts'

let db: DB
beforeEach(() => { db = openDb(':memory:') })

function g(actor: string, speaker: string, content: string, ts: string) {
  addEpisode(db, { ts, channel: 'group', scope: 'group', actor, kind: 'message', content, meta: { speaker }, sourceRef: `t:${ts}:${Math.random()}` })
}

describe('renderRecentGroupBlock', () => {
  it('无群聊 → 空串', () => {
    assert.equal(renderRecentGroupBlock(db), '')
  })

  it('带说话人、按时间正序', () => {
    g('peer', '林澄', '你们在聊啥', '2026-11-05T01:00:00Z')
    g('ai', '哈基米', '在聊后端', '2026-11-05T01:01:00Z')
    g('ai', '小克', '对', '2026-11-05T01:02:00Z')
    const block = renderRecentGroupBlock(db)
    assert.match(block, /# 最近群聊/)
    const body = block.slice(block.indexOf('林澄'))
    assert.ok(body.indexOf('林澄') < body.indexOf('哈基米'), '应按时间正序')
    assert.match(block, /林澄：你们在聊啥/)
    assert.match(block, /哈基米：在聊后端/)
    assert.match(block, /小克：对/)
  })

  it('actor 没 speaker 时用兜底名', () => {
    addEpisode(db, { ts: '2026-11-05T01:00:00Z', channel: 'group', scope: 'group', actor: 'peer', kind: 'message', content: '匿名一句', sourceRef: 'x1' })
    assert.match(renderRecentGroupBlock(db), /群友：匿名一句/)
  })

  it('只取 group 线，不混日常 chat', () => {
    addEpisode(db, { ts: '2026-11-05T01:00:00Z', channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: '日常私话', sourceRef: 'c1' })
    g('ai', '小克', '群里的话', '2026-11-05T01:01:00Z')
    const block = renderRecentGroupBlock(db)
    assert.doesNotMatch(block, /日常私话/)
    assert.match(block, /群里的话/)
  })
})
