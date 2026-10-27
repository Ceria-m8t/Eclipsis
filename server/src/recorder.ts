// 记录器：每次调用写一条 exchange（原始证据），再从中推出经历（episodes）。
// 只记录，不改转发内容。任何异常都由调用方吞掉，不影响聊天。
import { type DB, tx, addEpisode } from './db.ts'
import { type BlobStore, sha256 } from './blobs.ts'
import { type Reply, parseReply } from './reply.ts'

// Dylan wake_up.js 发出的唤醒请求里固定有这句
export const WAKE_MARKER = '你现在处于后台自主唤醒状态'

const SCENES: Record<string, { channel: string; scope: string }> = {
  chat: { channel: 'chat', scope: 'daily' },
  room: { channel: 'room', scope: 'daily' },
  work: { channel: 'chat', scope: 'work' },
  game: { channel: 'game', scope: 'game' },
  creative: { channel: 'creative', scope: 'fiction' },
  group: { channel: 'group', scope: 'group' }
}
export function sceneInfo(scene: string | null): { channel: string; scope: string } {
  return SCENES[scene || ''] || SCENES.chat
}

export type Tap = 'front' | 'upstream'

export interface StartInput {
  tap: Tap
  rid: string
  linked: boolean               // 上游入口：请求里带了前端出口给的 rid
  path: string
  headers: Record<string, string | string[] | undefined>
  body: any                     // 已解析的 JSON（转发前的原样）
}

export interface ExchangeCtx {
  id: number
  tap: Tap
  rid: string
  linked: boolean
  scene: string | null
  conversation: string | null
  turn: string | null
  version: number | null
  startedAt: string
  startMs: number
  wake: boolean
  derive: boolean               // 是否从这次调用推出经历
}

export interface FinishInput {
  httpStatus: number | null
  contentType: string
  body: string                  // 上游响应原文（可能被截断）
  aborted: boolean              // 客户端中途断开
  networkError?: string
}

function header(h: StartInput['headers'], name: string): string | null {
  const v = h[name]
  const s = Array.isArray(v) ? v[0] : v
  if (!s) return null
  const t = String(s).trim().slice(0, 200)
  return t || null
}

// 消息正文转纯文本；图片换成 [图片]
export function textOf(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p: any) => {
    if (typeof p === 'string') return p
    if (p?.type === 'text' || p?.type === 'input_text') return p.text ?? ''
    if (p?.type === 'image_ref' || p?.type === 'image' || p?.image_url) return '[图片]'
    return ''
  }).filter(Boolean).join('\n')
}

export class Recorder {
  db: DB
  blobs: BlobStore

  constructor(db: DB, blobs: BlobStore) {
    this.db = db
    this.blobs = blobs
  }

