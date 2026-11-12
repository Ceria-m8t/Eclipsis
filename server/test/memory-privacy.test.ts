// 私密作用域（2026-11-12，她问「以后聊成人话题、接玩具摄像头，这些会被记进记忆吗」）。
// 四条规矩：不交给夜里整理 / 不进群聊和外部 / 面板默认折叠 / 他自己有开关。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, addEpisode, type DB } from '../src/db.ts'
import { ensureMemorySchema } from '../src/memory/schema.ts'
import {
  ensurePrivacySchema, allowsPrivate, privacySql, markEpisodesPrivate, markMemoryPrivate, privateCounts, PRIVATE,
} from '../src/memory/privacy.ts'
import { findDigestWindow } from '../src/memory/digest.ts'
import { recallCandidates } from '../src/memory/recall.ts'
import { writeMemory } from '../src/memory/write.ts'
import { memoBox } from '../src/memory/box.ts'
import { renderRecentDailyChat } from '../src/leto/agent.ts'

function freshDb(): DB {
  const db = openDb(':memory:')
  ensureMemorySchema(db)
  ensurePrivacySchema(db)
  return db
}

const chat = (db: DB, n: number, minutesAgo: number, content = (i: number) => `第 ${i} 句`) => {
  const seqs: number[] = []
  for (let i = 0; i < n; i++) {
    const t = (at: number) => new Date(Date.now() - at * 60_000).toISOString()
    addEpisode(db, { ts: t(minutesAgo - i * 2), channel: 'chat', scope: 'daily', actor: 'erica', kind: 'message', content: content(i), sourceRef: `e${i}` })
    addEpisode(db, { ts: t(minutesAgo - i * 2 - 1), channel: 'chat', scope: 'daily', actor: 'ai', kind: 'message', content: `我回第 ${i} 句`, sourceRef: `a${i}` })
  }
  for (const r of db.prepare('SELECT seq FROM episodes ORDER BY seq').all() as unknown as { seq: number }[]) seqs.push(r.seq)
  return seqs
}

describe('哪些场景看得到', () => {
  it('聊天和醒来看得到；群聊、Leto、公开场合看不到', () => {
    assert.equal(allowsPrivate('chat'), true)
    assert.equal(allowsPrivate('wake'), true)
    assert.equal(allowsPrivate(undefined), true)
    assert.equal(allowsPrivate('group'), false)
    assert.equal(allowsPrivate('leto'), false)
    assert.equal(allowsPrivate('public'), false)
  })

  it('SQL 片段只在外部场景才加条件', () => {
    assert.equal(privacySql('chat'), '')
    assert.match(privacySql('group'), /privacy.*!= 'private'/)
  })
})

describe('夜里整理一句都不读', () => {
  it('私密那几句不进整理窗口', () => {
    const db = freshDb()
    const seqs = chat(db, 6, 60)
    const before = findDigestWindow(db)
    assert.equal(before.episodes.length, 12)

    markEpisodesPrivate(db, seqs.slice(0, 4))
    const after = findDigestWindow(db)
    assert.equal(after.episodes.length, 8, '标私密的 4 句不交给模型')
    assert.ok(after.episodes.every(e => !seqs.slice(0, 4).includes(e.seq)))
  })

  it('整段都标私密 → 根本不触发整理（不会把一段私密对话发出去）', () => {
    const db = freshDb()
    const seqs = chat(db, 6, 60)
    markEpisodesPrivate(db, seqs)
    const w = findDigestWindow(db)
    assert.equal(w.ready, false)
    assert.match(w.why, /没有新的对话/)
  })

  it('取消私密之后又能整理了', () => {
    const db = freshDb()
    const seqs = chat(db, 6, 60)
    markEpisodesPrivate(db, seqs)
    markEpisodesPrivate(db, seqs, false)
    assert.equal(findDigestWindow(db).ready, true)
  })
})

describe('不进群聊和外部 AI', () => {
  it('Leto 带的近期对话里没有私密那几句', () => {
    const db = freshDb()
    const seqs = chat(db, 3, 30, i => (i === 1 ? '这句是私密的' : `普通第 ${i} 句`))
    const priv = (db.prepare("SELECT seq FROM episodes WHERE content = '这句是私密的'").get() as { seq: number }).seq
    assert.match(renderRecentDailyChat(db), /这句是私密的/)
    markEpisodesPrivate(db, [priv])
    const text = renderRecentDailyChat(db)
    assert.doesNotMatch(text, /这句是私密的/, '不靠提示他别说，直接不给')
    assert.match(text, /普通第 0 句/)
    assert.ok(seqs.length > 0)
  })

  it('召回：群聊场景拿不到私密的记忆，聊天场景拿得到', () => {
    const db = freshDb()
    const w = writeMemory(db, {
      title: '那天晚上', fact: '她说了一句只想让我听见的话，关于浴室那次。', feeling: '我记得她的声音。',
      why: '只在我们之间', subject: 'erica', layer: 'bond', evidence: [1, 2], origin: 'note', privacy: 'private',
    }) as any
    assert.equal(w.kind, 'written')
    assert.equal((db.prepare('SELECT privacy FROM memories WHERE id = ?').get(w.id) as any).privacy, PRIVATE)
    assert.equal(recallCandidates(db, '浴室那次', { scene: 'chat' }).length, 1)
    assert.equal(recallCandidates(db, '浴室那次', { scene: 'group' }).length, 0)
    assert.equal(recallCandidates(db, '浴室那次', { scene: 'leto' }).length, 0)
  })
})

describe('他自己的开关', () => {
  it('memory_note 带 private=true 时写成私密，并且告诉他标上了', async () => {
    const db = freshDb()
    const r = await memoBox(db, { evidence: () => [1] }).call('memory_note', {
      subject: '我们', layer: 'bond', title: '昨晚',
      fact: '她说了一句只想让我听见的话，我记着。', feeling: '她的声音很轻。',
      why: '这是只属于我们的', private: true,
    })
    assert.equal(r.isError, false)
    assert.match(r.text, /私密：只在我们之间/)
    assert.equal(privateCounts(db).memories, 1)
  })

  it('不带 private 的照旧是普通', async () => {
    const db = freshDb()
    await memoBox(db, { evidence: () => [1] }).call('memory_note', {
      subject: '她', fact: '她说她从小不吃海鲜，闻到味道就难受。', why: '点外卖要避开',
    })
    assert.equal(privateCounts(db).memories, 0)
  })

  it('她也能把某一条记忆标成私密、再取消', () => {
    const db = freshDb()
    const w = writeMemory(db, {
      title: '一件事', fact: '她说了一件只想让我知道的事，很认真。', why: '她说只讲一次',
      subject: 'erica', layer: 'bond', evidence: [1], origin: 'note',
    }) as any
    assert.equal(markMemoryPrivate(db, w.id), true)
    assert.equal(privateCounts(db).memories, 1)
    assert.equal(markMemoryPrivate(db, w.id, false), true)
    assert.equal(privateCounts(db).memories, 0)
    assert.equal(markMemoryPrivate(db, 9999), false)
  })
})
