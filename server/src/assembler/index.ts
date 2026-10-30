// 组装器 v1：现场状态注入
//
// v1 策略：不替换 xiaoke 的 system message，在末尾追加「此刻」块。
// xiaoke 的提示词、记忆规则、时间树、梗百科全部保留，
// 我们只增加脉状态、北京时间、天气。
// v2 再逐步替换 xiaoke 的各段。

import type { DB } from '../db.ts'
import { loadPulseState, renderVitalsLine } from '../pulse/index.ts'
import { getXinchaoBridgeCache } from '../pulse/xinchao-bridge.ts'

export interface AssembleResult {
  sceneBlock: string
  meta: {
    vitalsLine: string | null
    timeBeijing: string
    weather: string | null
    xinchaoEmotion: string | null
  }
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
export function assembleSceneBlock(db: DB): AssembleResult {
  const now = new Date()
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
  const bridge = getXinchaoBridgeCache()
  if (bridge && (Date.now() - bridge.fetchedAt) < 30 * 60_000) {
    xinchaoEmotion = bridge.inferredEmotion
  }

  const parts: string[] = []
  parts.push('')
  parts.push('---')
  parts.push('# 此刻')
  parts.push(`现在是 ${timeStr}`)
  if (vitalsLine) parts.push(`身体：${vitalsLine}`)
  if (weatherDesc) parts.push(`上海天气：${weatherDesc}`)

  return {
    sceneBlock: parts.join('\n'),
    meta: { vitalsLine, timeBeijing: timeStr, weather: weatherDesc, xinchaoEmotion }
  }
}

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
