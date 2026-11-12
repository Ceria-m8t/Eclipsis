// 语义召回（2026-11-12）。她的原话：「花钱无所谓，我只是害怕它时间太长。」
//
// 所以慢的问题不靠「换个小模型」解决，靠结构解决：
//   1. **卡片的向量一次性算好存库**（188 条一次批量），平时不动；只有卡片正文变了才重算。
//   2. 每轮只给**她这一句**算一次向量。
//   3. 算过的句子**缓存**（同一句话第二次是 0 毫秒）。
//   4. **硬超时**（默认 250ms）：超时就当没有语义这一层，只用字面分 —— 宁可召回差一点，
//      也绝不让他的回复等在这里。
//
// 为什么用站上的 bge-m3 而不是本地 bge-small：
//   本地要装 onnxruntime 原生模块，这台机器有前科（Node 升到 v24 之后共读小屋的原生模块
//   ERR_DLOPEN_FAILED，崩溃重启 57 万次刷满日志，见 README 运维记录 2026-11-07）。
//   她说花钱无所谓，那就把钱花在更稳的那条路上。
import { createHash } from 'node:crypto'
import type { DB } from '../db.ts'

export interface EmbedConfig {
  url: string
  key: string
  model: string
  timeoutMs: number
}

export function embedConfig(env: NodeJS.ProcessEnv = process.env): EmbedConfig | null {
  const url = (env.MEMORY_EMBED_URL || '').trim()
  const key = (env.MEMORY_EMBED_KEY || '').trim()
  if (!url || !key) return null
  return {
    url: url.replace(/\/+$/, ''),
    key,
    model: (env.MEMORY_EMBED_MODEL || 'BAAI/bge-m3').trim(),
    timeoutMs: Number(env.MEMORY_EMBED_TIMEOUT_MS) || 250,
  }
}

export function ensureVectorSchema(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_vectors (
    memory_id INTEGER PRIMARY KEY,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    body_hash TEXT NOT NULL,          -- 正文的哈希：卡片改了才重算
    vec BLOB NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS memory_query_vectors (
    hash TEXT PRIMARY KEY,            -- model + 查询文本
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    used_at TEXT NOT NULL
  )`)
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32)

export function packVec(v: number[]): Buffer {
  const buf = Buffer.allocUnsafe(v.length * 4)
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i], i * 4)
  return buf
}

export function unpackVec(buf: Buffer | Uint8Array): Float32Array {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  const out = new Float32Array(b.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4)
  return out
}

/** 余弦相似度。向量已归一化时就是点积，但别假设，老实算 */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

export type EmbedFn = (texts: string[]) => Promise<number[][]>

/** 走 OpenAI 兼容的 /embeddings（siliconflow 的 bge-m3 就是这个口） */
export function apiEmbedder(cfg: EmbedConfig, timeoutMs?: number): EmbedFn {
  return async (texts) => {
    const res = await fetch(`${cfg.url}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ model: cfg.model, input: texts, encoding_format: 'float' }),
      signal: AbortSignal.timeout(timeoutMs ?? cfg.timeoutMs),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`embedding HTTP ${res.status}：${text.slice(0, 160)}`)
    const data = JSON.parse(text)
    const arr = Array.isArray(data?.data) ? data.data : []
    return arr.map((d: any) => (Array.isArray(d?.embedding) ? d.embedding.map(Number) : []))
  }
}

/** 卡片拿去算向量的那段文字（标题 + 正文 + 标签，和字面打分同一口径） */
export function vectorText(row: { title: string; fact_body: string; tags?: string | null }): string {
  let tags: string[] = []
  try { tags = JSON.parse(row.tags || '[]') } catch { tags = [] }
  return [row.title, row.fact_body, tags.join(' ')].filter(Boolean).join('\n').slice(0, 2000)
}

export interface IndexReport {
  total: number
  missing: number
  embedded: number
  failed: number
  ms: number
  model: string
  error?: string
}

/**
 * 给还没算过（或正文变了）的卡片算向量。离线跑，一次批量。
 * 卡片有 188 条，一次 32 条一批，几秒就完。
 */
export async function indexMemories(
  db: DB,
  embed: EmbedFn,
  o: { model: string; batch?: number; limit?: number } = { model: 'BAAI/bge-m3' }
): Promise<IndexReport> {
  ensureVectorSchema(db)
  const t0 = Date.now()
  const rows = db.prepare(`SELECT m.id, m.title, m.fact_body, m.tags, v.body_hash, v.model
    FROM memories m LEFT JOIN memory_vectors v ON v.memory_id = m.id
    WHERE m.retracted_at IS NULL`).all() as unknown as any[]
  const todo = rows.filter(r => {
    const h = sha(vectorText(r))
    return r.body_hash !== h || r.model !== o.model
  }).slice(0, o.limit ?? 1000)
  const report: IndexReport = { total: rows.length, missing: todo.length, embedded: 0, failed: 0, ms: 0, model: o.model }
  if (!todo.length) { report.ms = Date.now() - t0; return report }

  const batch = Math.min(Math.max(o.batch ?? 32, 1), 64)
  const ins = db.prepare(`INSERT INTO memory_vectors (memory_id, model, dim, body_hash, vec, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, dim = excluded.dim,
      body_hash = excluded.body_hash, vec = excluded.vec, updated_at = excluded.updated_at`)
  for (let i = 0; i < todo.length; i += batch) {
    const chunk = todo.slice(i, i + batch)
    try {
      // 建索引不急，超时放宽到 60 秒（和每轮召回那 250ms 是两回事）
      const vecs = await embed(chunk.map(r => vectorText(r)))
      const now = new Date().toISOString()
      chunk.forEach((r, j) => {
        const v = vecs[j]
        if (!v?.length) { report.failed++; return }
        ins.run(r.id, o.model, v.length, sha(vectorText(r)), packVec(v), now)
        report.embedded++
      })
    } catch (e: any) {
      report.failed += chunk.length
      report.error = String(e?.message || e).slice(0, 200)
      break
    }
  }
  report.ms = Date.now() - t0
  return report
}

