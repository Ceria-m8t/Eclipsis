// Pulse HTTP API
// 挂在前端出口上（跟 Wake API 一样），由 main.ts 的 handleApi 链调用。
// 路由前缀：/v1/eclipsis/pulse/*
//
// 只读接口（前端面板 + 组装器）：
//   GET /state       — 完整身体状态
//   GET /vitals      — 精简一行（组装器注入用）
//   GET /hr-history  — 心率历史曲线（?hours=24&limit=500）
//
// 写入接口（他的工具 / 情绪检测 / 内部调用）：
//   POST /emotion    — { emotion: Emotion }
//   POST /sense      — { deltas: Partial<SensoryField> }
//   POST /posture    — { posture: Posture }
//   POST /weather    — { temperatureC, humidity?, condition? } 手动覆盖天气
//   POST /tick       — 手动触发一次 tick（调试用）

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DB } from '../db.ts'
import type { Emotion, Posture, WeatherInput } from './types.ts'
import { EMOTION_HR_DELTA, POSTURE_HR_BASE } from './types.ts'
import { loadPulseState, savePulseState, recordHr } from './store.ts'
import { pulseTick, renderVitalsLine } from './engine.ts'

// ── helpers ──

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function isValidEmotion(e: string): e is Emotion {
  return e in EMOTION_HR_DELTA
}

function isValidPosture(p: string): p is Posture {
  return p in POSTURE_HR_BASE
}

// ── 外部状态注入口 ──
// weather 和 xinchao 情绪由 main.ts 的定时器注入到这里，API 调用时直接用

let _externalWeather: WeatherInput | undefined
let _xinchaoEmotion: Emotion | undefined

export function setExternalWeather(w: WeatherInput | undefined): void { _externalWeather = w }
export function setXinchaoEmotion(e: Emotion | undefined): void { _xinchaoEmotion = e }

// ── 内部 tick（供 main.ts 定时器和手动 tick 调用） ──

export interface TickOptions {
  emotion?: Emotion
  posture?: Posture
  weather?: WeatherInput
  senseDeltas?: Partial<{ touch: number; smell: number; taste: number; sound: number }>
}

export function doTick(db: DB, opts: TickOptions = {}): ReturnType<typeof pulseTick> {
  const prev = loadPulseState(db)
  const now = new Date()

  // 情绪优先级：显式传入 > 心潮推断 > 保持不变
  const emotion = opts.emotion ?? _xinchaoEmotion ?? undefined
  // 天气优先级：显式传入 > 自动拉取 > 保持不变
  const weather = opts.weather ?? _externalWeather ?? undefined

  const next = pulseTick(prev, {
    now,
    emotion,
    posture: opts.posture,
    weather,
    senseDeltas: opts.senseDeltas
  })

  savePulseState(db, next)
  recordHr(db, next)
  return next
}

// ── API handler ──

const PREFIX = '/v1/eclipsis/pulse/'

export async function handlePulseApi(db: DB, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://local')
  if (!url.pathname.startsWith(PREFIX)) return false

  const route = url.pathname.slice(PREFIX.length)
  const method = req.method ?? 'GET'

  try {
    // ── GET routes ──
    if (method === 'GET') {
      if (route === 'state') {
        const state = loadPulseState(db)
        json(res, 200, { ok: true, ...state })
        return true
      }

      if (route === 'vitals') {
        const state = loadPulseState(db)
        json(res, 200, {
          ok: true,
          line: renderVitalsLine(state.vitals),
          vitals: state.vitals,
          emotion: state.emotion,
          posture: state.posture
        })
        return true
      }

      if (route === 'hr-history') {
        const hours = Math.min(168, Math.max(1, Number(url.searchParams.get('hours')) || 24))
        const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 500))
        const rows = db.prepare(`
          SELECT ts, hr, temp, chord, emotion FROM pulse_hr_history
          WHERE ts >= datetime('now', '-' || ? || ' hours')
          ORDER BY ts DESC LIMIT ?
        `).all(hours, limit) as { ts: string; hr: number; temp: number | null; chord: string | null; emotion: string | null }[]
        json(res, 200, { ok: true, hours, count: rows.length, points: rows.reverse() })
        return true
      }

      json(res, 404, { error: 'not found' })
      return true
    }

    // ── POST routes ──
    if (method === 'POST') {
      const body = JSON.parse(await readBody(req))

      if (route === 'emotion') {
        const e = String(body.emotion ?? '')
        if (!isValidEmotion(e)) { json(res, 400, { error: `invalid emotion: ${e}` }); return true }
        const state = doTick(db, { emotion: e })
        json(res, 200, { ok: true, emotion: state.emotion, vitals: state.vitals })
        return true
      }

      if (route === 'sense') {
        const deltas = body.deltas
        if (!deltas || typeof deltas !== 'object') { json(res, 400, { error: 'missing deltas' }); return true }
        const state = doTick(db, { senseDeltas: deltas })
        json(res, 200, { ok: true, senses: state.senses, vitals: state.vitals })
        return true
      }

      if (route === 'posture') {
        const p = String(body.posture ?? '')
        if (!isValidPosture(p)) { json(res, 400, { error: `invalid posture: ${p}` }); return true }
        const state = doTick(db, { posture: p })
        json(res, 200, { ok: true, posture: state.posture, vitals: state.vitals })
        return true
      }

      if (route === 'weather') {
        const w: WeatherInput = { temperatureC: Number(body.temperatureC) }
        if (!Number.isFinite(w.temperatureC)) { json(res, 400, { error: 'invalid temperatureC' }); return true }
        if (body.humidity != null) w.humidity = Number(body.humidity)
        if (body.condition) w.condition = String(body.condition)
        setExternalWeather(w)
        const state = doTick(db, { weather: w })
        json(res, 200, { ok: true, weather: w, vitals: state.vitals })
        return true
      }

      if (route === 'tick') {
        const state = doTick(db)
        json(res, 200, { ok: true, ...state })
        return true
      }

      json(res, 404, { error: 'not found' })
      return true
    }

    json(res, 405, { error: 'method not allowed' })
    return true
  } catch (e: any) {
    json(res, 500, { error: String(e?.message || e) })
    return true
  }
}
