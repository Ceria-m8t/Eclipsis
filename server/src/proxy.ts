// 透传代理：原样转发、原样流式返回，同时把请求和响应抄一份给记录器。
// 记录出错只打日志，永远不影响转发。
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Recorder, ExchangeCtx, Tap, Timing } from './recorder.ts'

const MAX_BODY = 25 * 1024 * 1024      // nginx 那边是 20m
const MAX_CAPTURE = 20 * 1024 * 1024   // 记录用的响应副本上限，超过不再追加（转发不受影响）

// 不转发的请求头
const DROP_REQ = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'content-length', 'accept-encoding', 'x-eclipsis-scene', 'x-eclipsis-conversation',
  'x-eclipsis-turn', 'x-eclipsis-version'])
// 不回传的响应头（fetch 已经解压过，长度/编码都不再准确）
const DROP_RES = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length'])

/** 中转站回这些状态时自动重试（见 retry429DelaysMs） */
const RETRY_STATUSES = new Set([429, 502, 503])

export interface Prepared {
  rid: string
  linked: boolean
  body: Buffer            // 实际发出去的请求体
  json?: any              // 改过请求时：实际发出去的 JSON（记录用这个）
  transforms?: Record<string, unknown> | null
}

export interface TapOptions {
  tap: Tap
  name: string
  authorize: (req: IncomingMessage) => boolean
  target: (path: string) => string | null                    // null = 未配置，返回 503
  outgoingHeaders: (req: IncomingMessage) => Record<string, string>
  prepare: (json: any | null, raw: Buffer) => Prepared
  recorder: Recorder | null
  headerTimeoutMs: number
  /** 开始输出后连续多久没有任何字节就断开；不给 = 不限 */
  streamIdleMs?: number
  /** 中转站回 429/502/503 时先不告诉客户端，隔这些毫秒各自动重试一次；不给 = 不重试（名字沿用最早只管 429 时的） */
  retry429DelaysMs?: number[]
  api?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>   // 本地接口，返回 true 表示已处理，不转发
  log?: (msg: string, err?: unknown) => void
}

export function forwardHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || DROP_REQ.has(k)) continue
    out[k] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, obj: unknown) {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

const isChat = (path: string) => /^\/v1\/chat\/completions(\?|$)/.test(path)

// 流里第一条有内容的分片（文字、思考或工具调用）。跨分片拼行，找到就不再看。
export class FirstTokenWatch {
  private buf = ''
  found = false
  feed(chunk: Buffer): boolean {
    if (this.found) return false
    this.buf += chunk.toString('utf8')
    const lines = this.buf.split('\n')
    this.buf = lines.pop() || ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      try {
        const d = JSON.parse(line.slice(5).trim())?.choices?.[0]?.delta || {}
        const think = d.reasoning_content ?? d.reasoning ?? d.thinking
        if ((typeof d.content === 'string' && d.content) || (typeof think === 'string' && think) || d.tool_calls?.length) {
          this.found = true
          this.buf = ''
          return true
        }
      } catch {}
    }
    if (this.buf.length > 1_000_000) this.buf = ''
    return false
  }
}

