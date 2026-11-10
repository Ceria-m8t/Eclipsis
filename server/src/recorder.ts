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
  body: any                     // 已解析的 JSON（实际发出去的内容，加工过）
  clientBody?: any              // 调用方原来发的那份：经历表按它记
  transforms?: Record<string, unknown> | null
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
  /** 这一轮她说的话（最后一段连着的 user，含工具轮之前的那段），给心潮判互动用 */
  herText?: string
}

/** 去掉 Kelivo/前端加的时间标记，只留她说的话 */
export function cleanHerText(t: string): string {
  return t.replace(/<current_time>[\s\S]*?<\/current_time>/g, '')
    .replace(/^[（(]\d{4}-\d{2}-\d{2} \d{2}:\d{2}[）)]\s*/gm, '')
    .trim()
}

/** 最后一段连着的 user 消息（工具轮时往前越过 assistant/tool 找） */
export function lastHerTurn(messages: any[]): string {
  let i = messages.length - 1
  while (i >= 0 && messages[i]?.role !== 'user') i--
  const parts: string[] = []
  while (i >= 0 && messages[i]?.role === 'user') { parts.unshift(cleanHerText(textOf(messages[i].content))); i-- }
  return parts.filter(Boolean).join('\n')
}

// 都是从收到请求起算的毫秒数
export interface Timing {
  ttfbMs: number | null         // 上游返回响应头
  firstTokenMs: number | null   // 第一个有内容的分片（文字/思考/工具）
  clientClosedMs: number | null // 调用方在回复结束前断开
  bytesOut: number              // 实际写给调用方的字节数
}

export interface FinishInput {
  httpStatus: number | null
  contentType: string
  body: string                  // 上游响应原文（可能被截断）
  aborted: boolean              // 客户端中途断开
  networkError?: string
  timing?: Timing
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

/** 判断「是不是同一句」：不看图片占位行和空白（同一句第二次发时，图可能换成了文字占位，或者反过来） */
function sameText(t: string): string {
  return t.split('\n').filter(l => !/^\s*(\[图片\]|（图片）)\s*$/.test(l)).join('\n').replace(/\s+/g, ' ').trim()
}

export class Recorder {
  db: DB
  blobs: BlobStore

  /** 经历表里新写入了她的消息时调用（事务提交之后；重复/重新生成不会触发）。异常不影响记录 */
  onEricaMessage?: (text: string) => void
  /** 一轮聊天正常说完（不是中途调工具）时调用：她说的、他回的。异常不影响记录 */
  onTurnComplete?: (her: string, his: string) => void

  constructor(db: DB, blobs: BlobStore, opts: { onEricaMessage?: (text: string) => void; onTurnComplete?: (her: string, his: string) => void } = {}) {
    this.db = db
    this.blobs = blobs
    this.onEricaMessage = opts.onEricaMessage
    this.onTurnComplete = opts.onTurnComplete
  }

  // body = 真正发出去的那份（加工过的，message_hashes 记它）；clientBody = 调用方原来发的那份，经历表按它记。
  // 两份不一样很要紧：加工会把文件标记换成整份文件的正文，按加工后的记，她那条消息会变成几千字的文件内容（11-11 踩过）
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
    const clientBody = input.clientBody && typeof input.clientBody === 'object' ? input.clientBody : body
    const clientMessages: any[] = Array.isArray(clientBody.messages) ? clientBody.messages : messages
    const storedClient = clientBody === body ? stored : clientMessages.map(m => this.blobs.putMessage(m))
    const { messages: _m, eclipsis_rid: _r, ...options } = body
    const optionsHash = this.blobs.putText('options', JSON.stringify(options))
    // 只看最后一条 user：xiaoke 会把以前的唤醒提示当成历史注入回来
    const lastUser = [...messages].reverse().find(m => m?.role === 'user')
    const wake = input.tap === 'upstream' && !input.linked && !!lastUser && textOf(lastUser.content).includes(WAKE_MARKER)
    // 前端出口的都推经历；上游入口只推"没经过前端出口"的（直连 Dylan 的客户端，如 Kelivo），避免记两遍
    const derive = input.tap === 'front' || (input.tap === 'upstream' && !input.linked && !wake)

