// 全站液态玻璃：页面上所有 .glass / .glass-strong / .glass-btn / [data-glass] 都画成水波玻璃。
//
// 做法：一个共用的 WebGL2 上下文（不挂在页面上），每块玻璃里塞一块 2D 小画布（垫在内容下面）。
// 玻璃背后是哪张图，由标了 [data-glass-backdrop] 的元素决定（外壳渐变、聊天背景图、房间底图、书页……），
// 按那张图在屏幕上的实际位置采样 → 着色器算折射/高光 → 拷进这块玻璃的小画布。
// 压在内容上面的玻璃（顶栏、输入栏、底栏、弹出面板）只弯背景图，底下滚过的内容会被挡住（Erica 定的 A）。
// 画面不动就不画；位置、大小、背景都没变的玻璃跳过。没有 WebGL2 时什么都不改，CSS 磨砂照旧。
//
// 以后新加的面板：只要用 .glass 这几个类或加 data-glass，就自动是玻璃，不用另写。
// 不想要玻璃的：加 .liq-skip。textarea/input 里塞不了画布，要套一层 div.glass。
import { ref } from 'vue'
import { coverPlacement, type Box } from './geometry'
import { buildProgram, newTexture, type Uniforms } from './shader'

const HOST_SEL = '.glass, .glass-strong, .glass-btn, [data-glass]'
const SKIP_SEL = 'textarea, input, select, .bubble, .liq-skip'
const BACK_SEL = '[data-glass-backdrop]'
const KEY = 'eclipsis-liquid'
const MARGIN = 160          // 超出屏幕这么多以内的部分也画（滚动时不露白）
const WIN_STEP = 128        // 高玻璃只画看得见的那段，按这个步长取整，免得每帧改画布尺寸

/** 水波（参考图一，Erica 选的）：全站统一 */
const P = { refract: 1.5, bevel: 22, wobble: 0.7, tint: 0.04, shine: 1.1, dispersion: 0.14 }

function loadEnabled(): boolean {
  try { return localStorage.getItem(KEY) !== '0' } catch { return true }
}
/** 用户开关（设置 → 外观） */
export const liquidEnabled = ref(loadEnabled())
/** 真的在画（开关开着且设备支持） */
export const liquidActive = ref(false)

interface Tex { tex: WebGLTexture; w: number; h: number; lum: Float32Array; ready: boolean; used: number }
interface HostState { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; key: string; seed: number }
interface Back { el: Element; clip: Box; place: Box; tex: Tex }

let gl: WebGL2RenderingContext | null = null
let U: Uniforms | null = null
let glCanvas: HTMLCanvasElement | null = null
const texCache = new Map<string, Tex>()
const states = new Map<HTMLElement, HostState>()
let seedCounter = 0
let rescanNeeded = true
let raf = 0
let activeUntil = 0
let started = false
let mo: MutationObserver | null = null
let safety = 0
let lostCount = 0

// ---------------- 启动 / 开关 ----------------

export function startGlobalGlass() {
  if (started) return
  started = true
  if (liquidEnabled.value) enable()
}

export function setLiquidEnabled(on: boolean) {
  liquidEnabled.value = on
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch {}
  on ? enable() : disable()
}

function enable() {
  if (gl) return
  glCanvas = document.createElement('canvas')
  const ctx = glCanvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true })
  if (!ctx) { glCanvas = null; return }
  const u = buildProgram(ctx)
  if (!u) { glCanvas = null; return }
  gl = ctx; U = u
  glCanvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lostCount++; teardownHosts(); gl = null; texCache.clear() })
  glCanvas.addEventListener('webglcontextrestored', () => {
    if (lostCount > 3 || !glCanvas) return
    const c = glCanvas.getContext('webgl2') as WebGL2RenderingContext | null
    const u2 = c && buildProgram(c)
    if (c && u2) { gl = c; U = u2; rescanNeeded = true; poke(800) }
  })
  liquidActive.value = true
  document.documentElement.classList.add('liq-on')
  mo = new MutationObserver(muts => {
    for (const m of muts) if (m.type === 'childList' || m.type === 'attributes') { rescanNeeded = true; break }
    poke(400)
  })
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-glass', 'data-glass-backdrop', 'src', 'style'] })
  const opts = { capture: true, passive: true } as const
  document.addEventListener('scroll', onScroll, opts)
  window.addEventListener('resize', onShort)
  window.visualViewport?.addEventListener('resize', onShort)
  document.addEventListener('pointerdown', onLong, opts)
  document.addEventListener('pointermove', onShort, opts)
  document.addEventListener('pointerup', onLong, opts)
  document.addEventListener('transitionrun', onLong, opts)
  document.addEventListener('animationstart', onLong, opts)
  document.addEventListener('load', onShort, opts)     // 图片加载完（load 不冒泡，捕获阶段能收到）
  document.addEventListener('visibilitychange', onShort)
  safety = window.setInterval(() => poke(60), 1500)
  poke(1000)
}

