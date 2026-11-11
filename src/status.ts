// 他的"状态"（聊天页顶栏他名字下面那一行）。
//
// 2026-11-11：真正的那一份在后端（/api/eclipsis/status），聊天和醒来共用，他每轮在「此刻」里看得到现在挂着什么。
// localStorage 只是缓存：进聊天页先画缓存，再后台拉后端最新的（他醒着的时候改过的也从那里来）。
// 直连别的 API（设置里填了 apiBase）时没有后端，就只用本机这份。
import { ref } from 'vue'
import { getSettings } from './settings'

export interface AiStatus {
  emoji: string      // 比如 🎧 ☕ 📖 💤
  text: string       // 比如 "在听歌" "在厨房"
  room?: string      // 以后和房间联动：他在哪个房间
  updatedAt: number
}

const KEY = 'eclipsis-ai-status'
const API = '/api/eclipsis/status'

function load(): AiStatus | null {
  try {
    const s = localStorage.getItem(KEY)
    return s ? JSON.parse(s) : null
  } catch { return null }
}

export const aiStatus = ref<AiStatus | null>(load())

function store(s: AiStatus | null) {
  aiStatus.value = s
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s))
    else localStorage.removeItem(KEY)
  } catch {}
}

/** 只写本机（缓存）。后端那份由 pushStatus / fetchStatus 管 */
export function setStatus(s: Omit<AiStatus, 'updatedAt'> | null) {
  store(s ? { ...s, updatedAt: Date.now() } : null)
}

const hasBackend = () => !getSettings().apiBase

/** 从后端拉一次（他醒来时改过的就是这样回到顶栏的）。拿不到就保持现在显示的 */
export async function fetchStatus(): Promise<void> {
  if (!hasBackend()) return
  try {
    const r = await fetch(API, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    if (!r.ok) return
    const s = (await r.json())?.status
    if (!s?.text) { store(null); return }
    const at = Date.parse(s.updatedAt || '')
    store({ emoji: s.emoji || '', text: s.text, updatedAt: Number.isNaN(at) ? Date.now() : at })
  } catch { /* 拉不到就用本机那份 */ }
}

/** 他在聊天里调了工具：先更新顶栏，再存到后端。返回没存上的原因 */
export async function pushStatus(s: Omit<AiStatus, 'updatedAt'> | null): Promise<string | null> {
  setStatus(s)
  if (!hasBackend()) return null
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(s ? { emoji: s.emoji, text: s.text, source: 'chat' } : { clear: true }),
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`
    return null
  } catch (e: any) {
    return e?.message || '连不上后端'
  }
}