    const ctx: ExchangeCtx = {
      id: 0, tap: input.tap, rid: input.rid, linked: input.linked,
      scene, conversation, turn, version, startedAt: now.toISOString(), startMs: now.getTime(), wake, derive,
      herText: derive ? lastHerTurn(clientMessages) : undefined
    }
    let newErica: string[] = []
    tx(this.db, () => {
      const r = this.db.prepare(`INSERT INTO exchanges(rid, tap, started_at, status, path, scene, conversation, turn, version, model, stream, message_hashes, options_hash, transforms)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.rid, input.tap, ctx.startedAt, input.path, scene, conversation, turn, version,
        typeof body.model === 'string' ? body.model : null, body.stream === true ? 1 : 0,
        JSON.stringify(stored.map(s => s.hash)), optionsHash,
        input.transforms ? JSON.stringify(input.transforms) : null
      )
      ctx.id = Number(r.lastInsertRowid)
      if (derive) newErica = this.startEpisodes(ctx, storedClient)
    })
    if (newErica.length && this.onEricaMessage) {
      try { this.onEricaMessage(newErica.join('\n')) } catch { /* 通知失败不影响记录 */ }
    }
    return ctx
  }

  // 前端出口：本轮新增的 user 消息、上一轮工具的结果
  // 返回本次新写入的她的消息正文（已存在的不算）
  private startEpisodes(ctx: ExchangeCtx, stored: { hash: string; message: any; images: string[] }[]): string[] {
    const { channel, scope } = sceneInfo(ctx.scene)
    const last = stored[stored.length - 1]
    const inserted: string[] = []
    if (!last) return inserted
    if (last.message?.role === 'user') {
      // 重新生成：她的话第一次发的时候已经记过了（Kelivo 那边来的也一样），不再记一遍
      if (ctx.turn && (ctx.version ?? 0) > 0) return inserted
      // 她这一次发送的所有话：结尾连在一起的 user（回车分条发、最后才点发送的几句），每句一条经历
      let first = stored.length - 1
      while (first > 0 && stored[first - 1].message?.role === 'user') first--
      // 有 turn header 时按 turn 去重（重新生成不会重复记）；没有时按"会话 + 上下文链"去重。
      // 最后一句沿用原来的键；前面几句加 -1、-2……（倒数第几句）
      const base = ctx.turn
        ? `${ctx.tap}:turn:${ctx.conversation || '-'}:${ctx.turn}:user`
        : `${ctx.tap}:fp:${sha256((ctx.conversation || '-') + '|' + stored.map(s => s.hash).join(','))}:user`
      // 上一轮停掉/失败了、她补了几句再发：前面那几句已经记过了（还没有他的回复），不再记一遍。
      // 按「同样的话出现几次」算：这次请求里比库里多出来的才记（她真的连说两遍同一句也不会丢）
      const lastAi = (this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM episodes WHERE channel = ? AND actor = 'ai' AND kind = 'message' AND retracted_at IS NULL`).get(channel) as { s: number }).s
      const already = new Map<string, number>()
      for (const r of this.db.prepare(`SELECT content FROM episodes WHERE channel = ? AND actor = 'erica' AND kind = 'message' AND retracted_at IS NULL AND seq > ? AND ts >= ?`)
        .all(channel, lastAi, new Date(Date.now() - 12 * 3600_000).toISOString()) as { content: string }[]) {
        const k = sameText(r.content); already.set(k, (already.get(k) || 0) + 1)
      }
      for (let i = first; i < stored.length; i++) {
        const m = stored[i]
        const text = textOf(m.message.content).trim() || (m.images.length ? '[图片]' : '')
        if (!text) continue
        const k = sameText(text)
        const left = already.get(k) || 0
        if (left > 0) { already.set(k, left - 1); continue }
        const back = stored.length - 1 - i
        const meta: Record<string, unknown> = {}
        if (m.images.length) meta.images = m.images
        if (ctx.tap === 'upstream') meta.via = 'upstream'
        const added = addEpisode(this.db, {
          ts: ctx.startedAt, channel, scope, actor: 'erica', kind: 'message', content: text,
          meta: Object.keys(meta).length ? meta : null, sourceRef: back ? `${base}-${back}` : base
        })
        if (added) inserted.push(text)
      }
      return inserted
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
    return inserted
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
        reply_content = ?, reply_thinking = ?, reply_tool_calls = ?, finish_reason = ?, usage = ?, error = ?,
        ttfb_ms = ?, first_token_ms = ?, client_closed_ms = ?, bytes_out = ? WHERE id = ?`).run(
        now.toISOString(), status, input.httpStatus, now.getTime() - ctx.startMs,
        reply?.content || null, reply?.thinking || null,
        reply?.toolCalls.length ? JSON.stringify(reply.toolCalls) : null,
        reply?.finishReason ?? null, reply?.usage ? JSON.stringify(reply.usage) : null, error,
        input.timing?.ttfbMs ?? null, input.timing?.firstTokenMs ?? null, input.timing?.clientClosedMs ?? null,
        input.timing?.bytesOut ?? null, ctx.id
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
    if (status === 'ok' && ctx.derive && ctx.herText && reply && !reply.toolCalls.length && this.onTurnComplete) {
      let his = reply.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
      his = his.replace(/<moment(\s+lock)?\s*>[\s\S]*?(?:<\/moment>|$)/gi, '').trim()
      if (his.startsWith('[NO_REPLY]')) his = '（他看了，没有回）'
      if (his) { try { this.onTurnComplete(ctx.herText, his) } catch { /* 通知失败不影响记录 */ } }
    }
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
