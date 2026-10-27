// 把 xiaoke 的时间线导进经历表。只读打开 xiaoke 的库，不改它。
// 可重复运行：每条按 xiaoke:<id> 去重，已导入的跳过。
//   node server/src/import-xiaoke.ts [--from /root/xiaoke/data/xiaoke.sqlite] [--until ISO时间] [--dry-run]
// 影子网关接入后，新对话由网关自己记；再导入时要用 --until 截到接入时刻，否则会记两遍。
import { DatabaseSync } from 'node:sqlite'
import { openDb, tx, addEpisode, type DB } from './db.ts'
import { loadConfig } from './config.ts'
import { WAKE_MARKER } from './recorder.ts'

interface Row { id: string; sequence: number; request_id: string | null; created_at: string; source: string; role: string; content: string }

const ACTOR: Record<string, string> = { user: 'erica', assistant: 'ai', event: 'system' }

export function importXiaoke(target: DB, sourcePath: string, opts: { dryRun?: boolean; until?: string } = {}) {
  const src = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    const until = opts.until ? new Date(opts.until).getTime() : Infinity
    if (Number.isNaN(until)) throw new Error(`--until 不是有效时间：${opts.until}`)
    const rows = (src.prepare('SELECT id, sequence, request_id, created_at, source, role, content FROM timeline_records ORDER BY sequence').all() as unknown as Row[])
      .filter(r => new Date(r.created_at).getTime() < until)
    // Dylan 的唤醒经过 xiaoke 时，提示词被存成了 user、他的回应存成了 assistant
    const wakeRequests = new Set(rows.filter(r => r.role === 'user' && r.request_id && String(r.content).includes(WAKE_MARKER)).map(r => r.request_id))
    let inserted = 0, skipped = 0
    const run = () => {
      for (const r of rows) {
        const actor = ACTOR[r.role]
        if (!actor || !String(r.content || '').trim()) { skipped++; continue }
        const ts = new Date(r.created_at)
        const wake = !!r.request_id && wakeRequests.has(r.request_id)
        const ok = addEpisode(target, {
          ts: Number.isNaN(ts.getTime()) ? r.created_at : ts.toISOString(),
          channel: wake ? 'wake' : 'chat', scope: 'daily',
          actor: wake && r.role === 'user' ? 'system' : actor,
          kind: wake ? (r.role === 'user' ? 'wake_prompt' : 'wake') : r.role === 'event' ? 'note' : 'message',
          content: r.content,   // 原样保留（含 <current_time>、时间前缀），清洗交给组装器
          meta: { imported: 'xiaoke', xiaoke_sequence: r.sequence, xiaoke_source: r.source },
          sourceRef: `xiaoke:${r.id}`,
          xiaokeId: r.id
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
  const untilIdx = args.indexOf('--until')
  const result = importXiaoke(db, from, { dryRun: args.includes('--dry-run'), until: untilIdx >= 0 ? args[untilIdx + 1] : undefined })
  console.log(JSON.stringify(result))
  db.close()
}
