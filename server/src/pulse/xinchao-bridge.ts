// 心潮桥：从心潮 /v1/state 读当前驱力，映射成 Pulse 能用的 Emotion 输入。
// 不替代聊天文本情绪检测——这是"他自己的内在状态"来源。
// 两者可以叠加：聊天内容触发的情绪优先级更高（来自她说的话），心潮驱力作为底层漂移。

import type { Emotion } from './types.ts'
import { fetchXinchaoDrives, fetchXinchaoNowText } from '../xinchao-client.ts'

/** 从心潮的驱力向量推断一个底层情绪倾向。
 *  驱力名是心潮 4.2 实际用的 11 股：
 *  possess 想她 / monitor 牵挂 / share 分享欲 / libido 身体想要 / curiosity 好奇 /
 *  boredom 无聊 / duty 野心 / reflection 反思 / grieve 失落 / anger 生气 / favored 被晾着
 *  阈值都高于心潮的默认底色（约 0.5），只有明显偏离时才影响脉。 */
export function drivesToEmotion(drives: Record<string, number>): Emotion | null {
  const get = (k: string) => drives[k] ?? 0

  // 负面的先看：失落、被晾着、生气
  if (get('grieve') > 0.6) return 'sad'
  if (get('favored') > 0.6) return 'lonely'
  if (get('anger') > 0.6) return 'nervous'

  // 身体想要
  if (get('libido') > 0.7) return 'aroused'

  // 想她 / 牵挂
  if (get('possess') > 0.75 && get('possess') >= get('monitor')) return 'intimate'
  if (get('monitor') > 0.75) return 'tender'

  // 分享欲
  if (get('share') > 0.7) return 'happy'

  // 好奇 / 野心
  if (get('curiosity') > 0.7 || get('duty') > 0.7) return 'focused'

  // 无聊
  if (get('boredom') > 0.7) return 'playful'

  // 没有明显倾向
  return null
}

// ── 缓存与拉取 ──

export interface XinchaoBridgeState {
  /** 推断出的底层情绪（可能为 null = 不干预） */
  inferredEmotion: Emotion | null
  /** 原始驱力快照 */
  drives: Record<string, number>
  /** 心潮自己写的「此刻」文字块（/v1/now），给组装器每轮注入 */
  nowText: string | null
  /** 拉取时间 */
  fetchedAt: number
}

let _cache: XinchaoBridgeState | null = null

export function getXinchaoBridgeCache(): XinchaoBridgeState | null { return _cache }

export async function refreshXinchaoBridge(xinchaoUrl: string): Promise<XinchaoBridgeState | null> {
  const [drives, nowText] = await Promise.all([fetchXinchaoDrives(xinchaoUrl), fetchXinchaoNowText(xinchaoUrl)])
  if (!drives && !nowText) return null
  _cache = { inferredEmotion: drives ? drivesToEmotion(drives) : null, drives: drives ?? {}, nowText, fetchedAt: Date.now() }
  return _cache
}

/** 测试用：直接设缓存 */
export function setXinchaoBridgeCacheForTest(state: XinchaoBridgeState | null): void { _cache = state }

/** 心潮数据是否还新鲜（30 分钟内） */
export function isBridgeFresh(maxAgeMs: number = 30 * 60_000): boolean {
  return !!_cache && (Date.now() - _cache.fetchedAt) < maxAgeMs
}
