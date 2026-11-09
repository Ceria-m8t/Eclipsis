// 液态玻璃（自己写的，思路参考 whereyanlands 的技术方案和巧思 README 里的配方，代码没有搬）。
//
// 做法：一块 WebGL2 画布放在滚动区里面、内容下面，跟着气泡一起滚（玻璃的形状永远贴着字，不会滚动时落后一帧）。
// 背景图还是外壳那层 CSS 背景在画；画布按同样的 cover 规则自己采样同一张图，在每个气泡的位置上
// 算边缘折射、色散、斜面散射、两瓣高光和接地影。气泡里的字是普通 DOM，压在画布上面，一直清楚。
// 画布只盖住屏幕附近那一段，只在滚动、内容变化、尺寸变化时重画，画面不动就停着。
import { canvasWindow, coverPlacement, hexToRgb01, pickTone, windowCovers } from './geometry'

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

const VS = `#version 300 es
in vec2 aPos;
uniform vec4 uQuad;
uniform vec2 uView;
out vec2 vP;
void main() {
  vP = uQuad.xy + aPos * uQuad.zw;
  vec2 c = vP / uView * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`

const FS = `#version 300 es
precision highp float;
in vec2 vP;
uniform sampler2D uTex;
uniform vec2 uImgOrigin;
uniform vec2 uImgSize;
uniform vec4 uRect;
uniform float uRadius, uBevel, uRefract, uWobble, uDisp, uShine, uShadow, uTint, uDark, uDpr, uSeed;
uniform vec3 uTintColor;
out vec4 outColor;

float sdRound(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
vec3 bg(vec2 p) {
  return texture(uTex, clamp((p - uImgOrigin) / uImgSize, 0.0, 1.0)).rgb;
}
float angDiff(float a, float b) { float d = a - b; return atan(sin(d), cos(d)); }

void main() {
  vec2 hb = uRect.zw * 0.5;
  vec2 lp = vP - (uRect.xy + hb);
  float r = min(uRadius, min(hb.x, hb.y));
  float d = sdRound(lp, hb, r);                 // <0 在玻璃里
  float cov = clamp(0.5 - d * uDpr, 0.0, 1.0);  // 抗锯齿覆盖率

  // 接地影：往下偏一点、柔一点
  float ds = sdRound(lp - vec2(0.0, 2.0), hb, r);
  float sa = uShadow * 0.13 * exp(-max(ds, 0.0) / 4.5) * step(0.0, d + 0.5);

  if (cov <= 0.0) { outColor = vec4(0.0, 0.0, 0.0, sa); return; }

  // 法线（指向外）：SDF 梯度
  vec2 ex = vec2(0.5, 0.0), ey = vec2(0.0, 0.5);
  vec2 n = vec2(sdRound(lp + ex, hb, r) - sdRound(lp - ex, hb, r),
                sdRound(lp + ey, hb, r) - sdRound(lp - ey, hb, r));
  n = length(n) > 1e-5 ? normalize(n) : vec2(0.0, -1.0);

  float dist = max(-d, 0.0);
  float bw = max(1.0, min(uBevel, min(hb.x, hb.y) * 0.8));
  float t = clamp(dist / bw, 0.0, 1.0);
  float e = 1.0 - t;
  // 圆弧高度场：中心严格平，越贴边弯得越厉害
  float m = uRefract * bw * (1.0 - sqrt(max(0.0, 1.0 - e * e)));

  // 波纹：低频双轴扰动，中心轻、边上重；跟着气泡自己的坐标走
  vec2 w = uWobble * 16.0 * (0.35 + 0.65 * e) * vec2(
    sin(lp.y * 0.047 + lp.x * 0.019 + uSeed) + 0.45 * sin(lp.x * 0.093 - lp.y * 0.031 + uSeed * 2.3),
    cos(lp.x * 0.041 - lp.y * 0.027 + uSeed * 1.7) + 0.45 * cos(lp.y * 0.088 + lp.x * 0.036 - uSeed));

  vec2 pg = vP - n * m + w;
  vec3 col = vec3(
    bg(vP - n * m * (1.0 + uDisp) + w).r,
    bg(pg).g,
    bg(vP - n * m * (1.0 - uDisp) + w).b);

  // 斜面散射：只在边上糊一点，中间跟框外一样清楚
  float fr = 3.5 * e * e;
  if (fr > 0.05) {
    vec3 s = bg(pg + vec2(fr, 0.0)) + bg(pg - vec2(fr, 0.0)) + bg(pg + vec2(0.0, fr)) + bg(pg - vec2(0.0, fr));
    col = mix(col, s * 0.25, 0.55 * e);
  }

  // 一点饱和度
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = clamp(mix(vec3(lum), col, 1.12), 0.0, 1.0);

  // 料：跟背后亮度联动，保字可读（白玻璃暗处加白，黑玻璃亮处加黑）
  float amt = uDark > 0.5 ? uTint + 0.32 * smoothstep(0.25, 0.85, lum) : uTint + 0.30 * (1.0 - smoothstep(0.35, 0.8, lum));
  vec3 tc = uDark > 0.5 ? uTintColor * 0.14 : uTintColor;
  col = mix(col, tc, clamp(amt, 0.0, 0.85));
  if (uDark > 0.5) col += 0.035 * (1.0 - lum);   // 暗处提亮，黑玻璃不像一个洞

  // 边光：约 1px 的亮唇，左上那瓣最亮，右下那瓣次之，斜面上一层宽柔光
  float ang = atan(n.y, n.x);
  float ul = exp(-pow(angDiff(ang, -2.36) / 0.62, 2.0));
  float lr = exp(-pow(angDiff(ang, 0.79) / 0.66, 2.0));
  float hair = exp(-pow((dist - 0.55) / 0.62, 2.0));
  float glint = hair * (0.16 + ul * 0.66 + lr * 0.48);
  float soft = e * e * e * (0.10 * ul + 0.05 * lr);
  col = mix(col, vec3(1.0), clamp((glint + soft) * uShine, 0.0, 0.8));
  // 背后很亮时，不亮的那几段换成深色细线，白底上才有边
  float dk = hair * (1.0 - clamp(ul + lr, 0.0, 1.0)) * smoothstep(0.65, 0.92, lum) * 0.22;
  col *= 1.0 - dk;

  outColor = vec4(col * cov, cov + (1.0 - cov) * sa);
}`