export function createTap(opts: TapOptions): Server {
  const log = opts.log || ((m: string, e?: unknown) => console.error(`[${opts.name}] ${m}`, e ?? ''))

  return createServer(async (req, res) => {
    const t0 = Date.now()
    const path = req.url || '/'
    if (path === '/healthz') return sendJson(res, 200, { service: 'eclipsis-backend', tap: opts.tap, status: 'ok' })
    if (opts.api) {
      try { if (await opts.api(req, res)) return } catch (e) { log('接口出错', e); return sendJson(res, 500, { error: 'internal error' }) }
    }
    if (!opts.authorize(req)) return sendJson(res, 401, { error: { message: 'unauthorized', type: 'authentication_error' } })
    const target = opts.target(path)
    if (!target) return sendJson(res, 503, { error: { message: `${opts.name}: 上游地址未配置`, type: 'config_error' } })

    let raw: Buffer
    try { raw = await readBody(req) } catch (e: any) {
      return sendJson(res, e?.status || 400, { error: { message: String(e?.message || e), type: 'invalid_request_error' } })
    }

    // 只记录 chat/completions；其他路径（/v1/models 等）纯透传
    const method = req.method || 'GET'
    let json: any = null
    const ct = String(req.headers['content-type'] || '')
    if (method === 'POST' && isChat(path) && raw.length && ct.includes('json')) {
      try { json = JSON.parse(raw.toString('utf8')) } catch { json = null }
    }
    let prepared: Prepared = { rid: randomUUID(), linked: false, body: raw }
    if (json) {
      try { prepared = opts.prepare(json, raw) } catch (e) { log('prepare 失败，按原样转发', e) }
    }

    let ctx: ExchangeCtx | null = null
    if (json && opts.recorder) {
      try {
        ctx = opts.recorder.start({
          tap: opts.tap, rid: prepared.rid, linked: prepared.linked, path, headers: req.headers,
          body: prepared.json ?? json, transforms: prepared.transforms
        })
      }
      catch (e) { log('记录 start 失败', e) }
    }
    const finish = (input: Parameters<Recorder['finish']>[1]) => {
      if (!ctx || !opts.recorder) return
      try { opts.recorder.finish(ctx, input) } catch (e) { log('记录 finish 失败', e) }
      ctx = null
    }

    // 客户端断开 → 取消上游请求
    const ac = new AbortController()
    let clientGone = false
    const timing: Timing = { ttfbMs: null, firstTokenMs: null, clientClosedMs: null, bytesOut: 0 }
    res.on('close', () => { if (!res.writableFinished) { clientGone = true; timing.clientClosedMs = Date.now() - t0; ac.abort() } })
    let upstream: Response
    // 2026-11-07：中转站偶尔回 429（请求太多），他连着调工具时一被拒，Kelivo 那串工具就断了。
    // 429 = 站点没处理这次请求，重试不会重复执行；隔几秒自己再试，客户端只觉得慢一点
    // 2026-11-08：502/503 也这样重试。晚晚舟号池用完时回 502「All available accounts exhausted」，
    // 他在 Leto 上连着调工具，18:22、18:25 两次被拒，Kelivo 那串就断了。
    // 重试只是让站再算一次这条回复（工具在客户端执行，不会多做一遍）。500/504 不重试：可能是站真算了一半或已经等太久。
    const retryDelays = opts.retry429DelaysMs ?? []
    for (let attempt = 0; ; attempt++) {
      const timer = setTimeout(() => ac.abort(new Error('上游响应头超时')), opts.headerTimeoutMs)
      try {
        upstream = await fetch(target, {
          method,
          headers: opts.outgoingHeaders(req),
          body: method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(prepared.body),
          signal: ac.signal,
          redirect: 'manual'
        })
      } catch (e: any) {
        clearTimeout(timer)
        const msg = clientGone ? 'client aborted' : `上游连接失败：${e?.cause?.message || e?.message || e}`
        finish({ httpStatus: null, contentType: '', body: '', aborted: clientGone, networkError: clientGone ? undefined : msg, timing })
        if (!clientGone) sendJson(res, 502, { error: { message: msg, type: 'upstream_error' } })
        return
      }
      clearTimeout(timer)
      if (!RETRY_STATUSES.has(upstream.status) || attempt >= retryDelays.length || clientGone) break
      try { await upstream.body?.cancel() } catch { /* 丢掉这次的回包 */ }
      const wait = retryDelays[attempt]
      log(`[${opts.name}] 中转站 ${upstream.status}，${Math.round(wait / 1000)} 秒后自动重试（第 ${attempt + 1} 次）`)
      await new Promise(r => setTimeout(r, wait))
      if (clientGone) {
        finish({ httpStatus: upstream.status, contentType: '', body: '', aborted: true, timing })
        return
      }
    }
    timing.ttfbMs = Date.now() - t0
    const watch = new FirstTokenWatch()

    const headers: Record<string, string> = {}
    upstream.headers.forEach((v, k) => { if (!DROP_RES.has(k)) headers[k] = v })
    const upstreamCt = upstream.headers.get('content-type') || ''
    if (upstreamCt.includes('text/event-stream')) {
      headers['cache-control'] = 'no-cache'
      headers['x-accel-buffering'] = 'no'
    }
    res.writeHead(upstream.status, headers)

    const captured: Buffer[] = []
    let capturedSize = 0
    let streamError: string | undefined
    // 2026-11-07：中转站回了响应头、吐了 232 字节就再没动静，xiaoke 只有一个 worker，被占了 10 分钟，后面的 roll 全排队超时（524）
    let idle: ReturnType<typeof setTimeout> | undefined
    let idleTimedOut = false
    const armIdle = () => {
      if (!opts.streamIdleMs) return
      clearTimeout(idle)
      idle = setTimeout(() => { idleTimedOut = true; ac.abort(new Error('上游流卡住')) }, opts.streamIdleMs)
    }
    try {
      if (upstream.body) {
        armIdle()
        for await (const chunk of upstream.body as any as AsyncIterable<Uint8Array>) {
          armIdle()
          const buf = Buffer.from(chunk)
          if (ctx && capturedSize < MAX_CAPTURE) { captured.push(buf); capturedSize += buf.length }
          if (timing.firstTokenMs === null && watch.feed(buf)) timing.firstTokenMs = Date.now() - t0
          if (!clientGone) { res.write(buf); timing.bytesOut += buf.length }
        }
      }
      res.end()
    } catch (e: any) {
      if (!clientGone) {
        streamError = idleTimedOut
          ? `上游 ${Math.round((opts.streamIdleMs ?? 0) / 1000)} 秒没有任何输出，已断开`
          : `上游流中断：${e?.message || e}`
        log(streamError)
      }
      res.destroy()
    } finally {
      clearTimeout(idle)
    }
    finish({
      httpStatus: upstream.status, contentType: upstreamCt,
      body: Buffer.concat(captured).toString('utf8'), aborted: clientGone, networkError: streamError, timing
    })
  })
}
