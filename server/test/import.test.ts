import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { openDb } from '../src/db.ts'
import { importXiaoke } from '../src/import-xiaoke.ts'
import { tempDir } from './helpers.ts'
import { WAKE_MARKER } from '../src/recorder.ts'

test('导入 xiaoke：角色对应、可重复运行、dry-run 不写入', () => {
  const { dir, cleanup } = tempDir()
  try {
    const srcPath = join(dir, 'xiaoke.sqlite')
    const src = new DatabaseSync(srcPath)
    src.exec(`CREATE TABLE timeline_records (id TEXT PRIMARY KEY, sequence INTEGER, request_id TEXT, created_at TEXT,
      source TEXT, role TEXT, content TEXT, eligible_for_handoff INTEGER DEFAULT 1)`)
    const ins = src.prepare('INSERT INTO timeline_records(id, sequence, request_id, created_at, source, role, content) VALUES (?, ?, ?, ?, ?, ?, ?)')
    ins.run('u1', 1, 'r1', '2026-09-29T14:25:00.239469+00:00', 'unknown', 'user', 'hello')
    ins.run('a1', 2, 'r1', '2026-09-29T14:25:02.460150+00:00', 'unknown', 'assistant', '在')
    ins.run('e1', 3, null, '2026-09-29T15:00:00+00:00', 'dylan', 'event', '（发了 Bark）')
    ins.run('x1', 4, 'r2', '2026-09-29T15:00:01+00:00', 'unknown', 'user', '   ')
    src.close()

    const db = openDb(':memory:')
    assert.deepEqual(importXiaoke(db, srcPath, { dryRun: true }), { total: 4, inserted: 3, skipped: 1, dryRun: true })
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM episodes').get() as any).n, 0)

    assert.equal(importXiaoke(db, srcPath).inserted, 3)
    assert.equal(importXiaoke(db, srcPath).inserted, 0, '第二次全部跳过')
    const rows = db.prepare('SELECT ts, actor, kind, content, source_ref FROM episodes ORDER BY ts').all() as any[]
    assert.deepEqual(rows.map(r => [r.actor, r.kind, r.source_ref]), [
      ['erica', 'message', 'xiaoke:u1'], ['ai', 'message', 'xiaoke:a1'], ['system', 'note', 'xiaoke:e1']
    ])
    assert.equal(rows[0].ts, '2026-09-29T14:25:00.239Z')
  } finally { cleanup() }
})

test('导入 xiaoke：唤醒那一对记成 wake；--until 之后的不导', () => {
  const { dir, cleanup } = tempDir()
  try {
    const srcPath = join(dir, 'xiaoke.sqlite')
    const src = new DatabaseSync(srcPath)
    src.exec(`CREATE TABLE timeline_records (id TEXT PRIMARY KEY, sequence INTEGER, request_id TEXT, created_at TEXT,
      source TEXT, role TEXT, content TEXT, eligible_for_handoff INTEGER DEFAULT 1)`)
    const ins = src.prepare('INSERT INTO timeline_records(id, sequence, request_id, created_at, source, role, content) VALUES (?, ?, ?, ?, ?, ?, ?)')
    ins.run('w1', 1, 'rw', '2026-10-01T00:00:00+00:00', 'unknown', 'user', `最近记录……${WAKE_MARKER}`)
    ins.run('w2', 2, 'rw', '2026-10-01T00:00:05+00:00', 'unknown', 'assistant', '想她了')
    ins.run('u1', 3, 'r1', '2026-10-27T10:16:00+00:00', 'unknown', 'user', '接入后的')
    src.close()
    const db = openDb(':memory:')
    assert.equal(importXiaoke(db, srcPath, { until: '2026-10-27T10:12:00Z' }).inserted, 2)
    const rows = db.prepare('SELECT channel, actor, kind FROM episodes ORDER BY ts').all() as any[]
    assert.deepEqual(rows.map(r => [r.channel, r.actor, r.kind]), [['wake', 'system', 'wake_prompt'], ['wake', 'ai', 'wake']])
  } finally { cleanup() }
})
