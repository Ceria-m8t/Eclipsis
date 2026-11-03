// Wake 影响来源：每条来源从现有数据里算出一个 [0, 1] 的本源值。
// 来源只负责"我观察到什么"，不负责"该不该醒"——那是引擎的事。
import type { DB } from "../db.ts"
import type { SourceReading } from './types.ts'
import { loadPulseState } from '../pulse/store.ts'
import type { PulseState } from '../pulse/types.ts'
import { fetchXinchaoDrives } from '../xinchao-client.ts'

// ── 来源 1：沉默时长 ──
// 最基本的信号：距离上一次任何一方说话过了多久。
// 不依赖他调工具，纯从 episodes 表算。

/** 沉默越久 → 值越高，用 sigmoid 映射到 [0, 1] */
function silenceSigmoid(minutesSilent: number): number {
  // 30 分钟 → ~0.27，60 分钟 → ~0.5，120 分钟 → ~0.73，240 分钟 → ~0.88
  const midpoint = 60  // 60 分钟时 = 0.5
  const steepness = 0.03
  return 1 / (1 + Math.exp(-steepness * (minutesSilent - midpoint)))
}

export function readSilence(db: DB, now: Date): SourceReading {
  // 最近一条非系统的聊天经历（不算 wake 和系统消息）
  const row = db.prepare(`
    SELECT ts FROM episodes
    WHERE retracted_at IS NULL
      AND channel IN ('chat', 'room')
      AND actor IN ('erica', 'ai')
      AND kind = 'message'
    ORDER BY ts DESC LIMIT 1
  `).get() as { ts: string } | undefined

  if (!row) {
    return { sourceId: 'silence', value: 0.5, stale: false, label: '无历史消息' }
  }

  const lastMs = new Date(row.ts).getTime()
  const minutesSilent = (now.getTime() - lastMs) / 60_000

  if (minutesSilent < 0) {
    return { sourceId: 'silence', value: 0, stale: true, label: '时间异常' }
  }

  return {
    sourceId: 'silence',
    value: silenceSigmoid(minutesSilent),
    stale: false,
    label: `沉默 ${Math.round(minutesSilent)} 分钟`
  }
}

// ── 来源 2：用户状态推断 ──
// 参考 Revive Companion 的贝叶斯思路，简化版：
// 从最近的交互模式推断她现在大概在干嘛，输出"适不适合打扰"。

export type UserState = 'chatting' | 'idle' | 'busy' | 'sleeping' | 'away' | 'needs_care'

interface UserStateEstimate {
  state: UserState
  /** 这个状态下的发送适宜度 [0, 1] */
  suitability: number
}

const STATE_SUITABILITY: Record<UserState, number> = {
  chatting: 0.15,     // 正在聊 → 别用 wake 打断，她已经在了
  idle: 0.7,          // 闲着 → 好时机
  busy: 0.1,          // 忙 → 别打扰
  sleeping: 0.0,      // 睡了 → 不发
  away: 0.3,          // 离开 → 再等等
  needs_care: 0.9     // 可能需要关心 → 主动联系
}

export function inferUserState(db: DB, now: Date): UserStateEstimate {
  const nowMs = now.getTime()

  // 最近 3 条她的消息，看间隔和时间
  const recentErica = db.prepare(`
    SELECT ts FROM episodes
    WHERE retracted_at IS NULL AND actor = 'erica' AND kind = 'message'
    ORDER BY ts DESC LIMIT 3
  `).all() as { ts: string }[]

  if (recentErica.length === 0) {
    return { state: 'away', suitability: STATE_SUITABILITY.away }
  }

  const lastEricaMs = new Date(recentErica[0].ts).getTime()
  const sinceLast = (nowMs - lastEricaMs) / 60_000

  // 5 分钟内有消息 → 正在聊天
  if (sinceLast < 5) {
    return { state: 'chatting', suitability: STATE_SUITABILITY.chatting }
  }

  // 30 分钟内有消息 → 可能还在附近但不聊天
  if (sinceLast < 30) {
    return { state: 'idle', suitability: STATE_SUITABILITY.idle }
  }

  // 超过 6 小时没消息 → 大概率在睡或不在
  if (sinceLast > 360) {
    return { state: 'sleeping', suitability: STATE_SUITABILITY.sleeping }
  }

  // 30 分钟 - 6 小时：看最近几条的间隔模式
  if (recentErica.length >= 2) {
    const gaps = []
    for (let i = 0; i < recentErica.length - 1; i++) {
      gaps.push(new Date(recentErica[i].ts).getTime() - new Date(recentErica[i + 1].ts).getTime())
    }
    const avgGapMin = gaps.reduce((a, b) => a + b, 0) / gaps.length / 60_000

    // 之前的消息间隔很密（< 5 分钟），但突然断了 → 可能去忙了
    if (avgGapMin < 5 && sinceLast > 30) {
      return { state: 'busy', suitability: STATE_SUITABILITY.busy }
    }
  }

  // 默认：离开状态
  return { state: 'away', suitability: STATE_SUITABILITY.away }
}

export function readUserState(db: DB, now: Date): SourceReading {
  const est = inferUserState(db, now)
  return {
    sourceId: 'user_state',
    value: est.suitability,
    stale: false,
    label: `推断状态: ${est.state}`
  }
}

// ── 来源 3：生活线头 ──
// 活跃线头越多越紧迫 → 值越高

