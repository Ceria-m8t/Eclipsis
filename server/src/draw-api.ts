// 她自己点生图（2026-11-11）：加号面板 → 生图 → 填一句 → 出图，不经过他。
//   POST /v1/eclipsis/draw  { prompt, size? } → { hash, url, mime, bytes, mode, station }
// 画出来的图当她的待发送图片（她决定要不要发给他），所以这里只画、不记经历。
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DB } from './db.ts'
import type { BlobStore } from './blobs.ts'
import { draw } from './draw.ts'
import { currentImageStation } from './image-station.ts'

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export async function handleDrawApi(db: DB, blobs: BlobStore, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const p = new URL(req.url || '/', 'http://local').pathname
  if (p !== '/v1/eclipsis/draw') return false
  if (req.method === 'GET') {
    const st = currentImageStation()
    json(res, 200, { ready: !!st, station: st ? st.name : null, model: st?.model || null, size: st?.size || null })
    return true
  }
  if (req.method !== 'POST') return false
  let body: any = {}
  try {
    const chunks: Buffer[] = []
    for await (const c of req) { chunks.push(c as Buffer); if (chunks.reduce((n, x) => n + x.length, 0) > 32 * 1024) break }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch { json(res, 400, { error: '请求体不是合法 JSON' }); return true }
  try {
    const r = await draw(db, blobs, String(body?.prompt || ''), { size: body?.size ? String(body.size) : undefined })
    json(res, 200, r)
  } catch (e: any) {
    json(res, 502, { error: String(e?.message || e).slice(0, 300) })
  }
  return true
}
