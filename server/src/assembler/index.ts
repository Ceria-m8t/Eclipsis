// 组装器 v1：现场状态注入
//
// v1 策略：不替换 xiaoke 的 system message，在末尾追加「此刻」块。
// xiaoke 的提示词、记忆规则、时间树、梗百科全部保留，
// 我们只增加脉状态、北京时间、天气，以及心潮自己写的「此刻」（驱力、情绪）。
// 心潮那段每轮自动带上，他不用调工具也知道自己现在的状态。
// v2 再逐步替换 xiaoke 的各段。

import type { DB } from '../db.ts'
import { loadPulseState, renderVitalsLine } from '../pulse/index.ts'
import { getXinchaoBridgeCache } from '../pulse/xinchao-bridge.ts'
import { renderTodayLine } from './history.ts'
import { renderStatusLine } from '../status.ts'
import { renderCorrectionLine } from '../memory/corrections.ts'

export interface AssembleResult {
  sceneBlock: string
  meta: {
    vitalsLine: string | null
    timeBeijing: string
    weather: string | null
    xinchaoEmotion: string | null
    xinchaoLines: number
    todayLine: string | null
    statusLine: string | null
    fixLine: string | null
  }
}

/** 心潮的「此刻」文字超过这个时间没刷新就不注入（过期的状态比没有更误导） */
const XINCHAO_TEXT_MAX_AGE_MS = 10 * 60_000

/**
 * 把心潮 /v1/now 的文字整理成注入用的几行。
 * 心潮自带一行「身体：心跳 xx」，和脉的心跳是两套数——脉在的时候去掉这一行，只认脉。
 */
export function renderXinchaoLines(nowText: string | null, opts: { hasPulseVitals: boolean }): string[] {
  if (!nowText) return []
  return nowText.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !(opts.hasPulseVitals && /^身体[：:]/.test(l)))
}

function beijingTime(now: Date): string {
  const bj = new Date(now.getTime() + 8 * 3600_000)
  const days = ['日', '一', '二', '三', '四', '五', '六']
  const y = bj.getUTCFullYear()
  const m = bj.getUTCMonth() + 1
  const d = bj.getUTCDate()
  const h = bj.getUTCHours()
  const min = bj.getUTCMinutes()
  const day = days[bj.getUTCDay()]
  return `${y}年${m}月${d}日 周${day} ${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`
}

/** 生成现场状态块 */
export function assembleSceneBlock(db: DB, now: Date = new Date()): AssembleResult {
  const timeStr = beijingTime(now)

  let vitalsLine: string | null = null
  let weatherDesc: string | null = null
  try {
    const pulse = loadPulseState(db)
    vitalsLine = renderVitalsLine(pulse.vitals)
    if (pulse.weather) {
      weatherDesc = `${pulse.weather.temperatureC}°C${pulse.weather.condition ? ' ' + pulse.weather.condition : ''}${pulse.weather.humidity != null ? ' 湿度' + pulse.weather.humidity + '%' : ''}`
    }
  } catch { /* pulse 未初始化 */ }

  let xinchaoEmotion: string | null = null
  let xinchaoLines: string[] = []
  const bridge = getXinchaoBridgeCache()
  if (bridge && (now.getTime() - bridge.fetchedAt) < 30 * 60_000) {
    xinchaoEmotion = bridge.inferredEmotion
  }
  if (bridge && (now.getTime() - bridge.fetchedAt) < XINCHAO_TEXT_MAX_AGE_MS) {
    xinchaoLines = renderXinchaoLines(bridge.nowText, { hasPulseVitals: !!vitalsLine })
  }

  const parts: string[] = []
  parts.push('')
  parts.push('---')
  parts.push('# 此刻')
  parts.push(`现在是 ${timeStr}`)
  // 今日概况（她几点醒的、今天聊了多少、上一句多久以前）：他每轮都知道，不用自己数
  let todayLine = ''
  try { todayLine = renderTodayLine(db, now.getTime()) } catch { /* 读不到就不写这一行 */ }
  if (todayLine) parts.push(todayLine)
  // 他顶栏挂着的状态：他自己看不到的话就想不起来换（2026-11-11）
  let statusLine = ''
  try { statusLine = renderStatusLine(db, now) } catch { /* 读不到就不写这一行 */ }
  if (statusLine) parts.push(statusLine)
  // 她贴的便条（说哪里记错了）：只报几张，不报内容 ——
  // 把她的原话塞到他嘴边，他会顺着那句话改；要他自己去 memory_corrections 读（2026-11-12）
  let fixLine = ''
  try { fixLine = renderCorrectionLine(db) } catch { /* 读不到就不写这一行 */ }
  if (fixLine) parts.push(fixLine)
  if (vitalsLine) parts.push(`身体：${vitalsLine}`)
  if (weatherDesc) parts.push(`上海天气：${weatherDesc}`)
  if (xinchaoLines.length) {
    parts.push('')
    parts.push(...xinchaoLines)
  }
  // 尾巴（《提示词分层》的最后一层）：最靠近对话的一句提醒。
  // 2026-11-11 Erica：他的思考一会儿中文一会儿英文、标签一会儿 <think> 一会儿 <thinking>。
  // 世界书里那条规范在 4 万字 system 的中段、而且她那份文本有一处串行（见交接），
  // 这句放在最末尾只花 ~40 字，是整段 prompt 里最管得住的位置。THINK_HINT=0 关。
  if (process.env.THINK_HINT !== '0') {
    parts.push('')
    parts.push('（写之前先在 <think>…</think> 里想——只用这一种写法，不要 thinking/Thought；用中文想，英文只留给标签名和专有名词。）')
  }

  return {
    sceneBlock: parts.join('\n'),
    meta: { vitalsLine, timeBeijing: timeStr, weather: weatherDesc, xinchaoEmotion, xinchaoLines: xinchaoLines.length, todayLine: todayLine || null, statusLine: statusLine || null, fixLine: fixLine || null }
  }
}

