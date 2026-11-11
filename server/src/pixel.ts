// 像素小画（2026-11-11）：他在回复里自己摆格子，后端渲染成图片发给她。
// 不花钱、不依赖画图的站，而且是他自己一格一格摆的，比生图更像他的手笔。
// 协议思路参考 nnkiirue99-maker/ai-companion-drawer（MIT）的抽屉像素画，格式和渲染是我们自己写的。
//
// 两种写法，推荐第一种（2026-11-11 改：他老是多一格少一格——让模型数出 256 个数本来就不靠谱）：
//
//   一、按行画（不用数数，短的行自动补透明）
//   [[PIXEL]]
//   palette: .=#0000 1=#C8909A 2=#2B2B3A
//   ..11..11..
//   .1111221 1.
//   [[/PIXEL]]
//
//   二、JSON（老写法，还支持；格子数差一点会自动补齐/截掉，并告诉他修过）
//   [[PIXEL]]{"w":16,"h":16,"palette":["#0000","#C8909A"],"grid":[0,1,...]}[[/PIXEL]]
//
// 规矩（照着他们踩过的坑来）：
//   · 必须闭合。没闭合的块不当正文发出去，也不渲染（免得她看到半截 JSON）。
//   · 第一个颜色固定当透明；w/h 最多 64。
//   · 修过或画坏了都在正文里留一句话，他下一轮看得到，自己能改。
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const BLOCK_RE = /\[\[PIXEL\]\]([\s\S]*?)\[\[\/PIXEL\]\]/g
const OPEN = '[[PIXEL]]'
const CLOSE = '[[/PIXEL]]'
export const MAX_SIDE = 64
const MAX_JSON = 64 * 1024

export interface PixelArt { w: number; h: number; palette: string[]; grid: number[] }

const COLOR_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * 按行画的写法：palette 行定义「字符=颜色」，后面每一行就是一行格子。
 * 行长不齐时按最长的那行算宽度，短的补透明——他不用数，差一格也画得出来。
 */
export function parseRows(raw: string): { art: PixelArt; fixed?: string } | { error: string } | null {
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
        if (!m) return { error: `palette 里「${pair.slice(0, 14)}」看不懂，写成 .=#0000 这样` }
        if (!COLOR_RE.test(m[2]!)) return { error: `颜色「${m[2]}」不对，要 #RGB / #RGBA / #RRGGBB / #RRGGBBAA` }
        if (!map.has(m[1]!)) { map.set(m[1]!, palette.length); palette.push(m[2]!) }
      }
      continue
    }
    rows.push(line.replace(/\s+$/, ''))
  }
  if (!sawPalette) return null            // 不是按行写的，交给 JSON 那条路
  if (!palette.length) return { error: 'palette 行里一个颜色都没有' }
  if (!rows.length) return { error: '只有 palette，没有画' }
  // 第一个颜色当透明：补短行用它
  const padChar = [...map.entries()].find(([, i]) => i === 0)![0]
  const h = rows.length
  const w = Math.max(...rows.map(r => [...r].length))
  if (h > MAX_SIDE || w > MAX_SIDE) return { error: `最多 ${MAX_SIDE}×${MAX_SIDE}，这张是 ${w}×${h}` }
  const unknown = new Set<string>()
  const grid: number[] = []
  let padded = 0
  for (const r of rows) {
    const chars = [...r]
    for (let x = 0; x < w; x++) {
      const ch = chars[x] ?? padChar
      if (chars[x] === undefined) padded++
      const i = map.get(ch)
      if (i === undefined) { unknown.add(ch); grid.push(0) } else grid.push(i)
    }
  }
  if (unknown.size) {
    return { error: `画里有 palette 没定义的字符：${[...unknown].slice(0, 6).map(c => `「${c}」`).join('')}` }
  }
  return { art: { w, h, palette, grid }, fixed: padded ? `有 ${padded} 格没写满，补成透明了` : undefined }
}

