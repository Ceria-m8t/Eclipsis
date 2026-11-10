// 中转站面板（2026-11-11，从 Leto 管理页搬过来）：聊天的站和画图的站各一套，密钥只在后端。
const BASE = '/api/eclipsis/stations'

export interface ChatStation { id: string; name: string; url: string; key: string; defaultModel: string }
export interface ChatStationList {
  active: string | null
  switchedAt?: string
  current: { id: string | null; name: string; url: string; key: string; defaultModel: string; switchedAt?: string }
  stations: ChatStation[]
}

export type DrawMode = 'images' | 'chat' | 'auto'
export interface ImageStation { id: string; name: string; url: string; key: string; model: string; size: string; mode: DrawMode }
export interface ImageStationList { active: string; stations: ImageStation[] }

async function call(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(BASE + path, { cache: 'no-store', ...init })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((d as any).error || `HTTP ${r.status}`)
  return d
}
const post = (path: string, body: unknown) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// ── 聊天的站 ──
export const listChatStations = (): Promise<ChatStationList> => call('')
export const saveChatStation = (b: { id?: string; name: string; url: string; key?: string; defaultModel?: string }) => post('', b)
export const switchChatStation = (id: string) => post('/switch', { id })
export const deleteChatStation = (id: string) => post('/delete', { id })
export const stationModels = (id: string): Promise<{ models: string[]; error?: string }> => post('/models', { id })
export const testChatStation = (id: string, model?: string): Promise<{ ok: boolean; ms?: number; error?: string; reply?: string }> =>
  post('/test', { id, model })

// ── 画图的站 ──
export const listImageStations = (): Promise<ImageStationList> => call('?kind=image')
export const saveImageStation = (b: { id?: string; name: string; url: string; key?: string; model?: string; size?: string; mode?: DrawMode }) =>
  post('?kind=image', b)
export const switchImageStation = (id: string) => post('/switch?kind=image', { id })
export const deleteImageStation = (id: string) => post('/delete?kind=image', { id })
export const imageStationModels = (id: string): Promise<{ models: string[]; error?: string }> => post('/models?kind=image', { id })
export const testImageStation = (id: string): Promise<{ ok: boolean; mode?: DrawMode; ms?: number; bytes?: number; error?: string }> =>
  post('/test?kind=image', { id })

// ── 她自己生图 ──
export interface DrawReady { ready: boolean; station: string | null; model: string | null; size: string | null }
export const drawReady = (): Promise<DrawReady> => fetch('/api/eclipsis/draw', { cache: 'no-store' }).then(r => r.json())
export async function drawImage(prompt: string, size?: string): Promise<{ hash: string; url: string; mode: string; station: string }> {
  const r = await fetch('/api/eclipsis/draw', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, size }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((d as any).error || `画不出来（HTTP ${r.status}）`)
  return d
}
