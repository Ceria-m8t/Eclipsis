// OB 221 张卡 → 我们自己的 memories 表（记忆库二改第一期：搬家）。
//
//   node server/src/memory/migrate-ob.ts --dry-run      # 只算不写，打报告
//   node server/src/memory/migrate-ob.ts                # 写进 config 里那个库
//   node server/src/memory/migrate-ob.ts --into /tmp/x.sqlite
//   node server/src/memory/migrate-ob.ts --reset        # 把搬进来的（bucket_id 非空）清掉重搬
//
// 规矩：
//   - OB 一个字节都不改（只读文件），docker 照常跑着，和我们并跑对照。
//   - 原卡整份存进 raw，被合并掉的整份存进 memory_merges → 搬错了能回退。
//   - **双轨里的「情绪」那一栏搬家时留空**：原卡没有分栏，硬拆就是替他编。
//     以后新写入的记忆才有两栏。
//   - 规则拿不准的标 needs_review，不进召回。
import { readFileSync } from 'node:fs'
import { openDb, tx, type DB } from '../db.ts'
import { loadConfig } from '../config.ts'
import { ensureMemorySchema, RESIDENT_CAP, type Grade, type Layer } from './schema.ts'
import { readObCards, emptyDirs, OB_BUCKETS, type ObCard } from './ob-cards.ts'
import { classify, dupGroups, guessSubject, PEOPLE_SEEDS, type Classified } from './classify.ts'

export interface MigrateReport {
  cards: number
  inserted: number
  skipped: number
  byLayer: Record<Layer, number>
  byGrade: Record<Grade, number>
  bySubject: Record<string, number>
  needsReview: number
  mergedGroups: number
  mergedCards: number
  residentCandidates: number
  residentTrimmed: number
  people: { slug: string; mentions: number }[]
  emptyDirs: string[]
  dryRun: boolean
}

interface Prepared {
  card: ObCard
  c: Classified
  mergedIntoBucket: string | null
  mergeOverlap: number
}

/** 算一遍：分层、主体、三档、合并计划。不碰数据库 */
export function planMigration(cards: ObCard[]): { prepared: Prepared[]; groups: ReturnType<typeof dupGroups>; residentTrimmed: number } {
  const groups = dupGroups(cards)
  const droppedOf = new Map<string, { keep: string; overlap: number }>()
  for (const g of groups) for (const d of g.drop) droppedOf.set(d.card.bucketId, { keep: g.keep.bucketId, overlap: d.overlap })

  const prepared: Prepared[] = cards.map(card => {
    const dropped = droppedOf.get(card.bucketId)
    return {
      card,
      c: classify(card),
      mergedIntoBucket: dropped?.keep ?? null,
      mergeOverlap: dropped?.overlap ?? 0,
    }
  })

  // 常驻有名额（≤30）：超了按 importance 降序留，其余降成「重要」。
  // 搬家本身几乎不产生常驻（只有 OB 原来标 permanent 的那张），这里是兜底。
  const residents = prepared.filter(p => p.c.grade === 'resident' && !p.mergedIntoBucket)
    .sort((a, b) => b.card.importance - a.card.importance || b.card.created.localeCompare(a.card.created))
  let residentTrimmed = 0
  for (const p of residents.slice(RESIDENT_CAP)) { p.c.grade = 'important'; residentTrimmed++ }
  return { prepared, groups, residentTrimmed }
}

