// 换站面板搬进 Eclipsis 前端（2026-11-11，Erica 要）：
// 以前只在 Leto 管理页里有，切完站还要回前端再拉一次模型列表选聊天模型，来回两趟。
// 现在设置页里一块「中转站」：存站、切站、自检、顺手选默认模型和聊天模型。
//
// 画图的站（2026-11-11）：和聊天的站分开存，同一套接口（?kind=image），因为她的生图站也会经常换。
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DB } from './db.ts'
import { listStations, saveStation, deleteStation, switchStation, findStation, currentStation } from './station.ts'
import {
  listImageStations, saveImageStation, deleteImageStation, switchImageStation, findImageStation, probeImageStation,
} from './image-station.ts'
import { forgetModels } from './models.ts'
import { probeStation } from './leto/station-check.ts'

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage, max = 64 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { reject(new Error('请求太大')); req.destroy(); return } chunks.push(c) })
    req.on('end', () => { try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : {}) } catch { reject(new Error('请求体不是合法 JSON')) } })
    req.on('error', reject)
  })
}

/** 站上有哪些模型（用存着的密钥问，前端不碰密钥） */
async function modelsOf(url: string, key: string): Promise<string[]> {
  const r = await fetch(`${url.replace(/\/+$/, '')}/models`, {
    headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(20_000),
  })
  if (!r.ok) throw new Error(`站回了 HTTP ${r.status}`)
  const j = await r.json() as any
  if (!Array.isArray(j?.data)) throw new Error('站回的不是模型列表')
  return j.data.map((m: any) => String(m?.id || '')).filter(Boolean)
}

/**
 *   GET  /v1/eclipsis/stations            聊天的站：列表（密钥打码）+ 正在用哪个
 *   POST /v1/eclipsis/stations            加/改（改时密钥留空 = 不改）
 *   POST /v1/eclipsis/stations/switch     切过去（聊天、Wake、心潮、小克的 Leto 一起换）
 *   POST /v1/eclipsis/stations/delete     删
 *   POST /v1/eclipsis/stations/models     这个站有哪些模型
 *   POST /v1/eclipsis/stations/test       用存着的密钥真发一条，看通不通
 *   以上都接受 ?kind=image：换成「画图的站」
 */
export async function handleStationsApi(_db: DB, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://local')
  const p = url.pathname
  if (!p.startsWith('/v1/eclipsis/stations')) return false
  const image = url.searchParams.get('kind') === 'image'
  const sub = p.slice('/v1/eclipsis/stations'.length).replace(/^\//, '')
  try {
    if (!sub && req.method === 'GET') {
      json(res, 200, image ? listImageStations() : listStations())
      return true
    }
    if (!sub && req.method === 'POST') {
      const b = await readJson(req)
      const st = image
        ? saveImageStation({ id: b.id || undefined, name: b.name, url: b.url, key: b.key, model: b.model, size: b.size, mode: b.mode })
        : saveStation({ id: b.id || undefined, name: b.name, url: b.url, key: b.key, defaultModel: b.defaultModel })
      json(res, 200, { ok: true, id: st.id })
      return true
    }
    if (sub === 'switch' && req.method === 'POST') {
      const b = await readJson(req)
      const id = String(b?.id || '')
      if (image) { const c = switchImageStation(id); json(res, 200, { ok: true, current: { name: c.name, model: c.model } }); return true }
      const c = switchStation(id)
      forgetModels()        // 换站了：模型列表重新问新站
      json(res, 200, { ok: true, current: { name: c.name, url: c.url, defaultModel: c.defaultModel } })
      return true
    }
    if (sub === 'delete' && req.method === 'POST') {
      const b = await readJson(req)
      if (image) deleteImageStation(String(b?.id || '')); else deleteStation(String(b?.id || ''))
      json(res, 200, { ok: true })
      return true
    }
    if (sub === 'models' && req.method === 'POST') {
      const b = await readJson(req)
      const st = image ? findImageStation(String(b?.id || '')) : findStation(String(b?.id || ''))
      const u = st?.url || String(b?.url || '')
      const k = st?.key || String(b?.key || '')
      if (!u) { json(res, 400, { error: '要选一个存过的站' }); return true }
      try { json(res, 200, { models: await modelsOf(u, k) }) }
      catch (e: any) { json(res, 200, { models: [], error: `拉不到模型列表：${String(e?.message || e).slice(0, 160)}` }) }
      return true
    }
    if (sub === 'test' && req.method === 'POST') {
      const b = await readJson(req)
      if (image) {
        const st = findImageStation(String(b?.id || ''))
        if (!st) { json(res, 400, { error: '要选一个存过的站' }); return true }
        json(res, 200, await probeImageStation(st))
        return true
      }
      const st = findStation(String(b?.id || ''))
      const u = st?.url || String(b?.url || '')
      const k = st?.key || String(b?.key || '')
      const model = String(b?.model || st?.defaultModel || currentStation().defaultModel || '')
      if (!u || !k) { json(res, 400, { error: '要选一个存过的站' }); return true }
      if (!model) { json(res, 400, { error: '先给这个站挑一个模型，再自检' }); return true }
      json(res, 200, await probeStation(u, k, model))
      return true
    }
  } catch (e: any) {
    json(res, 400, { error: String(e?.message || e) })
    return true
  }
  return false
}
