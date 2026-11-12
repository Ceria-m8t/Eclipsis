// 别名展开（2026-11-12，她问「我搜妈妈有记录，搜我妈就没有」）。
//
// 数据是这样的：经历表里「我妈」出现在 248 条原话里，「妈妈」144 条；
// 而记忆卡片里「我妈」**0 条**、「妈妈」6 条 —— 她平时说「我妈」，他记卡时写「妈妈」。
// 所以她用自己的说法搜，一条都搜不到。
//
// recall-secretary 的第 4 条规矩说的就是这个：
//   「她平时不说『妈妈』说『我妈』，卡名对不上就认不出。」
// 解法不是让他改写法（他写「妈妈」没错），而是**召回时把说法展开**。
import type { DB } from '../db.ts'
import { addColumns } from '../db.ts'

/** 出厂带的几组说法。少而稳，宁可漏不要乱——乱了会把不相干的事捞上来 */
export const BUILTIN_ALIASES: string[][] = [
  ['例假', '大姨妈', '生理期', '月经', '那几天'],
  ['止痛药', '止疼药', '布洛芬'],
  ['落枕', '脖子疼', '颈椎'],
  ['口腔溃疡', '嘴里溃疡', '上火'],
  ['外卖', '点餐', '叫饭'],
  ['睡眠周期', '作息', 'DSPS', '昼夜颠倒'],
  ['休学', '退学', '请假'],
  ['换窗', '新窗口', '开新窗'],
  ['玩偶', '娃娃', '毛绒'],
]

export function ensureAliasSchema(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_aliases (
    id INTEGER PRIMARY KEY,
    term TEXT NOT NULL,
    canonical TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT 'her',
    created_at TEXT NOT NULL,
    UNIQUE (term, canonical)
  )`)
  addColumns(db, 'memory_aliases', { created_by: "TEXT NOT NULL DEFAULT 'her'" })
}

export function addAlias(db: DB, term: string, canonical: string, by = 'her', now: Date = new Date()):
  { ok: true } | { ok: false; error: string } {
  ensureAliasSchema(db)
  const t = String(term ?? '').trim()
  const c = String(canonical ?? '').trim()
  if (t.length < 1 || c.length < 1) return { ok: false, error: '两边都要填：你平时怎么说、库里写的是什么' }
  if (t === c) return { ok: false, error: '两个一样就不用加了' }
  db.prepare(`INSERT OR IGNORE INTO memory_aliases (term, canonical, created_by, created_at) VALUES (?, ?, ?, ?)`)
    .run(t, c, by, now.toISOString())
  return { ok: true }
}

export function removeAlias(db: DB, id: number): boolean {
  ensureAliasSchema(db)
  return Number(db.prepare('DELETE FROM memory_aliases WHERE id = ?').run(id).changes) > 0
}

export function listAliases(db: DB): { id: number; term: string; canonical: string; createdBy: string }[] {
  ensureAliasSchema(db)
  return (db.prepare('SELECT id, term, canonical, created_by FROM memory_aliases ORDER BY id').all() as unknown as any[])
    .map(r => ({ id: r.id, term: r.term, canonical: r.canonical, createdBy: r.created_by }))
}

/** 人物卡上的那几组说法（「我妈」→「妈妈」靠的就是这里） */
function peopleGroups(db: DB): string[][] {
  try {
    const rows = db.prepare('SELECT name, slug, aliases FROM people').all() as unknown as { name: string; slug: string; aliases: string }[]
    return rows.map(r => {
      let a: string[] = []
      try { a = JSON.parse(r.aliases) } catch { a = [] }
      return [...new Set([r.name, ...a].filter(x => typeof x === 'string' && x.length >= 1))]
    }).filter(g => g.length > 1)
  } catch { return [] }
}

function customGroups(db: DB): string[][] {
  try {
    const rows = listAliases(db)
    const byCanonical = new Map<string, Set<string>>()
    for (const r of rows) {
      const set = byCanonical.get(r.canonical) ?? new Set<string>([r.canonical])
      set.add(r.term)
      byCanonical.set(r.canonical, set)
    }
    return [...byCanonical.values()].map(s => [...s])
  } catch { return [] }
}

export interface Expansion {
  /** 原文里出现的那些说法 */
  matched: string[]
  /** 补进来的别名 */
  added: string[]
  /** 拿去打分的那串（原句 + 补的说法） */
  text: string
}

/**
 * 把一句话里出现的说法展开成「同一件事的所有说法」。
 * 只补**整词出现过**的那几组，不做模糊联想 —— 乱补会把不相干的事捞上来。
 */
export function expandQuery(db: DB, query: string): Expansion {
  const q = String(query ?? '')
  const groups = [...peopleGroups(db), ...customGroups(db), ...BUILTIN_ALIASES]
  const matched: string[] = []
  const added: string[] = []
  for (const group of groups) {
    const hit = group.find(w => w.length >= 1 && q.includes(w))
    if (!hit) continue
    matched.push(hit)
    for (const w of group) {
      if (w !== hit && !q.includes(w) && !added.includes(w)) added.push(w)
    }
  }
  return { matched, added, text: added.length ? `${q} ${added.join(' ')}` : q }
}