export function readThreads(db: DB, now: Date): SourceReading {
  const threads = db.prepare(`
    SELECT id, text, created_at, expires_at FROM wake_threads
    WHERE status = 'active'
    ORDER BY created_at DESC LIMIT 5
  `).all() as { id: string; text: string; created_at: string; expires_at: string | null }[]

  // 清理过期线头
  const nowIso = now.toISOString()
  db.prepare(`UPDATE wake_threads SET status = 'expired'
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`).run(nowIso)

  const active = threads.filter(t => !t.expires_at || t.expires_at > nowIso)

  if (active.length === 0) {
    // 没有线头是"没有数据"，不是"不想醒"：标 stale，不参与平均
    return { sourceId: 'threads', value: 0, stale: true, label: '无活跃线头（不参与）' }
  }

  // 1 根 = 0.3，2 根 = 0.5，3 根 = 0.65，5 根 = 0.8
  const value = Math.min(0.8, 0.15 + active.length * 0.15)
  return {
    sourceId: 'threads',
    value,
    stale: false,
    label: `${active.length} 根活跃线头`
  }
}

// ── 来源 4：心潮驱力 ──
// 从心潮 /v1/state 读当前驱力状态（需要 XINCHAO_TOKEN）。
// 数据超过 30 分钟标记为 stale，权重自动降为 0。

export interface XinchaoNow {
  drives?: Record<string, number>
  pulse?: { bpm?: number }
  fetchedAt: number
}

// 缓存：避免每次 tick 都 HTTP 请求
let xinchaoCache: XinchaoNow | null = null

export async function fetchXinchao(xinchaoUrl: string): Promise<XinchaoNow | null> {
  const drives = await fetchXinchaoDrives(xinchaoUrl)
  if (!drives) return null
  xinchaoCache = { drives, fetchedAt: Date.now() }
  return xinchaoCache
}

export function readXinchao(now: Date): SourceReading {
  if (!xinchaoCache) {
    return { sourceId: 'xinchao', value: 0, stale: true, label: '心潮未连接' }
  }

  const ageMin = (now.getTime() - xinchaoCache.fetchedAt) / 60_000
  if (ageMin > 30) {
    return { sourceId: 'xinchao', value: 0, stale: true, label: `心潮数据过期 (${Math.round(ageMin)} 分钟)` }
  }

  // 从驱力里取跟"想联系"相关的维度
  const drives = xinchaoCache.drives || {}
  // 心潮 4.2 实际的 11 股驱力：possess 想她、monitor 牵挂、share 分享欲、libido 身体想要、
  // curiosity 好奇、boredom 无聊、duty 野心、reflection 反思、grieve 失落、anger 生气、favored 被晾着
  //
  // 跟"想醒来联系她"最相关的：想她、牵挂、分享欲、被晾着
  const relevant = ['possess', 'monitor', 'share', 'favored']
  const vals = relevant.map(k => drives[k] ?? 0).filter(v => typeof v === 'number')

  if (vals.length === 0) {
    return { sourceId: 'xinchao', value: 0, stale: true, label: '无驱力数据' }
  }

  // 取相关驱力的最大值（不是平均——任何一个维度够强就推动醒来）
  const maxDrive = Math.max(...vals)
  // 驱力值通常在 0-1 范围，直接用
  const value = Math.max(0, Math.min(1, maxDrive))

  return {
    sourceId: 'xinchao',
    value,
    stale: false,
    label: `心潮驱力 max=${maxDrive.toFixed(2)} (${ageMin.toFixed(0)}m ago)`
  }
}

// ── 来源 6：身体状态（脉）──
// 从 Pulse 模块读当前身体状态。
// 逻辑：身体处于"不平静"状态时，微弱地推动醒来——他在身体上有反应，可能想说点什么。
// 不是主要驱动力（factor 默认 1，但 value 通常较低），只是在其他来源都中性时提供微弱推力。

export function readBody(db: DB, now: Date): SourceReading {
  let state: PulseState
  try {
    state = loadPulseState(db)
  } catch {
    return { sourceId: 'body', value: 0, stale: true, label: '脉未初始化' }
  }

  // 数据超过 30 分钟没更新 → stale
  const ageMin = (now.getTime() - new Date(state.updatedAt).getTime()) / 60_000
  if (ageMin > 30) {
    return { sourceId: 'body', value: 0, stale: true, label: `脉数据过期 (${Math.round(ageMin)} 分钟)` }
  }

  // 身体"不平静"度：从心率偏离基线的程度算
  // 基线 73bpm（sitting neutral），偏离越大 → 越不平静
  const hrDeviation = Math.abs(state.vitals.heartRate - state.hrBase)
  // 心率偏离 0 → 0，偏离 20 → 0.5，偏离 40+ → ~0.8
  const hrComponent = Math.min(1, hrDeviation / 50)

  // 五感活跃度（任何通道有感知都算）
  const senseActivity = Math.max(state.senses.touch, state.senses.smell, state.senses.taste, state.senses.sound)

  // 情绪权重：非中性情绪微弱推动
  const emotionBoost = ['neutral', 'focused', 'sleepy'].includes(state.emotion) ? 0 : 0.15

  // 综合：心率偏离为主，感知和情绪为辅
  const value = Math.min(1, hrComponent * 0.6 + senseActivity * 0.2 + emotionBoost)

  return {
    sourceId: 'body',
    value,
    stale: false,
    label: `HR ${state.vitals.heartRate}bpm (偏离 ${hrDeviation.toFixed(0)}) ${state.emotion} ${state.vitals.chord}`
  }
}

// ── 汇总 ──

/** 收集所有可用来源的读数 */
export function collectReadings(db: DB, now: Date): SourceReading[] {
  return [
    readSilence(db, now),
    readUserState(db, now),
    readThreads(db, now),
    readXinchao(now),
    readBody(db, now)
  ]
}
