// 画图的站（2026-11-11，Erica 要）：和聊天的站分开存，因为她的生图站也会经常换，不能写死在代码里。
//
// 两种调法，按站选（不确定就点自检，后端两种都试一遍）：
//   images  ——  POST {url}/images/generations  {model, prompt, size, n:1}   大部分中转站都有
//   chat    ——  POST {url}/chat/completions    让图片模型在回复里返图（gemini 那类）
// 存在 /etc/eclipsis/stations/image-stations.json（600），密钥不回前端。
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type DrawMode = 'images' | 'chat' | 'auto'

export interface ImageStation {
  id: string
  name: string
  url: string
  key: string
  model: string
  size: string          // 如 1024x1024，空 = 不传
  mode: DrawMode
}

interface FileShape { active: string; stations: ImageStation[] }

let filePath = '/etc/eclipsis/stations/image-stations.json'
export function setImageStationFile(p: string) { filePath = p }

function read(): FileShape {
  try {
    if (existsSync(filePath)) {
      const f = JSON.parse(readFileSync(filePath, 'utf8'))
      return { active: typeof f.active === 'string' ? f.active : '', stations: Array.isArray(f.stations) ? f.stations : [] }
    }
  } catch { /* 坏了按空的来，写的时候会先备份 */ }
  return { active: '', stations: [] }
}

function write(f: FileShape) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (existsSync(filePath)) { try { copyFileSync(filePath, `${filePath}.bak`) } catch {} }
  writeFileSync(filePath, JSON.stringify(f, null, 2), { mode: 0o600 })
}

const mask = (k: string) => (k ? `${k.slice(0, 3)}…${k.slice(-3)}（${k.length} 位）` : '')

export function listImageStations(): { active: string; stations: (Omit<ImageStation, 'key'> & { key: string })[] } {
  const f = read()
  return { active: f.active, stations: f.stations.map(s => ({ ...s, key: mask(s.key) })) }
}

export function findImageStation(id: string): ImageStation | null {
  return read().stations.find(s => s.id === id) ?? null
}

/** 正在用的那个画图站；没存过返回 null（他的画笔就不出现） */
export function currentImageStation(): ImageStation | null {
  const f = read()
  return f.stations.find(s => s.id === f.active) ?? null
}

export function saveImageStation(input: {
  id?: string; name: string; url: string; key?: string; model?: string; size?: string; mode?: DrawMode
}): ImageStation {
  const name = String(input.name ?? '').trim()
  const url = String(input.url ?? '').trim().replace(/\/+$/, '')
  if (!name) throw new Error('要填名字')
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error('地址要以 http:// 或 https:// 开头')
  const f = read()
  const old = input.id ? f.stations.find(s => s.id === input.id) : undefined
  if (input.id && !old) throw new Error('找不到这个站')
  const key = String(input.key ?? '').trim() || old?.key || ''
  if (!key) throw new Error('要填密钥')
  const mode = (['images', 'chat', 'auto'] as DrawMode[]).includes(input.mode as DrawMode) ? input.mode as DrawMode : old?.mode ?? 'auto'
  const size = String(input.size ?? old?.size ?? '').trim()
  if (size && !/^\d{3,4}x\d{3,4}$/.test(size)) throw new Error('尺寸写成 1024x1024 这样，或者留空')
  const st: ImageStation = {
    id: old?.id ?? `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name, url, key, model: String(input.model ?? old?.model ?? '').trim(), size, mode,
  }
  f.stations = old ? f.stations.map(s => (s.id === st.id ? st : s)) : [...f.stations, st]
  if (!f.active) f.active = st.id
  write(f)
  return st
}

export function deleteImageStation(id: string): void {
  const f = read()
  f.stations = f.stations.filter(s => s.id !== id)
  if (f.active === id) f.active = f.stations[0]?.id ?? ''
  write(f)
}

export function switchImageStation(id: string): ImageStation {
  const f = read()
  const st = f.stations.find(s => s.id === id)
  if (!st) throw new Error('找不到这个站')
  f.active = id
  write(f)
  return st
}

/** 自检：按它的 mode 真画一张小的，回报哪种调法通、花了多久 */
export async function probeImageStation(st: ImageStation): Promise<{ ok: boolean; mode?: DrawMode; ms?: number; bytes?: number; error?: string }> {
  const { drawWith } = await import('./draw.ts')
  const t0 = Date.now()
  try {
    const r = await drawWith(st, '一只很小的像素风小螃蟹，纯色背景', { size: st.size || '512x512' })
    return { ok: true, mode: r.mode, ms: Date.now() - t0, bytes: r.data.length }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 300), ms: Date.now() - t0 }
  }
}
