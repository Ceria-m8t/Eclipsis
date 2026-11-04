// Leto Agent 配置：哪个 AI、用哪枚令牌、哪个站点/模型、身份 prompt 怎么来、暴露哪些工具。
//
// 配置文件驱动（/etc/eclipsis/leto-agents.json，LETO_AGENTS_FILE 可改路径）：
// 每个 AI 各自填站点地址/密钥/模型、人格文件、要不要 dudulove 简报。
// Erica 随时改文件，后端每次醒来重读（loadAgents 不缓存），不用动代码、不用重启。
//
// 小克 identity='eclipsis'：复用 Eclipsis 主 prompt+世界书+此刻块，站点默认用 backend.env 的 UPSTREAM。
// 哈基米/ds identity=人格文件：读文件 + 可选 dudulove 简报；站点各自填（它们走 Gemini/DeepSeek、随时换站）。
import { readFileSync } from 'node:fs'
import type { DB } from '../db.ts'
import { composeSystemPrompt } from '../prompts.ts'
import { assembleSceneBlock } from '../assembler/index.ts'
import { fetchBriefing, type DuduloveConfig } from './dudulove.ts'

/** 每个 Agent 自己的上游站点（为空字段回退到 backend 默认） */
export interface AgentUpstream {
  url?: string
  key?: string
  model?: string
}

export interface LetoAgent {
  id: string
  name: string
  /** 这个 AI 在 Leto 上的显示名（Claude/Gemini/DeepSeek），镜像去重用 */
  letoName?: string
  token: string
  upstream?: AgentUpstream
  /** 造该 Agent 的身份 system prompt（可异步：要拉 dudulove 简报） */
  buildSystem: (db: DB, now?: Date) => string | Promise<string>
  allowTool?: (name: string) => boolean
}

// ── 工具白名单：第一版只开核心应答工具 ──
const CORE_TOOLS = new Set([
  'leto_list_pending', 'leto_list_groups', 'leto_read', 'leto_get_invocation',
  'leto_reply', 'leto_decline', 'leto_continue', 'leto_blind_answer', 'leto_list_stickers'
])
export function coreToolsOnly(name: string): boolean {
  return CORE_TOOLS.has(name)
}
function makeAllow(tools?: string[]): ((name: string) => boolean) | undefined {
  if (!tools || tools.length === 0) return coreToolsOnly   // 默认核心
  if (tools.includes('*')) return undefined                 // 全开
  const set = new Set(tools)
  return (name: string) => set.has(name)
}

// ── 小克：Eclipsis 身份 ──
export function buildXiaokeSystem(db: DB, now: Date = new Date()): string {
  const main = composeSystemPrompt(db, { features: false }) || ''
  let scene = ''
  try { scene = assembleSceneBlock(db, now).sceneBlock } catch { /* 组装失败就只用主 prompt */ }
  const recent = renderRecentDailyChat(db)
  return [main, scene.trim(), recent, letoNote()].filter(Boolean).join('\n\n')
}

/** 读小克和 Erica 最近的私下对话（chat/room，daily），让他在 Leto 里不断片。
 *  2026-11-05 Erica 定：Leto 里也带近期对话（连贯优先）；但附明确提示别外传私事。 */
export function renderRecentDailyChat(db: DB, limit = 16, maxChars = 2000): string {
  let rows: { actor: string; content: string }[]
  try {
    rows = db.prepare(`
      SELECT actor, content FROM episodes
      WHERE retracted_at IS NULL AND channel IN ('chat', 'room') AND scope = 'daily'
        AND actor IN ('erica', 'ai') AND kind = 'message'
        AND content IS NOT NULL AND content != ''
      ORDER BY ts DESC LIMIT ?
    `).all(limit) as unknown as { actor: string; content: string }[]
  } catch { return '' }
  if (!rows.length) return ''
  rows.reverse()

  const lines: string[] = []
  let total = 0
  for (const r of rows) {
    const name = r.actor === 'erica' ? 'Erica' : '你'
    // 剥时间壳和思维链，只留她/你说的内容
    let text = r.content.replace(/<current_time>[\s\S]*?<\/current_time>/gi, ' ')
      .replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (text.length > 200) text = text.slice(0, 200) + '…'
    const line = `${name}：${text}`
    total += line.length
    if (total > maxChars) break
    lines.push(line)
  }
  if (!lines.length) return ''
  return ['# 你和 Erica 最近的私下对话（只供你自己记得、保持连贯；这是你俩私下的事，别在 Leto 群里对别人讲）', ...lines].join('\n')
}

