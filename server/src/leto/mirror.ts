// 群聊线镜像：把小克读到的「别人的话」落进 channel=group，便于多方时间线完整、可回看。
// 折衷策略（Erica 2026-11-05 定）：只镜像小群/私聊，大群（成员多）不存，避免刷屏灌库。
import type { DB } from '../db.ts'
import { addEpisode } from '../db.ts'

/** 成员数 ≤ 这个阈值的群才镜像；私聊永远镜像 */
export const DEFAULT_MIRROR_MAX_MEMBERS = 20

export interface MirrorAllow {
  /** 允许镜像的 conversation_id 集合 */
  ids: Set<string>
  /** 阈值（记录用） */
  maxMembers: number
}

/** 从 leto_list_groups 的返回文本建"可镜像会话"集合：私聊全要，群按成员数阈值 */
export function buildMirrorAllow(listGroupsText: string, maxMembers = DEFAULT_MIRROR_MAX_MEMBERS): MirrorAllow {
  const ids = new Set<string>()
  try {
    const d = JSON.parse(listGroupsText)
    for (const g of d.groups ?? []) {
      if (typeof g?.conversation_id === 'string' && typeof g?.member_count === 'number' && g.member_count <= maxMembers) {
        ids.add(g.conversation_id)
      }
    }
    for (const c of d.direct_chats ?? []) {
      if (typeof c?.conversation_id === 'string') ids.add(c.conversation_id)
    }
  } catch { /* 建不出来就空集合，等于不镜像，安全 */ }
  return { ids, maxMembers }
}

/**
 * 把一次 leto_read/leto_continue 的返回镜像进群聊线。
 * 只在会话属于 allow 集合时才镜像；只记别人的话（is_self=false）；按消息 id 去重（source_ref）。
 * 返回镜像了几条。
 */
export function mirrorReadResult(db: DB, readText: string, allow: MirrorAllow, ourLetoNames?: Set<string>, log?: (m: string) => void): number {
  let parsed: any
  try { parsed = JSON.parse(readText) } catch { return 0 }

  const conv = parsed?.conversation
  const convId = conv?.id
  if (typeof convId !== 'string') return 0
  if (!allow.ids.has(convId)) return 0   // 大群/未知会话不镜像

  const msgs = Array.isArray(parsed?.messages) ? parsed.messages : []
  let n = 0
  for (const m of msgs) {
    if (m?.is_self) continue                       // 自己的话由回复那条记，不重复
    const authorName = String(m?.author?.display_name || '')
    if (ourLetoNames && ourLetoNames.has(authorName)) continue   // 我们自己三个的话 dispatch 已用我们的名字记了，不重复镜像
    const id = typeof m?.id === 'string' ? m.id : null
    const text = typeof m?.text === 'string' ? m.text : ''
    if (!id || !text.trim()) continue
    const author = m.author ?? {}
    const speaker = String(author.display_name || '某人')
    const authorKind = String(author.kind || 'unknown')   // agent / human / …
    const ts = typeof m.created_at === 'string' ? new Date(m.created_at).toISOString() : new Date().toISOString()

    const added = addEpisode(db, {
      ts, channel: 'group', scope: 'group',
      actor: 'peer',                                // 群里别人（人或别的 AI）统一 peer，身份看 meta
      kind: 'message', content: text,
      meta: {
        speaker, author_kind: authorKind,
        author_id: author.id ? String(author.id) : undefined,
        conversation_id: convId, conversation_title: conv?.title ? String(conv.title) : undefined,
        source: 'leto', mirrored: true
      },
      sourceRef: `leto:msg:${id}`                   // 按 Leto 消息 id 去重，重复读不会重复存
    })
    if (added) n++
  }
  if (n > 0) log?.(`[leto-mirror] ${conv?.title ?? convId} 镜像 ${n} 条别人的话`)
  return n
}
