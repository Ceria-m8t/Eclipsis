// 生图：垫图、画风、她自己出图（2026-11-11）
const BASE = '/api/eclipsis/draw'

export interface RefPhotoInfo { id: string; url: string; size: number }
export interface DrawRefInfo { id: string; name: string; note: string; enabled: boolean; byDefault: boolean; photos: RefPhotoInfo[] }
export interface DrawStyleInfo { id: string; name: string; prompt: string; isDefault: boolean }
export interface DrawInfo {
  ready: boolean; station: string | null; model: string | null; size: string | null
  refs: DrawRefInfo[]; styles: DrawStyleInfo[]; defaultStyle: string | null
}
export interface Drawn { hash: string; url: string; mime: string; bytes: number; mode: string; station: string; style: string | null; refs: string[]; photos: number }

async function post(path: string, body: unknown): Promise<any> {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((d as any).error || `HTTP ${r.status}`)
  return d
}

export async function drawInfo(): Promise<DrawInfo> {
  const r = await fetch(BASE, { cache: 'no-store' })
  if (!r.ok) throw new Error(`读不到生图设置（HTTP ${r.status}）`)
  return r.json()
}

/** 她自己画一张（默认带上默认垫图和默认画风） */
export const drawImage = (prompt: string, opts: { size?: string; refs?: string[]; style?: string; useDefaultRefs?: boolean } = {}): Promise<Drawn> =>
  post('', { prompt, ...opts })

export async function uploadRef(blob: Blob, name: string, note: string, byDefault: boolean): Promise<DrawRefInfo> {
  const r = await fetch(`${BASE}/refs`, {
    method: 'POST',
    headers: {
      'content-type': blob.type || 'image/jpeg',
      'x-ref-name': encodeURIComponent(name),
      'x-ref-note': encodeURIComponent(note),
      'x-ref-default': byDefault ? '1' : '0',
    },
    body: blob,
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((d as any).error || `上传失败（HTTP ${r.status}）`)
  return d as DrawRefInfo
}
export const editRef = (b: { id: string; name?: string; note?: string; byDefault?: boolean; enabled?: boolean }) => post('/refs/edit', b)
export const deleteRef = (id: string) => post('/refs/delete', { id })
export const deleteRefPhoto = (id: string) => post('/refs/photo/delete', { id })
export const saveStyle = (b: { id?: string; name: string; prompt: string; isDefault?: boolean }) => post('/styles', b)
export const setDefaultStyle = (id: string) => post('/styles/default', { id })
export const deleteStyle = (id: string) => post('/styles/delete', { id })
