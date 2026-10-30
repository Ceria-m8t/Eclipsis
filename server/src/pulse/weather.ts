// 天气自动拉取：Open-Meteo（免费、不需要 API key）
// 给 Pulse 引擎喂 WeatherInput（室外温度/湿度/天气状况）
// 上海坐标：31.23°N, 121.47°E

import type { WeatherInput } from './types.ts'

const SHANGHAI_LAT = 31.23
const SHANGHAI_LON = 121.47

/** Open-Meteo current weather 返回结构（只取需要的字段） */
interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number
    relative_humidity_2m?: number
    weather_code?: number
  }
}

/** WMO weather code → 简单天气状况 */
function wmoToCondition(code: number): string {
  // https://open-meteo.com/en/docs → WMO Weather interpretation codes
  if (code === 0) return 'clear'
  if (code <= 3) return 'cloudy'
  if (code >= 51 && code <= 57) return 'drizzle'
  if (code >= 61 && code <= 67) return 'rain'
  if (code >= 71 && code <= 77) return 'snow'
  if (code >= 80 && code <= 82) return 'rain'
  if (code >= 85 && code <= 86) return 'snow'
  if (code >= 95) return 'thunderstorm'
  if (code >= 45 && code <= 48) return 'fog'
  return 'cloudy'
}

/** 从 Open-Meteo 拉取上海当前天气 */
export async function fetchWeather(
  lat: number = SHANGHAI_LAT,
  lon: number = SHANGHAI_LON
): Promise<WeatherInput | null> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code&timezone=Asia/Shanghai`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const data = await res.json() as OpenMeteoResponse
    if (!data.current || data.current.temperature_2m == null) return null
    return {
      temperatureC: data.current.temperature_2m,
      humidity: data.current.relative_humidity_2m,
      condition: data.current.weather_code != null
        ? wmoToCondition(data.current.weather_code)
        : undefined
    }
  } catch {
    return null
  }
}

// ── 周期性拉取管理 ──

export class WeatherFetcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private _latest: WeatherInput | null = null
  private fetchedAt = 0
  private readonly intervalMs: number
  private readonly log: (msg: string) => void

  constructor(opts: { intervalMs?: number; log?: (msg: string) => void } = {}) {
    this.intervalMs = opts.intervalMs ?? 600_000  // 默认 10 分钟
    this.log = opts.log ?? (() => {})
  }

  get latest(): WeatherInput | null { return this._latest }
  get ageMs(): number { return this.fetchedAt ? Date.now() - this.fetchedAt : Infinity }

  /** 立即拉一次 + 开始定时拉 */
  start(): void {
    this.refresh()
    this.timer = setInterval(() => this.refresh(), this.intervalMs)
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private async refresh(): Promise<void> {
    const w = await fetchWeather()
    if (w) {
      this._latest = w
      this.fetchedAt = Date.now()
      this.log(`[pulse:weather] ${w.temperatureC}°C ${w.condition ?? ''} humidity=${w.humidity ?? '?'}%`)
    }
  }
}
