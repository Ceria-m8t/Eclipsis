// 液态玻璃（自己写的，思路参考 whereyanlands 的技术方案和巧思 README 里的配方，代码没有搬）。
//
// 做法：一块 WebGL2 画布放在滚动区里面、内容下面，跟着气泡一起滚（玻璃的形状永远贴着字，不会滚动时落后一帧）。
// 背景图还是外壳那层 CSS 背景在画；画布按同样的 cover 规则自己采样同一张图，在每个气泡的位置上
// 算边缘折射、色散、斜面散射、两瓣高光和接地影。气泡里的字是普通 DOM，压在画布上面，一直清楚。
// 画布只盖住屏幕附近那一段，只在滚动、内容变化、尺寸变化时重画，画面不动就停着。
import { canvasWindow, coverPlacement, hexToRgb01, pickTone, windowCovers } from './geometry'
import { buildProgram, newTexture, type Uniforms } from './shader'

export interface GlassParams {
  refract: number     // 边上弯的力度（倍率）
  bevel: number       // 斜面宽度，CSS 像素
  wobble: number      // 整块波纹 0–1（0 = 只有边上弯）
  tint: number        // 料的厚薄 0–0.6
  shine: number       // 高光 0–1.5
  dispersion: number  // 色散 0–0.3
  shadow: number      // 接地影 0–1.5
  tone: 'light' | 'dark'
}

export interface StageOptions {
  scroller: HTMLElement                 // 滚动容器（画布插在它里面）
  backdrop: () => HTMLElement | null    // 画着背景图的那层（用它的位置算 cover）
  selector: string                      // 哪些元素是玻璃
  tintOf: (el: Element) => string       // 这块玻璃的底色（#rrggbb）
  onLost?: () => void                   // WebGL 彻底用不了时（退回 CSS）
}

const MARGIN = 240          // 画布比屏幕上下各多盖这么多
const QUAD_PAD = 14         // 每块玻璃四周多画一圈，放接地影
const MAX_HOSTS = 40
const KEEP_FRAMES = 18      // 一次触发后多画几帧，接住过渡动画


export class LiquidStage {
  readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext | null = null
  private tex: WebGLTexture | null = null
  private u = {} as Uniforms
  private img: { w: number; h: number } | null = null
  private wallpaperUrl = ''
  private params: GlassParams = { refract: 0.9, bevel: 12, wobble: 0, tint: 0.06, shine: 1, dispersion: 0.08, shadow: 0.6, tone: 'light' }

  private hosts: Element[] = []
  private visible = new Set<Element>()
  private seeds = new WeakMap<Element, number>()
  private seedCounter = 0
  private io: IntersectionObserver
  private ro: ResizeObserver
  private mo: MutationObserver
  private raf = 0
  private keep = 0
  private rescanNeeded = true
  private winTop = -1
  private winH = 0
  private lostCount = 0
  private dead = false
  private safety = 0
  private onScroll = () => this.invalidate()
  private onVis = () => { if (!document.hidden) this.invalidate() }
  /** 最近一次画了几块（调试用） */
  lastDrawn = 0
  /** 背景图平均亮度，0–1 */
  avgLum = 0.6

  private opts: StageOptions

  constructor(opts: StageOptions) {
    this.opts = opts
    const c = document.createElement('canvas')
    c.className = 'liquid-canvas'
    c.setAttribute('aria-hidden', 'true')
    Object.assign(c.style, { position: 'absolute', left: '0', top: '0', zIndex: '-1', pointerEvents: 'none', transformOrigin: '0 0' })
    this.canvas = c
    opts.scroller.insertBefore(c, opts.scroller.firstChild)

    this.io = new IntersectionObserver(entries => {
      for (const e of entries) e.isIntersecting ? this.visible.add(e.target) : this.visible.delete(e.target)
      this.invalidate()
    }, { root: opts.scroller, rootMargin: `${MARGIN}px 0px` })
    this.ro = new ResizeObserver(() => { this.winTop = -1; this.invalidate() })
    this.mo = new MutationObserver(muts => {
      if (muts.some(m => m.type === 'childList')) this.rescanNeeded = true
      this.invalidate()
    })
    this.mo.observe(opts.scroller, { childList: true, subtree: true, characterData: true })
    this.ro.observe(opts.scroller)
    opts.scroller.addEventListener('scroll', this.onScroll, { passive: true })
    window.addEventListener('resize', this.onScroll)
    document.addEventListener('visibilitychange', this.onVis)
    c.addEventListener('webglcontextlost', e => { e.preventDefault(); this.gl = null; this.lostCount++ })
    c.addEventListener('webglcontextrestored', () => {
      if (this.lostCount > 3) return this.fail()
      if (this.initGl() && this.wallpaperUrl) this.setWallpaper(this.wallpaperUrl, true)
    })
    // 保底：每 2 秒画一次（防漏掉的变化，比如过渡动画）
    this.safety = window.setInterval(() => { if (!document.hidden) this.invalidate() }, 2000)
  }

