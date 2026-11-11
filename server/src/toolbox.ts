// 他的工具箱（2026-11-10，A4）：聊天和醒来共用一份箱子。
//
// 箱子 = 一个入口（open_xxx）+ 里面一组工具。他先看到入口，打开了才拿到里面的工具（工具定义每轮都要重发，
// 一次塞 112 个光说明就上万 token）。醒来那边 11-06 起就是这样（wake/boxes.ts），这里把它也给聊天用。
//
// 两种箱子：
//   内置的：wake/boxes.ts 按 backend.env 装（记忆库、心潮、Leto、迎风小镇、醒来设置、这一刻），只能开关「聊天/醒来」
//   （「这一刻」是 wakeOnly：聊天那个开关打不开，见 wake/moments-box.ts）
//   她加的：在设置页「他的工具箱」里填 MCP 地址和令牌，存在 /etc/eclipsis/toolbox/boxes.json（600），令牌不回给前端
// 以后加新工具 = 加一个箱子，聊天和醒来各一个开关，默认都开。不同箱子里不许有同名的工具（后加的那个同名的不给）。
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DB } from './db.ts'
import { buildWakeBoxes, mcpBox, strings, type WakeBox } from './wake/boxes.ts'
import type { BlobStore } from './blobs.ts'
import { toOpenAITools, type McpTool } from './leto/mcp-client.ts'

export type Scene = 'chat' | 'wake'

export interface CustomBox {
  id: string
  title: string          // 设置页里显示的名字
  entryName: string      // open_xxx
  description: string    // 入口说明：箱子里大概有什么、什么时候用
  url: string
  token: string          // 没有就空（令牌在 URL 里的那种）
  chat: boolean
  wake: boolean
  /** 不让他用的：工具名，或参数里的命令名（像 AIsay 只有一个 cli 工具，命令写在 command 参数里）。不分大小写，整个词相同才算 */
  blocked?: string[]
}
interface BoxFile {
  custom: CustomBox[]
  /** 内置箱子的开关：{ memory: { chat: true, wake: false } } */
  builtin: Record<string, { chat?: boolean; wake?: boolean }>
  /** 箱子的顺序（箱子 id）。他手边的入口按这个排；两个箱子有同名工具时排前面的那个算数。没列进去的排在后面 */
  order?: string[]
}

let filePath = '/etc/eclipsis/toolbox/boxes.json'
export function setToolboxFile(p: string) { filePath = p; cache.clear() }

function readFile(): BoxFile {
  try {
    if (existsSync(filePath)) {
      const f = JSON.parse(readFileSync(filePath, 'utf8'))
      return { custom: Array.isArray(f.custom) ? f.custom : [], builtin: f.builtin && typeof f.builtin === 'object' ? f.builtin : {},
        order: Array.isArray(f.order) ? f.order.filter((x: unknown) => typeof x === 'string') : undefined }
    }
  } catch { /* 坏了按空的来，不覆盖它：写的时候会先备份 */ }
  return { custom: [], builtin: {} }
}
function writeFile(f: BoxFile) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o770 })
  if (existsSync(filePath)) { try { copyFileSync(filePath, `${filePath}.bak`) } catch {} }
  writeFileSync(filePath, JSON.stringify(f, null, 2), { mode: 0o600 })
  cache.clear()
}

const BUILTIN_TITLES: Record<string, string> = { memory: '记忆库', memo: '随手记', xinchao: '心潮', leto: 'Leto', town: '迎风小镇', settings: '醒来设置', moments: '这一刻', draw: '画笔' }

// 画笔要用 blobs 存图：main.ts 启动时塞进来
let blobStore: BlobStore | undefined
export function setToolboxBlobs(b: BlobStore) { blobStore = b }

interface Entry { box: WakeBox; title: string; builtin: boolean; chat: boolean; wake: boolean; custom?: CustomBox }