function disable() {
  cancelAnimationFrame(raf); raf = 0
  clearInterval(safety)
  mo?.disconnect(); mo = null
  const opts = { capture: true } as const
  document.removeEventListener('scroll', onScroll, opts)
  window.removeEventListener('resize', onShort)
  window.visualViewport?.removeEventListener('resize', onShort)
  document.removeEventListener('pointerdown', onLong, opts)
  document.removeEventListener('pointermove', onShort, opts)
  document.removeEventListener('pointerup', onLong, opts)
  document.removeEventListener('transitionrun', onLong, opts)
  document.removeEventListener('animationstart', onLong, opts)
  document.removeEventListener('load', onShort, opts)
  document.removeEventListener('visibilitychange', onShort)
  teardownHosts()
  for (const t of texCache.values()) gl?.deleteTexture(t.tex)
  texCache.clear()
  gl?.getExtension('WEBGL_lose_context')?.loseContext()
  gl = null; U = null; glCanvas = null
  liquidActive.value = false
  document.documentElement.classList.remove('liq-on')
}

function teardownHosts() {
  for (const [el, st] of states) { st.canvas.remove(); el.classList.remove('liq-host'); delete el.dataset.glassTone }
  states.clear()
  rescanNeeded = true
}

const onScroll = () => poke(250)
const onShort = () => poke(300)
const onLong = () => poke(1300)

/** 接下来这段时间每帧都看一眼（没变的玻璃会跳过，不费事） */
export function poke(ms = 400) {
  if (!gl) return
  activeUntil = Math.max(activeUntil, performance.now() + ms)
  if (!raf) raf = requestAnimationFrame(tick)
}

function tick() {
  raf = 0
  if (!gl || document.hidden) return
  frame()
  if (performance.now() < activeUntil) raf = requestAnimationFrame(tick)
}

// ---------------- 找玻璃 ----------------

function rescan() {
  rescanNeeded = false
  const found = new Set<HTMLElement>()
  for (const el of document.querySelectorAll<HTMLElement>(HOST_SEL)) {
    if (el.matches(SKIP_SEL) || el.closest('.liq-skip')) continue
    found.add(el)
    let st = states.get(el)
    if (!st) {
      const canvas = document.createElement('canvas')
      canvas.className = 'liq-canvas'
      canvas.setAttribute('aria-hidden', 'true')
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      st = { canvas, ctx, key: '', seed: (seedCounter++ * 2.399) % 6.283 }
      states.set(el, st)
    }
    // Vue 改纯文本内容时会整个替换子节点，画布会被冲掉：放回去
    if (st.canvas.parentNode !== el) { el.insertBefore(st.canvas, el.firstChild); st.key = '' }
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
  }
  for (const [el, st] of states) {
    if (!found.has(el)) { st.canvas.remove(); el.classList.remove('liq-host'); states.delete(el) }
  }
}

// ---------------- 背景 ----------------

function clipRect(el: Element): Box {
  let r = el.getBoundingClientRect()
  let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p)
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      r = p.getBoundingClientRect()
      x0 = Math.max(x0, r.left); y0 = Math.max(y0, r.top); x1 = Math.min(x1, r.right); y1 = Math.min(y1, r.bottom)
    }
    if (cs.position === 'fixed') break
  }
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
}

function collectBacks(): Back[] {
  const out: Back[] = []
  for (const el of document.querySelectorAll(BACK_SEL)) {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    const src = backSource(el, cs, r)
    if (!src) continue
    const tex = getTex(src.key, src.load)
    if (!tex || !tex.ready) continue
    tex.used = performance.now()
    out.push({ el, clip: clipRect(el), place: src.place(tex), tex })
  }
  return out
}

type Source = { key: string; load: () => Promise<TexImageSource | null>; place: (t: Tex) => Box }

