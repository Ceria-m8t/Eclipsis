// 聊天记录（给 Eclipsis 前端的聊天页读）：从经历表里取日常聊天，整理成气泡用的样子。
// Kelivo、Eclipsis、早先从 xiaoke 导入的都在同一条时间线上；撤回的（她删的、没进 xiaoke 的）不出现。
//
//   GET  /v1/eclipsis/chat/history?before=<seq>&limit=N   往前翻（不带 before = 最新的 N 条）
//   GET  /v1/eclipsis/chat/history?after=<seq>            比 seq 新的（轮询、发完一轮后补上）
//   POST /v1/eclipsis/chat/delete  { seqs: [..] }          删：经历表里撤回 + 从 xiaoke 里删（他以后看不到）
//   GET  /v1/eclipsis/blob/<hash>                          聊天里的图片
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { type DB, tx } from './db.ts'
import { cleanHerText } from './recorder.ts'
import { splitMoment, type Moment } from './moment.ts'
import { activeChoices, setActiveVersion } from './versions.ts'
import { FILE_MARK, findFiles } from './files.ts'

export interface ChatTool { id: string; name: string; args: string; result?: string }
export interface ChatVersion {
  moment?: Moment; seq: number; seqs: number[]; ts: string; content: string; thinking: string; tools: ChatTool[]; partial?: boolean
  /** 他画的图（画笔画完直接发给她） */
  images?: string[]
}
export interface ChatItem {
  id: string            // e<第一条的 seq>
  seq: number           // 这一项最后一条经历的 seq（翻页、轮询用）
  seqs: number[]        // 这一项包含的经历（删的时候一起删）
  role: 'user' | 'assistant'
  ts: string
  turn: string          // 重新生成时用：同一个 turn 的回复归成一项的几个版本
  content: string       // 显示用（她的：去掉时间标记；他的：去掉 <think>）
  raw?: string          // 她的原文（重新生成时原样发回去，xiaoke 才认得出是同一条）
  images?: string[]     // 图片地址
  versions?: ChatVersion[]
  source: 'eclipsis' | 'kelivo' | 'import' | 'wake'
  /** 他自己醒来时发的（或醒来了没找她）：当时留下的念头、用过的工具 */
  wake?: { id: string; trace?: string; tools?: string[]; silent?: boolean }
  /** 他这一轮选择已读不回（整条回复只有 [NO_REPLY]） */
  noReply?: boolean
  /** 有好几版时，算数的是第几版（她翻到的那版，没翻过是最后一版）。他只看得到这一版 */
  active?: number
  /** 她这条消息带的文件（正文里的标记已经拆掉） */
  files?: { name: string; hash: string; size: number; kind: string; chars: number; note: string | null }[]
}

/** 他已读不回时整条回复就是这个（思考照常写） */
export const NO_REPLY = '[NO_REPLY]'
export const isNoReply = (body: string) => body.trim() === NO_REPLY || body.trim().startsWith(NO_REPLY)
/** 她的心声（发消息时附的心里话）：拼在她这条消息末尾，他隐约感知。他要是学着写，显示时剥掉 */
export const HEART_RE = /\n*〔她心里想的，没说出口：[\s\S]*?〕\s*$/

const MSG_KINDS = "('message','tool_call','tool_result')"
// 列表里的行：日常聊天 + 他醒来时留的念头（醒来发给她的消息本来就记在 chat 里）
const LIST = `scope = 'daily' AND retracted_at IS NULL AND (
  (channel = 'chat' AND kind IN ${MSG_KINDS})
  OR (channel = 'wake' AND kind = 'note' AND source_ref LIKE 'wake:trace:%'))`

interface Row { seq: number; ts: string; actor: string; kind: string; content: string; meta: string | null; source_ref: string | null }

/**
 * 他的回复里的 <think>…</think> 拆出来（开头没闭合的也算思考）。
 * 拆完把空行收一收（和前端 markdown.splitThink、transforms.stripThinkText 同一条规则）：
 * 一轮里调了工具的回复是几段接起来的，中间夹着思考，剪掉以后会留下三四个空行。
 */
