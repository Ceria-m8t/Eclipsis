// Wake HTTP 接口：挂在前端出口上（已有 nginx 登录保护）。
// 心潮的 MCP 工具定义指向这些接口。
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DB } from '../db.ts'
import {
  setFrequency, setSourceFactor, setAlarm, cancelAlarm,
  addThread, completeThread, inspectWakeControl, wakeHistory
} from './tools.ts'

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function parseJson(req: IncomingMessage): Promise<any> {
  const raw = await readBody(req)
  return raw ? JSON.parse(raw) : {}
}

/** 返回 true 表示这里处理了 */
export async function handleWakeApi(db: DB, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://local')
  const path = url.pathname

  // 所有 wake 接口在 /v1/eclipsis/wake/ 下
  if (!path.startsWith('/v1/eclipsis/wake/')) return false

  const route = path.slice('/v1/eclipsis/wake/'.length)

  try {
    if (req.method === 'GET') {
      // 读接口
      if (route === 'control') {
        json(res, 200, inspectWakeControl(db))
        return true
      }
      if (route === 'history') {
        const limit = Number(url.searchParams.get('limit')) || 10
        json(res, 200, wakeHistory(db, limit))
        return true
      }
    }

    if (req.method === 'POST') {
      const body = await parseJson(req)
      // 写接口
      if (route === 'frequency') {
        json(res, 200, setFrequency(db, body))
        return true
      }
      if (route === 'source-factor') {
        json(res, 200, setSourceFactor(db, body))
        return true
      }
      if (route === 'alarm') {
        json(res, 200, setAlarm(db, body))
        return true
      }
      if (route === 'alarm/cancel') {
        json(res, 200, cancelAlarm(db, body.id))
        return true
      }
      if (route === 'thread') {
        json(res, 200, addThread(db, body))
        return true
      }
      if (route === 'thread/complete') {
        json(res, 200, completeThread(db, body.id))
        return true
      }
    }

    json(res, 404, { error: 'unknown wake endpoint' })
    return true
  } catch (e: any) {
    json(res, 400, { error: String(e?.message || e) })
    return true
  }
}
