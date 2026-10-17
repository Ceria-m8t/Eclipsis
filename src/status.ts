// 他的"状态"（顶栏显示）。
// 现在只是前端占位：数据结构先定好，存在本机。
// 以后状态来源会换成后端（他通过受限工具设置，或由房间里小人的位置/动作推出来），
// 到时候只改 loadStatus / 订阅方式，顶栏不用动。
import { ref } from 'vue'

export interface AiStatus {
  emoji: string      // 比如 🎧 ☕ 📖 💤
  text: string       // 比如 "在听歌" "在厨房"
  room?: string      // 以后和房间联动：他在哪个房间
  updatedAt: number
}

const KEY = 'eclipsis-ai-status'

function load(): AiStatus | null {
  try {
    const s = localStorage.getItem(KEY)
    return s ? JSON.parse(s) : null
  } catch { return null }
}

export const aiStatus = ref<AiStatus | null>(load())

export function setStatus(s: Omit<AiStatus, 'updatedAt'> | null) {
  aiStatus.value = s ? { ...s, updatedAt: Date.now() } : null
  try {
    if (aiStatus.value) localStorage.setItem(KEY, JSON.stringify(aiStatus.value))
    else localStorage.removeItem(KEY)
  } catch {}
}
