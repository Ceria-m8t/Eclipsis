// 给前端读的接口（第一期只有调试面板一个）。挂在前端出口上：nginx /api/ 已经要求登录，端口只听本机。
//   GET /v1/eclipsis/turn/<turn>?version=N   这一条回复（含工具调用的多轮）每一轮发了什么、花了多久
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DB } from './db.ts'

const PREVIEW = 60
const MAX_MESSAGES = 400

export interface MessageSummary {
  role: string
  chars: number
  images: number
  tool_calls: number
  origin: 'frontend' | 'gateway'   // frontend = 前端发出去的；gateway = 一路上（Dylan/xiaoke）补进来的
  preview: string
}

export interface RoundInfo {
  rid: string
  started_at: string
  model: string | null
  status: string
  error: string | null
  front: { ttfb_ms: number | null; first_token_ms: number | null; latency_ms: number | null; client_closed_ms: number | null } | null
  upstream: { ttfb_ms: number | null; first_token_ms: number | null; latency_ms: number | null; status: string; error: string | null } | null
  transforms: unknown
  sent: { messages: number; chars: number; system_chars: number } | null
  delivered: { messages: number; chars: number; from_frontend: number; from_gateway: number; gateway_chars: number } | null
  messages: MessageSummary[]
  reply: { chars: number; thinking_chars: number; tool_calls: string[]; finish_reason: string | null }
}

function textOf(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 }
  if (!Array.isArray(content)) return { text: '', images: 0 }
  let text = '', images = 0
  for (const p of content as any[]) {
    if (p?.type === 'text' || p?.type === 'input_text') text += (text ? '\n' : '') + (p.text ?? '')
    else if (p?.type === 'image_ref' || p?.type === 'image' || p?.image_url) images++
  }
  return { text, images }
}

function loadMessages(db: DB, hashesJson: string | null): { hash: string; msg: any }[] {
  if (!hashesJson) return []
  const hashes = JSON.parse(hashesJson) as string[]
  const get = db.prepare('SELECT text FROM blobs WHERE hash = ?')
  return hashes.slice(-MAX_MESSAGES).map(h => {
    const row = get.get(h) as { text: string | null } | undefined
    try { return { hash: h, msg: row?.text ? JSON.parse(row.text) : {} } } catch { return { hash: h, msg: {} } }
  })
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

export function turnRounds(db: DB, turn: string, version: number | null): RoundInfo[] {
  const fronts = db.prepare(`SELECT * FROM exchanges WHERE tap = 'front' AND turn = ?
    AND (? IS NULL OR version = ? OR version IS NULL) ORDER BY id`).all(turn, version, version) as any[]
  const upOf = db.prepare(`SELECT * FROM exchanges WHERE tap = 'upstream' AND rid = ? ORDER BY id LIMIT 1`)
  return fronts.map(f => {
    const up = upOf.get(f.rid) as any | undefined
    const sentMsgs = loadMessages(db, f.message_hashes)
    const sentHashes = new Set(sentMsgs.map(m => m.hash))
    const sentChars = sentMsgs.reduce((n, m) => n + textOf(m.msg.content).text.length, 0)
    const systemChars = sentMsgs.filter(m => m.msg.role === 'system').reduce((n, m) => n + textOf(m.msg.content).text.length, 0)
    // 有上游记录就展示实际发给模型的；没有就展示前端发出的
    const shown = up ? loadMessages(db, up.message_hashes) : sentMsgs
    const messages: MessageSummary[] = shown.map(({ hash, msg }) => {
      const { text, images } = textOf(msg.content)
      return {
        role: String(msg.role || '?'),
        chars: text.length,
        images,
        tool_calls: Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 0,
        origin: !up || sentHashes.has(hash) ? 'frontend' : 'gateway',
        preview: flat(text).slice(0, PREVIEW)
      }
    })
    const gw = messages.filter(m => m.origin === 'gateway')
    const toolCalls = (() => { try { return (JSON.parse(f.reply_tool_calls || '[]') as any[]).map(c => String(c.name)) } catch { return [] } })()
    return {
      rid: f.rid,
      started_at: f.started_at,
      model: f.model,
      status: f.status,
      error: f.error,
      front: { ttfb_ms: f.ttfb_ms, first_token_ms: f.first_token_ms, latency_ms: f.latency_ms, client_closed_ms: f.client_closed_ms },
      upstream: up ? { ttfb_ms: up.ttfb_ms, first_token_ms: up.first_token_ms, latency_ms: up.latency_ms, status: up.status, error: up.error } : null,
      transforms: up?.transforms ? JSON.parse(up.transforms) : null,
      sent: { messages: sentMsgs.length, chars: sentChars, system_chars: systemChars },
      delivered: up ? {
        messages: messages.length,
        chars: messages.reduce((n, m) => n + m.chars, 0),
        from_frontend: messages.length - gw.length,
        from_gateway: gw.length,
        gateway_chars: gw.reduce((n, m) => n + m.chars, 0)
      } : null,
      messages,
      reply: {
        chars: (f.reply_content || '').length,
        thinking_chars: (f.reply_thinking || '').length,
        tool_calls: toolCalls,
        finish_reason: f.finish_reason
      }
    }
  })
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

// 返回 true 表示这里处理了
export function handleApi(db: DB, req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || '/', 'http://local')
  const m = /^\/v1\/eclipsis\/turn\/([\w-]{1,80})$/.exec(url.pathname)
  if (!m) return false
  if (req.method !== 'GET') { json(res, 405, { error: 'method not allowed' }); return true }
  const v = url.searchParams.get('version')
  const version = v !== null && /^\d{1,4}$/.test(v) ? Number(v) : null
  try {
    json(res, 200, { turn: m[1], version, rounds: turnRounds(db, m[1], version) })
  } catch (e: any) {
    json(res, 500, { error: String(e?.message || e) })
  }
  return true
}
