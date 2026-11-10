// 生图（2026-11-11）：他有一支画笔（工具箱里的本地箱子），她也能在加号面板里直接出图。
//
// 站的配置在 image-station.ts（她在设置页里加几个、随时切）。两种调法：
//   images  POST {url}/images/generations  → data[0].b64_json 或 data[0].url
//   chat    POST {url}/chat/completions    → 回复里夹着图（b64 的 image_url / inline_data / 一个图片链接）
// mode=auto 时先试 images，不行再试 chat，并把结果写回这次调用的记录里。
//
// 画出来的图存进 blobs（和她发的图同一套），聊天页照常显示。
import type { DB } from './db.ts'
import type { BlobStore } from './blobs.ts'
import { addEpisode } from './db.ts'
import { currentImageStation, type DrawMode, type ImageStation } from './image-station.ts'

export interface DrawResult { data: Buffer; mime: string; mode: DrawMode; revised?: string }

const TIMEOUT_MS = 180_000     // 画图慢，给 3 分钟

function pickDataUrl(s: string): { data: Buffer; mime: string } | null {
  const m = /data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)/.exec(s)
  if (!m) return null
  return { mime: m[1]!, data: Buffer.from(m[2]!.replace(/\s+/g, ''), 'base64') }
}

async function fetchImage(url: string): Promise<{ data: Buffer; mime: string }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!r.ok) throw new Error(`取图失败 HTTP ${r.status}`)
  const mime = r.headers.get('content-type') || 'image/png'
  if (!/^image\//.test(mime)) throw new Error(`取回来的不是图片（${mime}）`)
  return { data: Buffer.from(await r.arrayBuffer()), mime }
}

/** 从任意 JSON 里挖出第一张图：先认常见字段（b64_json / inline_data / image_url），再兜底 */
const B64_KEYS = new Set(['b64_json', 'b64', 'base64', 'imagebytes', 'image_bytes', 'bytesbase64encoded', 'data'])

function tryB64(v: unknown): { data: Buffer; mime: string } | null {
  if (typeof v !== 'string' || v.length < 24) return null
  const body = v.includes(',') && v.startsWith('data:') ? v.slice(v.indexOf(',') + 1) : v
  if (!/^[A-Za-z0-9+/=\s]+$/.test(body)) return null
  try {
    const data = Buffer.from(body.replace(/\s+/g, ''), 'base64')
    if (data.length < 16) return null
    const mime = sniff(data, true)
    return mime ? { data, mime } : null      // 解出来不是图片就不算
  } catch { return null }
}

async function digImage(j: any): Promise<{ data: Buffer; mime: string } | null> {
  const seen = new Set<any>()
  const urls: string[] = []
  const walk = (v: any): { data: Buffer; mime: string } | null => {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return null
    if (typeof v === 'string') {
      const d = pickDataUrl(v)
      if (d) return d
      if (/^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?$/i.test(v)) urls.push(v)
      return null
    }
    if (typeof v !== 'object' || seen.has(v)) return null
    seen.add(v)
    if (!Array.isArray(v)) {
      for (const [k, val] of Object.entries(v)) {
        if (B64_KEYS.has(k.toLowerCase())) { const got = tryB64(val); if (got) return got }
      }
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) {
      const got = walk(x)
      if (got) return got
    }
    return null
  }
  const inline = walk(j)
  if (inline) return inline
  if (urls.length) return fetchImage(urls[0]!)
  // markdown 里的图片链接 ![](...)
  const text = JSON.stringify(j)
  const md = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/.exec(text)
  if (md) return fetchImage(md[1]!)
  // 兜底：某个长字段整个就是 base64
  const loose = /"([A-Za-z0-9+/=]{512,})"/.exec(text)
  if (loose) { const got = tryB64(loose[1]!); if (got) return got }
  return null
}

function sniff(b: Buffer, strict = false): string {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b.length > 12 && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (b.length > 3 && b.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  return strict ? '' : 'image/png'
}

async function post(url: string, key: string, body: unknown): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`站回了 HTTP ${r.status}${text ? '：' + text.slice(0, 200) : ''}`)
  try { return JSON.parse(text) } catch { throw new Error('站回的不是 JSON：' + text.slice(0, 160)) }
}

/** 用某个站画一张 */
export async function drawWith(st: ImageStation, prompt: string, opts: { size?: string } = {}): Promise<DrawResult> {
  const base = st.url.replace(/\/+$/, '')
  const size = (opts.size || st.size || '').trim()
  const tryImages = async (): Promise<DrawResult> => {
    const j = await post(`${base}/images/generations`, st.key, {
      model: st.model || undefined, prompt, n: 1,
      ...(size ? { size } : {}), response_format: 'b64_json',
    })
    const got = await digImage(j)
    if (!got) throw new Error('站回了结果但里面没有图')
    return { ...got, mode: 'images', revised: j?.data?.[0]?.revised_prompt }
  }
  const tryChat = async (): Promise<DrawResult> => {
    if (!st.model) throw new Error('走聊天接口画图要填模型名')
    const j = await post(`${base}/chat/completions`, st.key, {
      model: st.model, stream: false,
      messages: [{ role: 'user', content: size ? `${prompt}\n（画成 ${size}）` : prompt }],
    })
    const got = await digImage(j)
    if (!got) throw new Error('这个模型没返图（回复里只有文字）')
    return { ...got, mode: 'chat' }
  }
  if (st.mode === 'images') return tryImages()
  if (st.mode === 'chat') return tryChat()
  try { return await tryImages() } catch (e1: any) {
    try { return await tryChat() } catch (e2: any) {
      throw new Error(`两种调法都不行。images：${String(e1?.message || e1).slice(0, 120)}；chat：${String(e2?.message || e2).slice(0, 120)}`)
    }
  }
}

export interface DrawnImage { hash: string; url: string; mime: string; bytes: number; mode: DrawMode; station: string }

/** 画一张并存下来。没配画图的站就抛 */
export async function draw(_db: DB, blobs: BlobStore, prompt: string, opts: { size?: string } = {}): Promise<DrawnImage> {
  const st = currentImageStation()
  if (!st) throw new Error('还没配画图的站（设置页 → 画图的站）')
  const text = prompt.trim()
  if (!text) throw new Error('要写画什么')
  const r = await drawWith(st, text, opts)
  const hash = blobs.putFile(r.mime, r.data)
  return { hash, url: `/api/eclipsis/blob/${hash}`, mime: r.mime, bytes: r.data.length, mode: r.mode, station: st.name }
}

/** 他画完直接发给她：记一条他的消息（聊天页按图片显示） */
export function recordHisImage(db: DB, hash: string, opts: { prompt: string; wakeId?: string } = { prompt: '' }): void {
  addEpisode(db, {
    ts: new Date().toISOString(),
    channel: opts.wakeId ? 'wake' : 'chat', scope: 'daily', actor: 'ai', kind: 'message',
    content: '[图片]',
    meta: { images: [hash], drawn: true, prompt: opts.prompt.slice(0, 500), ...(opts.wakeId ? { wake_id: opts.wakeId } : {}) },
    sourceRef: `draw:${hash}:${Date.now().toString(36)}`,
  })
}