function entries(db: DB, env: NodeJS.ProcessEnv): Entry[] {
  const f = readFile()
  const out: Entry[] = buildWakeBoxes(db, env, blobStore).map(box => ({
    box, title: BUILTIN_TITLES[box.id] || box.id, builtin: true,
    chat: !box.wakeOnly && f.builtin[box.id]?.chat !== false, wake: f.builtin[box.id]?.wake !== false,
  }))
  const taken = new Set(out.map(e => e.box.entryName))
  for (const c of f.custom) {
    if (taken.has(c.entryName)) continue
    taken.add(c.entryName)
    const blocked = new Set((c.blocked || []).map(x => x.trim().toLowerCase()).filter(Boolean))
    out.push({
      box: mcpBox({ id: c.id, entryName: c.entryName, entryDescription: c.description,
        mcp: { baseUrl: '', url: c.url, token: c.token, label: c.title, timeoutMs: 60_000 },
        ...(blocked.size ? {
          allow: (name: string) => !blocked.has(name.toLowerCase()),
          block: (_name: string, args: Record<string, unknown>) => {
            const hit = strings(args).find(x => blocked.has(x.trim().toLowerCase()))
            return hit ? `「${hit.trim()}」她设成了不让用。` : undefined
          },
        } : {}) }),
      title: c.title, builtin: false, chat: c.chat, wake: c.wake, custom: c,
    })
  }
  if (f.order?.length) {
    const at = new Map(f.order.map((id, i) => [id, i]))
    const rank = (e: Entry) => at.get(e.box.id) ?? Number.MAX_SAFE_INTEGER
    out.sort((a, b) => rank(a) - rank(b))   // 稳定排序：没列进去的保持原来的先后
  }
  return out
}

/** 这个场景能用的箱子（醒来那边 dispatch.ts 也用这个） */
export function boxesFor(db: DB, scene: Scene, env: NodeJS.ProcessEnv = process.env): WakeBox[] {
  return entries(db, env).filter(e => (scene === 'chat' ? e.chat : e.wake)).map(e => e.box)
}

// 箱子里有哪些工具：问一次记 10 分钟（MCP 的 tools/list 不便宜，有的服务器还慢）
const cache = new Map<string, { at: number; tools: McpTool[] }>()
const TTL = 10 * 60_000
async function toolsOf(box: WakeBox): Promise<McpTool[]> {
  const hit = cache.get(box.entryName)
  if (hit && Date.now() - hit.at < TTL) return hit.tools
  const tools = await box.listTools()
  cache.set(box.entryName, { at: Date.now(), tools })
  return tools
}

/** 打开一个箱子：返回里面的工具（OpenAI 格式）。和别的箱子同名的不给 */
export async function openBox(db: DB, entryName: string, env: NodeJS.ProcessEnv = process.env): Promise<{ title: string; tools: any[] }> {
  const all = entries(db, env).filter(e => e.chat)
  const e = all.find(x => x.box.entryName === entryName)
  if (!e) throw new Error(`没有 ${entryName} 这个箱子`)
  const mine = await toolsOf(e.box)
  // 排在前面的箱子已经用了的名字（只看已经问过的，不为这个去问别的服务器）
  const before = new Set<string>()
  for (const x of all) { if (x === e) break; for (const t of cache.get(x.box.entryName)?.tools || []) before.add(t.name) }
  return { title: e.title, tools: toOpenAITools(mine.filter(t => !before.has(t.name) && t.name !== entryName)) }
}

/** 调箱子里的一个工具（聊天用）。box 是打开时的入口名，避免同名时调错箱子 */
export async function callBoxTool(db: DB, entryName: string, name: string, args: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env) {
  const e = entries(db, env).find(x => x.chat && x.box.entryName === entryName)
  if (!e) return { text: `没有 ${entryName} 这个箱子`, isError: true }
  try { return await e.box.call(name, args) } catch (err: any) { return { text: `调用失败：${String(err?.message || err).slice(0, 300)}`, isError: true } }
}

// ---------------- HTTP ----------------

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
function readJson(req: IncomingMessage, max = 64 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { reject(new Error('请求太大')); req.destroy(); return } chunks.push(c) })
    req.on('end', () => { try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : {}) } catch { reject(new Error('请求体不是合法 JSON')) } })
    req.on('error', reject)
  })
}

