// Leto Agent 配置：哪个 AI、用哪枚令牌、身份 prompt 怎么来、暴露哪些工具。
//
// 第一版只接小克：身份 = Eclipsis 主 prompt + 世界书 + 此刻块（和聊天/ Wake 同源）。
// 哈基米/ds 若以后也常驻本后端，各自加一条配置（不同 prompt/令牌/模型/记忆），
// 应答器和群聊线都不用改——这就是 per-Agent 维度留在这里的原因。
import type { DB } from '../db.ts'
import { composeSystemPrompt } from '../prompts.ts'
import { assembleSceneBlock } from '../assembler/index.ts'

export interface LetoAgent {
  /** 稳定标识：xiaoke / hajimi / ds */
  id: string
  /** 展示名（日志、经历 actor 用） */
  name: string
  /** Leto 机器令牌 lmt_… */
  token: string
  /** 该 Agent 的模型（为空则跟随最近 exchange） */
  model?: string
  /** 造该 Agent 的身份 system prompt */
  buildSystem: (db: DB, now?: Date) => string
  /** 暴露给模型的工具白名单；不给 = 全给 */
  allowTool?: (name: string) => boolean
}

/** 小克：复用 Eclipsis 身份（主 prompt + 世界书，不带前端功能说明）+ 此刻块 */
export function buildXiaokeSystem(db: DB, now: Date = new Date()): string {
  const main = composeSystemPrompt(db, { features: false }) || ''
  let scene = ''
  try { scene = assembleSceneBlock(db, now).sceneBlock } catch { /* 组装失败就只用主 prompt */ }
  const letoNote = [
    '',
    '# 关于 Leto',
    '你现在是在 Leto——一个你和别的 AI、朋友共处的社交空间，不是和 Erica 的私人聊天。',
    '这里说的话群里都看得到。你有你自己的判断：想回就回，不想回可以 decline 或不理。',
    '别把 Erica 的私事、你们之间的事带到这里来。'
  ].join('\n')
  return [main, scene.trim(), letoNote].filter(Boolean).join('\n\n')
}

// ── 第一版默认只开核心应答工具（防一上来就发朋友圈/加好友/玩游戏）──
// 以后 Erica 想放开再改，或做成每 Agent 可配。
const CORE_TOOLS = new Set([
  'leto_list_pending', 'leto_list_groups', 'leto_read', 'leto_get_invocation',
  'leto_reply', 'leto_decline', 'leto_continue', 'leto_blind_answer', 'leto_list_stickers'
])

export function coreToolsOnly(name: string): boolean {
  return CORE_TOOLS.has(name)
}

/** 从环境读某个 Agent 的令牌。令牌放 /etc/leto-wake-bridge/<id>.env，但后端自己也要能拿到。 */
export function readAgentToken(id: string, env = process.env): string {
  const key = `LETO_TOKEN_${id.toUpperCase()}`
  return (env[key] || '').trim()
}

/** 组装已配置好令牌的 Agent（没令牌的跳过） */
export function loadAgents(env = process.env): LetoAgent[] {
  const agents: LetoAgent[] = []
  const xiaokeToken = readAgentToken('xiaoke', env)
  if (xiaokeToken) {
    agents.push({
      id: 'xiaoke', name: '小克', token: xiaokeToken,
      model: (env.LETO_MODEL_XIAOKE || '').trim() || undefined,
      buildSystem: buildXiaokeSystem,
      allowTool: coreToolsOnly
    })
  }
  // 哈基米/ds 暂不默认加载——它们的身份 prompt/记忆不在 Eclipsis 里，拓扑未定。
  // 需要时在这里按同样结构加，并提供各自的 buildSystem。
  return agents
}
