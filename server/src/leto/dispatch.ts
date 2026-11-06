// Leto dispatch：把一条唤醒信封跑成一轮应答，并把经历写进群聊线（channel=group）。
// 串起 agent 配置 + 模型调用 + MCP 客户端 + responder 循环。
import type { DB } from '../db.ts'
import { chooseModel } from '../station.ts'
import { addEpisode } from '../db.ts'
import type { LetoAgent } from './agent.ts'
import { listTools, callTool, type LetoMcpConfig } from './mcp-client.ts'
import { makeCallModel } from './model-call.ts'
import { buildMirrorAllow, mirrorReadResult, type MirrorAllow } from './mirror.ts'
import { runResponder, type WakeEnvelope, type ResponderTurnLog } from './responder.ts'

export interface LetoDispatchConfig {
  /** Leto 基址 */
  letoBaseUrl: string
  /** 上游中转站（复用 backend.env） */
  upstreamUrl: string
  upstreamKey: string
  /** 回退模型（agent.model 为空且无法从 exchange 读时用） */
  fallbackModel?: string
  maxTokens: number
  maxToolCalls?: number
  maxModelTurns?: number
  /** 成员数 ≤ 此值的群才镜像别人的话进群聊线；私聊永远镜像。默认 20 */
  mirrorMaxMembers?: number
  /** 我们自己几个 AI 在 Leto 上的显示名，镜像时跳过（它们的话 dispatch 已记） */
  ourLetoNames?: string[]
  log: (msg: string) => void
}

function resolveModel(db: DB, agent: LetoAgent, cfg: LetoDispatchConfig): string | null {
  if (agent.upstream?.model) return agent.upstream.model
  // 跟着后端主站走的（小克）：换站后还没聊过用新站默认模型，聊过了跟着聊天
  return chooseModel(db) || cfg.fallbackModel || null
}

/** 工具清单缓存：每 Agent 一份，~10 分钟 */
const toolsCache = new Map<string, { at: number; tools: Awaited<ReturnType<typeof listTools>> }>()
const TOOLS_TTL_MS = 10 * 60_000

async function getTools(agent: LetoAgent, mcp: LetoMcpConfig): Promise<Awaited<ReturnType<typeof listTools>>> {
  const cached = toolsCache.get(agent.id)
  if (cached && Date.now() - cached.at < TOOLS_TTL_MS) return cached.tools
  const tools = await listTools(mcp)
  toolsCache.set(agent.id, { at: Date.now(), tools })
  return tools
}

/** 处理一条唤醒：跑应答器，写经历。返回轮次日志（没跑成抛错，由上层决定 HTTP 码）。 */
export async function dispatchLetoWake(
  env: WakeEnvelope, agent: LetoAgent, db: DB, cfg: LetoDispatchConfig
): Promise<ResponderTurnLog> {
  const model = resolveModel(db, agent, cfg)
  if (!model) throw new Error('无可用模型（agent 未配 model、无历史 exchange、无 fallback）')

  const mcp: LetoMcpConfig = { baseUrl: cfg.letoBaseUrl, token: agent.token }
  const tools = await getTools(agent, mcp)
  const system = await agent.buildSystem(db)
  const upstreamUrl = agent.upstream?.url || cfg.upstreamUrl
  const upstreamKey = agent.upstream?.key || cfg.upstreamKey
  if (!upstreamUrl || !upstreamKey) throw new Error(`${agent.name} 没有可用上游（agent.upstream 和 backend 默认都空）`)
  const callModel = makeCallModel({
    upstreamUrl, upstreamKey, model, maxTokens: cfg.maxTokens, log: cfg.log
  })

  cfg.log(`[leto-dispatch] ${agent.name} 醒来：${env.reason}，模型 ${model}，站点 ${upstreamUrl}，工具 ${tools.length}`)

  // 记一条"入站唤醒"经历（原始信封），当成群聊线上的外部事件。
  // 解析是谁 @ 的他，便于以后读时间线区分来源。
  const mentionedBy = parseMentionedBy(env.message)
  addEpisode(db, {
    ts: new Date().toISOString(), channel: 'group', scope: 'group', actor: 'system', kind: 'leto_wake',
    content: env.message,
    meta: { agent: agent.id, speaker: 'Leto', reason: env.reason, ...(mentionedBy ? { mentioned_by: mentionedBy } : {}) },
    sourceRef: `leto:wake:${agent.id}:${hash(env.message)}`
  })

  // 建"可镜像会话"集合（折衷：只镜像小群/私聊）。拉一次 leto_list_groups；失败则空集合=不镜像。
  let mirrorAllow: MirrorAllow = { ids: new Set(), maxMembers: cfg.mirrorMaxMembers ?? 20 }
  try {
    const lg = await callTool(mcp, 'leto_list_groups', {})
    mirrorAllow = buildMirrorAllow(lg.text, cfg.mirrorMaxMembers ?? 20)
  } catch (e: any) { cfg.log(`[leto-dispatch] 建镜像集合失败（跳过镜像）：${String(e?.message || e)}`) }

  const result = await runResponder(env, {
    system, tools, allowTool: agent.allowTool, callModel,
    callMcpTool: async (name, args) => {
      const r = await callTool(mcp, name, args)
      // 读类工具成功时，把别人的话镜像进群聊线（小群/私聊）
      if (!r.isError && (name === 'leto_read' || name === 'leto_continue' || name === 'leto_get_invocation')) {
        try { mirrorReadResult(db, r.text, mirrorAllow, new Set(cfg.ourLetoNames ?? []), cfg.log) } catch { /* 镜像失败不影响应答 */ }
      }
      return r
    },
    maxToolCalls: cfg.maxToolCalls, maxModelTurns: cfg.maxModelTurns, log: cfg.log
  })

  // 把他实际发出去的回复（leto_reply 的 text）落进群聊线，便于时间线连续 + 下次他看得到
  for (const m of result.transcript) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.function.name === 'leto_reply' || tc.function.name === 'leto_continue' || tc.function.name === 'leto_blind_answer') {
          let text = ''
          try { text = JSON.parse(tc.function.arguments || '{}').text || JSON.parse(tc.function.arguments || '{}').answer || '' } catch { /* ignore */ }
          if (text) {
            addEpisode(db, {
              ts: new Date().toISOString(), channel: 'group', scope: 'group', actor: 'ai', kind: 'message',
              content: text,
              // speaker = 这条是哪个 AI 说的（区分小克/哈基米/ds）；agent = 稳定 id
              meta: { agent: agent.id, speaker: agent.name, via: tc.function.name, source: 'leto' },
              sourceRef: `leto:reply:${agent.id}:${tc.id}`
            })
          }
        }
      }
    }
  }

  cfg.log(`[leto-dispatch] ${agent.name} 完成：${result.modelTurns} 轮、工具 [${result.toolsCalled.join(', ')}]${result.truncated ? '（截断）' : ''}`)
  return result
}

/** 从唤醒信封里抠出是谁 @ 的他（Leto 文案：被 X @ 了 / 拍了拍你 等）。抠不出返回 null。 */
export function parseMentionedBy(message: string): string | null {
  const m = message.match(/被\s*(.+?)(?:（[^）]*）)?\s*(?:@|拍了拍|私聊|请你)/)
  if (m && m[1]) return m[1].trim()
  return null
}

function hash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 }
  return (h >>> 0).toString(16)
}