const ENTRY_RE = /^open_[a-z][a-z0-9_]{1,30}$/
const mask = (t: string) => (t ? `${t.slice(0, 3)}…${t.slice(-3)}（${t.length} 位）` : '')
/** 地址里可能带令牌（心潮、小镇就是），给前端看时只留主机和路径开头 */
const maskUrl = (u: string) => { try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname.length > 12 ? x.pathname.slice(0, 12) + '…' : x.pathname}` } catch { return '（地址看不懂）' } }

function validate(b: any): string | null {
  if (typeof b?.title !== 'string' || !b.title.trim() || b.title.length > 30) return '名字要填（30 字以内）'
  if (typeof b.entryName !== 'string' || !ENTRY_RE.test(b.entryName)) return '入口名要像 open_music 这样：open_ 开头，小写英文、数字、下划线'
  if (typeof b.description !== 'string' || b.description.trim().length < 4 || b.description.length > 600) return '要写一句说明：箱子里有什么、什么时候用（600 字以内）'
  if (typeof b.url !== 'string' || !/^https?:\/\//.test(b.url)) return 'MCP 地址要以 http:// 或 https:// 开头'
  if (b.blocked !== undefined && (!Array.isArray(b.blocked) || b.blocked.length > 50 || b.blocked.some((x: unknown) => typeof x !== 'string' || x.length > 96))) return '不让用的要一行一个（最多 50 个）'
  return null
}

/**
 *   GET  /v1/eclipsis/tools                      聊天时他手边的入口 { boxes: [{ entryName, description }] }
 *   POST /v1/eclipsis/tools/open  { entry }      打开箱子 → { title, tools }
 *   POST /v1/eclipsis/tools/call  { entry, name, args } → { text, isError }
 *   GET  /v1/eclipsis/toolbox                    设置页：所有箱子（令牌、地址打码）
 *   POST /v1/eclipsis/toolbox                    加/改她的箱子（改的时候令牌留空 = 不改）
 *   POST /v1/eclipsis/toolbox/flags  { id, chat, wake }   开关（内置的也能关）
 *   POST /v1/eclipsis/toolbox/order  { ids }     排顺序（他手边入口的顺序；同名工具排前面的算数）
 *   POST /v1/eclipsis/toolbox/delete { id }      删她的箱子
 *   POST /v1/eclipsis/toolbox/test   { id }      问一下箱子里有哪些工具
 */
export async function handleToolboxApi(db: DB, req: IncomingMessage, res: ServerResponse, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const p = new URL(req.url || '/', 'http://local').pathname
  if (!p.startsWith('/v1/eclipsis/tool')) return false
  try {
    if (p === '/v1/eclipsis/tools' && req.method === 'GET') {
      json(res, 200, { boxes: entries(db, env).filter(e => e.chat).map(e => ({ entryName: e.box.entryName, title: e.title, description: e.box.entryDescription })) })
      return true
    }
    if (p === '/v1/eclipsis/tools/open' && req.method === 'POST') {
      const b = await readJson(req)
      json(res, 200, await openBox(db, String(b?.entry || ''), env))
      return true
    }
    if (p === '/v1/eclipsis/tools/call' && req.method === 'POST') {
      const b = await readJson(req)
      const args = b?.args && typeof b.args === 'object' && !Array.isArray(b.args) ? b.args : {}
      json(res, 200, await callBoxTool(db, String(b?.entry || ''), String(b?.name || ''), args, env))
      return true
    }
    if (p === '/v1/eclipsis/toolbox' && req.method === 'GET') {
      json(res, 200, { boxes: entries(db, env).map(e => ({
        id: e.box.id, title: e.title, entryName: e.box.entryName, description: e.box.entryDescription,
        builtin: e.builtin, chat: e.chat, wake: e.wake, wakeOnly: e.box.wakeOnly || undefined,
        url: e.custom ? maskUrl(e.custom.url) : '（backend.env）', token: e.custom ? mask(e.custom.token) : '',
        blocked: e.custom ? e.custom.blocked || [] : undefined,
        tools: cache.get(e.box.entryName)?.tools.length ?? null,
      })) })
      return true
    }
    if (p === '/v1/eclipsis/toolbox' && req.method === 'POST') {
      const b = await readJson(req)
      const err = validate(b)
      if (err) { json(res, 400, { error: err }); return true }
      const f = readFile()
      const builtinNames = new Set(buildWakeBoxes(db, env, blobStore).map(x => x.entryName))
      const old = b.id ? f.custom.find(c => c.id === b.id) : undefined
      if (builtinNames.has(b.entryName) || f.custom.some(c => c.entryName === b.entryName && c.id !== old?.id)) {
        json(res, 400, { error: `入口名 ${b.entryName} 已经有箱子在用了` }); return true
      }
      const box: CustomBox = {
        id: old?.id || 'c' + Date.now().toString(36), title: b.title.trim(), entryName: b.entryName, description: b.description.trim(),
        url: b.url.trim(), token: typeof b.token === 'string' && b.token.trim() ? b.token.trim() : old?.token || '',
        chat: b.chat !== false, wake: b.wake !== false,
        blocked: Array.isArray(b.blocked) ? [...new Set<string>(b.blocked.map((x: string) => x.trim()).filter(Boolean))] : old?.blocked || [],
      }
      f.custom = old ? f.custom.map(c => (c.id === old.id ? box : c)) : [...f.custom, box]
      writeFile(f)
      json(res, 200, { ok: true, id: box.id })
      return true
    }
    if (p === '/v1/eclipsis/toolbox/flags' && req.method === 'POST') {
      const b = await readJson(req)
      const f = readFile()
      const id = String(b?.id || '')
      const c = f.custom.find(x => x.id === id)
      if (c) { if (typeof b.chat === 'boolean') c.chat = b.chat; if (typeof b.wake === 'boolean') c.wake = b.wake }
      else if (buildWakeBoxes(db, env, blobStore).some(x => x.id === id)) {
        if (b.chat === true && buildWakeBoxes(db, env, blobStore).find(x => x.id === id)?.wakeOnly) {
          json(res, 400, { error: '这个箱子只在醒来时有：聊天里调用，结果会经过她的手机、显示在聊天里' }); return true
        }
        f.builtin[id] = { ...f.builtin[id], ...(typeof b.chat === 'boolean' ? { chat: b.chat } : {}), ...(typeof b.wake === 'boolean' ? { wake: b.wake } : {}) }
      } else { json(res, 404, { error: '没有这个箱子' }); return true }
      writeFile(f)
      json(res, 200, { ok: true })
      return true
    }
    if (p === '/v1/eclipsis/toolbox/order' && req.method === 'POST') {
      const b = await readJson(req)
      const known = new Set(entries(db, env).map(e => e.box.id))
      if (!Array.isArray(b?.ids) || b.ids.some((x: unknown) => typeof x !== 'string')) { json(res, 400, { error: 'ids 要是箱子 id 的列表' }); return true }
      const f = readFile()
      f.order = [...new Set<string>(b.ids)].filter(id => known.has(id))
      writeFile(f)
      json(res, 200, { ok: true, order: f.order })
      return true
    }
    if (p === '/v1/eclipsis/toolbox/delete' && req.method === 'POST') {
      const b = await readJson(req)
      const f = readFile()
      const n = f.custom.length
      f.custom = f.custom.filter(c => c.id !== String(b?.id || ''))
      if (f.custom.length === n) { json(res, 404, { error: '没有这个箱子（内置的只能关，不能删）' }); return true }
      writeFile(f)
      json(res, 200, { ok: true })
      return true
    }
    if (p === '/v1/eclipsis/toolbox/test' && req.method === 'POST') {
      const b = await readJson(req)
      const e = entries(db, env).find(x => x.box.id === String(b?.id || ''))
      if (!e) { json(res, 404, { error: '没有这个箱子' }); return true }
      cache.delete(e.box.entryName)
      try {
        const tools = await toolsOf(e.box)
        json(res, 200, { ok: true, tools: tools.map(t => t.name) })
      } catch (err: any) { json(res, 200, { ok: false, error: String(err?.message || err).slice(0, 300) }) }
      return true
    }
  } catch (e: any) {
    json(res, 500, { error: String(e?.message || e) })
    return true
  }
  return false
}
