// 心潮 HTTP 客户端：Wake、Wake dispatch、Pulse 心潮桥共用。
// 心潮的 /v1/* 接口要求 Authorization: Bearer <SERVICE_TOKEN>，密钥从 XINCHAO_TOKEN 读。
//   /v1/state  → 完整状态，drives 是数字（0-1）
//   /v1/now    → 「此刻」文字块，只有 text，没有数字
// 失败时返回 null，并按地址节流写一行日志（每 10 分钟最多一次），不再静默吞掉。

const LOG_EVERY_MS = 10 * 60_000
const lastLogged = new Map<string, number>()

function logFailure(path: string, reason: string): void {
  const now = Date.now()
  if (now - (lastLogged.get(path) ?? 0) < LOG_EVERY_MS) return
  lastLogged.set(path, now)
  console.warn(`[xinchao] ${path} 失败: ${reason}`)
}

export async function xinchaoGet<T = any>(baseUrl: string, path: string, timeoutMs = 5000): Promise<T | null> {
  const token = (process.env.XINCHAO_TOKEN || '').trim()
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + path, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) {
      logFailure(path, `HTTP ${res.status}${token ? '' : '（XINCHAO_TOKEN 未设置）'}`)
      return null
    }
    return await res.json() as T
  } catch (e: any) {
    logFailure(path, String(e?.message || e))
    return null
  }
}

/** 心潮 4.2 实际的 11 股驱力（中文名见 xinchao app/src/self-signals.js） */
export const XINCHAO_DRIVES = {
  possess: '想她',
  monitor: '牵挂',
  share: '分享欲',
  libido: '身体想要',
  curiosity: '好奇',
  boredom: '无聊',
  duty: '野心',
  reflection: '反思',
  grieve: '失落',
  anger: '生气',
  favored: '被晾着/吃醋'
} as const

/** 读心潮的数字驱力。失败返回 null */
export async function fetchXinchaoDrives(baseUrl: string): Promise<Record<string, number> | null> {
  const state = await xinchaoGet<{ drives?: Record<string, unknown> }>(baseUrl, '/v1/state')
  if (!state?.drives || typeof state.drives !== 'object') return null
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(state.drives)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  return out
}

/** 读心潮的「此刻」文字块。失败返回 null */
export async function fetchXinchaoNowText(baseUrl: string): Promise<string | null> {
  const now = await xinchaoGet<{ text?: string }>(baseUrl, '/v1/now')
  return typeof now?.text === 'string' && now.text.trim() ? now.text.trim() : null
}

// ── 「她来了」：她每发一条新消息就告诉心潮 ──
// 心潮把不带 interaction_type 的 /v1/conversation-event 当成在场信号：
// 叫醒（如果在睡）、更新上次对话时间、学她的作息。正文只放前 120 字给心潮内存里的 recent 参照，不落盘。
// 她一口气发几条只算一次：两次通知至少隔 minGapMs（默认 20 秒）。

let lastPresenceAt = 0

export async function notifyXinchaoPresence(
  baseUrl: string, text: string, opts: { minGapMs?: number; now?: number } = {}
): Promise<boolean> {
  const now = opts.now ?? Date.now()
  if (now - lastPresenceAt < (opts.minGapMs ?? 20_000)) return false
  lastPresenceAt = now
  const token = (process.env.XINCHAO_TOKEN || '').trim()
  const path = '/v1/conversation-event'
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ event_id: `eclipsis:${now}`, recent: text.replace(/\s+/g, ' ').trim().slice(0, 120) }),
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) { logFailure(path, `HTTP ${res.status}`); return false }
    return true
  } catch (e: any) {
    logFailure(path, String(e?.message || e))
    return false
  }
}

/** 测试用 */
export function resetPresenceThrottle(): void { lastPresenceAt = 0; lastExchangeAt = 0 }

// ── 「这一轮聊了什么」：一轮说完，把她的一句 + 他回的一段交给心潮，让心潮自己判互动类型和氛围 ──
// （2026-11-07 Erica 定打开；心潮要 MODEL_ENABLED=true 才会判，它自己 8 分钟最多判一次，这里也按 8 分钟节流）
// 正文只走这一跳：心潮判完即删，不落盘。

let lastExchangeAt = 0

export function buildExchangeText(her: string, his: string): string {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
  return `她说：${flat(her).slice(0, 500)} 他回：${flat(his).slice(0, 900)}`
}

export async function notifyXinchaoExchange(
  baseUrl: string, her: string, his: string, opts: { minGapMs?: number; now?: number } = {}
): Promise<boolean> {
  const now = opts.now ?? Date.now()
  if (now - lastExchangeAt < (opts.minGapMs ?? 8 * 60_000)) return false
  lastExchangeAt = now
  const token = (process.env.XINCHAO_TOKEN || '').trim()
  const path = '/v1/conversation-event'
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ event_id: `eclipsis:x:${now}`, exchange: buildExchangeText(her, his), recent: her.replace(/\s+/g, ' ').trim().slice(0, 120) }),
      signal: AbortSignal.timeout(60_000)   // 心潮要调模型判，比"她来了"慢
    })
    if (!res.ok) { logFailure(path, `HTTP ${res.status}`); return false }
    return true
  } catch (e: any) {
    logFailure(path, String(e?.message || e))
    return false
  }
}
