// Eclipsis 后端（第一期：影子地基）
//   前端出口 FRONT_PORT：nginx /api/ → 这里 → Dylan。记下前端发了什么、场景、他回了什么，推出经历。
//   上游入口 TAP_PORT ：xiaoke → 这里 → 中转站。记下实际发给模型的完整内容。
// 两边都只记录、原样转发，不改回复。
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import { loadConfig, joinV1, type Config } from './config.ts'
import { openDb, type DB } from './db.ts'
import { BlobStore } from './blobs.ts'
import { Recorder } from './recorder.ts'
import { createTap, forwardHeaders, type Prepared } from './proxy.ts'

function bearer(req: IncomingMessage): string {
  const h = String(req.headers.authorization || '')
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function buildServers(cfg: Config, db: DB, opts: { linkRid?: boolean; log?: (m: string, e?: unknown) => void } = {}): { front: Server; tap: Server } {
  const blobs = new BlobStore(db, cfg.blobDir)
  const recorder = new Recorder(db, blobs)

  // 前端出口：鉴权交给 Dylan（nginx 注入的网关 key 原样带过去）；本端口只监听 127.0.0.1
  const front = createTap({
    tap: 'front', name: 'front', recorder, headerTimeoutMs: cfg.headerTimeoutMs, log: opts.log,
    authorize: () => true,
    target: path => joinV1(cfg.dylanUrl, path),
    outgoingHeaders: forwardHeaders,
    prepare: (json, raw): Prepared => {
      const rid = crypto.randomUUID()
      // 把 rid 塞进请求体，Dylan 和 xiaoke 会原样带到上游入口，两边记录就能对上。
      // 上游入口会把它删掉再发给中转站；所以只有上游入口接好之后才能打开。
      if (!opts.linkRid) return { rid, linked: false, body: raw }
      return { rid, linked: false, body: Buffer.from(JSON.stringify({ ...json, eclipsis_rid: rid })) }
    }
  })

  // 上游入口：只认 TAP_KEY；发给中转站时换成 UPSTREAM_KEY
  const tap = createTap({
    tap: 'upstream', name: 'tap', recorder, headerTimeoutMs: cfg.headerTimeoutMs, log: opts.log,
    authorize: req => !!cfg.tapKey && safeEqual(bearer(req), cfg.tapKey),
    target: path => (cfg.upstreamUrl ? joinV1(cfg.upstreamUrl, path) : null),
    outgoingHeaders: req => {
      const h: Record<string, string> = {
        'content-type': String(req.headers['content-type'] || 'application/json'),
        accept: String(req.headers.accept || 'application/json')
      }
      if (cfg.upstreamKey) h.authorization = `Bearer ${cfg.upstreamKey}`
      if (req.headers['user-agent']) h['user-agent'] = String(req.headers['user-agent'])
      return h
    },
    prepare: (json, raw): Prepared => {
      const linkedRid = typeof json?.eclipsis_rid === 'string' && /^[\w-]{8,64}$/.test(json.eclipsis_rid) ? json.eclipsis_rid : null
      if (!('eclipsis_rid' in json)) return { rid: crypto.randomUUID(), linked: false, body: raw }
      const { eclipsis_rid: _drop, ...rest } = json
      return { rid: linkedRid || crypto.randomUUID(), linked: !!linkedRid, body: Buffer.from(JSON.stringify(rest)) }
    }
  })
  return { front, tap }
}

function main() {
  const cfg = loadConfig()
  if (!cfg.tapKey) console.warn('[eclipsis] TAP_KEY 未设置：上游入口会拒绝所有请求')
  if (!cfg.upstreamUrl) console.warn('[eclipsis] UPSTREAM_URL 未设置：上游入口返回 503')
  const db = openDb(cfg.dbPath)
  const { front, tap } = buildServers(cfg, db, { linkRid: process.env.LINK_RID === '1' })
  front.listen(cfg.frontPort, '127.0.0.1', () => console.log(`[eclipsis] front  127.0.0.1:${cfg.frontPort} → ${cfg.dylanUrl}`))
  tap.listen(cfg.tapPort, '127.0.0.1', () => console.log(`[eclipsis] tap    127.0.0.1:${cfg.tapPort} → ${cfg.upstreamUrl || '(未配置)'}`))
  const stop = () => {
    front.close(); tap.close()
    setTimeout(() => { db.close(); process.exit(0) }, 3000).unref()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (import.meta.main) main()