  start(input: StartInput): ExchangeCtx {
    const now = new Date()
    const scene = header(input.headers, 'x-eclipsis-scene')
    const conversation = header(input.headers, 'x-eclipsis-conversation')
    const turn = header(input.headers, 'x-eclipsis-turn')
    const versionRaw = header(input.headers, 'x-eclipsis-version')
    const version = versionRaw !== null && /^\d+$/.test(versionRaw) ? Number(versionRaw) : null
    const body = input.body && typeof input.body === 'object' ? input.body : {}
    const messages: any[] = Array.isArray(body.messages) ? body.messages : []
    const stored = messages.map(m => this.blobs.putMessage(m))
    const { messages: _m, eclipsis_rid: _r, ...options } = body
    const optionsHash = this.blobs.putText('options', JSON.stringify(options))
    // 只看最后一条 user：xiaoke 会把以前的唤醒提示当成历史注入回来
    const lastUser = [...messages].reverse().find(m => m?.role === 'user')
    const wake = input.tap === 'upstream' && !input.linked && !!lastUser && textOf(lastUser.content).includes(WAKE_MARKER)
    // 前端出口的都推经历；上游入口只推"没经过前端出口"的（直连 Dylan 的客户端，如 Kelivo），避免记两遍
    const derive = input.tap === 'front' || (input.tap === 'upstream' && !input.linked && !wake)

    const ctx: ExchangeCtx = {
      id: 0, tap: input.tap, rid: input.rid, linked: input.linked,
      scene, conversation, turn, version, startedAt: now.toISOString(), startMs: now.getTime(), wake, derive
    }
    tx(this.db, () => {
      const r = this.db.prepare(`INSERT INTO exchanges(rid, tap, started_at, status, path, scene, conversation, turn, model, stream, message_hashes, options_hash)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.rid, input.tap, ctx.startedAt, input.path, scene, conversation, turn,
        typeof body.model === 'string' ? body.model : null, body.stream === true ? 1 : 0,
        JSON.stringify(stored.map(s => s.hash)), optionsHash
      )
      ctx.id = Number(r.lastInsertRowid)
      if (derive) this.startEpisodes(ctx, stored)
    })
    return ctx
  }

  // 前端出口：本轮新增的 user 消息、上一轮工具的结果
  private startEpisodes(ctx: ExchangeCtx, stored: { hash: string; message: any; images: string[] }[]) {
    const { channel, scope } = sceneInfo(ctx.scene)
    const last = stored[stored.length - 1]
    if (!last) return
    if (last.message?.role === 'user') {
      const text = textOf(last.message.content).trim() || (last.images.length ? '[图片]' : '')
      if (!text) return
      // 有 turn header 时按 turn 去重（重新生成不会重复记）；没有时按"会话 + 上下文链"去重
      const ref = ctx.turn
        ? `${ctx.tap}:turn:${ctx.conversation || '-'}:${ctx.turn}:user`
        : `${ctx.tap}:fp:${sha256((ctx.conversation || '-') + '|' + stored.map(s => s.hash).join(','))}:user`
      const meta: Record<string, unknown> = {}
      if (last.images.length) meta.images = last.images
      if (ctx.tap === 'upstream') meta.via = 'upstream'
      addEpisode(this.db, {
        ts: ctx.startedAt, channel, scope, actor: 'erica', kind: 'message', content: text,
        meta: Object.keys(meta).length ? meta : null, sourceRef: ref
      })
      return
    }
    // 结尾是一串 tool 消息：上一轮工具调用的结果
    for (let i = stored.length - 1; i >= 0 && stored[i].message?.role === 'tool'; i--) {
      const m = stored[i].message
      const callId = String(m.tool_call_id || stored[i].hash)
      addEpisode(this.db, {
        ts: ctx.startedAt, channel, scope, actor: 'tool', kind: 'tool_result',
        content: textOf(m.content), meta: { tool_call_id: callId }, sourceRef: `${ctx.tap}:tool_result:${callId}`
      })
    }
  }

  finish(ctx: ExchangeCtx, input: FinishInput): Reply | null {
    const now = new Date()
    const reply = input.httpStatus !== null ? parseReply(input.contentType, input.body) : null
    let status: string
    if (input.networkError) status = 'network_error'
    else if ((input.httpStatus ?? 0) >= 400 || reply?.error) status = 'http_error'
    // xiaoke 读到 [DONE] 就断开，这不算中断
    else if (input.aborted && !reply?.done) status = 'aborted'
    else status = 'ok'
    const error = input.networkError || reply?.error || ((input.httpStatus ?? 0) >= 400 ? input.body.slice(0, 2000) : null)

    tx(this.db, () => {
      this.db.prepare(`UPDATE exchanges SET finished_at = ?, status = ?, http_status = ?, latency_ms = ?,
        reply_content = ?, reply_thinking = ?, reply_tool_calls = ?, finish_reason = ?, usage = ?, error = ? WHERE id = ?`).run(
        now.toISOString(), status, input.httpStatus, now.getTime() - ctx.startMs,
        reply?.content || null, reply?.thinking || null,
        reply?.toolCalls.length ? JSON.stringify(reply.toolCalls) : null,
        reply?.finishReason ?? null, reply?.usage ? JSON.stringify(reply.usage) : null, error, ctx.id
      )
      if (!reply) return
      // 中途断开（她点了停止 / 网络断了）时，前端会保留已收到的部分并在下一轮发回去，所以也记
      const partial = status === 'aborted' || status === 'network_error'
      const usable = status === 'ok' || (partial && (reply.content.trim() || reply.toolCalls.length))
      if (!usable) return
      if (ctx.derive) this.finishEpisodes(ctx, reply, partial, now.toISOString())
      else if (ctx.wake && reply.content.trim()) {
        addEpisode(this.db, {
          ts: now.toISOString(), channel: 'wake', scope: 'daily', actor: 'ai', kind: 'wake',
          content: reply.content.trim(), meta: { rid: ctx.rid }, sourceRef: `wake:${ctx.rid}`
        })
      }
    })
    return reply
  }

  // 前端出口：他的回复文字、他发起的工具调用
  private finishEpisodes(ctx: ExchangeCtx, reply: Reply, partial: boolean, ts: string) {
    const { channel, scope } = sceneInfo(ctx.scene)
    const text = reply.content.trim()
    if (text) {
      addEpisode(this.db, {
        ts, channel, scope, actor: 'ai', kind: 'message', content: text,
        meta: {
          rid: ctx.rid, turn: ctx.turn, version: ctx.version,
          regenerated: (ctx.version ?? 0) > 0 || undefined,
          partial: partial || undefined, finish_reason: reply.finishReason,
          via: ctx.tap === 'upstream' ? 'upstream' : undefined
        },
        sourceRef: `${ctx.tap}:reply:${ctx.rid}`
      })
    }
    reply.toolCalls.forEach((c, i) => {
      addEpisode(this.db, {
        ts, channel, scope, actor: 'ai', kind: 'tool_call', content: `${c.name}(${c.arguments})`,
        meta: { tool_call_id: c.id || null, name: c.name, rid: ctx.rid },
        sourceRef: c.id ? `${ctx.tap}:tool_call:${c.id}` : `${ctx.tap}:tool_call:${ctx.rid}:${i}`
      })
    })
  }
}