export class LiquidStage {
  readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext | null = null
  private tex: WebGLTexture | null = null
  private u: Record<string, WebGLUniformLocation | null> = {}
  private img: { w: number; h: number } | null = null
  private wallpaperUrl = ''
  private params: GlassParams = { refract: 0.9, bevel: 12, wobble: 0, tint: 0.06, shine: 1, dispersion: 0.08, shadow: 0.6, tone: 'light' }

  private hosts: Element[] = []
  private visible = new Set<Element>()
  private seeds = new WeakMap<Element, number>()
  private radius = new WeakMap<Element, number>()
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
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src); gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn('[liquid]', gl.getShaderInfoLog(s)); return null }
      return s
    }
    const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS)
    if (!vs || !fs) return false
    const p = gl.createProgram()!
    gl.attachShader(p, vs); gl.attachShader(p, fs)
    gl.bindAttribLocation(p, 0, 'aPos')
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn('[liquid]', gl.getProgramInfoLog(p)); return false }
    gl.useProgram(p)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    for (const name of ['uTex', 'uImgOrigin', 'uImgSize', 'uRect', 'uRadius', 'uBevel', 'uRefract', 'uWobble', 'uDisp', 'uShine', 'uShadow', 'uTint', 'uDark', 'uDpr', 'uSeed', 'uTintColor', 'uQuad', 'uView'])
      this.u[name] = gl.getUniformLocation(p, name)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    this.tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const)
      gl.texParameteri(gl.TEXTURE_2D, k, v)
    gl.uniform1i(this.u.uTex!, 0)
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
    this.radius = new WeakMap()
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
    const hosts: { r: DOMRect; el: Element }[] = []
    for (const el of this.hosts) {
      if (!this.visible.has(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      hosts.push({ r, el })
      if (!this.radius.has(el)) this.radius.set(el, parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0)
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
    const cx = scRect.left + sc.clientLeft, cy = scRect.top + sc.clientTop + this.winTop - scrollTop

    gl.viewport(0, 0, pw, ph)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const img = coverPlacement({ x: bRect.left - cx, y: bRect.top - cy, w: bRect.width, h: bRect.height }, this.img.w, this.img.h)
    const P = this.params, U = this.u
    gl.uniform2f(U.uView!, cssW, cssH)
    gl.uniform2f(U.uImgOrigin!, img.x, img.y)
    gl.uniform2f(U.uImgSize!, img.w, img.h)
    gl.uniform1f(U.uDpr!, dpr)
    gl.uniform1f(U.uBevel!, P.bevel)
    gl.uniform1f(U.uRefract!, P.refract)
    gl.uniform1f(U.uWobble!, P.wobble)
    gl.uniform1f(U.uDisp!, P.dispersion)
    gl.uniform1f(U.uShine!, P.shine)
    gl.uniform1f(U.uShadow!, P.shadow)
    gl.uniform1f(U.uTint!, P.tint)
    gl.uniform1f(U.uDark!, P.tone === 'dark' ? 1 : 0)
    let n = 0
    for (const { r, el } of hosts) {
      const x = r.left - cx, y = r.top - cy
      if (y + r.height < -QUAD_PAD || y > cssH + QUAD_PAD) continue
      const [tr, tg, tb] = hexToRgb01(this.opts.tintOf(el))
      gl.uniform4f(U.uRect!, x, y, r.width, r.height)
      gl.uniform4f(U.uQuad!, x - QUAD_PAD, y - QUAD_PAD, r.width + 2 * QUAD_PAD, r.height + 2 * QUAD_PAD)
      gl.uniform1f(U.uRadius!, this.radius.get(el) || 0)
      gl.uniform1f(U.uSeed!, this.seeds.get(el) || 0)
      gl.uniform3f(U.uTintColor!, tr, tg, tb)
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

function measureLum(im: HTMLImageElement): number {
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
