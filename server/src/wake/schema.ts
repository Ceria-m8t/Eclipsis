// Wake 模块 SQLite schema（追加到现有库，用 addColumns 兼容旧库）
import type { DB } from '../db.ts'

const WAKE_SCHEMA = `
-- 非精确 Wake 引擎状态（单行）
CREATE TABLE IF NOT EXISTS wake_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  h REAL NOT NULL DEFAULT 0,
  theta REAL NOT NULL DEFAULT 1,
  last_tick_at TEXT NOT NULL,
  last_wake_at TEXT,
  frequency_mode TEXT NOT NULL DEFAULT 'normal',
  custom_params TEXT,                -- JSON: FrequencyParams
  frequency_expires_at TEXT
);

-- 来源因子控制：他调过的来源权重
CREATE TABLE IF NOT EXISTS wake_source_controls (
  source_id TEXT PRIMARY KEY,
  factor REAL NOT NULL DEFAULT 1,
  reason TEXT,
  expires_at TEXT,
  set_at TEXT NOT NULL
);

-- 外部精确来源开关
CREATE TABLE IF NOT EXISTS wake_precise_source_controls (
  source_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  expires_at TEXT,
  set_at TEXT NOT NULL
);

-- 精确 Wake（他自己设的闹钟 + 外部事件）
CREATE TABLE IF NOT EXISTS wake_precise (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  wake_at TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  triggered_at TEXT,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wake_precise_status ON wake_precise(status, wake_at);

-- 生活线头
CREATE TABLE IF NOT EXISTS wake_threads (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  surfaced_count INTEGER NOT NULL DEFAULT 0,
  last_surfaced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wake_threads_status ON wake_threads(status);

-- Wake 机会记录（审计 + 调试）
CREATE TABLE IF NOT EXISTS wake_opportunities (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  sources TEXT,                     -- JSON: SourceReading[]
  reason TEXT NOT NULL,
  precise_wake_id TEXT,
  created_at TEXT NOT NULL,
  outcome TEXT,                     -- silent / trace / message
  fact TEXT,
  content TEXT,
  surfaced_thread_ids TEXT,         -- JSON: string[]
  finished_at TEXT,
  exchange_rid TEXT
);
CREATE INDEX IF NOT EXISTS idx_wake_opp_created ON wake_opportunities(created_at);
`

export function ensureWakeSchema(db: DB): void {
  db.exec(WAKE_SCHEMA)
  // 初始化单行状态（不存在时插入）
  const row = db.prepare('SELECT id FROM wake_state WHERE id = 1').get()
  if (!row) {
    db.prepare(`INSERT INTO wake_state(id, h, theta, last_tick_at, frequency_mode)
      VALUES (1, 0, 1, ?, 'normal')`).run(new Date().toISOString())
  }
}
