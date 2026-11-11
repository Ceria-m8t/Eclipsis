// 她这边的生图接口（2026-11-11）：
//   GET  /v1/eclipsis/draw            画图的站准备好了没、现在的垫图和画风
//   POST /v1/eclipsis/draw            { prompt, size?, refs?, style?, useDefaultRefs? } → 画一张（当她的待发送图片）
//   GET  /v1/eclipsis/draw/refs       垫图清单
//   POST /v1/eclipsis/draw/refs       原始字节 + x-ref-name / x-ref-note / x-ref-default（加一张）
//   POST /v1/eclipsis/draw/refs/edit  { id, name?, note?, byDefault?, enabled? }（不换图，只改信息）
//   POST /v1/eclipsis/draw/refs/delete{ id }
//   GET  /v1/eclipsis/draw/styles     画风清单
//   POST /v1/eclipsis/draw/styles     { id?, name, prompt, isDefault? }
//   POST /v1/eclipsis/draw/styles/default { id }
//   POST /v1/eclipsis/draw/styles/delete { id }
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DB } from './db.ts'
import type { BlobStore } from './blobs.ts'
import { draw } from './draw.ts'
import { currentImageStation } from './image-station.ts'
import {
  listRefs, saveRef, deleteRef, deleteRefPhoto, listStyles, saveStyle, setDefaultStyle, deleteStyle, defaultStyle,
} from './draw-refs.ts'

const MAX_REF_BYTES = 8 * 1024 * 1024

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > max) throw Object.assign(new Error('图太大了（最多 8MB）'), { status: 413 })
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks)
}
async function readJson(req: IncomingMessage): Promise<any> {
  const raw = await readRaw(req, 64 * 1024)
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {} } catch { throw new Error('请求体不是合法 JSON') }
}
const header = (req: IncomingMessage, k: string) => {
  const v = req.headers[k]
  const raw = Array.isArray(v) ? v[0] : v
  if (!raw) return ''
  try { return decodeURIComponent(raw) } catch { return raw }
}
const publicRef = (r: ReturnType<typeof listRefs>[number]) => ({
  id: r.id, name: r.name, note: r.note, enabled: r.enabled, byDefault: r.byDefault,
  photos: r.photos.map(p => ({ id: p.id, url: `/api/eclipsis/blob/${p.hash}`, size: p.size })),
})

export async function handleDrawApi(db: DB, blobs: BlobStore, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const p = new URL(req.url || '/', 'http://local').pathname
  if (!p.startsWith('/v1/eclipsis/draw')) return false
  const sub = p.slice('/v1/eclipsis/draw'.length).replace(/^\//, '')
  try {
    if (!sub && req.method === 'GET') {
      const st = currentImageStation()
      json(res, 200, {
        ready: !!st, station: st ? st.name : null, model: st?.model || null, size: st?.size || null,
        refs: listRefs(db).map(publicRef), styles: listStyles(db), defaultStyle: defaultStyle(db)?.name ?? null,
      })
      return true
    }
    if (!sub && req.method === 'POST') {
      const b = await readJson(req)
      const r = await draw(db, blobs, String(b?.prompt || ''), {
        size: b?.size ? String(b.size) : undefined,
        refs: Array.isArray(b?.refs) ? b.refs.map(String) : undefined,
        style: b?.style ? String(b.style) : undefined,
        useDefaultRefs: b?.useDefaultRefs !== false,     // 她自己画，默认带上默认垫图
      })
      json(res, 200, r)
      return true
    }
    if (sub === 'refs' && req.method === 'GET') { json(res, 200, { refs: listRefs(db).map(publicRef) }); return true }
    if (sub === 'refs' && req.method === 'POST') {
      const data = await readRaw(req, MAX_REF_BYTES)
      if (!data.length) { json(res, 400, { error: '图是空的' }); return true }
      const r = saveRef(db, blobs, {
        name: header(req, 'x-ref-name'), note: header(req, 'x-ref-note'),
        byDefault: header(req, 'x-ref-default') === '1',
        data, mime: String(req.headers['content-type'] || 'image/png'),
      })
      json(res, 200, publicRef(r))
      return true
    }
    if (sub === 'refs/edit' && req.method === 'POST') {
      const b = await readJson(req)
      const cur = listRefs(db).find(x => x.id === String(b?.id || ''))
      if (!cur) { json(res, 404, { error: '找不到这张垫图' }); return true }
      const r = saveRef(db, blobs, {
        id: cur.id, name: b?.name !== undefined ? String(b.name) : cur.name,
        note: b?.note !== undefined ? String(b.note) : cur.note,
        byDefault: typeof b?.byDefault === 'boolean' ? b.byDefault : cur.byDefault,
        enabled: typeof b?.enabled === 'boolean' ? b.enabled : cur.enabled,
      })
      json(res, 200, publicRef(r))
      return true
    }
    // 删一个名字下面的某一张
    if (sub === 'refs/photo/delete' && req.method === 'POST') {
      const b = await readJson(req)
      deleteRefPhoto(db, String(b?.id || ''))
      json(res, 200, { ok: true })
      return true
    }
    if (sub === 'refs/delete' && req.method === 'POST') {
      const b = await readJson(req)
      deleteRef(db, String(b?.id || ''))
      json(res, 200, { ok: true })
      return true
    }
    if (sub === 'styles' && req.method === 'GET') { json(res, 200, { styles: listStyles(db) }); return true }
    if (sub === 'styles' && req.method === 'POST') {
      const b = await readJson(req)
      json(res, 200, saveStyle(db, { id: b?.id || undefined, name: String(b?.name || ''), prompt: String(b?.prompt || ''), isDefault: !!b?.isDefault }))
      return true
    }
    if (sub === 'styles/default' && req.method === 'POST') {
      const b = await readJson(req)
      setDefaultStyle(db, String(b?.id || ''))
      json(res, 200, { ok: true })
      return true
    }
    if (sub === 'styles/delete' && req.method === 'POST') {
      const b = await readJson(req)
      deleteStyle(db, String(b?.id || ''))
      json(res, 200, { ok: true })
      return true
    }
  } catch (e: any) {
    json(res, e?.status || 400, { error: String(e?.message || e).slice(0, 300) })
    return true
  }
  return false
}
