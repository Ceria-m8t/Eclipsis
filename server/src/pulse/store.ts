// 脉 SQLite schema + 持久化
import type { DB } from '../db.ts'
import type { PulseState } from './types.ts'
import { createDefaultState } from './types.ts'

const PULSE_SCHEMA = `
-- 身体状态（单行，JSON 存完整 PulseState）
CREATE TABLE IF NOT EXISTS pulse_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 心率历史（画曲线用）
CREATE TABLE IF NOT EXISTS pulse_hr_history (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  hr INTEGER NOT NULL,
  temp REAL,
  chord TEXT,
  emotion TEXT
);
CREATE INDEX IF NOT EXISTS idx_pulse_hr_ts ON pulse_hr_history(ts);

-- 生病记录
CREATE TABLE IF NOT EXISTS pulse_sick_log (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  reason TEXT NOT NULL,
  peak_temp REAL,
  notes TEXT
);
`

export function ensurePulseSchema(db: DB): void {
  db.exec(PULSE_SCHEMA)
  const row = db.prepare('SELECT id FROM pulse_state WHERE id = 1').get()
  if (!row) {
    const initial = createDefaultState()
    db.prepare('INSERT INTO pulse_state(id, state, updated_at) VALUES (1, ?, ?)')
      .run(JSON.stringify(initial), initial.updatedAt)
  }
}

export function loadPulseState(db: DB): PulseState {
  const row = db.prepare('SELECT state FROM pulse_state WHERE id = 1').get() as { state: string }
  return JSON.parse(row.state)
}

export function savePulseState(db: DB, s: PulseState): void {
  db.prepare('UPDATE pulse_state SET state = ?, updated_at = ? WHERE id = 1')
    .run(JSON.stringify(s), s.updatedAt)
}

/** 记一条心率历史（每次 tick 调用，前端画日曲线） */
export function recordHr(db: DB, s: PulseState): void {
  db.prepare('INSERT INTO pulse_hr_history(ts, hr, temp, chord, emotion) VALUES (?, ?, ?, ?, ?)')
    .run(s.updatedAt, s.vitals.heartRate, s.vitals.temperature, s.vitals.chord, s.emotion)
}

/** 清理超过 7 天的心率历史 */
export function pruneHrHistory(db: DB): void {
  db.prepare("DELETE FROM pulse_hr_history WHERE ts < datetime('now', '-7 days')").run()
}