export function splitThink(text: string): { body: string; think: string } {
  let think = ''
  let body = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_, t) => { think += (think ? '\n\n' : '') + t.trim(); return '' })
  const open = body.search(/<think>/i)
  if (open >= 0) { think += (think ? '\n\n' : '') + body.slice(open + 7).trim(); body = body.slice(0, open) }
  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), think: think.trim() }
}

function sourceOf(ref: string | null): ChatItem['source'] {
  if (!ref) return 'kelivo'
  if (ref.startsWith('wake:')) return 'wake'
  if (ref.startsWith('front:')) return 'eclipsis'
  if (ref.startsWith('xiaoke:')) return 'import'
  return 'kelivo'
}

// Kelivo 夹带的不是她说的话：记忆注入（单独一条 user）、起窗口标题的请求（连同它的回复）
const INJECTED = /^以下内容由系统提供，不是用户本轮发送的内容/
const TITLE_REQUEST = /^I will give you some dialogue content in the `<content>` block/

const parseMeta = (m: string | null): any => { try { return m ? JSON.parse(m) : {} } catch { return {} } }

/** 一段经历（按 seq 升序）→ 气泡项。工具调用/结果挂到它后面那条他的回复上 */
export function buildItems(db: DB, rows: Row[]): ChatItem[] {
  const items: ChatItem[] = []
  const byTurn = new Map<string, ChatItem>()
  let tools: ChatTool[] = []
  let toolSeqs: number[] = []
  const callById = new Map<string, ChatTool>()
  // 前端出口的回复，思考在 exchanges 里
  const rids = rows.filter(r => r.actor === 'ai' && r.kind === 'message').map(r => parseMeta(r.meta).rid).filter(Boolean)
  const thinkOf = new Map<string, string>()
  if (rids.length) {
    const q = db.prepare(`SELECT rid, reply_thinking FROM exchanges WHERE rid IN (${rids.map(() => '?').join(',')}) AND reply_thinking IS NOT NULL`)
    for (const r of q.all(...rids) as { rid: string; reply_thinking: string }[]) if (!thinkOf.has(r.rid)) thinkOf.set(r.rid, r.reply_thinking)
  }

  let skipReply = false
  let lastHerSeq = 0            // 她最后一句的 seq：之后他的几条回复算同一轮的好几版
  const byWake = new Map<string, ChatItem>()
  const wakeIds = [...new Set(rows.map(r => parseMeta(r.meta).wake_id).filter((x): x is string => typeof x === 'string'))]
  const toolsOf = new Map<string, string[]>()
  if (wakeIds.length) {
    try {
      const q = db.prepare(`SELECT id, tools_used FROM wake_opportunities WHERE id IN (${wakeIds.map(() => '?').join(',')})`)
      for (const w of q.all(...wakeIds) as { id: string; tools_used: string | null }[]) {
        try { const t = JSON.parse(w.tools_used || '[]'); if (Array.isArray(t) && t.length) toolsOf.set(w.id, t.map(String)) } catch {}
      }
    } catch { /* 老库没有这张表 */ }
  }
  const wakeItem = (r: Row, wid: string): ChatItem => {
    let it = byWake.get(wid)
    if (!it) {
      it = { id: 'e' + r.seq, seq: r.seq, seqs: [], role: 'assistant', ts: r.ts, turn: 'wake:' + wid, content: '',
        versions: [{ seq: r.seq, seqs: [], ts: r.ts, content: '', thinking: '', tools: [] }], source: 'wake',
        wake: { id: wid, tools: toolsOf.get(wid), silent: true } }
      items.push(it)
      byWake.set(wid, it)
    }
    it.seqs.push(r.seq)
    it.versions![0]!.seqs.push(r.seq)
    it.seq = Math.max(it.seq, r.seq)
    return it
  }
  for (const r of rows) {
    const meta = parseMeta(r.meta)
    if (typeof meta.wake_id === 'string' && (r.kind === 'note' || (r.actor === 'ai' && r.kind === 'message'))) {
      const it = wakeItem(r, meta.wake_id)
      const v0 = it.versions![0]!
      // 他醒着画的（像素小画）：挂到这一项上，她在聊天里看得到图，不是一屏字符
      const imgs: string[] = Array.isArray(meta.images)
        ? meta.images.filter((h: unknown) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) : []
      if (imgs.length) v0.images = [...(v0.images || []), ...imgs.map(h => `/api/eclipsis/blob/${h}`)]
      // 醒来时他把「这一刻」写在了念头里或消息里：拆出来挂在这一项上（锁着的不给原文），念头里不再露出标签
      const mo = splitMoment(r.content.replace(HEART_RE, '').trim())
      if (mo.moment) v0.moment = mo.moment.locked ? { locked: true, text: '' } : mo.moment
      // 整条就是一幅画时正文是占位符，显示时去掉（她看到的是图）
      const body = imgs.length ? mo.text.replace(/^\[图片\]$/, '').trim() : mo.text
      if (r.kind === 'note') {
        if (body) it.wake!.trace = (it.wake!.trace ? it.wake!.trace + '\n\n' : '') + body
        continue
      }
      it.content = it.content ? (body ? it.content + '\n\n' + body : it.content) : body
      v0.content = it.content
      it.wake!.silent = false
      continue
    }
    if (r.kind === 'message' && r.actor === 'erica' && (INJECTED.test(r.content) || TITLE_REQUEST.test(r.content))) {
      if (TITLE_REQUEST.test(r.content)) skipReply = true
      continue
    }
    if (skipReply && r.kind === 'message' && r.actor === 'ai') { skipReply = false; continue }
    if (r.kind === 'message') skipReply = false
    if (r.kind === 'tool_call') {
      const m = /^([^(]*)\(([\s\S]*)\)$/.exec(r.content)
      const t: ChatTool = { id: String(meta.tool_call_id || r.seq), name: String(meta.name || m?.[1] || '工具'), args: m?.[2] ?? r.content }
      tools.push(t); toolSeqs.push(r.seq)
      callById.set(t.id, t)
      continue
    }
    if (r.kind === 'tool_result') {
      const t = callById.get(String(meta.tool_call_id))
      if (t) t.result = r.content
      toolSeqs.push(r.seq)
      continue
    }
    if (r.actor === 'erica') {
      tools = []; toolSeqs = []
      lastHerSeq = r.seq
      const imgs: string[] = Array.isArray(meta.images) ? meta.images.filter((h: unknown) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) : []
      let content = cleanHerText(r.content).replace(/^\[图片\]$/, '')
      // 她发的文件：标记拆成文件项，正文里不留
      let files: ChatItem['files']
      if (content.includes('[文件 ')) {
        const marks = [...content.matchAll(FILE_MARK)].map(m => ({ name: m[1]!, prefix: m[2]! }))
        if (marks.length) {
          const found = findFiles(db, marks.map(m => m.prefix))
          files = marks.map(m => {
            const f = found.get(m.prefix)
            return {
              name: f?.name || m.name, hash: m.prefix, size: f?.size ?? 0,
              kind: f?.kind || 'other', chars: f?.chars ?? 0, note: f?.note ?? null,
            }
          })
          content = content.replace(FILE_MARK, '').replace(/\n{3,}/g, '\n\n').trim()
        }
      }
      items.push({
        id: 'e' + r.seq, seq: r.seq, seqs: [r.seq], role: 'user', ts: r.ts, turn: 'e' + r.seq,
        content, raw: r.content, images: imgs.length ? imgs.map(h => `/api/eclipsis/blob/${h}`) : undefined,
        files, source: sourceOf(r.source_ref)
      })
      continue
    }
    if (r.actor !== 'ai') continue
    const split = splitThink(r.content)
    const think = split.think
    // 这一刻拆出来单独给；锁着的只说「锁着」，原文不给
    const mo = splitMoment(split.body.replace(HEART_RE, '').trim())
    const body = mo.text
    const moment: Moment | undefined = mo.moment ? (mo.moment.locked ? { locked: true, text: '' } : mo.moment) : undefined
    // 他画的图（画笔）也在 meta.images 里
    const hisImgs: string[] = Array.isArray(meta.images) ? meta.images.filter((h: unknown) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) : []
    const seqs = [...toolSeqs, r.seq]
    const v: ChatVersion = {
      seq: r.seq, seqs, ts: r.ts, content: hisImgs.length ? body.replace(/^\[图片\]$/, '') : body,
      thinking: think || thinkOf.get(meta.rid) || '', tools, moment,
      images: hisImgs.length ? hisImgs.map(h => `/api/eclipsis/blob/${h}`) : undefined,
      partial: meta.partial || undefined
    }
    tools = []; toolSeqs = []
    const turn = typeof meta.turn === 'string' && meta.turn ? meta.turn : 'e' + r.seq
    // 同一轮的好几版：同一个 turn，而且中间没有她的话（重新生成、停掉重试都算；turn 偶尔会撞，见 versions.ts）
    const same = byTurn.get(turn)
    if (same && same.seq > lastHerSeq) {
      same.versions!.push(v)
      same.seqs.push(...seqs)
      same.seq = Math.max(same.seq, r.seq)
      same.content = body
      same.noReply = isNoReply(body) || undefined
      continue
    }
    const it: ChatItem = {
      id: 'e' + r.seq, seq: r.seq, seqs, role: 'assistant', ts: r.ts, turn,
      content: v.content, versions: [v], images: v.images, source: sourceOf(r.source_ref)
    }
    if (isNoReply(body)) it.noReply = true
    items.push(it)
    byTurn.set(turn, it)
  }
  // 有好几版的轮次：标出算数的是哪一版（她翻到的那版，她那边刷新后也接着看这版）
  const chosen = activeChoices(db)
  for (const it of items) {
    if (!it.versions || it.versions.length < 2) continue
    const pick = chosen.get(it.turn)
    const i = pick === undefined ? -1 : it.versions.findIndex(v => v.seq === pick)
    it.active = i >= 0 ? i : it.versions.length - 1
    const v = it.versions[it.active]!
    it.content = v.content
    it.noReply = isNoReply(v.content) || undefined
  }
  return items
}

export function chatHistory(db: DB, opts: { before?: number; after?: number; limit?: number }): { items: ChatItem[]; hasMore: boolean } {
  const limit = Math.min(Math.max(opts.limit ?? 150, 1), 500)
  const cols = 'seq, ts, actor, kind, content, meta, source_ref'
  if (opts.after != null) {
    const rows = db.prepare(`SELECT ${cols} FROM episodes WHERE ${LIST} AND seq > ? ORDER BY seq LIMIT 1000`).all(opts.after) as unknown as Row[]
    return { items: buildItems(db, rows), hasMore: false }
  }
  // 先按"她的话 + 他的回复"数够 limit 条，再把这一段里的工具记录一起取出来
  const before = opts.before ?? Number.MAX_SAFE_INTEGER
  const msgs = db.prepare(`SELECT seq FROM episodes WHERE ${LIST} AND kind IN ('message', 'note') AND seq < ? ORDER BY seq DESC LIMIT ?`).all(before, limit + 1) as { seq: number }[]
  const hasMore = msgs.length > limit
  const shown = msgs.slice(0, limit)
  if (!shown.length) return { items: [], hasMore: false }
  const from = shown[shown.length - 1]!.seq
  const rows = db.prepare(`SELECT ${cols} FROM episodes WHERE ${LIST} AND seq >= ? AND seq < ? ORDER BY seq`).all(from, before) as unknown as Row[]
  return { items: buildItems(db, rows), hasMore }
}

// ---------------- 删 ----------------

export interface XiaokeApi {
  /** 删一条 xiaoke 记录；没找到当作已删 */
  remove(id: string): Promise<void>
  /** 最近的记录（找还没对上号的那条） */
  recent(limit: number): Promise<{ id: string; role: string; created_at: string; content: string | null }[]>
}

export function xiaokeApi(url: string, key: string): XiaokeApi | null {
  if (!url || !key) return null
  const base = url.replace(/\/$/, '')
  const h = { authorization: `Bearer ${key}` }
  return {
    async remove(id) {
      const r = await fetch(`${base}/internal/timeline/records/${encodeURIComponent(id)}`, { method: 'DELETE', headers: h, signal: AbortSignal.timeout(10_000) })
      if (!r.ok && r.status !== 404) throw new Error(`xiaoke 删除失败 HTTP ${r.status}`)
    },
    async recent(limit) {
      const r = await fetch(`${base}/internal/timeline?limit=${limit}`, { headers: h, signal: AbortSignal.timeout(10_000) })
      if (!r.ok) throw new Error(`xiaoke 读取失败 HTTP ${r.status}`)
      return ((await r.json()) as any).records || []
    },
  }
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const LINK_WINDOW_MS = 30 * 60_000

/**
 * 删聊天记录：经历表里撤回（manual），连带同一段的工具记录；对应的 xiaoke 记录也删掉。
 * 还没对上号的（刚发、对账还没跑），按"角色 + 正文 + 时间 ±30 分钟"在 xiaoke 最近的记录里找。
 * xiaoke 删失败时经历表也不动，返回错误，免得这边看不到了他那边还记得。
 */
export async function deleteChat(db: DB, xk: XiaokeApi | null, seqs: number[], opts: { xiaokeHasNewMessages?: boolean } = {}): Promise<{ deleted: number; xiaoke: number }> {
  // 直连中转站以后（BYPASS_XIAOKE=1），新消息根本没进过 xiaoke：只删我们自己的，老消息照旧也删它那边
  const needXiaoke = opts.xiaokeHasNewMessages !== false
  const rows = db.prepare(`SELECT seq, ts, actor, kind, content, meta, xiaoke_id, source_ref FROM episodes WHERE seq IN (${seqs.map(() => '?').join(',')}) AND ${LIST}`)
    .all(...seqs) as { seq: number; ts: string; actor: string; kind: string; content: string; meta: string | null; xiaoke_id: string | null; source_ref: string | null }[]
  if (!rows.length) return { deleted: 0, xiaoke: 0 }
  const messages = rows.filter(r => r.kind === 'message' && (r.actor === 'erica' || r.actor === 'ai') && !String(r.source_ref || '').startsWith('wake:'))
  const ids: string[] = messages.map(r => r.xiaoke_id).filter((x): x is string => !!x)
  const unlinked = messages.filter(r => !r.xiaoke_id)
  if (messages.length && !xk && needXiaoke) throw new Error('没配置 xiaoke（XIAOKE_URL / XIAOKE_KEY），删不了他那边的记录')
  if (unlinked.length && xk && needXiaoke) {
    const taken = new Set((db.prepare('SELECT xiaoke_id FROM episodes WHERE xiaoke_id IS NOT NULL').all() as { xiaoke_id: string }[]).map(r => r.xiaoke_id))
    const recent = await xk.recent(200)
    for (const e of unlinked) {
      const role = e.actor === 'erica' ? 'user' : 'assistant'
      const t = new Date(e.ts).getTime()
      let best: { id: string; dt: number } | null = null
      for (const x of recent) {
        if (x.role !== role || x.content == null || taken.has(x.id) || ids.includes(x.id)) continue
        if (norm(x.content) !== norm(e.content)) continue
        const dt = Math.abs(new Date(x.created_at).getTime() - t)
        if (dt <= LINK_WINDOW_MS && (!best || dt < best.dt)) best = { id: x.id, dt }
      }
      if (best) ids.push(best.id)
      // 刚发的（对账两分钟一次，xiaoke 也可能还没写完）：找不到就先别删，免得这边没了他那边还在
      else if (Date.now() - t < 20 * 60_000 && !parseMeta(e.meta).partial) throw new Error('xiaoke 里还没找到这条（可能刚发），过一两分钟再删')
    }
  }
  for (const id of ids) await xk!.remove(id)
  const now = new Date().toISOString()
  tx(db, () => {
    const st = db.prepare(`UPDATE episodes SET retracted_at = ?, retract_reason = 'manual' WHERE seq = ? AND retracted_at IS NULL`)
    for (const r of rows) st.run(now, r.seq)
    // 连带：删掉的回复里的工具调用和结果
    const cascade = db.prepare(`UPDATE episodes SET retracted_at = ?, retract_reason = 'cascade' WHERE retracted_at IS NULL AND (
        (kind = 'tool_call' AND json_extract(meta, '$.rid') = ?)
        OR (kind = 'tool_result' AND json_extract(meta, '$.tool_call_id') IN (
          SELECT json_extract(meta, '$.tool_call_id') FROM episodes WHERE kind = 'tool_call' AND json_extract(meta, '$.rid') = ?)))`)
    for (const r of rows) { const rid = parseMeta(r.meta).rid; if (r.actor === 'ai' && rid) cascade.run(now, rid, rid) }
  })
  return { deleted: rows.length, xiaoke: ids.length }
}

// ---------------- HTTP ----------------

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage, max = 64 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { reject(new Error('请求太大')); req.destroy(); return } chunks.push(c) })
    req.on('end', () => { try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : {}) } catch { reject(new Error('请求体不是合法 JSON')) } })
    req.on('error', reject)
  })
}

