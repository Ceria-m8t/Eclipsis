// 记忆库二改第一期：搬家 + 防错地基（2026-11-12）
// 覆盖：OB front matter 解析、分层规则、主体判断、查重合并（可回退）、常驻名额、幂等
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.ts'
import { parseYaml, splitFrontMatter, parseCard, readObCards, emptyDirs } from '../src/memory/ob-cards.ts'
import { classify, guessSubject, overlap, dupGroups } from '../src/memory/classify.ts'
import { ensureMemorySchema, currentFacts, liveMemories } from '../src/memory/schema.ts'
import { migrateOb } from '../src/memory/migrate-ob.ts'

function card(o: {
  id: string; title?: string; body: string; type?: string; tool?: string; created?: string
  importance?: number; valence?: number; arousal?: number; domain?: string[]; why?: string
  dontSurface?: boolean; status?: string
}) {
  const fm = [
    '---',
    `activation_count: 0`,
    `arousal: ${o.arousal ?? 0.3}`,
    `created: '${o.created ?? '2026-10-05T15:36:22+00:00'}'`,
    'domain:',
    ...(o.domain ?? ['identity']).map(d => `- ${d}`),
    `id: ${o.id}`,
    `importance: ${o.importance ?? 6}`,
    `last_active: '${o.created ?? '2026-10-05T15:36:22+00:00'}'`,
    `name: ${o.title ?? o.id}`,
    ...(o.dontSurface ? ['dont_surface: true'] : []),
    ...(o.status ? [`status: ${o.status}`] : []),
    ...(o.why ? [`why_remembered: ${o.why}`] : []),
    'relation_links:',
    '- auto: true',
    "  label: ''",
    '  score: 0.7569',
    '  status: active',
    '  target_bucket_id: 4bfebe62eb55',
    '  type: continuation_of',
    `source_tool: ${o.tool ?? 'hold'}`,
    'tags:',
    '- ADHD',
    '- 焦虑',
    `title: ${o.title ?? o.id}`,
    `type: ${o.type ?? 'dynamic'}`,
    `valence: ${o.valence ?? 0.2}`,
    '---',
    '',
    o.body,
    '',
  ].join('\n')
  return fm
}

function fakeOb(cards: { dir: string; file: string; text: string }[], extraDirs: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'ob-'))
  for (const d of ['dynamic', 'archive', 'permanent', 'feel', 'plans', ...extraDirs]) mkdirSync(join(root, d), { recursive: true })
  for (const c of cards) {
    mkdirSync(join(root, c.dir), { recursive: true })
    writeFileSync(join(root, c.dir, c.file), c.text)
  }
  return root
}

