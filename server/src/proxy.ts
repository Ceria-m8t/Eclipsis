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
    const timer = setTimeout(() => ac.abort(new Error('上游响应头超时')), opts.headerTimeoutMs)

    let upstream: Response
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
    try {
      if (upstream.body) {
        for await (const chunk of upstream.body as any as AsyncIterable<Uint8Array>) {
          const buf = Buffer.from(chunk)
          if (ctx && capturedSize < MAX_CAPTURE) { captured.push(buf); capturedSize += buf.length }
          if (timing.firstTokenMs === null && watch.feed(buf)) timing.firstTokenMs = Date.now() - t0
          if (!clientGone) { res.write(buf); timing.bytesOut += buf.length }
        }
      }
      res.end()
    } catch (e: any) {
      if (!clientGone) { streamError = `上游流中断：${e?.message || e}`; log(streamError) }
      res.destroy()
    }
    finish({
      httpStatus: upstream.status, contentType: upstreamCt,
      body: Buffer.concat(captured).toString('utf8'), aborted: clientGone, networkError: streamError, timing
    })
  })
}
