// IndexedDB 存储层
// 聊天记录不再放 localStorage：空间大（通常数百 MB 起），存满时报错而不是静默删除。

export type Role = 'user' | 'assistant'

export interface ToolEvent {
  id: string
  name: string
  args: string          // 原始 JSON 字符串
  result?: string
  isError?: boolean
  status: 'running' | 'done' | 'error'
}

// 一轮模型调用的原始记录，用于下次请求时原样回放给模型
export interface ApiTurn {
  content: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_results?: { tool_call_id: string; content: string }[]
}

export interface MessageVersion {
  content: string       // 展示用的完整文本（所有轮次拼接）
  thinking?: string
  tools?: ToolEvent[]
  trail?: ApiTurn[]     // 有工具调用时才有
  createdAt: number
}

export interface ChatMessage {
  id: string
  seq: number           // 排序用
  role: Role
  createdAt: number
  content: string       // 当前版本的内容（user 消息直接用）
  images?: string[]     // dataURL（已压缩）
  versions?: MessageVersion[]  // assistant 的多个版本（重新生成）
  activeVersion?: number
  error?: string
}

const DB_NAME = 'eclipsis'
const DB_VERSION = 1
const STORE = 'messages'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('seq', 'seq')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const r = fn(t.objectStore(STORE))
    t.oncomplete = () => resolve(r ? r.result : undefined)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  }))
}

export async function getAllMessages(): Promise<ChatMessage[]> {
  const all = (await tx<ChatMessage[]>('readonly', s => s.getAll())) || []
  return all.sort((a, b) => a.seq - b.seq)
}

// Vue 的响应式代理不能直接存进 IndexedDB，先转成普通对象
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

export async function putMessage(msg: ChatMessage): Promise<void> {
  await tx('readwrite', s => { s.put(plain(msg)) })
}

export async function putMessages(msgs: ChatMessage[]): Promise<void> {
  await tx('readwrite', s => { for (const m of msgs) s.put(plain(m)) })
}

export async function deleteMessage(id: string): Promise<void> {
  await tx('readwrite', s => { s.delete(id) })
}

export async function clearMessages(): Promise<void> {
  await tx('readwrite', s => { s.clear() })
}

export function newId(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// 申请持久化存储：浏览器空间紧张时不会优先清掉本站数据
export async function requestPersist(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist()
  } catch {}
  return false
}

// ===== 从旧版 localStorage 迁移 =====
const LEGACY_KEY = 'eclipsis-chat-history'

export async function migrateFromLocalStorage(): Promise<number> {
  const raw = localStorage.getItem(LEGACY_KEY)
  if (!raw) return 0
  const existing = await getAllMessages()
  if (existing.length > 0) return 0  // 已迁移过，不重复导入

  let legacy: { role: Role; content: string; time?: string; images?: string[] }[]
  try { legacy = JSON.parse(raw) } catch { return 0 }
  if (!Array.isArray(legacy) || legacy.length === 0) return 0

  const base = Date.now() - legacy.length * 1000
  const msgs: ChatMessage[] = legacy.map((m, i) => {
    // 旧版只存了 "HH:mm"，日期已丢失，按原顺序估算时间
    const createdAt = base + i * 1000
    const msg: ChatMessage = {
      id: newId(), seq: createdAt, role: m.role, createdAt,
      content: m.content || '', images: m.images
    }
    if (m.role === 'assistant') {
      msg.versions = [{ content: m.content || '', createdAt }]
      msg.activeVersion = 0
    }
    return msg
  })
  await putMessages(msgs)

  // 确认写入成功后才删除旧数据
  const check = await getAllMessages()
  if (check.length >= msgs.length) localStorage.removeItem(LEGACY_KEY)
  return msgs.length
}

// ===== 导出 / 导入 =====
export async function exportJson(): Promise<string> {
  const messages = await getAllMessages()
  return JSON.stringify({ app: 'eclipsis', version: 1, exportedAt: new Date().toISOString(), messages }, null, 0)
}

export async function importJson(text: string): Promise<number> {
  const data = JSON.parse(text)
  const msgs: ChatMessage[] = Array.isArray(data) ? data : data.messages
  if (!Array.isArray(msgs)) throw new Error('文件格式不对')
  for (const m of msgs) {
    if (!m.id || !m.role || typeof m.seq !== 'number') throw new Error('文件里有无法识别的消息')
  }
  // 按 id 合并，不会覆盖掉本地已有但文件里没有的消息
  await putMessages(msgs)
  return msgs.length
}