  /** 建 WebGL2；失败返回 false（调用方退回 CSS） */
  initGl(): boolean {
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false })
    if (!gl) return false
    const u = buildProgram(gl)
    if (!u) return false
    this.u = u
    this.tex = newTexture(gl)
    this.gl = gl
    this.winTop = -1
    return true
  }

  /** 换背景图。图片解码失败返回 false */
  async setWallpaper(url: string, force = false): Promise<boolean> {
    if (!force && url === this.wallpaperUrl && this.img) return true
    this.wallpaperUrl = url
    const im = new Image()
    im.decoding = 'async'
    im.src = url
    try { await im.decode() } catch { return false }
    if (url !== this.wallpaperUrl || !this.gl) return false
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im)
    this.img = { w: im.naturalWidth, h: im.naturalHeight }
    this.avgLum = measureLum(im)
    this.invalidate()
    return true
  }

  /** 自动明暗时用：按背景图亮度给出 light / dark */
  autoTone(): 'light' | 'dark' { return pickTone(this.avgLum) }

  setParams(p: GlassParams) { this.params = { ...p }; this.invalidate() }

  invalidate() {
    if (this.dead) return
    this.keep = KEEP_FRAMES
    if (!this.raf) this.raf = requestAnimationFrame(this.frame)
  }

  private frame = () => {
    this.raf = 0
    if (this.dead || document.hidden) return
    this.draw()
    if (--this.keep > 0) this.raf = requestAnimationFrame(this.frame)
  }

  private rescan() {
    this.rescanNeeded = false
    const list = Array.from(this.opts.scroller.querySelectorAll(this.opts.selector))
    const same = list.length === this.hosts.length && list.every((el, i) => el === this.hosts[i])
    if (same) return
    // 先 disconnect 再 observe：IntersectionObserver 会抓着离开 DOM 的节点
    this.io.disconnect(); this.ro.disconnect()
    this.ro.observe(this.opts.scroller)
    this.visible.clear()
    for (const el of list) {
      this.io.observe(el); this.ro.observe(el)
      if (!this.seeds.has(el)) this.seeds.set(el, (this.seedCounter++ * 2.399) % 6.283)
    }
    this.hosts = list
  }

  private draw() {
    const gl = this.gl
    if (!gl || !this.img) return
    if (this.rescanNeeded) this.rescan()
    const sc = this.opts.scroller
    const back = this.opts.backdrop()
    if (!back) return

    // ---- 先读 ----
    const scrollTop = sc.scrollTop, clientH = sc.clientHeight, clientW = sc.clientWidth
    const last = lastContentChild(sc, this.canvas)
    const contentH = last ? (last as HTMLElement).offsetTop + (last as HTMLElement).offsetHeight : clientH
    const scRect = sc.getBoundingClientRect()
    const bRect = back.getBoundingClientRect()
    const hosts: { r: DOMRect; el: Element; radii: number[] }[] = []
    for (const el of this.hosts) {
      if (!this.visible.has(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      // 气泡四个角不一样（同一组里挨着的那侧是小角），新消息进来时会变，每次都读
      const cs = getComputedStyle(el)
      hosts.push({ r, el, radii: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(v => parseFloat(v) || 0) })
      if (hosts.length >= MAX_HOSTS) break
    }

    // ---- 再写 ----
    if (this.winTop < 0 || !windowCovers(this.winTop, this.winH, scrollTop, clientH, contentH, MARGIN) || this.winTop + this.winH > Math.max(contentH, clientH)) {
      const w = canvasWindow(scrollTop, clientH, contentH, MARGIN)
      this.winTop = w.top; this.winH = w.height
      this.canvas.style.transform = `translate3d(0, ${w.top}px, 0)`
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cssW = clientW, cssH = this.winH
    const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr)
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw; this.canvas.height = ph
      this.canvas.style.width = cssW + 'px'; this.canvas.style.height = cssH + 'px'
    }
    // 画布左上角在屏幕上的位置（不再读 DOM：滚动区左上 + 画布在内容里的偏移 - 滚动量）
    const cx = scRect.left + sc.clientLeft - sc.scrollLeft, cy = scRect.top + sc.clientTop + this.winTop - scrollTop

    gl.viewport(0, 0, pw, ph)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const img = coverPlacement({ x: bRect.left - cx, y: bRect.top - cy, w: bRect.width, h: bRect.height }, this.img.w, this.img.h)
    const P = this.params, U = this.u
    gl.uniform2f(U.uView, cssW, cssH)
    gl.uniform2f(U.uImgOrigin, img.x, img.y)
    gl.uniform2f(U.uImgSize, img.w, img.h)
    gl.uniform1f(U.uDpr, dpr)
    gl.uniform1f(U.uBevel, P.bevel)
    gl.uniform1f(U.uRefract, P.refract)
    gl.uniform1f(U.uWobble, P.wobble)
    gl.uniform1f(U.uDisp, P.dispersion)
    gl.uniform1f(U.uShine, P.shine)
    gl.uniform1f(U.uShadow, P.shadow)
    gl.uniform1f(U.uTint, P.tint)
    gl.uniform1f(U.uDark, P.tone === 'dark' ? 1 : 0)
    let n = 0
    for (const { r, el, radii } of hosts) {
      const x = r.left - cx, y = r.top - cy
      if (y + r.height < -QUAD_PAD || y > cssH + QUAD_PAD) continue
      const [tr, tg, tb] = hexToRgb01(this.opts.tintOf(el))
      gl.uniform4f(U.uRect, x, y, r.width, r.height)
      gl.uniform4f(U.uQuad, x - QUAD_PAD, y - QUAD_PAD, r.width + 2 * QUAD_PAD, r.height + 2 * QUAD_PAD)
      gl.uniform4f(U.uRadii, radii[0]!, radii[1]!, radii[2]!, radii[3]!)
      gl.uniform1f(U.uSeed, this.seeds.get(el) || 0)
      gl.uniform3f(U.uTintColor, tr, tg, tb)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      n++
    }
    this.lastDrawn = n
  }

  private fail() {
    this.destroy()
    this.opts.onLost?.()
  }

  destroy() {
    if (this.dead) return
    this.dead = true
    cancelAnimationFrame(this.raf)
    clearInterval(this.safety)
    this.io.disconnect(); this.ro.disconnect(); this.mo.disconnect()
    this.opts.scroller.removeEventListener('scroll', this.onScroll)
    window.removeEventListener('resize', this.onScroll)
    document.removeEventListener('visibilitychange', this.onVis)
    const ext = this.gl?.getExtension('WEBGL_lose_context')
    ext?.loseContext()
    this.canvas.remove()
  }
}

function lastContentChild(sc: Element, skip: Element): Element | null {
  let el = sc.lastElementChild
  while (el && (el === skip || getComputedStyle(el).position === 'absolute')) el = el.previousElementSibling
  return el
}

export function measureLum(im: HTMLImageElement): number {
  try {
    const c = document.createElement('canvas')
    c.width = 24; c.height = 24
    const x = c.getContext('2d', { willReadFrequently: true })!
    x.drawImage(im, 0, 0, 24, 24)
    const d = x.getImageData(0, 0, 24, 24).data
    let s = 0
    for (let i = 0; i < d.length; i += 4) s += (0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!) / 255
    return s / (d.length / 4)
  } catch { return 0.6 }
}