export function migrateOb(db: DB, opts: { root?: string; dryRun?: boolean; reset?: boolean; now?: Date } = {}): MigrateReport {
  const root = opts.root ?? OB_BUCKETS
  const now = (opts.now ?? new Date()).toISOString()
  ensureMemorySchema(db)
  const cards = readObCards(root)
  const { prepared, groups, residentTrimmed } = planMigration(cards)

  const report: MigrateReport = {
    cards: cards.length,
    inserted: 0,
    skipped: 0,
    byLayer: { fact: 0, state: 0, bond: 0 },
    byGrade: { resident: 0, important: 0, normal: 0 },
    bySubject: {},
    needsReview: 0,
    residentCandidates: 0,
    residentTrimmed,
    mergedGroups: groups.length,
    mergedCards: groups.reduce((n, g) => n + g.drop.length, 0),
    people: [],
    emptyDirs: emptyDirs(root),
    dryRun: !!opts.dryRun,
  }

  // 人物卡的壳：先把名字和出现次数记下来，**默认不启用**（先列哪几个人她还没定）
  const mentions = new Map<string, number>()
  for (const card of cards) {
    const g = guessSubject(card)
    for (const [k, n] of Object.entries(g.counts)) {
      if (!k.startsWith('person:') || n <= 0) continue
      mentions.set(k.slice(7), (mentions.get(k.slice(7)) ?? 0) + n)
    }
  }
  report.people = PEOPLE_SEEDS.map(p => ({ slug: p.slug, mentions: mentions.get(p.slug) ?? 0 }))

  const run = () => {
    if (opts.reset) {
      db.prepare('DELETE FROM memories WHERE bucket_id IS NOT NULL').run()
      db.prepare('DELETE FROM memory_merges').run()
    }

    const ins = db.prepare(`INSERT OR IGNORE INTO memories
      (bucket_id, layer, subject, title, fact_body, feeling, why, tags, grade, valence, arousal,
       valid_from, valid_until, source, created_at, updated_at, dont_surface, needs_review, review_note, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

    for (const p of prepared) {
      const { card, c } = p
      const tags = [...new Set([...card.domain, ...card.tags, ...(c.residentCandidate ? ['常驻候选'] : [])])]
      const r = ins.run(
        card.bucketId, c.layer, c.subject, card.title, card.body, null, card.why || null,
        JSON.stringify(tags), c.grade, card.valence, card.arousal,
        c.validFrom, c.validUntil, card.sourceTool || 'migrate', card.created, card.lastActive || card.created,
        card.dontSurface ? 1 : 0, c.needsReview ? 1 : 0, c.reviewNote || null,
        JSON.stringify({ ob: card.raw, file: card.file, body: card.body, rules: c.reasons })
      )
      if (Number(r.changes) > 0) {
        report.inserted++
        if (!p.mergedIntoBucket) {
          report.byLayer[c.layer]++
          report.byGrade[c.grade]++
          report.bySubject[c.subject] = (report.bySubject[c.subject] ?? 0) + 1
          if (c.needsReview) report.needsReview++
          if (c.residentCandidate) report.residentCandidates++
        }
      } else report.skipped++
    }

    // 合并：被合掉的那张指向留下的那张、软删；整张原卡进 memory_merges（可回退）
    const idOf = db.prepare('SELECT id FROM memories WHERE bucket_id = ?')
    const mark = db.prepare(`UPDATE memories SET merged_into = ?, retracted_at = ?, retract_reason = 'merged', updated_at = ?
      WHERE bucket_id = ? AND retracted_at IS NULL`)
    const evid = db.prepare(`INSERT INTO memory_merges (kept_bucket_id, dropped_bucket_id, overlap, reason, dropped_raw, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
    for (const g of groups) {
      const keptRow = idOf.get(g.keep.bucketId) as { id: number } | undefined
      if (!keptRow) continue
      for (const d of g.drop) {
        // 已经合过的不再记一遍证据（这个脚本可以反复跑）
        if (Number(mark.run(keptRow.id, now, now, d.card.bucketId).changes) === 0) continue
        evid.run(
          g.keep.bucketId, d.card.bucketId, d.overlap,
          `搬家时合并：2-gram 重合 ${(d.overlap * 100).toFixed(0)}%，留下正文更长的那张`,
          JSON.stringify({ ob: d.card.raw, file: d.card.file, body: d.card.body }), now
        )
      }
    }

    // 人物卡：次数每次重算，**他手写的那半（his_note）永不覆盖**
    const pins = db.prepare(`INSERT INTO people
      (slug, name, aliases, relation, ambiguous, kin, card_enabled, mentions, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET aliases = excluded.aliases, relation = excluded.relation,
        ambiguous = excluded.ambiguous, kin = excluded.kin, mentions = excluded.mentions,
        updated_at = excluded.updated_at`)
    for (const s of PEOPLE_SEEDS) {
      pins.run(s.slug, s.name, JSON.stringify(s.aliases), s.relation, s.ambiguous ? 1 : 0, s.kin ? 1 : 0,
        mentions.get(s.slug) ?? 0, now, now)
    }

    if (opts.dryRun) throw new DryRun()
  }

  try { tx(db, run) } catch (e) { if (!(e instanceof DryRun)) throw e }
  return report
}

class DryRun extends Error {}

export function formatReport(r: MigrateReport): string {
  const line = (k: string, v: unknown) => `  ${k.padEnd(14)} ${v}`
  const sub = Object.entries(r.bySubject).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('、')
  return [
    `OB → memories ${r.dryRun ? '（只算不写）' : ''}`,
    line('读到卡片', `${r.cards} 张`),
    line('写入', `${r.inserted} 条（已存在跳过 ${r.skipped}）`),
    line('分层', `事实 ${r.byLayer.fact} / 近况 ${r.byLayer.state} / 我们之间 ${r.byLayer.bond}`),
    line('三档', `常驻 ${r.byGrade.resident} / 重要 ${r.byGrade.important} / 普通 ${r.byGrade.normal}`),
    line('常驻候选', `${r.residentCandidates} 条（打了标签，等她或他点头才真进固定前缀）` +
      (r.residentTrimmed ? `；超名额降级 ${r.residentTrimmed} 条` : '')),
    line('主体', sub || '（无）'),
    line('等人看一眼', `${r.needsReview} 条（needs_review=1，不进召回）`),
    line('合并', `${r.mergedGroups} 组、合掉 ${r.mergedCards} 张（证据在 memory_merges，可回退）`),
    line('人物卡', r.people.map(p => `${p.slug} ${p.mentions}`).join('、') + '（都先不启用）'),
    line('空目录', r.emptyDirs.length ? r.emptyDirs.join('、') : '（无）'),
  ].join('\n')
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const intoIdx = args.indexOf('--into')
  const path = intoIdx >= 0 ? args[intoIdx + 1] : loadConfig().dbPath
  const rootIdx = args.indexOf('--root')
  const db = openDb(path)
  try {
    const r = migrateOb(db, {
      root: rootIdx >= 0 ? args[rootIdx + 1] : undefined,
      dryRun: args.includes('--dry-run'),
      reset: args.includes('--reset'),
    })
    console.log(`库：${path}`)
    console.log(formatReport(r))
    if (args.includes('--json')) console.log(JSON.stringify(r, null, 2))
  } finally {
    db.close()
  }
}

/** 调试用：看某一张卡被判成了什么、凭哪条规则 */
export function explainCard(file: string, root = OB_BUCKETS) {
  const text = readFileSync(`${root}/${file}`, 'utf8')
  const [card] = readObCards(root).filter(c => c.file === file)
  return { card: card ?? null, classified: card ? classify(card) : null, bytes: text.length }
}
