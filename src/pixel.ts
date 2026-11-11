// 像素小画（2026-11-11）：他在回复里摆格子，前端边流边把那段藏起来，并在本地画成图立刻显示。
// 后端也会渲染一份存进记录（server/src/pixel.ts），所以刷新后看到的是同一张。
// 两种写法要和后端一致：按行画（推荐，不用数格子）和老的 JSON。
const OPEN = '[[PIXEL]]'
const CLOSE = '[[/PIXEL]]'
const BLOCK = /\[\[PIXEL\]\]([\s\S]*?)\[\[\/PIXEL\]\]/g
const MAX_SIDE = 64
const COLOR_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export interface PixelArt { w: number; h: number; palette: string[]; grid: number[] }

/** 按行画：palette 行 + 每行一行格子，短行补透明 */
function parseRows(raw: string): PixelArt | null {
  const lines = raw.replace(/\r/g, '').split('\n')
  const map = new Map<string, number>()
  const palette: string[] = []
  const rows: string[] = []
  let sawPalette = false
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    const pal = /^palette\s*[:：]\s*(.+)$/i.exec(t)
    if (pal) {
      sawPalette = true
      for (const pair of pal[1]!.split(/[\s,，]+/).filter(Boolean)) {
        const m = /^(\S)\s*=\s*(#[0-9a-fA-F]{3,8})$/.exec(pair)
        if (!m || !COLOR_RE.test(m[2]!)) return null
        if (!map.has(m[1]!)) { map.set(m[1]!, palette.length); palette.push(m[2]!) }
      }
      continue
    }
    rows.push(line.replace(/\s+$/, ''))
  }
  if (!sawPalette || !palette.length || !rows.length) return null
  const h = rows.length
  const w = Math.max(...rows.map(r => [...r].length))
  if (h > MAX_SIDE || w > MAX_SIDE) return null
  const grid: number[] = []
  for (const r of rows) {
    const chars = [...r]
    for (let x = 0; x < w; x++) {
      const i = chars[x] === undefined ? 0 : map.get(chars[x]!)
      if (i === undefined) return null
      grid.push(i)
    }
  }
  return { w, h, palette, grid }
}

/** 老的 JSON 写法；格子数差几个自动补齐/截掉（和后端一个规矩） */
function parseJson(raw: string): PixelArt | null {
  try {
    const j = JSON.parse(raw.trim())
    let w = Number(j?.w), h = Number(j?.h)
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE) return null
    if (!Array.isArray(j.palette) || !j.palette.length || !Array.isArray(j.grid)) return null
    const palette = j.palette.map((c: unknown) => String(c))
    const grid = j.grid.map((v: unknown) => Number(v))
    if (grid.some((n: number) => !Number.isInteger(n) || n < 0 || n >= palette.length)) return null
    if (grid.length !== w * h) {
      const n = grid.length
      if (n % w === 0 && n / w <= MAX_SIDE) h = n / w
      else if (n % h === 0 && n / h <= MAX_SIDE) w = n / h
      else if (n < w * h && w * h - n <= Math.max(8, Math.round(w * h * 0.05))) { while (grid.length < w * h) grid.push(0) }
      else if (n > w * h && n - w * h <= Math.max(8, Math.round(w * h * 0.05))) grid.length = w * h
      else return null
    }
    return { w, h, palette, grid }
  } catch { return null }
}

export const parsePixel = (raw: string): PixelArt | null => parseRows(raw) ?? parseJson(raw)

/**
 * 从他的回复里拆出像素小画。
 * 流式写到一半（还没闭合）时把那半截藏掉，她不会看到半个 JSON 或者半张画。
 */
export function splitPixel(text: string): { text: string; arts: PixelArt[] } {
  if (!text.includes(OPEN) && !text.includes(CLOSE)) return { text, arts: [] }
  const arts: PixelArt[] = []
  let out = text.replace(BLOCK, (_w, inner: string) => {
    const art = parsePixel(inner)
    if (art) { arts.push(art); return '' }
    return '〔像素小画没画成〕'
  })
  const cut = out.indexOf(OPEN)
  if (cut >= 0) out = out.slice(0, cut)          // 还没写完那块：先不显示
  out = out.split(CLOSE).join('')
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), arts }
}

/** 画成 dataURL（放大到长边约 320，保持像素边界清楚） */
export function renderPixel(art: PixelArt, maxSide = 320): string {
  const scale = Math.max(1, Math.floor(maxSide / Math.max(art.w, art.h)))
  const canvas = document.createElement('canvas')
  canvas.width = art.w * scale
  canvas.height = art.h * scale
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  for (let y = 0; y < art.h; y++) {
    for (let x = 0; x < art.w; x++) {
      const color = art.palette[art.grid[y * art.w + x]!]!
      if (/^#(0000|00000000)$/i.test(color)) continue      // 第一个颜色当透明
      ctx.fillStyle = color
      ctx.fillRect(x * scale, y * scale, scale, scale)
    }
  }
  return canvas.toDataURL('image/png')
}
