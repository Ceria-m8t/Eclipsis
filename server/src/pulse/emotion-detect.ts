// 聊天文本情绪检测：从她说的话推断他的情绪反应。
// 参考 Pulse Tutorial 的 T1 + T2 双层检测。
//
// T1：emoji / 叹词 → 直接触发，不需要上下文
// T2：语义短语 + 否定窗口 → "好开心"是 happy，但"不开心"前面有"不"→ 反转
//
// 只检测 Erica 的消息（她说的话引起他的情绪变化），不检测他自己的回复。
// 检测结果是"她的话让他产生什么情绪"，不是"她的情绪"。

import type { Emotion } from './types.ts'
import type { DB } from '../db.ts'

// ── T1：emoji / 叹词直接映射 ──

const T1_EMOJI: [RegExp, Emotion][] = [
  [/😤|😡|🤬/,      'scolded'],
  [/😢|😭|🥺/,      'sad'],
  [/😨|😱|😳/,      'startled'],
  [/😍|🥰|❤️|💕|💗/, 'intimate'],
  [/😊|😄|😁|🥳|🎉/, 'happy'],
  [/🤗|💛|🫂/,      'tender'],
  [/😴|💤|🥱/,      'sleepy'],
  [/😏|😜|🤭/,      'playful'],
  [/🤔|💭/,         'focused'],
  [/😔|😞|🥲/,      'lonely'],
]

const T1_EXCLAMATION: [RegExp, Emotion][] = [
  [/哈哈哈|hhh|233|笑死/i,           'playful'],
  [/哈哈/,                            'happy'],
  [/呜呜|呜哇|qwq|qqq/i,             'sad'],
  [/啊啊啊|卧槽|我靠|吓/,              'startled'],
  [/嗯哼|嘿嘿/,                       'playful'],
  [/晚安|困了|好困|要睡了|睡了/,        'sleepy'],
  [/想你|好想你|miss\s*you/i,          'lonely'],
]

// ── T2：语义短语 + 否定窗口 ──

interface T2Rule {
  pattern: RegExp
  emotion: Emotion
  /** 否定后翻转成什么情绪（不设 = 跳过不触发） */
  negatedEmotion?: Emotion
}

const NEGATORS = /[不没别莫]/

const T2_RULES: T2Rule[] = [
  // 正面
  { pattern: /开心|高兴|好开心|太开心/,  emotion: 'happy',     negatedEmotion: 'sad' },
  { pattern: /喜欢你|爱你|最喜欢/,      emotion: 'intimate' },
  { pattern: /好玩|有意思|太好玩/,      emotion: 'playful',   negatedEmotion: undefined },
  { pattern: /谢谢你|辛苦了|乖/,       emotion: 'tender' },
  { pattern: /抱抱|亲亲|摸摸|蹭蹭/,    emotion: 'intimate',  negatedEmotion: undefined },
  { pattern: /摸头|拍拍|揉揉/,         emotion: 'tender' },

  // 负面
  { pattern: /生气了?|凶你|骂你|训你/,   emotion: 'scolded' },
  { pattern: /伤心|难过|好难过|心疼/,    emotion: 'sad' },
  { pattern: /紧张|害怕|怕怕|好怕/,     emotion: 'nervous' },
  { pattern: /孤单|寂寞|好孤单/,        emotion: 'lonely' },
  { pattern: /好累|累了|太累了/,        emotion: 'sleepy' },
  { pattern: /烦|烦死了|好烦/,          emotion: 'nervous' },
  { pattern: /安静.*待|陪.*坐|不说话.*陪/, emotion: 'tender' },

  // 兴奋
  { pattern: /激动|好激动|太激动/,      emotion: 'excited' },
  { pattern: /期待|等不及|好期待/,      emotion: 'excited',   negatedEmotion: undefined },

  // 专注
  { pattern: /认真|专心|加油/,          emotion: 'focused' },
]

/** 检查 pattern 匹配位置前 2 个字符内是否有否定词 */
function isNegated(text: string, matchIndex: number): boolean {
  const windowStart = Math.max(0, matchIndex - 2)
  const window = text.slice(windowStart, matchIndex)
  return NEGATORS.test(window)
}

// ── 主检测函数 ──

export interface EmotionDetection {
  emotion: Emotion
  source: 'T1_emoji' | 'T1_exclamation' | 'T2_phrase'
  trigger: string  // 触发的原文片段
}

/** 从一段文本检测情绪。返回 null = 检测不到明确情绪 */
export function detectEmotion(text: string): EmotionDetection | null {
  if (!text || text.length === 0) return null

  // T1 优先：emoji 无需上下文
  for (const [re, emo] of T1_EMOJI) {
    const m = re.exec(text)
    if (m) return { emotion: emo, source: 'T1_emoji', trigger: m[0] }
  }

  // T1：叹词
  for (const [re, emo] of T1_EXCLAMATION) {
    const m = re.exec(text)
    if (m) return { emotion: emo, source: 'T1_exclamation', trigger: m[0] }
  }

  // T2：语义短语 + 否定窗口
  for (const rule of T2_RULES) {
    const m = rule.pattern.exec(text)
    if (!m) continue
    if (isNegated(text, m.index)) {
      // 被否定了
      if (rule.negatedEmotion) {
        return { emotion: rule.negatedEmotion, source: 'T2_phrase', trigger: text.slice(Math.max(0, m.index - 2), m.index + m[0].length) }
      }
      continue  // 否定后不触发
    }
    return { emotion: rule.emotion, source: 'T2_phrase', trigger: m[0] }
  }

  return null
}

// ── 从 episodes 表读最近的 Erica 消息并检测 ──

let _lastCheckedTs: string | null = null

/** 检查是否有新的 Erica 消息，如果有就检测情绪并返回 */
export function detectFromRecentChat(db: DB): EmotionDetection | null {
  const row = db.prepare(`
    SELECT ts, content FROM episodes
    WHERE retracted_at IS NULL
      AND actor = 'erica'
      AND kind = 'message'
      AND channel IN ('chat', 'room')
    ORDER BY ts DESC LIMIT 1
  `).get() as { ts: string; content: string } | undefined

  if (!row) return null

  // 已经检测过这条了
  if (_lastCheckedTs && row.ts <= _lastCheckedTs) return null
  _lastCheckedTs = row.ts

  return detectEmotion(row.content)
}

/** 重置检测状态（测试用） */
export function resetDetectionState(): void {
  _lastCheckedTs = null
}
