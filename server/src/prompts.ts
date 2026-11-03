// 提示词存储：主 prompt、功能说明、世界书、世界书分组，只存这一份。
// 前端面板读写这里（浏览器 localStorage 只当缓存），聊天和 Wake 拼接时都从这里读。
//
// 世界书条目的格式由前端决定（面板以后会大改），后端只要求是数组、原样保存；
// 拼接时只读 content / enabled / group / position / priority，规则和前端 chat-engine.buildSystemPrompt 一致。
import type { IncomingMessage, ServerResponse } from 'node:http'
import { type DB, tx } from './db.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prompt_docs (
  key TEXT PRIMARY KEY,          -- prompt / worldbook / worldbookGroups
  value TEXT NOT NULL,           -- JSON，原样保存
  updated_at TEXT NOT NULL
);
-- 主 prompt 的历史版本：每次保存前把旧的放进来（世界书改得太频繁，暂不记历史）
CREATE TABLE IF NOT EXISTS prompt_history (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT,
  saved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_history_key ON prompt_history(key, id);
`

export const PROMPT_KEYS = ['prompt', 'worldbook', 'worldbookGroups'] as const
export type PromptKey = typeof PROMPT_KEYS[number]
const MAX_VALUE_BYTES = 2 * 1024 * 1024
const MAX_BODY_BYTES = 5 * 1024 * 1024
export const MAX_HISTORY = 30

export function ensurePromptSchema(db: DB): void {
  db.exec(SCHEMA)
}

export function isPromptKey(k: string): k is PromptKey {
  return (PROMPT_KEYS as readonly string[]).includes(k)
}

/** 校验一份值；合法返回 null，否则返回原因 */
export function validateDoc(key: PromptKey, v: unknown): string | null {
  let size = 0
  try { size = Buffer.byteLength(JSON.stringify(v) ?? '') } catch { return '无法序列化' }
  if (size > MAX_VALUE_BYTES) return `太大（${size} 字节，上限 ${MAX_VALUE_BYTES}）`
  const isObj = !!v && typeof v === 'object' && !Array.isArray(v)
  if (key === 'prompt') {
    if (!isObj) return 'prompt 必须是对象'
    const p = v as Record<string, unknown>
    if (typeof p.main !== 'string') return 'prompt.main 必须是字符串'
    if (p.features !== undefined && typeof p.features !== 'string') return 'prompt.features 必须是字符串'
    if (p.featuresEnabled !== undefined && typeof p.featuresEnabled !== 'boolean') return 'prompt.featuresEnabled 必须是布尔值'
    return null
  }
  if (key === 'worldbook') return Array.isArray(v) ? null : 'worldbook 必须是数组'
  return isObj ? null : 'worldbookGroups 必须是对象'
}

export interface Doc<T = unknown> { value: T; updatedAt: string }

export function getDoc<T = unknown>(db: DB, key: PromptKey): Doc<T> | null {
  const row = db.prepare('SELECT value, updated_at FROM prompt_docs WHERE key = ?').get(key) as { value: string; updated_at: string } | undefined
  return row ? { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } : null
}

export function getAllDocs(db: DB): Record<PromptKey, Doc | null> {
  const out = {} as Record<PromptKey, Doc | null>
  for (const k of PROMPT_KEYS) out[k] = getDoc(db, k)
  return out
}

/** 保存一份。内容没变就什么都不做；主 prompt 变了时把旧版本放进历史（note 描述的是旧版本） */
export function putDoc(db: DB, key: PromptKey, value: unknown, note?: string, now = new Date()): { changed: boolean; updatedAt: string } {
  const err = validateDoc(key, value)
  if (err) throw new Error(err)
  const text = JSON.stringify(value)
  const at = now.toISOString()
  return tx(db, () => {
    const cur = db.prepare('SELECT value, updated_at FROM prompt_docs WHERE key = ?').get(key) as { value: string; updated_at: string } | undefined
    if (cur && cur.value === text) return { changed: false, updatedAt: cur.updated_at }
    if (cur && key === 'prompt') {
      db.prepare('INSERT INTO prompt_history(key, value, note, saved_at) VALUES (?, ?, ?, ?)').run(key, cur.value, note ?? '修改前的版本', at)
      db.prepare(`DELETE FROM prompt_history WHERE key = ? AND id NOT IN (
        SELECT id FROM prompt_history WHERE key = ? ORDER BY id DESC LIMIT ?)`).run(key, key, MAX_HISTORY)
    }
    db.prepare(`INSERT INTO prompt_docs(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, text, at)
    return { changed: true, updatedAt: at }
  })
}

export interface HistoryEntry { value: unknown; note: string | null; savedAt: string }

/** 主 prompt 的历史，新的在前 */
export function listHistory(db: DB, key: PromptKey = 'prompt'): HistoryEntry[] {
  const rows = db.prepare('SELECT value, note, saved_at FROM prompt_history WHERE key = ? ORDER BY id DESC').all(key) as { value: string; note: string | null; saved_at: string }[]
  return rows.map(r => ({ value: JSON.parse(r.value), note: r.note, savedAt: r.saved_at }))
}

/**
 * 首次搬家：把浏览器里的内容导进来。只填服务器上还没有的 key，已有的一律不覆盖。
 * 主 prompt 是这次导入的时，顺带导入浏览器里的历史版本（旧的在后）。
 */
