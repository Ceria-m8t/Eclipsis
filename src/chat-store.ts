// 聊天记录放在后端（经历表）：Kelivo、Eclipsis、醒来以外的日常聊天都在同一条时间线上。
// 这里只管读、删、把后端的样子转成聊天页用的 ChatMessage。
// 手机上只留两样：还没发出去的那几句（回车分条、还没点发送），和正在生成的那一条。
import type { ChatMessage, MessageVersion } from './db'

/** 他已读不回时整条回复就是这个 */
export const NO_REPLY = '[NO_REPLY]'
/** 正文（去掉思考以后）是不是已读不回；流式还没写完、只出了 "[NO_" 时也先当成是，免得闪一下 */
export function looksNoReply(body: string): boolean {
  const b = body.trim()
  return b.startsWith(NO_REPLY) || (b.length > 0 && b.length < NO_REPLY.length && NO_REPLY.startsWith(b))
}
/** 她按「已读不回」时发给他的信号 */
export const READ_SIGNAL = '〔她看了你的消息，没有回。〕'
/** 她的心声拼在消息末尾的样子 */
export const heartMarker = (t: string) => `〔她心里想的，没说出口：${t}〕`
const HEART_TAIL = /\n*〔她心里想的，没说出口：([\s\S]*?)〕\s*$/
/** 拆出她消息里的心声；他的回复里要是学着写了，也用这个剥掉 */
export function splitHeart(text: string): { text: string; thought: string } {
  const m = HEART_TAIL.exec(text)
  if (!m) return { text, thought: '' }
  return { text: text.slice(0, m.index).trim(), thought: m[1]!.trim() }
}

interface SrvTool { id: string; name: string; args: string; result?: string }
interface SrvVersion { seq: number; seqs: number[]; ts: string; content: string; thinking: string; tools: SrvTool[]; partial?: boolean; moment?: { locked: boolean; text: string }; images?: string[] }
export interface SrvItem {
  id: string; seq: number; seqs: number[]; role: 'user' | 'assistant'; ts: string; turn: string
  content: string; raw?: string; images?: string[]; versions?: SrvVersion[]; source: string
  files?: { name: string; hash: string; size: number; kind: string; chars: number; note: string | null }[]
  wake?: { id: string; trace?: string; tools?: string[]; silent?: boolean }
  noReply?: boolean
  /** 有好几版时算数的是第几版（她上次翻到的那版）：他只看得到这一版 */
  active?: number
}

const BASE = '/api/eclipsis/chat'

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) throw new Error(`读取聊天记录失败（HTTP ${r.status}）`)
  return r.json()
}

export function fromServer(it: SrvItem): ChatMessage {
  const createdAt = Date.parse(it.ts)
  const srv = { seqs: it.seqs, turn: it.turn, source: it.source }
  if (it.role === 'user') {
    // 早先从 xiaoke 导入的图片只剩「[图片]」两个字（xiaoke 不存图），照样显示出来，别成空的
    // 只发图时正文里有一行占位：Kelivo 写「[图片]」，Eclipsis 自己写「（图片）」。图另外显示在上面，有图时去掉，不然多一个气泡
    const text = it.images?.length ? it.content.split('\n').filter(l => !/^(\[图片\]|（图片）)$/.test(l.trim())).join('\n').trim() : it.content
    const heart = splitHeart(text)
    if (heart.text.trim() === READ_SIGNAL) return { id: it.id, seq: it.seq, role: 'user', createdAt, content: '', raw: it.raw, signal: 'read', srv }
    const content = heart.text || (it.images?.length || heart.thought ? '' : '[图片]')
    return { id: it.id, seq: it.seq, role: 'user', createdAt, content, raw: it.raw, images: it.images, files: it.files, thought: heart.thought || undefined, srv }
  }
  const versions: MessageVersion[] = (it.versions || []).map(v => {
    const out: MessageVersion = { content: v.content, createdAt: Date.parse(v.ts), srvSeqs: v.seqs }
    if (v.images?.length) out.images = v.images
    if (v.thinking) out.thinking = v.thinking
    if (v.moment) out.moment = v.moment
    if (v.tools.length) out.tools = v.tools.map(t => ({ id: t.id, name: t.name, args: t.args, result: t.result, status: 'done' as const }))
    return out
  })
  // 她上次翻到哪一版就接着看哪一版（后端记着，他也只看得到这一版）
  const active = it.active ?? versions.length - 1
  return { id: it.id, seq: it.seq, role: 'assistant', createdAt, content: it.content, versions, activeVersion: Math.max(0, active), srv,
    images: versions[Math.max(0, active)]?.images, wake: it.wake, noReply: it.noReply }
}

export async function loadLatest(limit = 150): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  const d = await getJson(`${BASE}/history?limit=${limit}`)
  return { messages: (d.items as SrvItem[]).map(fromServer), hasMore: !!d.hasMore }
}

export async function loadBefore(seq: number, limit = 150): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  const d = await getJson(`${BASE}/history?before=${seq}&limit=${limit}`)
  return { messages: (d.items as SrvItem[]).map(fromServer), hasMore: !!d.hasMore }
}

export async function loadAfter(seq: number): Promise<ChatMessage[]> {
  const d = await getJson(`${BASE}/history?after=${seq}`)
  return (d.items as SrvItem[]).map(fromServer)
}

