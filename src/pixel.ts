// 像素小画（2026-11-11）：他在回复里摆格子，前端边流边把那段藏起来，并在本地画成图立刻显示。
// 后端也会渲染一份存进记录（server/src/pixel.ts），所以刷新后看到的是同一张。
const OPEN = '[[PIXEL]]'
const CLOSE = '[[/PIXEL]]'
const BLOCK = /\[\[PIXEL\]\]([\s\S]*?)\[\[\/PIXEL\]\]/g
const MAX_SIDE = 64

export interface PixelArt { w: number; h: number; palette: string[]; grid: number[] }

export function parsePixel(raw: string): PixelArt | null {
  try {
    const j = JSON.parse(raw.trim())
    const w = Number(j?.w), h = Number(j?.h)
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE) return null
    if (!Array.isArray(j.palette) || !j.palette.length || !Array.isArray(j.grid) || j.grid.length !== w * h) return null
    const palette = j.palette.map((c: unknown) => String(c))
    const grid = j.grid.map((v: unknown) => Number(v))
    if (grid.some((n: number) => !Number.isInteger(n) || n < 0 || n >= palette.length)) return null
    return { w, h, palette, grid }
  } catch { return null }
}

/**
 * 从他的回复里拆出像素小画。
 * 流式写到一半（还没闭合）时把那半截藏掉，她不会看到半个 JSON。
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
      if (/^#(0000|00000000)$/i.test(color)) continue      // 第 0 项是透明
      ctx.fillStyle = color
      ctx.fillRect(x * scale, y * scale, scale, scale)
    }
  }
  return canvas.toDataURL('image/png')
}