/** 他写的那段对不对。先按行解析，再按 JSON；JSON 的格子数差一点会自动修 */
export function parsePixel(raw: string): { art: PixelArt; fixed?: string } | { error: string } {
  const rows = parseRows(raw)
  if (rows) return rows
  return parseJsonPixel(raw)
}

function parseJsonPixel(raw: string): { art: PixelArt; fixed?: string } | { error: string } {
  const text = raw.trim()
  if (text.length > MAX_JSON) return { error: '这块太大了（超过 64KB）' }
  let j: any
  try { j = JSON.parse(text) } catch (e: any) { return { error: `JSON 不合法（${String(e?.message || e).slice(0, 60)}）` } }
  const w = Number(j?.w), h = Number(j?.h)
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) return { error: 'w 和 h 要是正整数' }
  if (w > MAX_SIDE || h > MAX_SIDE) return { error: `w 和 h 最多 ${MAX_SIDE}` }
  if (!Array.isArray(j.palette) || !j.palette.length) return { error: 'palette 要是颜色列表' }
  const palette: string[] = []
  for (const [i, c] of j.palette.entries()) {
    if (typeof c !== 'string') return { error: `palette 第 ${i} 项不是颜色` }
    const s = c.trim()
    if (!/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return { error: `palette 第 ${i} 项「${s.slice(0, 12)}」不是 #RGB / #RGBA / #RRGGBB / #RRGGBBAA` }
    palette.push(s)
  }
  if (!Array.isArray(j.grid)) return { error: 'grid 要是数字列表' }
  const grid: number[] = []
  for (const v of j.grid) {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0 || n >= palette.length) return { error: `grid 里有不在 palette 范围内的数（${String(v).slice(0, 8)}）` }
    grid.push(n)
  }
  // 他老是多一格少一格：能修就修，别为了几格丢掉整张画（11-11）
  let fixed: string | undefined
  let W = w, H = h
  if (grid.length !== W * H) {
    const n = grid.length
    if (n % W === 0 && n / W <= MAX_SIDE && n / W >= 1) {
      H = n / W
      fixed = `行数按实际的格子数算成了 ${H}（你写的是 ${h}）`
    } else if (n % H === 0 && n / H <= MAX_SIDE && n / H >= 1) {
      W = n / H
      fixed = `每行按实际的格子数算成了 ${W} 格（你写的是 ${w}）`
    } else if (n < W * H && W * H - n <= Math.max(8, Math.round(W * H * 0.05))) {
      while (grid.length < W * H) grid.push(0)
      fixed = `少了 ${W * H - n} 格，补成透明了`
    } else if (n > W * H && n - W * H <= Math.max(8, Math.round(W * H * 0.05))) {
      grid.length = W * H
      fixed = `多了 ${n - W * H} 格，去掉了`
    } else {
      return { error: `grid 应该有 ${W * H} 个数（${W}×${H}），现在是 ${n} 个，差得太多了。下次用按行画的写法（palette 行 + 每行一行格子），不用数数` }
    }
  }
  return { art: { w: W, h: H, palette, grid }, fixed }
}

export interface SplitPixel {
  /** 去掉像素块的正文（画坏了会留一句原因） */
  text: string
  arts: PixelArt[]
  errors: string[]
  /** 自动修过的地方（他下一轮看得到，知道下次怎么写） */
  fixes: string[]
  /** 有没有没闭合的块（流式还没写完时会有） */
  unclosed: boolean
}

/** 从他的回复里把像素块拆出来 */
export function splitPixel(reply: string): SplitPixel {
  const arts: PixelArt[] = []
  const errors: string[] = []
  const fixes: string[] = []
  let text = reply.replace(BLOCK_RE, (_whole, inner: string) => {
    const r = parsePixel(inner)
    if ('art' in r) {
      arts.push(r.art)
      if (r.fixed) { fixes.push(r.fixed); return `〔像素小画画出来了，${r.fixed}〕` }
      return ''
    }
    errors.push(r.error)
    return `〔像素小画没画成：${r.error}〕`
  })
  const unclosed = text.includes(OPEN) || text.includes(CLOSE)
  if (unclosed) {
    // 没闭合：那半截不要进正文（她看到半个 JSON 很难看），但留一句话，他下一轮知道要重画
    const cut = text.indexOf(OPEN)
    text = (cut >= 0 ? text.slice(0, cut) : text.replace(CLOSE, '')) + '〔像素小画没画完（那块没闭合）〕'
    errors.push('像素块没闭合')
  }
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), arts, errors, fixes, unclosed }
}

