// 垫图和画风（2026-11-11，Erica 要）：
//
// 垫图：她上传几张图，每张一个名字和一句说明（「她」「小克」「糯糯」「我们的家」）。
//   他画图时按名字挑（refs: ["她","小克"]），画合照才像他们俩，不是两个陌生人。
//   他只看得到名字和说明，看不到图本身——免得他照着图写描述，越写越偏。
//
// 画风：几段提示词，起个名字（二次元 / 真人 / 像素），其中一个设成默认。
//   他和她都不用每次写风格，后端自动拼默认那段；他想换就写 style。
//   她以后加真人照片，就再加一个「真人」画风，切一下默认即可（不用改代码）。
import type { DB } from './db.ts'
import type { BlobStore } from './blobs.ts'

export interface DrawRef {
  id: string
  name: string
  note: string
  hash: string
  mime: string
  size: number
  enabled: boolean
  /** 她自己点生图时默认带上 */
  byDefault: boolean
}

export interface DrawStyle {
  id: string
  name: string
  prompt: string
  isDefault: boolean
}

export function ensureDrawSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS draw_refs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      note TEXT NOT NULL DEFAULT '',
      hash TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      by_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS draw_styles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      prompt TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `)
  // 出厂两个画风：她现在画二次元，以后加真人照片时改默认就行
  const n = (db.prepare('SELECT COUNT(*) AS n FROM draw_styles').get() as { n: number }).n
  if (n === 0) {
    const now = new Date().toISOString()
    const add = db.prepare('INSERT INTO draw_styles(id, name, prompt, is_default, created_at) VALUES (?, ?, ?, ?, ?)')
    add.run('anime', '二次元', '日系二次元插画风格，干净的线稿，柔和的赛璐璐上色，光线自然，画面干净不杂乱', 1, now)
    add.run('photo', '真人', '写实摄影风格，自然光，浅景深，真实的皮肤质感，不要插画感', 0, now)
    add.run('pixel', '像素', '像素画风格，小方块像素，有限色板，干净的轮廓', 0, now)
  }
}

const rowToRef = (r: any): DrawRef => ({
  id: r.id, name: r.name, note: r.note, hash: r.hash, mime: r.mime, size: r.size,
  enabled: !!r.enabled, byDefault: !!r.by_default,
})

export function listRefs(db: DB): DrawRef[] {
  ensureDrawSchema(db)
  return (db.prepare('SELECT * FROM draw_refs ORDER BY created_at').all() as any[]).map(rowToRef)
}

export function findRefsByName(db: DB, names: string[]): DrawRef[] {
  if (!names.length) return []
  const all = listRefs(db).filter(r => r.enabled)
  const out: DrawRef[] = []
  for (const raw of names) {
    const want = String(raw).trim().toLowerCase()
    if (!want) continue
    const hit = all.find(r => r.name.toLowerCase() === want) || all.find(r => r.name.toLowerCase().includes(want))
    if (hit && !out.some(x => x.id === hit.id)) out.push(hit)
  }
  return out
}

export function defaultRefs(db: DB): DrawRef[] {
  return listRefs(db).filter(r => r.enabled && r.byDefault)
}

export function saveRef(db: DB, blobs: BlobStore, input: { id?: string; name: string; note?: string; byDefault?: boolean; enabled?: boolean; data?: Buffer; mime?: string }): DrawRef {
  ensureDrawSchema(db)
  const name = String(input.name ?? '').trim()
  if (!name) throw new Error('要给这张垫图起个名字（他按名字挑）')
  if (name.length > 24) throw new Error('名字短一点（24 字以内）')
  const old = input.id ? (db.prepare('SELECT * FROM draw_refs WHERE id = ?').get(input.id) as any) : null
  if (input.id && !old) throw new Error('找不到这张垫图')
  const clash = db.prepare('SELECT id FROM draw_refs WHERE name = ? AND id != ?').get(name, old?.id ?? '') as any
  if (clash) throw new Error(`已经有一张叫「${name}」的垫图了`)
  let hash = old?.hash as string | undefined
  let mime = old?.mime as string | undefined
  let size = old?.size as number | undefined
  if (input.data?.length) {
    if (!/^image\//.test(input.mime || '')) throw new Error('垫图要是图片')
    hash = blobs.putFile(input.mime!, input.data)
    mime = input.mime!
    size = input.data.length
  }
  if (!hash) throw new Error('要选一张图')
  const ref: DrawRef = {
    id: old?.id ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    name, note: String(input.note ?? old?.note ?? '').trim().slice(0, 300),
    hash, mime: mime!, size: size!,
    enabled: input.enabled ?? (old ? !!old.enabled : true),
    byDefault: input.byDefault ?? (old ? !!old.by_default : false),
  }
  db.prepare(`INSERT INTO draw_refs(id, name, note, hash, mime, size, enabled, by_default, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, note = excluded.note, hash = excluded.hash,
      mime = excluded.mime, size = excluded.size, enabled = excluded.enabled, by_default = excluded.by_default`)
    .run(ref.id, ref.name, ref.note, ref.hash, ref.mime, ref.size, ref.enabled ? 1 : 0, ref.byDefault ? 1 : 0, new Date().toISOString())
  return ref
}

export function deleteRef(db: DB, id: string): void {
  ensureDrawSchema(db)
  db.prepare('DELETE FROM draw_refs WHERE id = ?').run(id)
}

// ── 画风 ──

const rowToStyle = (r: any): DrawStyle => ({ id: r.id, name: r.name, prompt: r.prompt, isDefault: !!r.is_default })

export function listStyles(db: DB): DrawStyle[] {
  ensureDrawSchema(db)
  return (db.prepare('SELECT * FROM draw_styles ORDER BY is_default DESC, created_at').all() as any[]).map(rowToStyle)
}

export function defaultStyle(db: DB): DrawStyle | null {
  return listStyles(db).find(s => s.isDefault) ?? null
}

export function findStyle(db: DB, name: string): DrawStyle | null {
  const want = String(name ?? '').trim().toLowerCase()
  if (!want) return null
  const all = listStyles(db)
  return all.find(s => s.name.toLowerCase() === want) || all.find(s => s.id.toLowerCase() === want)
    || all.find(s => s.name.toLowerCase().includes(want)) || null
}

export function saveStyle(db: DB, input: { id?: string; name: string; prompt: string; isDefault?: boolean }): DrawStyle {
  ensureDrawSchema(db)
  const name = String(input.name ?? '').trim()
  const prompt = String(input.prompt ?? '').trim()
  if (!name) throw new Error('要给画风起个名字')
  if (!prompt) throw new Error('要写这个画风的描述（会拼进提示词）')
  const old = input.id ? (db.prepare('SELECT * FROM draw_styles WHERE id = ?').get(input.id) as any) : null
  if (input.id && !old) throw new Error('找不到这个画风')
  const clash = db.prepare('SELECT id FROM draw_styles WHERE name = ? AND id != ?').get(name, old?.id ?? '') as any
  if (clash) throw new Error(`已经有一个叫「${name}」的画风了`)
  const id = old?.id ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const isDefault = input.isDefault ?? (old ? !!old.is_default : false)
  db.prepare(`INSERT INTO draw_styles(id, name, prompt, is_default, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, is_default = excluded.is_default`)
    .run(id, name, prompt, isDefault ? 1 : 0, new Date().toISOString())
  if (isDefault) db.prepare('UPDATE draw_styles SET is_default = 0 WHERE id != ?').run(id)
  return { id, name, prompt, isDefault }
}

export function setDefaultStyle(db: DB, id: string): void {
  ensureDrawSchema(db)
  const row = db.prepare('SELECT id FROM draw_styles WHERE id = ?').get(id)
  if (!row) throw new Error('找不到这个画风')
  db.prepare('UPDATE draw_styles SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END').run(id)
}

export function deleteStyle(db: DB, id: string): void {
  ensureDrawSchema(db)
  const row = db.prepare('SELECT is_default FROM draw_styles WHERE id = ?').get(id) as any
  if (!row) return
  db.prepare('DELETE FROM draw_styles WHERE id = ?').run(id)
  if (row.is_default) {
    const next = db.prepare('SELECT id FROM draw_styles ORDER BY created_at LIMIT 1').get() as any
    if (next) setDefaultStyle(db, next.id)
  }
}

/** 拼最终提示词：画风 + 她/他写的那句 + 垫图是谁 */
export function composePrompt(input: { prompt: string; style: DrawStyle | null; refs: DrawRef[] }): string {
  const parts: string[] = []
  if (input.style) parts.push(input.style.prompt)
  parts.push(input.prompt.trim())
  if (input.refs.length) {
    const who = input.refs.map((r, i) => `第 ${i + 1} 张是${r.name}${r.note ? `（${r.note}）` : ''}`).join('；')
    parts.push(`参考图：${who}。画里的这些人/东西要照参考图的样子，别换人。`)
  }
  return parts.filter(Boolean).join('\n')
}
