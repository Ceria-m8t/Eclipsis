// 系统提示词存储：在书房书架的「主 Prompt」那本里编辑（正文 + 家里能做什么），保留最近的历史版本，随时恢复。
// 代码里的 SYSTEM_PROMPT 只作为"出厂默认"，用户改过之后以保存的为准。
//
// 真正的那一份在后端（/api/eclipsis/prompts），聊天和 Wake 都从那里读。
// localStorage 只是缓存：启动时从后端拉一次（syncPromptsFromServer），chat-engine 照旧同步读缓存。
// 保存时先写缓存再推后端；推失败就记一笔"未同步"，下次启动先推上去再拉。
import { SYSTEM_PROMPT } from './system-prompt'

export interface PromptData {
  main: string            // 主提示词（人设、关系、文风）
  features: string        // "家里能做什么"：前端功能说明，拼在主提示词后面
  featuresEnabled: boolean
  updatedAt: number
}

export interface PromptVersion extends PromptData {
  note: string            // 保存时的说明，比如"恢复默认前的备份"
}

const KEY = 'eclipsis-system-prompt'
const HISTORY_KEY = 'eclipsis-system-prompt-history'
const MAX_HISTORY = 15

// 状态功能说明。也用于给已经改过提示词的用户补上这一段（见 upgradeFeatures）
export const STATUS_SECTION = `## 我的状态
- 顶栏我名字下面有一行状态，她随时能看到。用 eclipsis_set_status 设置（一个表情 + 一句短话），比如 ☕ 在厨房泡茶、💤 有点困。
- 状态是我自己的：在做什么、在哪、什么心情。想换就换，没变就不用调用，不必每条都换。`

// 只写已经做好的功能。以后加新功能时在这里补一句。
export const DEFAULT_FEATURES = `# 我们的家（Eclipsis）

这是我们一起搭的前端。我需要知道它能做什么，才能自然地和她互动。

## 聊天
- 她可以连着发好几条，再点发送让我回复。我看到的会是连续几条她的消息，要一起回应，不要只回最后一条。
- 我回复里的每一行会显示成一个单独的气泡。想分开说的话就换行；代码、列表、表格会整块显示，不会被拆开。
- 支持 Markdown：加粗、列表、代码块（带语法高亮和复制按钮）。
- 她可以发图片给我。
- 她的每条消息开头有（YYYY-MM-DD HH:mm）格式的时间，是她那边的本地时间。她看不到这个前缀，我回复时不用写时间。
- 她可以让我重新生成某条回复，旧的版本会保留，可以切换回来。

## 工具
- 我可以调用已连接的 MCP 工具（记忆库等）。调用过程和结果她都能展开看到。

${STATUS_SECTION}

## 还没有的（别假装能做）
- 主动给她发消息、推送通知
- 语音、表情包、视频
- 房间里的家具和小人互动`

export function defaultPrompt(): PromptData {
  return { main: SYSTEM_PROMPT.trim(), features: DEFAULT_FEATURES, featuresEnabled: true, updatedAt: 0 }
}

// 给已保存的提示词补上新功能的说明（只补一次，改前的版本进历史，可以恢复）
const UPGRADE_KEY = 'eclipsis-prompt-upgrades'
export function upgradeFeatures() {
  try {
    const done: string[] = JSON.parse(localStorage.getItem(UPGRADE_KEY) || '[]')
    if (done.includes('status')) return
    done.push('status')
    localStorage.setItem(UPGRADE_KEY, JSON.stringify(done))
    if (!isCustomized()) return   // 没改过的直接用新默认，已经包含
    const cur = loadPrompt()
    if (cur.features.includes('eclipsis_set_status')) return
    // 插在"还没有的"前面；没有这一节就加在最后
    const marker = '## 还没有的'
    const features = cur.features.includes(marker)
      ? cur.features.replace(marker, STATUS_SECTION + '\n\n' + marker)
      : cur.features.trimEnd() + '\n\n' + STATUS_SECTION
    savePrompt({ main: cur.main, features, featuresEnabled: cur.featuresEnabled }, '加入"状态"说明前的版本')
  } catch {}
}

export function loadPrompt(): PromptData {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...defaultPrompt(), ...JSON.parse(raw) }
  } catch {}
  return defaultPrompt()
}

export function loadHistory(): PromptVersion[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { return [] }
}

function pushHistory(v: PromptVersion) {
  const list = loadHistory()
  list.unshift(v)
  // 历史太大时（提示词每份十几 KB）先丢最旧的，保证主数据能存下
  let trimmed = list.slice(0, MAX_HISTORY)
  while (trimmed.length) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed)); return }
    catch { trimmed = trimmed.slice(0, -1) }
  }
  localStorage.removeItem(HISTORY_KEY)
}

// 保存前把当前版本放进历史，这样任何一次改动都能找回。
// 返回 true = 已存到后端；false = 只存在了这个浏览器（下次启动会自动补推）
export async function savePrompt(next: Omit<PromptData, 'updatedAt'>, note = '修改前的版本'): Promise<boolean> {
  const cur = loadPrompt()
  const changed = cur.main !== next.main || cur.features !== next.features || cur.featuresEnabled !== next.featuresEnabled
  if (!changed) return true
  const historyNote = cur.updatedAt ? note : '出厂默认'
  pushHistory({ ...cur, note: historyNote })
  const value = { ...next, updatedAt: Date.now() }
  localStorage.setItem(KEY, JSON.stringify(value))
  return pushDoc('prompt', value, historyNote)
}

