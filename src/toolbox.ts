// 他的工具箱（后端 server/src/toolbox.ts）：聊天时他手边先只有入口（open_xxx），打开了才拿到里面的工具。
// 箱子在后端，聊天和醒来共用一份；令牌也只在后端，浏览器拿不到。
export interface BoxEntry { entryName: string; title: string; description: string }

const BASE = '/api/eclipsis'
let cached: { at: number; boxes: BoxEntry[] } | null = null

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`)
  return d
}

/** 聊天时的入口（记一分钟，免得每轮都问） */
export async function boxEntries(): Promise<BoxEntry[]> {
  if (cached && Date.now() - cached.at < 60_000) return cached.boxes
  try {
    const r = await fetch(BASE + '/tools', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error()
    const boxes = ((await r.json()).boxes || []) as BoxEntry[]
    cached = { at: Date.now(), boxes }
    return boxes
  } catch {
    return cached?.boxes || []   // 后端连不上：这一轮就不给箱子，聊天照常
  }
}
export function forgetBoxEntries() { cached = null }

export const entryDefinition = (b: BoxEntry) => ({
  type: 'function',
  function: { name: b.entryName, description: b.description + '（打开以后，下一步才能用里面的工具）', parameters: { type: 'object', properties: {} } },
})

export async function openBox(entry: string): Promise<{ title: string; tools: any[] }> {
  return post('/tools/open', { entry })
}

export async function callBoxTool(entry: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  return post('/tools/call', { entry, name, args })
}

// ---- 设置页 ----
export interface BoxInfo {
  id: string; title: string; entryName: string; description: string
  builtin: boolean; chat: boolean; wake: boolean; wakeOnly?: boolean; url: string; token: string; tools: number | null
  blocked?: string[]
}
export async function listToolbox(): Promise<BoxInfo[]> {
  const r = await fetch(BASE + '/toolbox', { cache: 'no-store' })
  if (!r.ok) throw new Error(`读取工具箱失败（HTTP ${r.status}）`)
  return (await r.json()).boxes
}
export const saveBox = (b: { id?: string; title: string; entryName: string; description: string; url: string; token?: string; chat: boolean; wake: boolean; blocked?: string[] }) =>
  post('/toolbox', b).then(r => { forgetBoxEntries(); return r })
export const setBoxFlags = (id: string, flags: { chat?: boolean; wake?: boolean }) => post('/toolbox/flags', { id, ...flags }).then(r => { forgetBoxEntries(); return r })
export const setBoxOrder = (ids: string[]) => post('/toolbox/order', { ids }).then(r => { forgetBoxEntries(); return r })
export const deleteBox = (id: string) => post('/toolbox/delete', { id }).then(r => { forgetBoxEntries(); return r })
export const testBox = (id: string): Promise<{ ok: boolean; tools?: string[]; error?: string }> => post('/toolbox/test', { id })