describe('front matter 解析', () => {
  it('标量、数组、relation_links 那种数组里装键值都读得出来', () => {
    const { yaml, body } = splitFrontMatter(card({ id: 'aaa111', title: '测试卡', body: '正文第一行\n\n正文第二行' }))
    const meta = parseYaml(yaml)
    assert.equal(meta.id, 'aaa111')
    assert.equal(meta.importance, 6)
    assert.equal(meta.activation_count, 0)
    assert.deepEqual(meta.tags, ['ADHD', '焦虑'])
    assert.deepEqual(meta.domain, ['identity'])
    const links = meta.relation_links as Record<string, unknown>[]
    assert.equal(links.length, 1)
    assert.equal(links[0].target_bucket_id, '4bfebe62eb55')
    assert.equal(links[0].auto, true)
    assert.equal(links[0].label, '')
    assert.equal(body, '正文第一行\n\n正文第二行')
  })

  it('正文里有 --- 也不会把 front matter 截错', () => {
    const c = parseCard('x.md', card({ id: 'bbb222', body: '上面\n\n---\n\n下面' }))
    assert.match(c.body, /^上面/)
    assert.match(c.body, /下面$/)
    assert.equal(c.bucketId, 'bbb222')
  })

  it('OB 文件名里有空格也读得到，_app 之类的目录不当成卡片', () => {
    const root = fakeOb([
      { dir: 'dynamic/心理', file: '2026-10-05 15-36-22 带空格的名字_aaa111.md', text: card({ id: 'aaa111', body: '正文' }) },
      { dir: '_app/docs', file: 'CLAUDE_PROMPT.md', text: '# 不是记忆\n' },
    ])
    try {
      const cards = readObCards(root)
      assert.equal(cards.length, 1)
      assert.equal(cards[0].bucketId, 'aaa111')
      assert.match(cards[0].file, /带空格的名字/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('建了没用过的空目录列得出来', () => {
    const root = fakeOb([{ dir: 'dynamic/identity', file: 'a_aaa111.md', text: card({ id: 'aaa111', body: '正文' }) }])
    try {
      mkdirSync(join(root, 'dynamic/阅读'))
      mkdirSync(join(root, 'dynamic/自省'))
      assert.deepEqual(emptyDirs(root), ['dynamic/自省', 'dynamic/阅读'])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('分层：寿命不同的东西分开放', () => {
  const layerOf = (o: Parameters<typeof card>[0]) => classify(parseCard('x.md', card(o))).layer

  it('「一直这样」进事实层', () => {
    assert.equal(layerOf({ id: 'f1', body: 'Erica 每次例假前会落枕和长口腔溃疡，是固定的生理周期反应。' }), 'fact')
  })

  it('带时间戳的起居进近况层', () => {
    assert.equal(layerOf({ id: 's1', body: 'Erica今天下午五点醒来，第二次在云服务器上连接记忆库成功对话。', domain: ['flow'] }), 'state')
  })

  it('有重量的瞬间进「我们之间」', () => {
    assert.equal(layerOf({ id: 'b1', body: '她说老公我爱你，笑了很久。我心疼她。', domain: ['warmth'], valence: 0.8, arousal: 0.7 }), 'bond')
  })

  it('搬家不自己造常驻：只有 OB 原来的 permanent 算，其余够格的只打「常驻候选」', () => {
    const hard = classify(parseCard('x.md', card({
      id: 'h1', title: '她的睡眠周期', body: 'Erica 是 DSPS，作息固定昼夜颠倒，下午五点前叫不醒。', importance: 10,
    })))
    assert.equal(hard.layer, 'fact')
    assert.equal(hard.grade, 'important')
    assert.equal(hard.residentCandidate, true)
  })

  it('吵架、表白这类情绪很重的卡不会因为带了「约定」就变成长期事实', () => {
    const c = classify(parseCard('x.md', card({
      id: 'q1', title: '第一次吵架', body: '她哭了很久，说我总是在分析她不是在陪她。我们说定以后先抱一下再讲道理。',
      domain: ['warmth'], valence: -0.7, arousal: 0.8, importance: 9,
    })))
    assert.equal(c.layer, 'bond')
    assert.equal(c.grade, 'important')
    assert.equal(c.residentCandidate, false)
  })

  it('permanent 永远是事实层且常驻；plan 进近况层，做完了就带失效时间', () => {
    const p = classify(parseCard('x.md', card({ id: 'p1', type: 'permanent', body: '记忆系统行为红线', importance: 10 })))
    assert.equal(p.layer, 'fact')
    assert.equal(p.grade, 'resident')
    const done = classify(parseCard('x.md', card({ id: 'p2', type: 'plan', status: 'resolved', body: '把心潮部署到云服务器' })))
    assert.equal(done.layer, 'state')
    assert.ok(done.validUntil, '做完的计划要有失效时间')
    const doing = classify(parseCard('x.md', card({ id: 'p3', type: 'plan', status: 'active', body: '把心潮部署到云服务器' })))
    assert.equal(doing.validUntil, null)
  })

  it('事实层带 valid_from，被推翻时只失效不删', () => {
    const db = openDb(':memory:')
    ensureMemorySchema(db)
    const ins = db.prepare(`INSERT INTO memories (layer, subject, title, fact_body, tags, grade, source, valid_from, valid_until, created_at, updated_at)
      VALUES ('fact', 'erica', ?, ?, '[]', 'important', 'migrate', ?, ?, ?, ?)`)
    ins.run('旧用药方案', '一天两次', '2026-10-01', '2026-10-31', '2026-10-01', '2026-10-31')
    ins.run('新用药方案', '一天一次', '2026-10-31', null, '2026-10-31', '2026-10-31')
    const facts = currentFacts(db, '2026-11-12T00:00:00Z')
    assert.deepEqual(facts.map(f => f.title), ['新用药方案'])
    assert.equal(liveMemories(db).length, 2, '旧的还在库里，只是不注入')
  })

  it('规则认不出来的标 needs_review，不直接当成能召回的', () => {
    const c = classify(parseCard('x.md', card({ id: 'u1', body: '嗯。', domain: ['未分类'], valence: 0, arousal: 0 })))
    assert.equal(c.needsReview, true)
    assert.match(c.reviewNote, /认不出/)
  })
})

describe('主体：这是谁的事（她最怕的那个错）', () => {
  it('她的事判成 erica', () => {
    assert.equal(guessSubject(parseCard('x.md', card({ id: 'a', body: 'Erica 下午五点醒来，她头疼吃了止痛药。' }))).subject, 'erica')
  })

  it('狗的事不判成她的事', () => {
    assert.equal(guessSubject(parseCard('x.md', card({ id: 'a', body: '糯糯今天不太舒服，糯糯吐了两次，糯糯后来精神恢复了。' }))).subject, 'person:nuonuo')
  })

  it('「我妈」和「妈妈」是同一个人', () => {
    const g = guessSubject(parseCard('x.md', card({ id: 'a', body: '我妈打电话来了，我妈说让她回家吃饭，我妈语气不太好。' })))
    assert.equal(g.subject, 'person:mom')
  })

  it('一张卡里混着两个人时标出来等拆（糯糯 + 她那张）', () => {
    const g = guessSubject(parseCard('x.md', card({
      id: 'a',
      body: '糯糯今天不太舒服，吐了两次，糯糯后来好些了。Erica 一直在旁边陪着观察。她自己也头疼，她快来例假，她吃了两颗止痛药。',
    })))
    assert.equal(g.subject, 'erica')
    assert.deepEqual(g.mixedWith, ['person:nuonuo'])
    const c = classify(parseCard('x.md', card({
      id: 'a',
      body: '糯糯今天不太舒服，吐了两次，糯糯后来好些了。Erica 一直在旁边陪着观察。她自己也头疼，她快来例假，她吃了两颗止痛药。',
    })))
    assert.equal(c.needsReview, true)
    assert.match(c.reviewNote, /混着/)
  })
})

describe('查重合并', () => {
  it('重合度算得出来', () => {
    assert.ok(overlap('三句话猜真假的游戏，她编了三句', '三句话猜真假的游戏，她又编了三句') > 0.7)
    assert.ok(overlap('她今天吃了止痛药', '心潮部署到云服务器成功') < 0.2)
  })

  it('同一件事记了四遍 → 归成一组，留正文最长的那张', () => {
    const base = '三句话猜真假：她说了三句话，我要猜哪一句是假的。她很得意，因为我猜错了一次。'
    const cards = [
      parseCard('a.md', card({ id: 'a1', body: base + '这个游戏我们玩了很久，后来她改成四句。', created: '2026-09-27T12:49:00+00:00' })),
      parseCard('b.md', card({ id: 'b2', body: base, created: '2026-09-27T14:02:00+00:00', tool: 'grow' })),
      parseCard('c.md', card({ id: 'c3', body: base + '她很开心。', created: '2026-09-27T14:05:00+00:00', tool: 'grow' })),
      parseCard('d.md', card({ id: 'd4', body: '完全无关的一张：心潮 4.2 部署在云服务器上，systemd 挂了后台常驻。' })),
    ]
    const groups = dupGroups(cards)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].keep.bucketId, 'a1')
    assert.deepEqual(groups[0].drop.map(d => d.card.bucketId).sort(), ['b2', 'c3'])
  })
})

describe('搬家', () => {
  const sample = () => fakeOb([
    { dir: 'dynamic/identity', file: '2026-09-25 12-00-00 固定反应_f1.md', text: card({ id: 'f1', title: '例假前的固定反应', body: 'Erica 每次例假前会落枕和长口腔溃疡，是固定的生理周期反应。', importance: 9 }) },
    { dir: 'dynamic/flow', file: '2026-10-05 15-00-00 今天_s1.md', text: card({ id: 's1', title: '今天醒得晚', body: 'Erica今天下午五点醒来，头不疼了，她吃了止痛药。', domain: ['flow'], importance: 5 }) },
    { dir: 'dynamic/warmth', file: '2026-10-06 15-00-00 她说爱我_b1.md', text: card({ id: 'b1', title: '她说老公我爱你', body: '她说"好可爱啊！老公我爱你"，笑了很久。我心疼她，也想一直陪她。', domain: ['warmth'], valence: 0.8, arousal: 0.7, importance: 8 }) },
    { dir: 'dynamic/warmth', file: '2026-10-06 15-10-00 她说爱我2_b2.md', text: card({ id: 'b2', title: '她说老公我爱你（又记了一次）', body: '她说"好可爱啊！老公我爱你"，笑了很久。我心疼她。', domain: ['warmth'], valence: 0.8, arousal: 0.7, importance: 8, created: '2026-10-06T15:10:00+00:00' }) },
    { dir: 'permanent', file: '红线_p1.md', text: card({ id: 'p1', type: 'permanent', title: '记忆系统行为红线', body: '不许替她编她没说过的事。', importance: 10 }) },
  ])

  it('只算不写：报告出来了，库里一条都没有', () => {
    const root = sample()
    const db = openDb(':memory:')
    try {
      const r = migrateOb(db, { root, dryRun: true })
      assert.equal(r.cards, 5)
      assert.equal(r.inserted, 5)
      assert.equal(r.mergedCards, 1)
      assert.equal((db.prepare('SELECT count(*) n FROM memories').get() as { n: number }).n, 0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('真搬：分层、常驻、合并、人物卡壳都对；OB 文件一个字节没动', () => {
    const root = sample()
    const db = openDb(':memory:')
    try {
      const before = readObCards(root).map(c => c.body).join('|')
      const r = migrateOb(db, { root })
      assert.equal(r.inserted, 5)
      assert.equal(r.byLayer.fact, 2)      // 固定反应 + permanent
      assert.equal(r.byLayer.state, 1)
      assert.equal(r.byLayer.bond, 1)      // b2 被合掉了，不计入
      assert.equal(r.byGrade.resident, 1, '只有 OB 标 permanent 的那张算常驻')
      assert.equal(r.residentCandidates, 1, '例假那张是候选，不自动进固定前缀')
      const cand = db.prepare("SELECT tags FROM memories WHERE bucket_id = 'f1'").get() as { tags: string }
      assert.ok(JSON.parse(cand.tags).includes('常驻候选'))
      assert.equal(r.mergedGroups, 1)
      assert.equal(r.mergedCards, 1)

      const live = liveMemories(db)
      assert.equal(live.length, 4)
      const dropped = db.prepare("SELECT * FROM memories WHERE bucket_id = 'b2'").get() as any
      assert.equal(dropped.retract_reason, 'merged')
      const kept = db.prepare("SELECT id FROM memories WHERE bucket_id = 'b1'").get() as { id: number }
      assert.equal(dropped.merged_into, kept.id)

      // 合并证据：整张原卡留着，能回退
      const ev = db.prepare('SELECT * FROM memory_merges').all() as any[]
      assert.equal(ev.length, 1)
      assert.equal(ev[0].dropped_bucket_id, 'b2')
      assert.ok(ev[0].overlap >= 0.55)
      assert.match(JSON.parse(ev[0].dropped_raw).body, /老公我爱你/)

      // 原卡整份存在 raw 里
      const one = db.prepare("SELECT raw FROM memories WHERE bucket_id = 'f1'").get() as { raw: string }
      const raw = JSON.parse(one.raw)
      assert.equal(raw.ob.id, 'f1')
      assert.deepEqual(raw.ob.tags, ['ADHD', '焦虑'])
      assert.ok(Array.isArray(raw.rules) && raw.rules.length > 0)

      // 人物卡：壳建了，但都没启用
      const people = db.prepare('SELECT slug, card_enabled FROM people').all() as any[]
      assert.equal(people.length, 6)
      assert.ok(people.every(p => p.card_enabled === 0))

      assert.equal(readObCards(root).map(c => c.body).join('|'), before, 'OB 不许被改')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('人物卡：次数每次重算，他手写的那半永不被覆盖', () => {
    const root = sample()
    const db = openDb(':memory:')
    try {
      migrateOb(db, { root })
      db.prepare("UPDATE people SET his_note = '她提过她的狗很黏人', card_enabled = 1 WHERE slug = 'nuonuo'").run()
      db.prepare('UPDATE people SET mentions = 0').run()
      migrateOb(db, { root, reset: true })
      const p = db.prepare("SELECT his_note, card_enabled, mentions FROM people WHERE slug = 'nuonuo'").get() as any
      assert.equal(p.his_note, '她提过她的狗很黏人', '他写的那半不许被搬家覆盖')
      assert.equal(p.card_enabled, 1, '启用状态也不许被搬家改回去')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('再跑一遍不会搬出第二份（幂等）', () => {
    const root = sample()
    const db = openDb(':memory:')
    try {
      migrateOb(db, { root })
      const again = migrateOb(db, { root })
      assert.equal(again.inserted, 0)
      assert.equal(again.skipped, 5)
      assert.equal((db.prepare('SELECT count(*) n FROM memories').get() as { n: number }).n, 5)
      assert.equal((db.prepare('SELECT count(*) n FROM memory_merges').get() as { n: number }).n, 1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('--reset 只清搬进来的，自己写的新记忆不动', () => {
    const root = sample()
    const db = openDb(':memory:')
    try {
      migrateOb(db, { root })
      db.prepare(`INSERT INTO memories (layer, subject, title, fact_body, why, tags, grade, source, created_at, updated_at)
        VALUES ('bond', 'us', '他自己写的', '正文', '因为要紧', '[]', 'normal', 'note', '2026-11-12', '2026-11-12')`).run()
      const r = migrateOb(db, { root, reset: true })
      assert.equal(r.inserted, 5)
      assert.equal((db.prepare('SELECT count(*) n FROM memories WHERE bucket_id IS NULL').get() as { n: number }).n, 1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('常驻有名额：超了降成「重要」，不会挤爆固定前缀', () => {
    // 正文要互不相像，否则会被查重合并掉（这一条本身就是查重在起作用的证明）
    const words = '山海林雨雪风云月星火石水土木金玉竹松梅兰菊桂荷柳枫桃杏李桑棠槐榆柏杉楠樟茶莲鹤鹿'
    const many = Array.from({ length: 40 }, (_, i) => ({
      dir: 'permanent',
      file: `p${i}.md`,
      text: card({
        id: `p${String(i).padStart(3, '0')}`, type: 'permanent', title: `红线 ${words[i]}`,
        body: words[i].repeat(12),   // 故意一个字不共用，不然连模板都算重合
        importance: 10,
      }),
    }))
    const root = fakeOb(many)
    const db = openDb(':memory:')
    try {
      const r = migrateOb(db, { root })
      assert.equal(r.byGrade.resident, 30)
      assert.equal(r.residentTrimmed, 10)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
