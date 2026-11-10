// 模型列表（2026-11-11，Erica 要）：GET /v1/models 由后端自己回答，问当前这个中转站要。
//
// 以前这个路径是透传给 xiaoke 的，xiaoke 没实现，Kelivo 点「获取模型」只会拿到 404。
// 现在后端直接问站（换站面板里那个站），答案记 5 分钟。换站以后 /v1/models?fresh=1 能立刻重问。
import type { IncomingMessage, ServerResponse } from 'node:http'

const TTL = 5 * 60_000
let cache: { url: string; at: number; body: string } | null = null

export function forgetModels() { cache = null }

/** 问站要模型列表；拿不到就抛 */
async function fetchModels(url: string, key: string, timeoutMs = 20_000): Promise<string> {
  const base = url.replace(/\/+$/, '')
  const r = await fetch(`${base}/models`, {
    headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`站回了 HTTP ${r.status}${text ? '：' + text.slice(0, 200) : ''}`)
  // 确认是能用的 JSON（有的站回 HTML 错误页）
  const j = JSON.parse(text)
  if (!Array.isArray(j?.data)) throw new Error('站回的不是模型列表')
  return text
}

/** GET /v1/models：Kelivo 和以后 Eclipsis 的模型选择都读这个 */
export async function handleModelsApi(req: IncomingMessage, res: ServerResponse, st: { url: string; key: string }): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://local')
  if (url.pathname !== '/v1/models' || (req.method !== 'GET' && req.method !== 'HEAD')) return false
  const send = (status: number, body: string) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
  if (!st.url) { send(503, JSON.stringify({ error: { message: '还没配中转站', type: 'config_error' } })); return true }
  const fresh = url.searchParams.get('fresh') === '1'
  if (!fresh && cache && cache.url === st.url && Date.now() - cache.at < TTL) { send(200, cache.body); return true }
  try {
    const body = await fetchModels(st.url, st.key)
    cache = { url: st.url, at: Date.now(), body }
    send(200, body)
  } catch (e: any) {
    // 站暂时不给：有旧的就先用旧的，别让前端的模型选择变空
    if (cache && cache.url === st.url) { send(200, cache.body); return true }
    send(502, JSON.stringify({ error: { message: `取模型列表失败：${String(e?.message || e).slice(0, 200)}`, type: 'upstream_error' } }))
  }
  return true
}