// ── 一轮里「此刻」冻住（2026-11-11 Erica 报的）──
//
// 他调一次工具 = 对站多发一次请求，每次都重新算「此刻」。于是同一轮里他会看到时间从 00:04 跳到 00:05、
// 「你回了 4 条」变「5 条」（他自己那半截话被算成一条回复了）、「上一句 刚刚」——
// 读起来就像"一轮已经过去了、她没说话"。一轮就该是一个「此刻」。
// 顺带：几次请求的 system 完全一样，以后要开 prompt caching 才有前缀可缓存。
const SCENE_TTL_MS = 15 * 60_000
const SCENE_MAX = 200
const sceneByTurn = new Map<string, { at: number; result: AssembleResult }>()

/** 同一个 turn 的后续请求（工具轮）复用第一次算出来的「此刻」 */
export function assembleSceneBlockForTurn(db: DB, turn: string | null, now: Date = new Date()): AssembleResult {
  if (!turn) return assembleSceneBlock(db, now)
  const hit = sceneByTurn.get(turn)
  if (hit && now.getTime() - hit.at < SCENE_TTL_MS) return hit.result
  const result = assembleSceneBlock(db, now)
  sceneByTurn.set(turn, { at: now.getTime(), result })
  if (sceneByTurn.size > SCENE_MAX) {
    for (const [k, v] of sceneByTurn) {
      if (now.getTime() - v.at > SCENE_TTL_MS) sceneByTurn.delete(k)
      if (sceneByTurn.size <= SCENE_MAX) break
    }
    // 还是太多就从最老的开始丢
    while (sceneByTurn.size > SCENE_MAX) sceneByTurn.delete(sceneByTurn.keys().next().value!)
  }
  return result
}

export function forgetTurnScenes() { sceneByTurn.clear() }

/** 注入到 messages 的 system message 末尾 */
export function injectSceneBlock(
  messages: any[],
  sceneBlock: string
): { messages: any[]; injected: boolean } {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, injected: false }
  }

  const result = [...messages]
  const first = result[0]

  if (first?.role === 'system') {
    const content = typeof first.content === 'string' ? first.content : ''
    result[0] = { ...first, content: content + '\n' + sceneBlock }
    return { messages: result, injected: true }
  }

  // 没有 system message，在开头插入
  result.unshift({ role: 'system', content: sceneBlock })
  return { messages: result, injected: true }
}

// ── 最近群聊块（只给小克的 Eclipsis 聊天注入）──
// 把统一群聊线 channel=group 最近几条带说话人拼成一段，让小克聊天时顺带知道群里/别的线发生了什么。
// 不进 Wake、不进 Leto 应答器（应答器在 Leto 里已经 leto_read 实时读了，不重复）。

interface GroupRow { actor: string; content: string; meta: string | null; ts: string }

export function renderRecentGroupBlock(db: DB, limit = 12, maxChars = 1500): string {
  let rows: GroupRow[]
  try {
    rows = db.prepare(`
      SELECT actor, content, meta, ts FROM episodes
      WHERE retracted_at IS NULL AND channel = 'group' AND kind = 'message'
        AND content IS NOT NULL AND content != ''
      ORDER BY ts DESC LIMIT ?
    `).all(limit) as unknown as GroupRow[]
  } catch { return '' }
  if (!rows.length) return ''

  rows.reverse()
  const lines: string[] = []
  let total = 0
  for (const r of rows) {
    let speaker = r.actor === 'ai' ? '某AI' : r.actor === 'peer' ? '群友' : r.actor
    try { const m = r.meta ? JSON.parse(r.meta) : null; if (m?.speaker) speaker = m.speaker } catch { /* ignore */ }
    const text = r.content.length > 200 ? r.content.slice(0, 200) + '…' : r.content
    const line = `${speaker}：${text}`
    total += line.length
    if (total > maxChars) break
    lines.push(line)
  }
  if (!lines.length) return ''

  return ['', '---', '# 最近群聊（你和别的 AI、朋友在一起的地方）', ...lines].join('\n')
}