// seq 可以是负数：2026-11-13 从 Kelivo 补回的 9/25–9/29 排在第 1 条前面（-1203..-1）
const intParam = (v: string | null) => (v !== null && /^-?\d{1,12}$/.test(v) ? Number(v) : undefined)

export async function handleChatApi(db: DB, ctx: { blobDir: string; xiaoke: XiaokeApi | null; xiaokeHasNewMessages?: boolean }, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://local')
  const p = url.pathname
  try {
    if (p === '/v1/eclipsis/chat/history' && req.method === 'GET') {
      json(res, 200, chatHistory(db, {
        before: intParam(url.searchParams.get('before')),
        after: intParam(url.searchParams.get('after')),
        limit: intParam(url.searchParams.get('limit')),
      }))
      return true
    }
    // 她在聊天页翻到了哪一版（他只看得到这一版）
    if (p === '/v1/eclipsis/chat/version' && req.method === 'POST') {
      const body = await readJson(req)
      const turn = typeof body?.turn === 'string' ? body.turn : ''
      const seq = Number(body?.seq)
      if (!turn || !Number.isInteger(seq) || seq <= 0) { json(res, 400, { error: '要给 turn 和 seq' }); return true }
      try { json(res, 200, setActiveVersion(db, turn, seq)) }
      catch (e: any) { json(res, 404, { error: String(e?.message || e) }) }
      return true
    }
    if (p === '/v1/eclipsis/chat/delete' && req.method === 'POST') {
      const body = await readJson(req)
      const seqs = Array.isArray(body?.seqs) ? body.seqs.filter((x: unknown) => Number.isInteger(x) && x !== 0).slice(0, 200) : []
      if (!seqs.length) { json(res, 400, { error: 'seqs 不能为空' }); return true }
      json(res, 200, await deleteChat(db, ctx.xiaoke, seqs, { xiaokeHasNewMessages: ctx.xiaokeHasNewMessages }))
      return true
    }
    const b = /^\/v1\/eclipsis\/blob\/([0-9a-f]{64})$/.exec(p)
    if (b && req.method === 'GET') {
      const hash = b[1]!
      const row = db.prepare(`SELECT mime FROM blobs WHERE hash = ? AND kind = 'file'`).get(hash) as { mime: string | null } | undefined
      const file = join(ctx.blobDir, hash.slice(0, 2), hash)
      if (!row || !existsSync(file)) { json(res, 404, { error: 'not found' }); return true }
      const mime = row.mime && /^image\/[\w.+-]+$/.test(row.mime) ? row.mime : 'application/octet-stream'
      // 内容按哈希寻址，永远不变
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' })
      createReadStream(file).pipe(res)
      return true
    }
  } catch (e: any) {
    json(res, 500, { error: String(e?.message || e) })
    return true
  }
  return false
}
