// Leto 入站端点：injector 把唤醒信封 POST 到这里。挂在前端出口（已有 nginx 保护），
// 另加本地共享密钥 LETO_INGEST_KEY 二次确认（injector 和后端都在本机）。
//
// 流程：injector → POST /v1/eclipsis/leto/wake {agent, reason, message} + Bearer 本地密钥
//        → 找到对应 Agent → dispatchLetoWake 跑完 → 2xx(成功) / 5xx(失败，桥会重试一次)
//
// 桥对每个 Agent 是串行投递（一条接一条），所以同一 Agent 不会并发；不同 Agent 可并发，互不影响。
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DB } from '../db.ts'
import type { LetoAgent } from './agent.ts'
import { dispatchLetoWake, type LetoDispatchConfig } from './dispatch.ts'

export interface LetoApiDeps {
  agents: LetoAgent[]
  dispatchConfig: LetoDispatchConfig
  /** 本地共享密钥，和 injector 约定；为空则拒绝所有（未配置视为未启用） */
  ingestKey: string
  log: (msg: string) => void
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', c => { size += c.length; if (size > 256 * 1024) { reject(new Error('body 过大')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function bearer(req: IncomingMessage): string {
  const h = req.headers['authorization'] || ''
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(h) ? h[0] : h)
  return m ? m[1].trim() : ''
}

/** 返回 true 表示这里处理了。路径 /v1/eclipsis/leto/wake */
export async function handleLetoApi(deps: LetoApiDeps | null, db: DB, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://local')
  if (url.pathname !== '/v1/eclipsis/leto/wake') return false
  if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return true }

  // 未配置 = 未启用，直接拒（不泄露细节）
  if (!deps || !deps.ingestKey) { json(res, 503, { error: 'leto not enabled' }); return true }
  if (bearer(req) !== deps.ingestKey) { json(res, 401, { error: 'unauthorized' }); return true }

  let payload: any
  try { payload = JSON.parse(await readBody(req) || '{}') }
  catch { json(res, 400, { error: 'bad json' }); return true }

  const agentId = String(payload.agent || '').trim()
  const reason = String(payload.reason || '').trim()
  const message = String(payload.message || '').trim()
  if (!agentId || !reason || !message) { json(res, 400, { error: 'missing agent/reason/message' }); return true }

  const agent = deps.agents.find(a => a.id === agentId)
  if (!agent) { json(res, 404, { error: `unknown agent: ${agentId}` }); return true }

  try {
    const result = await dispatchLetoWake({ reason, message }, agent, db, deps.dispatchConfig)
    json(res, 200, {
      ok: true, agent: agentId,
      modelTurns: result.modelTurns, toolsCalled: result.toolsCalled, truncated: result.truncated
    })
  } catch (e: any) {
    deps.log(`[leto-api] ${agentId} 处理失败：${String(e?.message || e)}`)
    json(res, 502, { ok: false, error: String(e?.message || e) })
  }
  return true
}