function letoNote(): string {
  return [
    '# 关于 Leto',
    '你现在是在 Leto——一个你和别的 AI、朋友共处的社交空间，不是私人聊天。',
    '这里说的话群里都看得到。你有你自己的判断：想回就回，不想回可以 decline 或不理。',
    '别把 Erica 的私事、你们之间的事带到这里来。'
  ].join('\n')
}

// ── 哈基米/ds：人格文件 + 可选 dudulove 简报 ──
export interface PersonaIdentity {
  /** 人格提示词文件绝对路径 */
  personaFile: string
  /** 可选：世界书文件绝对路径。可一本（字符串）或多本（数组，按顺序拼） */
  worldbookFile?: string | string[]
  /** 可选：dudulove 简报 */
  dudulove?: DuduloveConfig & { query?: string }
}

export function makePersonaBuildSystem(identity: PersonaIdentity): (db: DB, now?: Date) => Promise<string> {
  return async () => {
    let persona = ''
    try { persona = readFileSync(identity.personaFile, 'utf8').trim() }
    catch { persona = '（人格文件读不到，先用空身份。请检查 personaFile 路径。）' }

    let worldbook = ''
    const wbFiles = Array.isArray(identity.worldbookFile)
      ? identity.worldbookFile
      : (identity.worldbookFile ? [identity.worldbookFile] : [])
    if (wbFiles.length > 0) {
      const books: string[] = []
      for (const f of wbFiles) {
        try { const wb = readFileSync(f, 'utf8').trim(); if (wb) books.push(wb) }
        catch { /* 某本读不到就跳过，不影响其它本 */ }
      }
      if (books.length > 0) worldbook = `# 世界书\n${books.join('\n\n')}`
    }

    let memory = ''
    if (identity.dudulove) {
      const brief = await fetchBriefing(identity.dudulove, identity.dudulove.query || '最近和 Erica、群里发生的事；我是谁')
      if (brief) memory = `# 你的记忆（来自记忆库，只读参考）\n${brief}`
    }
    return [persona, worldbook, memory, letoNote()].filter(Boolean).join('\n\n')
  }
}

// ── 从配置文件/环境加载 Agent ──

interface AgentFileEntry {
  id: string
  name: string
  letoName?: string
  enabled?: boolean
  token?: string                 // 不填则从 LETO_TOKEN_<ID> 读
  identity: 'eclipsis' | { personaFile: string; worldbookFile?: string | string[]; dudulove?: DuduloveConfig & { query?: string } }
  upstream?: AgentUpstream
  tools?: string[]               // 不填=核心；["*"]=全开；否则白名单
}

export function readAgentToken(id: string, env = process.env): string {
  return (env[`LETO_TOKEN_${id.toUpperCase()}`] || '').trim()
}

/** 读配置文件；没有或坏了返回 null（上层回退到 env-only 的小克） */
export function loadAgentFile(path: string): AgentFileEntry[] | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : parsed?.agents
    return Array.isArray(list) ? list : null
  } catch { return null }
}

function entryToAgent(e: AgentFileEntry, env: NodeJS.ProcessEnv): LetoAgent | null {
  if (e.enabled === false) return null
  const token = (e.token || readAgentToken(e.id, env)).trim()
  if (!token) return null
  const buildSystem = e.identity === 'eclipsis'
    ? buildXiaokeSystem
    : makePersonaBuildSystem(e.identity)
  return {
    id: e.id, name: e.name, letoName: e.letoName, token,
    upstream: e.upstream,
    buildSystem,
    allowTool: makeAllow(e.tools)
  }
}

/**
 * 加载 Agent。优先读配置文件 LETO_AGENTS_FILE（默认 /etc/eclipsis/leto-agents.json）；
 * 没有文件时回退到 env-only 的小克（保持上线时的行为）。
 */
export function loadAgents(env = process.env): LetoAgent[] {
  const file = (env.LETO_AGENTS_FILE || '/etc/eclipsis/leto-agents.json').trim()
  const entries = loadAgentFile(file)
  if (entries) {
    return entries.map(e => entryToAgent(e, env)).filter((a): a is LetoAgent => !!a)
  }
  // 回退：只有小克，令牌从环境读（和配置文件没建时的行为一致）
  const xiaokeToken = readAgentToken('xiaoke', env)
  if (!xiaokeToken) return []
  return [{
    id: 'xiaoke', name: '小克', letoName: 'Claude', token: xiaokeToken,
    upstream: { model: (env.LETO_MODEL_XIAOKE || '').trim() || undefined },
    buildSystem: buildXiaokeSystem,
    allowTool: coreToolsOnly
  }]
}