function backSource(el: Element, cs: CSSStyleDeclaration, r: DOMRect): Source | null {
  const box = { x: r.left, y: r.top, w: r.width, h: r.height }
  if (el instanceof HTMLImageElement) {
    const url = el.currentSrc || el.src
    if (!url || !el.complete || !el.naturalWidth) return null
    const fit = cs.objectFit
    return {
      key: url,
      load: async () => el,
      place: t => fit === 'cover' ? coverPlacement(box, t.w, t.h) : fit === 'contain' ? containPlacement(box, t.w, t.h) : box,
    }
  }
  const bg = cs.backgroundImage
  const m = /url\(["']?(.*?)["']?\)/.exec(bg)
  if (m && m[1]) {
    const url = m[1]
    return {
      key: url,
      load: () => loadImage(url),
      place: t => cs.backgroundSize === 'contain' ? containPlacement(box, t.w, t.h) : coverPlacement(box, t.w, t.h),
    }
  }
  // 渐变/纯色：按元素大小画一张（大小按 64px 取整，避免键盘弹起时反复重画）
  const w = Math.max(16, Math.round(r.width / 64) * 64), h = Math.max(16, Math.round(r.height / 64) * 64)
  const key = `${bg}|${cs.backgroundColor}|${w}x${h}`
  return { key, load: async () => paintGradient(bg, cs.backgroundColor, w, h), place: () => box }
}

function containPlacement(box: Box, iw: number, ih: number): Box {
  const s = Math.min(box.w / iw, box.h / ih)
  return { x: box.x + (box.w - iw * s) / 2, y: box.y + (box.h - ih * s) / 2, w: iw * s, h: ih * s }
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  const im = new Image()
  im.decoding = 'async'
  im.src = url
  return im.decode().then(() => im, () => null)
}

function getTex(key: string, load: () => Promise<TexImageSource | null>): Tex | null {
  const hit = texCache.get(key)
  if (hit) return hit
  if (!gl) return null
  const t: Tex = { tex: newTexture(gl), w: 1, h: 1, lum: new Float32Array(1).fill(0.6), ready: false, used: performance.now() }
  texCache.set(key, t)
  load().then(src => {
    if (!src || !gl || texCache.get(key) !== t) return
    gl.bindTexture(gl.TEXTURE_2D, t.tex)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
    const s = src as HTMLImageElement | HTMLCanvasElement
    t.w = (s as HTMLImageElement).naturalWidth || s.width
    t.h = (s as HTMLImageElement).naturalHeight || s.height
    t.lum = lumThumb(s)
    t.ready = true
    for (const st of states.values()) st.key = ''
    poke(300)
  })
  // 最多留 6 张，最久没用的先丢
  if (texCache.size > 6) {
    let oldK = '', oldT = Infinity
    for (const [k, v] of texCache) if (v.used < oldT && k !== key) { oldT = v.used; oldK = k }
    const v = texCache.get(oldK)
    if (v) { gl.deleteTexture(v.tex); texCache.delete(oldK) }
  }
  return t
}

const THUMB = 32
function lumThumb(src: CanvasImageSource): Float32Array {
  const out = new Float32Array(THUMB * THUMB).fill(0.6)
  try {
    const c = document.createElement('canvas'); c.width = THUMB; c.height = THUMB
    const x = c.getContext('2d', { willReadFrequently: true })!
    x.drawImage(src, 0, 0, THUMB, THUMB)
    const d = x.getImageData(0, 0, THUMB, THUMB).data
    for (let i = 0; i < out.length; i++) out[i] = (0.2126 * d[i * 4]! + 0.7152 * d[i * 4 + 1]! + 0.0722 * d[i * 4 + 2]!) / 255
  } catch {}
  return out
}

/** 把 CSS linear-gradient（计算后的值）照着 CSS 的几何画到画布上 */
export function paintGradient(bg: string, color: string, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const x = c.getContext('2d')!
  x.fillStyle = color && color !== 'rgba(0, 0, 0, 0)' ? color : '#eef0f5'
  x.fillRect(0, 0, w, h)
  const g = parseLinearGradient(bg)
  if (g) {
    const a = g.angle * Math.PI / 180
    const dx = Math.sin(a), dy = -Math.cos(a)
    const L = Math.abs(w * dx) + Math.abs(h * dy)
    const cx = w / 2, cy = h / 2
    const lg = x.createLinearGradient(cx - dx * L / 2, cy - dy * L / 2, cx + dx * L / 2, cy + dy * L / 2)
    g.stops.forEach((s, i) => { try { lg.addColorStop(s.pos ?? i / Math.max(1, g.stops.length - 1), s.color) } catch {} })
    x.fillStyle = lg
    x.fillRect(0, 0, w, h)
  }
  return c
}

/** 只认第一层 linear-gradient(角度, 颜色 位置%, …)；认不出返回 null */
export function parseLinearGradient(bg: string): { angle: number; stops: { color: string; pos?: number }[] } | null {
  const i = bg.indexOf('linear-gradient(')
  if (i < 0) return null
  let depth = 0, j = i + 'linear-gradient('.length, start = j
  const parts: string[] = []
  for (; j < bg.length; j++) {
    const ch = bg[j]
    if (ch === '(') depth++
    else if (ch === ')') { if (depth === 0) { parts.push(bg.slice(start, j).trim()); break } depth-- }
    else if (ch === ',' && depth === 0) { parts.push(bg.slice(start, j).trim()); start = j + 1 }
  }
  if (!parts.length) return null
  let angle = 180
  const first = parts[0]!
  const deg = /^(-?[\d.]+)deg$/.exec(first)
  const dirs: Record<string, number> = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 }
  if (deg) { angle = parseFloat(deg[1]!); parts.shift() }
  else if (first in dirs) { angle = dirs[first]!; parts.shift() }
  const stops = parts.map(p => {
    const m = /^(.*?)\s+(-?[\d.]+)%$/.exec(p)
    return m ? { color: m[1]!, pos: Math.min(1, Math.max(0, parseFloat(m[2]!) / 100)) } : { color: p }
  })
  return stops.length ? { angle, stops } : null
}

function pickBack(backs: Back[], cx: number, cy: number): Back | null {
  const inside = (c: Box) => cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h
  for (let i = backs.length - 1; i >= 0; i--) if (inside(backs[i]!.clip)) return backs[i]!
  // 还在屏幕外的（房间里没划到的那几块）：按整张图（不裁剪）找，免得先拿外壳渐变画成白的，划进来才变
  for (let i = backs.length - 1; i >= 0; i--) {
    const r = backs[i]!.el.getBoundingClientRect()
    if (inside({ x: r.left, y: r.top, w: r.width, h: r.height })) return backs[i]!
  }
  return backs[0] ?? null
}

function regionLum(t: Tex, place: Box, r: { x: number; y: number; w: number; h: number }): number {
  const u0 = Math.floor(((r.x - place.x) / place.w) * THUMB), u1 = Math.ceil(((r.x + r.w - place.x) / place.w) * THUMB)
  const v0 = Math.floor(((r.y - place.y) / place.h) * THUMB), v1 = Math.ceil(((r.y + r.h - place.y) / place.h) * THUMB)
  let s = 0, n = 0
  for (let v = Math.max(0, v0); v < Math.min(THUMB, Math.max(v1, v0 + 1)); v++)
    for (let u = Math.max(0, u0); u < Math.min(THUMB, Math.max(u1, u0 + 1)); u++) { s += t.lum[v * THUMB + u]!; n++ }
  return n ? s / n : 0.6
}

// ---------------- 画 ----------------

function frame() {
  if (!gl || !U) return
  if (rescanNeeded) rescan()
  if (!states.size) return
  const backs = collectBacks()
  const vh = window.innerHeight
  const dprMax = Math.min(window.devicePixelRatio || 1, 2)
  for (const [el, st] of states) {
    if (!el.isConnected) continue
    const lw = el.offsetWidth, lh = el.offsetHeight
    const r = el.getBoundingClientRect()
    if (lw < 2 || lh < 2 || r.width < 1 || r.height < 1) continue
    const sx = r.width / lw, sy = r.height / lh
    const back = pickBack(backs, r.left + r.width / 2, r.top + r.height / 2)
    if (!back) { if (el.classList.contains('liq-host')) { el.classList.remove('liq-host'); st.key = '' } continue }

    // 这块玻璃要画哪一段（宿主自己能滚动时，画布跟着滚动量走）
    const cs = getComputedStyle(el)
    const scrolls = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight
    let wt: number, wh: number, shapeY: number, canvasTop: number
    if (scrolls) {
      wt = 0; wh = lh; shapeY = 0; canvasTop = el.scrollTop
    } else {
      const vt = Math.min(lh, Math.max(0, (-MARGIN - r.top) / sy))
      const vb = Math.min(lh, Math.max(0, (vh + MARGIN - r.top) / sy))
      if (vb - vt < 1) continue
      wt = Math.floor(vt / WIN_STEP) * WIN_STEP
      wh = Math.min(lh, Math.ceil(vb / WIN_STEP) * WIN_STEP) - wt
      shapeY = -wt; canvasTop = wt
    }

    const lum = regionLum(back.tex, back.place, { x: r.left, y: r.top, w: r.width, h: r.height })
    const tone = lum < 0.45 ? 'dark' : 'light'
    const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(v => parseFloat(v) || 0)
    const radius = radii.join(',')
    const strong = el.classList.contains('glass-strong')
    const key = [r.left, r.top, r.width, r.height].map(v => Math.round(v * 2)).join(',') +
      `|${wt},${wh},${canvasTop}|${texKeyOf(back.tex)}|${back.place.x | 0},${back.place.y | 0},${back.place.w | 0}|${radius}|${tone}|${strong}`
    if (key === st.key) continue
    st.key = key

    // 画布尺寸（太高就降一点清晰度）
    let dpr = dprMax
    if (wh * dpr > 4096) dpr = 4096 / wh
    const pw = Math.max(1, Math.ceil(lw * dpr)), ph = Math.max(1, Math.ceil(wh * dpr))
    const gc = glCanvas!
    if (gc.width < pw || gc.height < ph) { gc.width = Math.max(gc.width, pw); gc.height = Math.max(gc.height, ph) }
    gl.viewport(0, 0, pw, ph)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(0, 0, pw, ph)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // 屏幕坐标 → 这块玻璃自己的坐标（考虑缩放：按下时会缩一点）
    const ox = (back.place.x - r.left) / sx, oy = (back.place.y - r.top) / sy
    const minSide = Math.min(lw, lh)
    const small = Math.min(1, Math.max(0.25, (minSide - 24) / 60))
    gl.bindTexture(gl.TEXTURE_2D, back.tex.tex)
    gl.uniform2f(U.uView, lw, wh)
    gl.uniform4f(U.uQuad, 0, 0, lw, wh)
    gl.uniform4f(U.uRect, 0, shapeY, lw, lh)
    // 画布左上角在宿主里的位置：不滚动的宿主是 wt；能滚动的宿主画布跟着滚动量走，看上去始终在 0
    gl.uniform2f(U.uImgOrigin, ox, scrolls ? oy : oy - wt)
    gl.uniform2f(U.uImgSize, back.place.w / sx, back.place.h / sy)
    gl.uniform1f(U.uDpr, dpr)
    gl.uniform4f(U.uRadii, radii[0]!, radii[1]!, radii[2]!, radii[3]!)
    gl.uniform1f(U.uBevel, Math.min(P.bevel, Math.max(4, minSide * 0.32)))
    gl.uniform1f(U.uRefract, P.refract)
    gl.uniform1f(U.uWobble, P.wobble * small)
    gl.uniform1f(U.uDisp, P.dispersion * small)
    gl.uniform1f(U.uShine, P.shine * (0.6 + 0.4 * small))
    gl.uniform1f(U.uShadow, 0)
    gl.uniform1f(U.uTint, P.tint + (strong ? 0.1 : 0))
    gl.uniform1f(U.uDark, tone === 'dark' ? 1 : 0)
    gl.uniform1f(U.uSeed, st.seed)
    gl.uniform3f(U.uTintColor, 1, 1, 1)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.disable(gl.SCISSOR_TEST)

    const c = st.canvas
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph }
    // 绝对定位从边框里面算起：退回边框宽度，画布才和宿主外沿对齐
    c.style.left = -el.clientLeft + 'px'
    c.style.top = canvasTop - el.clientTop + 'px'
    c.style.width = lw + 'px'
    c.style.height = wh + 'px'
    st.ctx.clearRect(0, 0, pw, ph)
    st.ctx.drawImage(gc, 0, gc.height - ph, pw, ph, 0, 0, pw, ph)
    if (el.dataset.glassTone !== tone) el.dataset.glassTone = tone
    if (!el.classList.contains('liq-host')) el.classList.add('liq-host')
  }
}

const texKeys = new WeakMap<Tex, string>()
let texKeyN = 0
function texKeyOf(t: Tex): string {
  let k = texKeys.get(t)
  if (!k) { k = 't' + texKeyN++; texKeys.set(t, k) }
  return k
}

/** 调试 / 检查脚本用 */
export function liquidDebug() {
  return { active: liquidActive.value, hosts: states.size, drawn: [...states.keys()].filter(e => e.classList.contains('liq-host')).length, textures: texCache.size }
}
;(window as any).__liquid = liquidDebug