export function importDocs(
  db: DB, docs: Record<string, unknown>, history: { value: unknown; note?: string | null }[] = [], now = new Date()
): { imported: PromptKey[]; skipped: string[] } {
  const imported: PromptKey[] = []
  const skipped: string[] = []
  tx(db, () => {
    for (const [k, v] of Object.entries(docs)) {
      if (!isPromptKey(k)) { skipped.push(k); continue }
      if (getDoc(db, k)) { skipped.push(k); continue }
      const err = validateDoc(k, v)
      if (err) { skipped.push(`${k}（${err}）`); continue }
      db.prepare('INSERT INTO prompt_docs(key, value, updated_at) VALUES (?, ?, ?)').run(k, JSON.stringify(v), now.toISOString())
      imported.push(k)
    }
    if (imported.includes('prompt')) {
      const ins = db.prepare('INSERT INTO prompt_history(key, value, note, saved_at) VALUES (?, ?, ?, ?)')
      // 浏览器里新的在前；倒着插，id 越大越新
      for (const h of history.slice(0, MAX_HISTORY).reverse()) {
        if (validateDoc('prompt', h.value)) continue
        ins.run('prompt', JSON.stringify(h.value), h.note ?? '从浏览器导入', now.toISOString())
      }
    }
  })
  return { imported, skipped }
}

// ── 拼接（和前端 chat-engine.buildSystemPrompt 同一套规则）──

interface WorldbookEntryLike { content?: unknown; enabled?: unknown; group?: unknown; position?: unknown; priority?: unknown }

/**
 * 拼成 system prompt：前置世界书（按优先级）→ 主 prompt → 功能说明 → 后置世界书。
 * 服务器上还没有主 prompt 时返回 null。
 */
export function composeSystemPrompt(db: DB, opts: { features?: boolean } = {}): string | null {
  const prompt = getDoc<{ main: string; features?: string; featuresEnabled?: boolean }>(db, 'prompt')?.value
  if (!prompt || !prompt.main.trim()) return null
  const entries = (getDoc<WorldbookEntryLike[]>(db, 'worldbook')?.value ?? []).filter(e => e && typeof e === 'object')
  const groups = (getDoc<Record<string, { enabled?: boolean }>>(db, 'worldbookGroups')?.value ?? {})
  const before: WorldbookEntryLike[] = []
  const after: WorldbookEntryLike[] = []
  for (const e of entries) {
    if (!e.enabled || typeof e.content !== 'string') continue
    if (groups[String(e.group)]?.enabled === false) continue
    ;(e.position === 'before' ? before : after).push(e)
  }
  const pri = (e: WorldbookEntryLike) => (typeof e.priority === 'number' ? e.priority : 50)
  const byPri = (a: WorldbookEntryLike, b: WorldbookEntryLike) => pri(b) - pri(a)
  before.sort(byPri)
  after.sort(byPri)
  const body = [prompt.main.trim()]
  if ((opts.features ?? true) && prompt.featuresEnabled !== false && prompt.features?.trim()) body.push(prompt.features.trim())
  return [...before.map(e => e.content as string), body.join('\n\n'), ...after.map(e => e.content as string)]
    .filter(Boolean).join('\n\n').trim()
}

// ── HTTP 接口（挂在前端出口上，nginx /api/ 已要求登录）──
//   GET  /v1/eclipsis/prompts            → { docs: { prompt, worldbook, worldbookGroups } }（没有的为 null）
//   PUT  /v1/eclipsis/prompts/<key>      { value, note? } → { changed, updatedAt }
//   GET  /v1/eclipsis/prompts/history    → { history: [{ value, note, savedAt }] }
//   POST /v1/eclipsis/prompts/import     { docs: {key: value}, history? } → { imported, skipped }

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

class TooLarge extends Error {}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) { reject(new TooLarge()); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { const raw = Buffer.concat(chunks).toString('utf8'); resolve(raw ? JSON.parse(raw) : {}) }
      catch { reject(new SyntaxError('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/** 返回 true 表示这里处理了 */
export async function handlePromptApi(db: DB, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://local')
  const m = /^\/v1\/eclipsis\/prompts(?:\/([\w-]{1,40}))?$/.exec(url.pathname)
  if (!m) return false
  const sub = m[1]
  try {
    if (!sub && req.method === 'GET') { json(res, 200, { docs: getAllDocs(db) }); return true }
    if (sub === 'history' && req.method === 'GET') { json(res, 200, { history: listHistory(db) }); return true }
    if (sub === 'import' && req.method === 'POST') {
      const body = await readJson(req)
      if (!body || typeof body.docs !== 'object' || Array.isArray(body.docs)) { json(res, 400, { error: 'docs 必须是对象' }); return true }
      json(res, 200, importDocs(db, body.docs, Array.isArray(body.history) ? body.history : []))
      return true
    }
    if (sub && isPromptKey(sub) && req.method === 'PUT') {
      const body = await readJson(req)
      if (!body || !('value' in body)) { json(res, 400, { error: '缺少 value' }); return true }
      const err = validateDoc(sub, body.value)
      if (err) { json(res, 400, { error: err }); return true }
      json(res, 200, putDoc(db, sub, body.value, typeof body.note === 'string' ? body.note.slice(0, 200) : undefined))
      return true
    }
    json(res, sub && !isPromptKey(sub) && sub !== 'history' && sub !== 'import' ? 404 : 405, { error: 'not found or method not allowed' })
  } catch (e: any) {
    if (e instanceof TooLarge) json(res, 413, { error: '请求体太大' })
    else if (e instanceof SyntaxError) json(res, 400, { error: e.message })
    else json(res, 500, { error: String(e?.message || e) })
  }
  return true
}
