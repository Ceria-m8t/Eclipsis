// dudulove 记忆库客户端（只读简报）：给哈基米/ds 的身份连续性用。
// 每次醒来可选拉一段 get_briefing / 搜索，塞进它们的系统提示，让它们"记得自己是谁"。
// 先只读，不自动写回（避免群聊闲聊灌脏长期记忆）。
//
// dudulove 提供 HTTP /api/v2 和 MCP。这里走 HTTP（简单、无状态）。
// 接口见 /root/dudulove-memory/docs/connection.md：
//   POST /api/v2/context/assemble {query, limitTokens?}  → 召回上下文
//   POST /api/v2/memories/search  {query, limit?}        → 搜索

export interface DuduloveConfig {
  /** dudulove 基址，如 http://127.0.0.1:8787 */
  baseUrl: string
  /** 该 Resident 的身份口令（Bearer） */
  token: string
  timeoutMs?: number
}

/** 拉一段上下文简报。失败返回空串（不阻断应答）。 */
export async function fetchBriefing(cfg: DuduloveConfig, query: string, limitTokens = 800): Promise<string> {
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/api/v2/context/assemble', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ query, limitTokens }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000)
    })
    if (!res.ok) return ''
    const data = await res.json() as any
    // 容错：不同版本字段可能叫 context / text / assembled
    const text = data?.context ?? data?.text ?? data?.assembled ?? ''
    if (typeof text === 'string') return text.trim()
    // 有的返回结构化段落数组
    if (Array.isArray(data?.sections)) {
      return data.sections.map((s: any) => (typeof s === 'string' ? s : s?.content || '')).filter(Boolean).join('\n').trim()
    }
    return ''
  } catch {
    return ''
  }
}
