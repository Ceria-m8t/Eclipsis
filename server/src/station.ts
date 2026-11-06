// 换站（2026-11-07）：几个常用中转站存在 /etc/eclipsis/stations/stations.json，面板上点一下就切，不用重启。
//
// 现在用哪个站，聊天（上游入口）、Wake、小克的 Leto、心潮（经内部转发口）都跟着走。
// 哈基米 / ds 在 leto-agents.json 里有自己的站，不受影响。
//
// 文件没有时用 backend.env 的 UPSTREAM_URL / UPSTREAM_KEY（和以前一样）。
// 第一次在面板上存站时，会把 backend.env 那个站也存进来（叫「原来的站」），随时能切回去。
//
// 模型：不同站给同一个模型起的名字不一样。切站以后、还没在新站聊过时，
// Wake / 小克 / 心潮用这个站的「默认模型」；在新站聊过以后跟着聊天走。
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DB } from './db.ts'

export interface Station {
  id: string
  name: string
  url: string
  key: string
  /** 换到这个站、还没在这里聊过时用的模型名 */
  defaultModel: string
}

interface StationFile {
  active: string
  /** 最近一次切站的时间（ISO） */
  switchedAt?: string
  stations: Station[]
}

export interface CurrentStation {
  id: string | null
  name: string
  url: string
  key: string
  defaultModel: string
  switchedAt?: string
}

let filePath = '/etc/eclipsis/stations/stations.json'
let envStation: CurrentStation = { id: null, name: 'backend.env', url: '', key: '', defaultModel: '' }
let current: CurrentStation = envStation

function readFile(): StationFile | null {
  if (!existsSync(filePath)) return null
  try {
    const f = JSON.parse(readFileSync(filePath, 'utf8')) as StationFile
    if (!f || !Array.isArray(f.stations)) return null
    return f
  } catch { return null }
}

function writeFile(f: StationFile) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (existsSync(filePath)) {
    try { copyFileSync(filePath, `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`) } catch { /* 备份失败不阻断 */ }
  }
  writeFileSync(filePath, JSON.stringify(f, null, 2), { mode: 0o600 })
}

function apply(f: StationFile | null) {
  const s = f?.stations.find(x => x.id === f.active)
  current = s ? { id: s.id, name: s.name, url: s.url, key: s.key, defaultModel: s.defaultModel, switchedAt: f!.switchedAt } : envStation
}

/** 启动时调一次 */
export function initStations(env: NodeJS.ProcessEnv = process.env): CurrentStation {
  filePath = (env.STATIONS_FILE || '/etc/eclipsis/stations/stations.json').trim()
  envStation = { id: null, name: 'backend.env', url: (env.UPSTREAM_URL || '').trim(), key: (env.UPSTREAM_KEY || '').trim(), defaultModel: (env.UPSTREAM_DEFAULT_MODEL || '').trim() }
  apply(readFile())
  return current
}

export function currentStation(): CurrentStation { return current }

/** 让 cfg.upstreamUrl / cfg.upstreamKey 每次读都是现在的站（上游入口、转发口都读 cfg） */
export function bindStationToConfig(cfg: { upstreamUrl: string; upstreamKey: string }): void {
  Object.defineProperty(cfg, 'upstreamUrl', { get: () => current.url, enumerable: true, configurable: true })
  Object.defineProperty(cfg, 'upstreamKey', { get: () => current.key, enumerable: true, configurable: true })
}

const mask = (k: string) => (k.length <= 8 ? '••••' : `${k.slice(0, 4)}…${k.slice(-4)}`)

/** 给面板看的：密钥打码 */
export function listStations(): { active: string | null; switchedAt?: string; current: Omit<CurrentStation, 'key'> & { key: string }; stations: (Omit<Station, 'key'> & { key: string })[] } {
  const f = readFile()
  return {
    active: f?.active ?? null,
    switchedAt: f?.switchedAt,
    current: { ...current, key: mask(current.key) },
    stations: (f?.stations ?? []).map(s => ({ ...s, key: mask(s.key) }))
  }
}

/** 第一次存站：把 backend.env 那个站也存进来，当成正在用的 */
function ensureFile(): StationFile {
  const f = readFile()
  if (f) return f
  const seed: StationFile = { active: 'env', stations: [] }
  if (envStation.url) seed.stations.push({ id: 'env', name: '原来的站（backend.env）', url: envStation.url, key: envStation.key, defaultModel: envStation.defaultModel })
  else seed.active = ''
  return seed
}

export function findStation(id: string): Station | null {
  return readFile()?.stations.find(s => s.id === id) ?? null
}

/** 新建或修改。修改时 key 留空 = 不改密钥 */
export function saveStation(input: { id?: string; name: string; url: string; key?: string; defaultModel?: string }): Station {
  const name = String(input.name ?? '').trim()
  const url = String(input.url ?? '').trim().replace(/\/+$/, '')
  if (!name) throw new Error('要填名字')
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error('地址要以 http:// 或 https:// 开头')
  const f = ensureFile()
  const old = input.id ? f.stations.find(s => s.id === input.id) : undefined
  if (input.id && !old) throw new Error('找不到这个站')
  const key = String(input.key ?? '').trim() || old?.key || ''
  if (!key) throw new Error('要填密钥')
  const st: Station = { id: old?.id ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, url, key, defaultModel: String(input.defaultModel ?? old?.defaultModel ?? '').trim() }
  f.stations = old ? f.stations.map(s => (s.id === st.id ? st : s)) : [...f.stations, st]
  writeFile(f)
  apply(f)
  return st
}

export function deleteStation(id: string): void {
  const f = readFile()
  if (!f) throw new Error('还没有存过站')
  if (f.active === id) throw new Error('正在用的站不能删，先切到别的站')
  f.stations = f.stations.filter(s => s.id !== id)
  writeFile(f)
}

export function switchStation(id: string, now = new Date()): CurrentStation {
  const f = ensureFile()
  if (!f.stations.some(s => s.id === id)) throw new Error('找不到这个站')
  f.active = id
  f.switchedAt = now.toISOString()
  writeFile(f)
  apply(f)
  return current
}

/**
 * Wake / 小克的 Leto / 心潮该用哪个模型：
 * 最近一次聊天发生在切站之后 → 跟着聊天的模型；切站后还没聊过 → 这个站的默认模型（没填就还用聊天的）。
 */
export function chooseModel(db: DB): string | null {
  const row = db.prepare(`SELECT model, started_at FROM exchanges
    WHERE tap = 'upstream' AND status = 'ok' AND model IS NOT NULL AND model != ''
    ORDER BY id DESC LIMIT 1`).get() as { model: string; started_at: string } | undefined
  const sw = current.switchedAt
  if (row && (!sw || row.started_at >= sw)) return row.model
  return current.defaultModel || row?.model || null
}

/** 测试用 */
export function resetStationsForTest(path: string, env: Partial<CurrentStation> = {}): void {
  filePath = path
  envStation = { id: null, name: 'backend.env', url: env.url ?? '', key: env.key ?? '', defaultModel: env.defaultModel ?? '' }
  apply(readFile())
}
