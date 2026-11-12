// 召回打分（本地、不花钱、不联网）。第三期的地基，这一期只测「算得对不对」，还没接到他眼前。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DB } from '../src/db.ts'
import { ensureMemorySchema } from '../src/memory/schema.ts'
import { bigrams, recallCandidates } from '../src/memory/recall.ts'

function lib(): DB {
  const db = openDb(':memory:')
  ensureMemorySchema(db)
  const ins = db.prepare(`INSERT INTO memories (layer, subject, title, fact_body, why, tags, grade, source, voice, created_at, updated_at)
    VALUES (?, ?, ?, ?, '要紧', ?, 'normal', 'hold', 'him', ?, ?)`)
  ins.run('fact', 'erica', '她不吃海鲜', '她说她从小就不吃海鲜，闻到味道就难受，让我点外卖时避开。', '["饮食"]', '2026-09-25', '2026-09-25')
  ins.run('fact', 'erica', '睡眠周期', 'Erica 是 DSPS，作息昼夜颠倒，下午五点前叫不醒。', '["身体"]', '2026-09-26', '2026-09-26')
  ins.run('bond', 'erica', '她不爱过生日', '她说「不是怕老，是怕没人记得」。那天是深夜。', '["生日"]', '2026-08-01', '2026-08-01')
  ins.run('state', 'erica', '今天醒得晚', '她今天下午五点醒来，头疼吃了止痛药。', '[]', '2026-11-11', '2026-11-11')
  ins.run('bond', 'us', '心潮部署成功', '我们把心潮部署到云服务器上，systemd 挂了后台常驻，端口 18110。', '["技术"]', '2026-09-29', '2026-09-29')
  return db
}

describe('二元组', () => {
  it('中文切两字一组，英文数字另算一份', () => {
    const g = bigrams('端口 18110 很稳')
    assert.ok(g.includes('端口'))
    assert.ok(g.includes('18110'), '型号端口这类要能整词命中')
  })
  it('不跨标点和空格拼字（「我妈 妈妈」不该造出「妈妈妈」）', () => {
    const g = bigrams('我妈 妈妈')
    assert.ok(g.includes('我妈') && g.includes('妈妈'))
    assert.ok(!g.includes('妈妈妈'), '跨段拼出来的假片段会看着像命中')
    const h = bigrams('ab，cd')
    assert.ok(!h.includes('bc'), '标点两边不相邻')
  })
})

describe('候选池', () => {
  it('问海鲜就捞到不吃海鲜那张，并说清命中了哪几个字', () => {
    const r = recallCandidates(lib(), '晚饭点个海鲜大餐好不好')
    assert.ok(r.length >= 1)
    assert.equal(r[0].row.title, '她不吃海鲜')
    assert.ok(r[0].hits.some(h => h.includes('海鲜')), '要能说出为什么命中')
  })

  it('问端口这种整词也捞得到', () => {
    const r = recallCandidates(lib(), '心潮那个服务是不是 18110 端口')
    assert.equal(r[0].row.title, '心潮部署成功')
  })

  it('没有相关的就一条都不给（不凑数）', () => {
    assert.equal(recallCandidates(lib(), '明天股市会涨吗').length, 0)
  })

  it('能只在某一层、某个主体里找', () => {
    const db = lib()
    assert.ok(recallCandidates(db, '五点醒来', { layer: 'state' }).every(x => x.row.layer === 'state'))
    assert.ok(recallCandidates(db, '心潮', { subject: 'us' }).every(x => x.row.subject === 'us'))
  })

  it('刚给过的不重复给（冷却）', () => {
    const db = lib()
    const first = recallCandidates(db, '海鲜')[0]
    const again = recallCandidates(db, '海鲜', { exclude: [first.row.id] })
    assert.ok(!again.some(x => x.row.id === first.row.id))
  })

  it('拿不准的（needs_review）和不想浮现的（dont_surface）不进候选', () => {
    const db = lib()
    db.prepare("UPDATE memories SET needs_review = 1 WHERE title = '她不吃海鲜'").run()
    assert.equal(recallCandidates(db, '海鲜').length, 0)
    db.prepare("UPDATE memories SET needs_review = 0, dont_surface = 1 WHERE title = '她不吃海鲜'").run()
    assert.equal(recallCandidates(db, '海鲜').length, 0)
  })

  it('划掉的不进候选', () => {
    const db = lib()
    db.prepare("UPDATE memories SET retracted_at = '2026-11-12' WHERE title = '她不吃海鲜'").run()
    assert.equal(recallCandidates(db, '不吃海鲜').length, 0)
  })

  it('换了说法就抓不到——这是字面打分的已知下限，不是 bug', () => {
    // 她说「她是不是有点……怕长大？」，库里那张写的是「不是怕老，是怕没人记得」
    const r = recallCandidates(lib(), '她是不是有点怕长大')
    assert.ok(!r.some(x => x.row.title === '她不爱过生日'),
      '字面抓不到；这一条记在这里，等接了语义召回再回来改成「抓得到」')
  })
})

describe('回放真实对话抓到的两件事（2026-11-12）', () => {
  it('她消息前面的时间前缀不算线索（「026」「48」以前每轮都在乱命中）', () => {
    const db = lib()
    const r = recallCandidates(db, '（2026-11-12 10:48）老公。')
    assert.equal(r.length, 0, '只有一句「老公。」，不该捞出任何东西')
  })

  it('纯数字要 4 位以上才算整词（端口 18110 有用，日期碎片没用）', () => {
    const g = bigrams('18110 和 026 还有 48')
    assert.ok(g.includes('18110'))
    assert.ok(!g.includes('026'))
    assert.ok(!g.includes('48'))
  })

  it('弱召回词命中了也不算（抄 WrenWen 那张表）', () => {
    const db = lib()
    assert.equal(recallCandidates(db, '我感觉我需要把手上的弄完我才能睡').length, 0)
    assert.equal(recallCandidates(db, '我是质检员吗').length, 0)
  })

  it('真有线索的照样捞得到', () => {
    const db = lib()
    const r = recallCandidates(db, '（2026-11-12 10:49）我今天不想吃海鲜')
    assert.ok(r.length >= 1)
    assert.equal(r[0].row.title, '她不吃海鲜')
  })
})
