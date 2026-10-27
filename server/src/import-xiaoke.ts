// 把 xiaoke 的时间线导进经历表。只读打开 xiaoke 的库，不改它。
// 可重复运行：每条按 xiaoke:<id> 去重，已导入的跳过。
//   node server/src/import-xiaoke.ts [--from /root/xiaoke/data/xiaoke.sqlite] [--dry-run]
import { DatabaseSync } from 'node:sqlite'
import { openDb, tx, addEpisode, type DB } from './db.ts'
import { loadConfig } from './config.ts'

interface Row { id: string; sequence: number; created_at: string; source: string; role: string; content: string }

const ACTOR: Record<string, string> = { user: 'erica', assistant: 'ai', event: 'system' }

export function importXiaoke(target: DB, sourcePath: string, opts: { dryRun?: boolean } = {}) {
  const src = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    const rows = src.prepare('SELECT id, sequence, created_at, source, role, content FROM timeline_records ORDER BY sequence').all() as unknown as Row[]
    let inserted = 0, skipped = 0
    const run = () => {
      for (const r of rows) {
        const actor = ACTOR[r.role]
        if (!actor || !String(r.content || '').trim()) { skipped++; continue }
        const ts = new Date(r.created_at)
        const ok = addEpisode(target, {
          ts: Number.isNaN(ts.getTime()) ? r.created_at : ts.toISOString(),
          channel: 'chat', scope: 'daily', actor,
          kind: r.role === 'event' ? 'note' : 'message',
          content: r.content,   // 原样保留（含 <current_time>、时间前缀），清洗交给组装器
          meta: { imported: 'xiaoke', xiaoke_sequence: r.sequence, xiaoke_source: r.source },
          sourceRef: `xiaoke:${r.id}`
        })
        if (ok) inserted++; else skipped++
      }
      if (opts.dryRun) throw new DryRun()
    }
    try { tx(target, run) } catch (e) { if (!(e instanceof DryRun)) throw e }
    return { total: rows.length, inserted, skipped, dryRun: !!opts.dryRun }
  } finally {
    src.close()
  }
}

class DryRun extends Error {}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const fromIdx = args.indexOf('--from')
  const from = fromIdx >= 0 ? args[fromIdx + 1] : '/root/xiaoke/data/xiaoke.sqlite'
  const db = openDb(loadConfig().dbPath)
  const result = importXiaoke(db, from, { dryRun: args.includes('--dry-run') })
  console.log(JSON.stringify(result))
  db.close()
}