export interface QueryVector {
  vec: Float32Array
  cached: boolean
  ms: number
}

/**
 * 查询向量。缓存命中就是 0 毫秒；没命中去算，**超时就返回 null**（调用方退回字面分）。
 */
export async function queryVector(
  db: DB,
  query: string,
  embed: EmbedFn,
  o: { model: string; timeoutMs?: number; now?: Date } = { model: 'BAAI/bge-m3' }
): Promise<QueryVector | null> {
  ensureVectorSchema(db)
  const t0 = Date.now()
  const key = sha(`${o.model}\n${query.trim()}`)
  const hit = db.prepare('SELECT dim, vec FROM memory_query_vectors WHERE hash = ?').get(key) as
    { dim: number; vec: Uint8Array } | undefined
  if (hit) {
    db.prepare('UPDATE memory_query_vectors SET used_at = ? WHERE hash = ?').run((o.now ?? new Date()).toISOString(), key)
    return { vec: unpackVec(hit.vec), cached: true, ms: Date.now() - t0 }
  }
  try {
    const [v] = await embed([query.trim().slice(0, 1000)])
    if (!v?.length) return null
    db.prepare('INSERT OR REPLACE INTO memory_query_vectors (hash, dim, vec, used_at) VALUES (?, ?, ?, ?)')
      .run(key, v.length, packVec(v), (o.now ?? new Date()).toISOString())
    pruneQueryCache(db)
    return { vec: new Float32Array(v), cached: false, ms: Date.now() - t0 }
  } catch {
    return null      // 超时 / 站挂了 / 没配：当语义这一层不存在
  }
}

/**
 * **只读缓存、完全同步**：聊天那条路（proxy 的 prepare）是同步的，一毫秒都不能等网络。
 * 命中就用，没命中返回 null，由调用方决定要不要后台补算。
 */
export function cachedQueryVector(db: DB, query: string, model: string, now: Date = new Date()): Float32Array | null {
  ensureVectorSchema(db)
  const key = sha(`${model}\n${query.trim()}`)
  const hit = db.prepare('SELECT vec FROM memory_query_vectors WHERE hash = ?').get(key) as { vec: Uint8Array } | undefined
  if (!hit) return null
  db.prepare('UPDATE memory_query_vectors SET used_at = ? WHERE hash = ?').run(now.toISOString(), key)
  return unpackVec(hit.vec)
}

/** 后台把这一句的向量算好（下一次同样的问法就是 0 毫秒）。失败就算了，不吵 */
export function warmQueryVector(db: DB, query: string, cfg: EmbedConfig, timeoutMs = 8000): void {
  void queryVector(db, query, apiEmbedder(cfg, timeoutMs), { model: cfg.model }).catch(() => {})
}

const QUERY_CACHE_MAX = 2000

export function pruneQueryCache(db: DB, max = QUERY_CACHE_MAX): number {
  const n = Number((db.prepare('SELECT count(*) n FROM memory_query_vectors').get() as { n: number }).n)
  if (n <= max) return 0
  const r = db.prepare(`DELETE FROM memory_query_vectors WHERE hash IN (
    SELECT hash FROM memory_query_vectors ORDER BY used_at ASC LIMIT ?)`).run(n - max)
  return Number(r.changes)
}

/** 库里现在有多少条算过向量 */
export function vectorStats(db: DB): { total: number; indexed: number; model: string | null; queryCache: number } {
  ensureVectorSchema(db)
  const one = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n)
  const model = db.prepare('SELECT model FROM memory_vectors LIMIT 1').get() as { model: string } | undefined
  return {
    total: one('SELECT count(*) n FROM memories WHERE retracted_at IS NULL'),
    indexed: one('SELECT count(*) n FROM memory_vectors'),
    model: model?.model ?? null,
    queryCache: one('SELECT count(*) n FROM memory_query_vectors'),
  }
}

/** 一张卡的向量（召回时批量读） */
export function loadVectors(db: DB, ids: number[]): Map<number, Float32Array> {
  ensureVectorSchema(db)
  const out = new Map<number, Float32Array>()
  if (!ids.length) return out
  const rows = db.prepare(`SELECT memory_id, vec FROM memory_vectors WHERE memory_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as unknown as { memory_id: number; vec: Uint8Array }[]
  for (const r of rows) out.set(r.memory_id, unpackVec(r.vec))
  return out
}
