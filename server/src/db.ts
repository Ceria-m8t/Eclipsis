// SQLite（Node 自带的 node:sqlite，不需要编译原生依赖）
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type DB = DatabaseSync

const SCHEMA = `
-- 去重存储：同一段系统提示词/同一条历史消息只存一次，exchanges 里只记哈希
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- message / options / file
  mime TEXT,
  size INTEGER NOT NULL,
  text TEXT,                     -- message/options 的 JSON；file 存在磁盘上，这里为空
  created_at TEXT NOT NULL
);

-- 每一次经过网关的 HTTP 调用（原始证据，调试面板以后读这里）
CREATE TABLE IF NOT EXISTS exchanges (
  id INTEGER PRIMARY KEY,
  rid TEXT NOT NULL,             -- 同一轮在前端出口和上游入口用同一个 rid 串起来
  tap TEXT NOT NULL,             -- front / upstream
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,          -- pending / ok / http_error / network_error / aborted
  http_status INTEGER,
  latency_ms INTEGER,
  path TEXT NOT NULL,
  scene TEXT,
  conversation TEXT,
  turn TEXT,
  model TEXT,
  stream INTEGER,
  message_hashes TEXT,           -- JSON 数组：按顺序的消息哈希
  options_hash TEXT,             -- 除 messages 以外的参数（tools、temperature……）
  reply_content TEXT,
  reply_thinking TEXT,
  reply_tool_calls TEXT,         -- JSON
  finish_reason TEXT,
  usage TEXT,                    -- JSON
  error TEXT,
  transforms TEXT                -- JSON：上游入口对请求做了哪些改动（message_hashes 记的是改动后的）
);
CREATE INDEX IF NOT EXISTS idx_exchanges_rid ON exchanges(rid);
CREATE INDEX IF NOT EXISTS idx_exchanges_started ON exchanges(started_at);

-- 经历表：唯一事实来源，只追加。读的时候按 ts 排序（导入的旧记录 seq 会比较大但 ts 早）
CREATE TABLE IF NOT EXISTS episodes (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,              -- UTC ISO
  channel TEXT NOT NULL,         -- chat / room / music / diary / game / creative / group / device / wake
  scope TEXT NOT NULL,           -- daily / work / game / fiction / group
  actor TEXT NOT NULL,           -- erica / ai / system
  kind TEXT NOT NULL,            -- message / tool_call / tool_result / wake / note / summary_ref
  content TEXT NOT NULL,
  meta TEXT,                     -- JSON：图片哈希、工具名、是否重新生成……
  source_ref TEXT UNIQUE,        -- 去重键，如 front:turn:xxx:user、xiaoke:<id>
  privacy TEXT NOT NULL DEFAULT 'normal'
);
CREATE INDEX IF NOT EXISTS idx_episodes_ts ON episodes(ts);
CREATE INDEX IF NOT EXISTS idx_episodes_scope_ts ON episodes(scope, ts);
`

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  // 旧库补列
  const cols = (db.prepare('PRAGMA table_info(exchanges)').all() as { name: string }[]).map(c => c.name)
  if (!cols.includes('transforms')) db.exec('ALTER TABLE exchanges ADD COLUMN transforms TEXT')
  return db
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export interface EpisodeInput {
  ts: string
  channel: string
  scope: string
  actor: string
  kind: string
  content: string
  meta?: Record<string, unknown> | null
  sourceRef?: string | null
  privacy?: string
}

// 有 sourceRef 且已存在时跳过，返回 false
export function addEpisode(db: DB, e: EpisodeInput): boolean {
  const r = db.prepare(`INSERT OR IGNORE INTO episodes(ts, channel, scope, actor, kind, content, meta, source_ref, privacy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    e.ts, e.channel, e.scope, e.actor, e.kind, e.content,
    e.meta ? JSON.stringify(e.meta) : null, e.sourceRef ?? null, e.privacy ?? 'normal'
  )
  return Number(r.changes) > 0
}