/** 删：后端撤回 + 从 xiaoke 里删（他以后看不到） */
export async function deleteOnServer(seqs: number[]): Promise<void> {
  const r = await fetch(`${BASE}/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seqs }) })
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try { msg = (await r.json()).error || msg } catch {}
    throw new Error(msg)
  }
}

/** 她翻到了哪一版：记到后端，他以后只看得到这一版（失败不挡界面，下次翻再记） */
export async function setActiveVersion(turn: string, seq: number): Promise<void> {
  await fetch(`${BASE}/version`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turn, seq }) })
}

/** 后端那一段里最新的 seq（只看后端来的） */
export function lastServerSeq(list: ChatMessage[]): number {
  let s = 0
  for (const m of list) if (m.srv) s = Math.max(s, m.seq)
  return s
}

/** 第一条后端来的 seq（往前翻用） */
export function firstServerSeq(list: ChatMessage[]): number | null {
  for (const m of list) if (m.srv) return m.seq
  return null
}

/**
 * 把后端新来的合进列表：同一个 turn 的回复（重新生成出来的新版本）替换掉原来那一项，其余按 seq 接上。
 * 本地的（还没发的、正在生成/出错的）seq 是时间戳，比后端的大，排序后自然在最后。
 */
export function mergeServer(list: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const out = list.slice()
  for (const m of incoming) {
    const same = out.findIndex(x => x.srv && x.id === m.id)
    if (same >= 0) { out[same] = m; continue }
    // 同一次醒来分几次取回来的（先发的消息、后写的念头）：拼回一项
    if (m.wake) {
      const w = out.findIndex(x => x.wake?.id === m.wake!.id)
      if (w >= 0) {
        const x = out[w]!
        const content = [x.content, m.content].filter(Boolean).join('\n\n')
        const trace = [x.wake!.trace, m.wake.trace].filter(Boolean).join('\n\n') || undefined
        out[w] = { ...x, seq: Math.max(x.seq, m.seq), content,
          versions: [{ ...(x.versions?.[0] || { createdAt: x.createdAt }), content, srvSeqs: [...(x.versions?.[0]?.srvSeqs || []), ...(m.versions?.[0]?.srvSeqs || [])] }],
          wake: { ...x.wake!, trace, silent: x.wake!.silent && m.wake.silent, tools: m.wake.tools || x.wake!.tools },
          srv: { ...x.srv!, seqs: [...x.srv!.seqs, ...m.srv!.seqs] } }
        continue
      }
    }
    // 重新生成出来的新版本：单独取回来时是一项新的，但 turn 和原来那条一样 → 接到原来那条的版本后面
    const old = m.role === 'assistant' ? out.findIndex(x => x.srv && x.role === 'assistant' && x.srv.turn === m.srv!.turn) : -1
    if (old >= 0) {
      const x = out[old]!
      const versions = [...(x.versions || []).filter(v => v.srvSeqs), ...(m.versions || [])]
      out[old] = { ...x, seq: Math.max(x.seq, m.seq), content: m.content, versions, activeVersion: versions.length - 1, error: undefined,
        srv: { ...x.srv!, seqs: [...x.srv!.seqs, ...m.srv!.seqs] } }
      continue
    }
    out.push(m)
  }
  return out.sort((a, b) => a.seq - b.seq)
}

/**
 * 这一轮要发给他的：最后一条他的回复之后、她说的那几句（xiaoke 会补上前面的历史，和 Kelivo 一样）。
 * 一句都没有（重新生成一条前面紧挨着也是他的回复）时，往回找最近的一句她的话。
 */
export function contextTail(before: ChatMessage[]): ChatMessage[] {
  const tail: ChatMessage[] = []
  for (let i = before.length - 1; i >= 0; i--) {
    const m = before[i]!
    if (m.role === 'assistant') break
    tail.unshift(m)
  }
  if (tail.length) return tail
  for (let i = before.length - 1; i >= 0; i--) if (before[i]!.role === 'user') return [before[i]!]
  return []
}

// ---- 上次看到的最新一段：进聊天页先画它，再在后台跟后端对一遍（不然每次进来都要等网络） ----
const CACHE_KEY = 'eclipsis-chat-cache'
const CACHE_MAX = 150
let memCache: ChatMessage[] | null = null

export function readCache(): ChatMessage[] | null {
  if (memCache) return memCache
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (raw) memCache = JSON.parse(raw)
  } catch {}
  return memCache
}

export function writeCache(list: ChatMessage[]) {
  // 临时取回的图片 dataURL 不进缓存（太大）
  const srv = list.filter(m => m.srv && !m.error).slice(-CACHE_MAX).map(m => (m.imageData ? { ...m, imageData: undefined } : m))
  memCache = srv
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(srv)) } catch { /* 太大存不下：只留内存里那份 */ }
}

// ---- 还没发出去的几句：存在本机，刷新/切走不会丢 ----
const PENDING_KEY = 'eclipsis-chat-pending'

export function savePending(list: ChatMessage[]) {
  const pending = list.filter(m => !m.srv && m.role === 'user' && !m.sent)
  try {
    if (pending.length) localStorage.setItem(PENDING_KEY, JSON.stringify(pending))
    else localStorage.removeItem(PENDING_KEY)
  } catch { /* 图片太大存不下就算了 */ }
}

export function loadPending(): ChatMessage[] {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]') } catch { return [] }
}
