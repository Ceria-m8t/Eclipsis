// 心潮桥：从 xinchao /v1/now 读当前驱力和情绪，映射成 Pulse 能用的 Emotion 输入。
// 不替代聊天文本情绪检测——这是"他自己的内在状态"来源。
// 两者可以叠加：聊天内容触发的情绪优先级更高（来自她说的话），心潮驱力作为底层漂移。

import type { Emotion } from './types.ts'

export interface XinchaoNowResponse {
  drives?: Record<string, number>  // 11 股驱力，各 0-1
  pulse?: { bpm?: number }
  emotions?: {
    current?: { valence?: number; arousal?: number; label?: string }
    undertone?: { label?: string; strength?: number }
  }
}

/** 从心潮的驱力向量推断一个底层情绪倾向 */
export function drivesToEmotion(drives: Record<string, number>): Emotion | null {
  // 心潮 4.2 的 11 股驱力：
  // connect / share / possess / explore / create / nurture / play / rest / retreat / assert / favored

  const get = (k: string) => drives[k] ?? 0

  // 退避很高 → lonely
  if (get('retreat') > 0.6 && get('retreat') > get('connect')) return 'lonely'

  // 休息很高 → sleepy
  if (get('rest') > 0.65) return 'sleepy'

  // 连接+照料都高 → tender
  if (get('connect') > 0.5 && get('nurture') > 0.4) return 'tender'

  // 玩耍高 → playful
  if (get('play') > 0.6) return 'playful'

  // 连接很高 → intimate
  if (get('connect') > 0.65) return 'intimate'

  // 探索或创造高 → focused
  if (get('explore') > 0.6 || get('create') > 0.6) return 'focused'

  // 分享高 → happy
  if (get('share') > 0.55) return 'happy'

  // 主张高 → excited
  if (get('assert') > 0.6) return 'excited'

  // 没有明显倾向
  return null
}

// ── 缓存与拉取 ──

export interface XinchaoBridgeState {
  /** 推断出的底层情绪（可能为 null = 不干预） */
  inferredEmotion: Emotion | null
  /** 原始驱力快照 */
  drives: Record<string, number>
  /** 拉取时间 */
  fetchedAt: number
}

let _cache: XinchaoBridgeState | null = null

export function getXinchaoBridgeCache(): XinchaoBridgeState | null { return _cache }

export async function refreshXinchaoBridge(xinchaoUrl: string): Promise<XinchaoBridgeState | null> {
  try {
    const res = await fetch(`${xinchaoUrl}/v1/now`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const data = await res.json() as XinchaoNowResponse
    const drives = data.drives ?? {}
    const inferredEmotion = drivesToEmotion(drives)
    _cache = { inferredEmotion, drives, fetchedAt: Date.now() }
    return _cache
  } catch {
    return null
  }
}

/** 心潮数据是否还新鲜（30 分钟内） */
export function isBridgeFresh(maxAgeMs: number = 30 * 60_000): boolean {
  return !!_cache && (Date.now() - _cache.fetchedAt) < maxAgeMs
}