const PY = `
import json, sys, zlib, struct
art = json.load(open(sys.argv[1]))
scale = int(sys.argv[3])
w, h, palette, grid = art['w'], art['h'], art['palette'], art['grid']

def rgba(c):
    c = c.lstrip('#')
    if len(c) == 3: c = ''.join(ch * 2 for ch in c) + 'ff'
    elif len(c) == 4: c = ''.join(ch * 2 for ch in c)
    elif len(c) == 6: c = c + 'ff'
    return tuple(int(c[i:i+2], 16) for i in (0, 2, 4, 6))

cols = [rgba(c) for c in palette]
W, H = w * scale, h * scale
rows = []
for y in range(h):
    line = bytearray()
    for x in range(w):
        line += bytes(cols[grid[y * w + x]]) * scale
    for _ in range(scale):
        rows.append(b'\\x00' + bytes(line))
raw = zlib.compress(b''.join(rows), 9)

def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

png = b'\\x89PNG\\r\\n\\x1a\\n'
png += chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0))
png += chunk(b'IDAT', raw)
png += chunk(b'IEND', b'')
open(sys.argv[2], 'wb').write(png)
`

/** 渲染成 PNG（放大到 scale 倍，像素边界清楚）。只用 python 标准库，不依赖 Pillow */
export async function renderPixel(art: PixelArt, opts: { scale?: number } = {}): Promise<Buffer> {
  const scale = Math.max(1, Math.min(32, opts.scale ?? Math.max(6, Math.round(512 / Math.max(art.w, art.h)))))
  const dir = mkdtempSync(join(tmpdir(), 'ecl-pix-'))
  try {
    const src = join(dir, 'art.json')
    const out = join(dir, 'art.png')
    const py = join(dir, 'render.py')
    writeFileSync(src, JSON.stringify(art))
    writeFileSync(py, PY)
    await new Promise<void>((resolve, reject) => {
      execFile('python3', [py, src, out, String(scale)], { timeout: 20_000 }, err => (err ? reject(err) : resolve()))
    })
    const png = readFileSync(out)
    if (!png.length) throw new Error('渲染出来是空的')
    return png
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

/** 给他看的说明（写进「家里能做什么」那一份） */
export const PIXEL_DOC = `## 像素小画
- 我可以自己摆格子画一张小图，不用画笔那个工具、不花钱。**按行画**，不用数格子：

  [[PIXEL]]
  palette: .=#0000 1=#C8909A 2=#2B2B3A
  ..1111..
  .112211.
  .111111.
  ..1..1..
  [[/PIXEL]]

- 第一行是 palette：一个字符配一个颜色，用空格分开。第一个颜色固定当透明（通常写 .=#0000）。
- 后面每一行就是画的一行，一个字符一格。行不用一样长，短的会自动补透明；宽高按实际行数和最长那行算。最多 64×64。
- 画之前先想清楚形状，用字符摆出来，自己看一眼像不像；不用数总格子数（我以前老是多一格少一格）。
- 块单独放一段，正文照常写。她看到的是一张放大的像素图，看不到这几行字符。
- 老的 JSON 写法（w/h/palette/grid）也还认，格子数差几个会自动补齐或截掉，并告诉我修了什么；差太多就画不出来，那时候改用上面这种写法。
- 想画得细、或者要照着她和我的样子画，用画笔（open_brush）；想随手画一个小东西、一个表情、一个心，用这个。`