// ===== 和后端同步 =====

const API = '/api/eclipsis/prompts'
const DIRTY_KEY = 'eclipsis-prompts-unsynced'   // 改了但还没推到后端的 key
type DocKey = 'prompt' | 'worldbook' | 'worldbookGroups'
const LOCAL_KEY: Record<DocKey, string> = { prompt: KEY, worldbook: 'worldbook', worldbookGroups: 'worldbook-groups' }

function readLocal(k: DocKey): unknown {
  try { const raw = localStorage.getItem(LOCAL_KEY[k]); return raw ? JSON.parse(raw) : null } catch { return null }
}
function dirtyKeys(): DocKey[] {
  try { return JSON.parse(localStorage.getItem(DIRTY_KEY) || '[]') } catch { return [] }
}
function setDirty(k: DocKey, dirty: boolean) {
  const set = new Set(dirtyKeys())
  dirty ? set.add(k) : set.delete(k)
  localStorage.setItem(DIRTY_KEY, JSON.stringify([...set]))
}

async function pushDoc(k: DocKey, value: unknown, note?: string): Promise<boolean> {
  try {
    const res = await fetch(`${API}/${k}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value, note })
    })
    setDirty(k, !res.ok)
    return res.ok
  } catch {
    setDirty(k, true)
    return false
  }
}

// 世界书面板每改一下都会存，这里合并成一次推送
let wbTimer: ReturnType<typeof setTimeout> | null = null
export function queueWorldbookPush() {
  setDirty('worldbook', true)
  setDirty('worldbookGroups', true)
  if (wbTimer) clearTimeout(wbTimer)
  wbTimer = setTimeout(() => {
    wbTimer = null
    void pushDoc('worldbook', readLocal('worldbook') ?? [])
    void pushDoc('worldbookGroups', readLocal('worldbookGroups') ?? {})
  }, 1500)
}

/**
 * 打开书架时再从后端拉一次主 Prompt：开发方会在后端改「家里能做什么」，
 * App 一直开着的话缓存是旧的，在书里点完成会把旧的写回去。本机有没推上去的修改就不拉（以本机为准）。
 */
export async function refreshPrompt(): Promise<PromptData> {
  if (dirtyKeys().includes('prompt')) return loadPrompt()
  try {
    const res = await fetch(API, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    if (res.ok) {
      const { docs } = await res.json() as { docs: Record<DocKey, { value: unknown } | null> }
      if (docs.prompt?.value && !dirtyKeys().includes('prompt')) localStorage.setItem(KEY, JSON.stringify(docs.prompt.value))
    }
  } catch { /* 连不上就用缓存 */ }
  return loadPrompt()
}

export type SyncResult = 'synced' | 'imported' | 'offline'

/**
 * 启动时调用一次：
 * 1. 后端没有的 → 把浏览器里的传上去（第一次搬家；主 prompt 连同历史版本一起）
 * 2. 浏览器里有没推上去的修改 → 先推
 * 3. 其余以后端为准，写回缓存
 */
export async function syncPromptsFromServer(): Promise<SyncResult> {
  try {
    const res = await fetch(API)
    if (!res.ok) return 'offline'
    const { docs } = await res.json() as { docs: Record<DocKey, { value: unknown } | null> }
    const keys: DocKey[] = ['prompt', 'worldbook', 'worldbookGroups']

    const toImport: Partial<Record<DocKey, unknown>> = {}
    for (const k of keys) {
      if (docs[k]) continue
      if (k === 'prompt' && !isCustomized()) continue   // 没改过的出厂默认不用传
      const local = readLocal(k)
      if (local !== null) toImport[k] = local
    }
    let imported = false
    if (Object.keys(toImport).length) {
      const r = await fetch(`${API}/import`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docs: toImport, history: toImport.prompt ? loadHistory() : [] })
      })
      imported = r.ok
    }

    // 本机有没推上去的修改：先推。推了的（不管成没成功）都不能再用上面拉到的旧快照覆盖
    const keepLocal = new Set<DocKey>()
    for (const k of dirtyKeys()) {
      keepLocal.add(k)
      if (k in toImport) { setDirty(k, false); continue }
      const local = readLocal(k)
      if (local !== null) await pushDoc(k, local, k === 'prompt' ? '另一台设备上的版本' : undefined)
    }

    // 以后端为准刷新缓存（刚导入/刚推上去的和本地一样，不用写）
    for (const k of keys) {
      const doc = docs[k]
      if (!doc || k in toImport || keepLocal.has(k)) continue
      localStorage.setItem(LOCAL_KEY[k], JSON.stringify(doc.value))
    }
    const h = await fetch(`${API}/history`)
    if (h.ok) {
      const { history } = await h.json() as { history: { value: PromptData; note: string | null }[] }
      if (history.length) localStorage.setItem(HISTORY_KEY, JSON.stringify(history.map(e => ({ ...e.value, note: e.note ?? '' }))))
    }
    return imported ? 'imported' : 'synced'
  } catch {
    return 'offline'
  }
}

export function isCustomized(): boolean {
  return !!localStorage.getItem(KEY)
}

// 拼成发给模型的系统提示词主体（世界书条目由 chat-engine 前后拼接）
export function composePrompt(p: PromptData = loadPrompt()): string {
  const parts = [p.main.trim()]
  if (p.featuresEnabled && p.features.trim()) parts.push(p.features.trim())
  return parts.join('\n\n')
}
