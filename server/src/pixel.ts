// 像素小画（2026-11-11）：他在回复里自己摆格子，后端渲染成图片发给她。
// 不花钱、不依赖画图的站，而且是他自己一格一格摆的，比生图更像他的手笔。
// 协议思路参考 nnkiirue99-maker/ai-companion-drawer（MIT）的抽屉像素画，格式和渲染是我们自己写的。
//
//   [[PIXEL]]{"w":16,"h":16,"palette":["#0000","#C8909A","#2B2B3A"],"grid":[0,1,1,0,...]}[[/PIXEL]]
//
// 规矩（照着他们踩过的坑来）：
//   · 必须闭合。没闭合的块不当正文发出去，也不渲染（免得她看到半截 JSON）。
//   · palette 第 0 项固定透明；grid 长度必须是 w*h；索引必须在 palette 里。
//   · w/h 最多 64。画坏了就在正文里留一句原因，他下一轮看得到，自己能改。
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

/** 他写的那段 JSON 对不对；不对就说原因（这句话会留在正文里，他下一轮看得到） */
export function parsePixel(raw: string): { art: PixelArt } | { error: string } {
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
  if (j.grid.length !== w * h) return { error: `grid 应该有 ${w * h} 个数（${w}×${h}），现在是 ${j.grid.length} 个` }
  const grid: number[] = []
  for (const v of j.grid) {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0 || n >= palette.length) return { error: `grid 里有不在 palette 范围内的数（${String(v).slice(0, 8)}）` }
    grid.push(n)
  }
  return { art: { w, h, palette, grid } }
}

export interface SplitPixel {
  /** 去掉像素块的正文（画坏了会留一句原因） */
  text: string
  arts: PixelArt[]
  errors: string[]
  /** 有没有没闭合的块（流式还没写完时会有） */
  unclosed: boolean
}

/** 从他的回复里把像素块拆出来 */
export function splitPixel(reply: string): SplitPixel {
  const arts: PixelArt[] = []
  const errors: string[] = []
  let text = reply.replace(BLOCK_RE, (_whole, inner: string) => {
    const r = parsePixel(inner)
    if ('art' in r) { arts.push(r.art); return '' }
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
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), arts, errors, unclosed }
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
- 我可以自己摆格子画一张小图，不用画笔那个工具、不花钱。写在回复里：
  [[PIXEL]]{"w":16,"h":16,"palette":["#0000","#C8909A","#2B2B3A"],"grid":[0,1,1,0, …]}[[/PIXEL]]
- w、h 是格子数，1 到 64。palette 是颜色表，第 0 项固定是透明 #0000。grid 有 w×h 个数，从左到右、从上到下，每个数是颜色表的下标。
- 必须写完整、闭合；JSON 里不要省略号、不要注释。画坏了她那边会显示一句原因，我下一轮能看到、可以重画。
- 块单独放一段，正文照常写。她看到的是一张放大的像素图，看不到这段 JSON。
- 想画得细、或者要照着她和我的样子画，用画笔（open_brush）；想随手画一个小东西、一个表情、一个心，用这个。`
