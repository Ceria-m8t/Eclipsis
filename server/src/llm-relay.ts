// 内部模型转发口（2026-11-07）：心潮等本机服务调模型都走这里，不直接连中转站。
//
//   POST /v1/eclipsis/llm/chat/completions   Authorization: Bearer <LLM_RELAY_KEY>
//
// - 转给后端现在用的中转站（UPSTREAM_URL/KEY），换站只改后端一处，心潮不用跟着改
// - 请求里 model 为空或写 "auto" → 用最近一次聊天的模型（和 Wake 一样跟着聊天走）
// - 不记进 exchanges：这些不是她和他的聊天，记进去会被 Wake 当成"最近一次聊天"接着醒
// - 只做非流式（心潮只用非流式）
import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { DB } from './db.ts'
import { chooseModel } from './station.ts'

export const LLM_RELAY_PATH = '/v1/eclipsis/llm/chat/completions'

export interface RelayConfig {
  upstreamUrl: string
  upstreamKey: string
  /** 本机服务用的密钥；为空 = 这个口不开 */
  relayKey: string
  timeoutMs?: number
}

const MAX_BODY = 2 * 1024 * 1024

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function keyOk(req: IncomingMessage, key: string): boolean {
  const h = String(req.headers.authorization || '')
  const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7).trim() : '')
  const want = Buffer.from(key)
  return got.length === want.length && timingSafeEqual(got, want)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { reject(new Error('请求太大')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 最近一次正常完成的聊天用的模型 */
export function latestChatModel(db: DB): string | null {
  const row = db.prepare(`SELECT model FROM exchanges
    WHERE tap = 'upstream' AND status = 'ok' AND model IS NOT NULL AND model != ''
    ORDER BY id DESC LIMIT 1`).get() as { model: string } | undefined
  return row?.model ?? null
}

export async function handleLlmRelay(cfg: RelayConfig, db: DB, req: IncomingMessage, res: ServerResponse, log: (m: string) => void = () => {}): Promise<boolean> {
  const path = new URL(req.url || '/', 'http://local').pathname
  if (path !== LLM_RELAY_PATH) return false
  if (!cfg.relayKey) { json(res, 404, { error: { message: '内部转发口没开（缺 LLM_RELAY_KEY）' } }); return true }
  if (!keyOk(req, cfg.relayKey)) { json(res, 401, { error: { message: 'unauthorized' } }); return true }
  if (req.method !== 'POST') { json(res, 405, { error: { message: 'method not allowed' } }); return true }
  if (!cfg.upstreamUrl) { json(res, 503, { error: { message: '后端没配中转站' } }); return true }

  let body: any
  try { body = JSON.parse(await readBody(req)) } catch { json(res, 400, { error: { message: '请求体不是 JSON' } }); return true }
  if (!body || !Array.isArray(body.messages)) { json(res, 400, { error: { message: '缺 messages' } }); return true }

  if (!body.model || body.model === 'auto') {
    const m = chooseModel(db)
    if (!m) { json(res, 503, { error: { message: '还没有聊天记录，不知道用哪个模型' } }); return true }
    body.model = m
  }
  body.stream = false

  const t0 = Date.now()
  try {
    const up = await fetch(cfg.upstreamUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.upstreamKey ? { authorization: `Bearer ${cfg.upstreamKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 120_000)
    })
    const text = await up.text()
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json' })
    res.end(text)
    log(`[llm-relay] ${body.model} → HTTP ${up.status} ${Date.now() - t0}ms`)
  } catch (e: any) {
    const msg = e?.name === 'TimeoutError' ? '中转站超时' : `连不上中转站：${e?.cause?.message || e?.message || e}`
    log(`[llm-relay] ${body.model} 失败：${msg}`)
    json(res, 502, { error: { message: msg, type: 'upstream_error' } })
  }
  return true
}
