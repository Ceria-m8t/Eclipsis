// 水面（她 2026-11-13 看完 art/mockups/pond2.html 说「应该可以了」的那一版参数）。
//
// 做法：把一块内容先画进离屏画布 → 当成「水下的画面」送进 WebGL2 → 高度场折射它。
// 为什么不用 SVG 置换滤镜：iPhone Safari 上基本不工作（第一版她什么都看不到）。
// 为什么只盖住头部一块、不盖整页：底下那些格子要能点、能滚、要跟着她在设置里换的字体，
// 整页塞进 WebGL 就全废了（样式稿里整页进水是作弊——那一页没有一个能点的东西）。
//
// 水面**不自己动**（她说那张截图是截到了点下去那一瞬间）：没人碰就只有一点点看不见的呼吸，
// 安静一会儿之后连 rAF 都停掉，最后一帧留在屏幕上 —— 水面上还留着手指划过的形状。
//
// ⚠ 改参数之前看 交接-2026-11-13 第 7 条：**波方程有稳定上限**。
// 传播系数 > 0.5 且每帧推多步会自激（她两次看到「一大团」）。要更快只能加密网格 + 多推步数。
// 步数变了阻尼要跟着补（dampFor）。

export const POND = {
  sim: 768,          // 高度场网格；格子更细 → 同样步数里波走过的屏幕距离更远
  steps: 4,          // 每帧推几步
  prop: 0.42,        // 传播系数（≤ 0.5，再大就自激）
  damp: 0.9985,      // 阻尼（4 步用的值，见 dampFor）
  cap: 0.7,          // 幅度封顶，不许长成一大块
  press: 0.2,        // 按下去的力度
  drag: 0.29,        // 划动的力度
  distort: 0.14,     // 折射强度（字跟着晃的幅度）
  caustic: 0.1,      // 焦散
  spec: 0.13,        // 粉蓝色散高光
  blur: 0.9,         // 高度场取样的九点模糊半径（px），形状软下来，不出现清晰同心环
  strokeGap: 5,      // 两次触摸采样之间每隔几 px 补一个落点（连成一道，不是一串圈）
  strokeMax: 24,     // 一次补点上限
  batch: 8,          // 一帧最多落几个点，而且**同一步一起落**
  quietFrames: 260,  // 最后一次碰过之后再推这么多帧（约 4 秒）就进收尾
  floor: 0.0025,     // 高度场地板：小于这个值直接归零，不留残波
  settleFrames: 150, // 收尾：阻尼加重地再推这么多帧，把波压平再停
  settleDamp: 0.955, // 收尾用的阻尼（比平时重得多）
  edgeSoak: 0.06,    // 贴边这一圈额外吃掉一点，免得小块水面被回弹塞满
} as const

/** 传播系数的稳定上限。高于它一定爆，别试。 */
export const PROP_MAX = 0.5

/** 这套参数稳不稳。写在代码里是因为我已经踩爆过两次。 */
export function stable(prop: number = POND.prop, steps: number = POND.steps): boolean {
  return prop > 0 && prop <= PROP_MAX && Number.isInteger(steps) && steps >= 1
}

/**
 * 步数变了，阻尼要跟着补，否则手感会变（她的说法是「平得变快了」）。
 * 每帧推 steps 步 ≈ 每步衰减 base^(baseSteps/steps)。
 */
export function dampFor(steps: number, base = 0.9955, baseSteps = 2): number {
  return Math.pow(base, baseSteps / steps)
}

/** 两次触摸采样之间补点：划得快也是**连着的一道**柔痕。返回不含起点。 */
export function strokePoints(
  x0: number, y0: number, x1: number, y1: number,
  gap: number = POND.strokeGap, max: number = POND.strokeMax,
): Array<[number, number]> {
  const d = Math.hypot(x1 - x0, y1 - y0)
  const n = Math.min(max, Math.max(1, Math.round(d / gap)))
  const out: Array<[number, number]> = []
  for (let i = 1; i <= n; i++) {
    const t = i / n
    out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t])
  }
  return out
}

/** 一帧里的落点太多就隔着取，保留两头（一笔的起止不能丢），顺序不变。 */
export function pickBatch<T>(list: T[], max: number = POND.batch): T[] {
  if (list.length <= max) return list.slice()
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(list[Math.round((i * (list.length - 1)) / (max - 1))]!)
  return out
}

/** 跑不跑得起来（没 WebGL2 或没半浮点就退回不带水的版本）。 */
export function pondSupported(): boolean {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2', { alpha: false, antialias: false })
    if (!gl) return false
    const ok = !!(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'))
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return ok
  } catch {
    return false
  }
}

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0., 1.); }`

const SIM_FS = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D cur, prev; uniform vec2 px; uniform float damp;
uniform vec3 drops[${POND.batch}]; uniform int nDrops;   // xy 位置、z 力度
void main(){
  float c = texture(cur, uv).r, q = texture(prev, uv).r;
  float l = texture(cur, uv + vec2(px.x, 0.)).r + texture(cur, uv - vec2(px.x, 0.)).r
          + texture(cur, uv + vec2(0., px.y)).r + texture(cur, uv - vec2(0., px.y)).r - 4. * c;
  float n = (2. * c - q + ${POND.prop} * l) * damp;
  // 一笔里的所有落点同一步按下去：划得快也是一道，而且不会把模拟推爆
  for (int i = 0; i < ${POND.batch}; i++) {
    if (i >= nDrops) break;
    float d = distance(uv, drops[i].xy);
    n -= drops[i].z * exp(-d * d * 900.);
  }
  // 贴边这一圈多吃掉一点：整屏的时候无所谓，一块头部这么小，回弹会攒成一片乱纹
  float e = min(min(uv.x, 1. - uv.x), min(uv.y, 1. - uv.y));
  n *= mix(0.982, 1.0, clamp(e / ${POND.edgeSoak}, 0., 1.));
  // 地板：小到看不见就直接归零。没有这一条，残波会一直在，
  // 停止绘制那一刻就把干涉条纹冻在屏幕上（她 2026-11-13 看到整页同心圆）。
  if (abs(n) < ${POND.floor}) n = 0.;
  o = vec4(clamp(n, -${POND.cap}, ${POND.cap}), 0., 0., 1.);
}`

const DRAW_FS = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D height, page; uniform vec2 px; uniform float t;
// 糊一点再用：波的形状软下来，不会出现清晰的同心环
float h(vec2 q){
  float s = texture(height, q).r * 0.28;
  s += (texture(height, q + vec2( px.x * ${POND.blur}, 0.)).r + texture(height, q + vec2(-px.x * ${POND.blur}, 0.)).r
      + texture(height, q + vec2(0.,  px.y * ${POND.blur})).r + texture(height, q + vec2(0., -px.y * ${POND.blur})).r) * 0.135;
  s += (texture(height, q + px * ${POND.blur}).r + texture(height, q - px * ${POND.blur}).r
      + texture(height, q + vec2(px.x, -px.y) * ${POND.blur}).r + texture(height, q + vec2(-px.x, px.y) * ${POND.blur}).r) * 0.0445;
  return s;
}
void main(){
  // 水面本身不流，只有一点点极慢的呼吸，几乎看不见
  vec2 breathe = vec2(sin(uv.y * 7.0 + t * 0.12), cos(uv.x * 6.0 - t * 0.1)) * 0.0012;

  float hx = h(uv + vec2(px.x, 0.)) - h(uv - vec2(px.x, 0.));
  float hy = h(uv + vec2(0., px.y)) - h(uv - vec2(0., px.y));
  vec2 n = vec2(hx, hy);

  // 折射：字跟着晃。带上 alpha —— 画布是透明的，底图由底下那层透上来（见 memory-head.ts）
  vec2 q = uv + breathe - n * ${POND.distort};
  vec4 src = texture(page, vec2(q.x, 1.0 - q.y));
  vec3 col = src.rgb;
  float a = src.a;

  // 焦散：波峰处把光聚一点（很淡）
  float lap = h(uv + vec2(px.x, 0.)) + h(uv - vec2(px.x, 0.))
            + h(uv + vec2(0., px.y)) + h(uv - vec2(0., px.y)) - 4. * h(uv);
  col += vec3(0.62, 0.76, 1.0) * clamp(-lap * 8.0, 0.0, 1.0) * ${POND.caustic};

  // 高光：极细一条边，粉蓝色散（和我们的液态玻璃一致）
  vec3 nrm = normalize(vec3(n * 16.0, 1.0));
  float spec = pow(clamp(dot(nrm, normalize(vec3(-0.4, 0.72, 0.56))), 0., 1.), 16.0);
  col += mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.84, 0.92), 0.4) * spec * ${POND.spec};

  // ⚠ 透明处（没有字的地方）**只在真有波的时候**才给一点光。
  // 不设这个门槛的话，焦散和高光会把整块头部染白，底图的细节全没了
  // （量到头部细节掉到 6.56，而卡片区是 10.8）。
  float wave = smoothstep(0.004, 0.02, length(n));
  float light = (clamp(-lap * 8.0, 0.0, 1.0) * ${POND.caustic} + spec * ${POND.spec}) * wave;
  o = vec4(col, max(a, light));
}`

/**
 * 全局那一层用的着色器：**只画波本身**，平的地方完全透明。
 * 为什么不折射：整页是 DOM，没法送进 WebGL。所以这一层画的是水面的高光、焦散和色散，
 * 压在内容上面（pointer-events: none），平静时看不出有东西。字跟着晃只在头部那一块做得到。
 */
const OVERLAY_FS = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D height; uniform vec2 px; uniform float t;
// 和折射那一版一样先糊一道：不糊的话细纹比屏幕像素还细，整页铺开就是摩尔纹
float h(vec2 q){
  float s = texture(height, q).r * 0.28;
  s += (texture(height, q + vec2( px.x * 1.4, 0.)).r + texture(height, q + vec2(-px.x * 1.4, 0.)).r
      + texture(height, q + vec2(0.,  px.y * 1.4)).r + texture(height, q + vec2(0., -px.y * 1.4)).r) * 0.135;
  s += (texture(height, q + px * 1.4).r + texture(height, q - px * 1.4).r
      + texture(height, q + vec2(px.x, -px.y) * 1.4).r + texture(height, q + vec2(-px.x, px.y) * 1.4).r) * 0.0445;
  return s;
}
void main(){
  float hx = h(uv + vec2(px.x, 0.)) - h(uv - vec2(px.x, 0.));
  float hy = h(uv + vec2(0., px.y)) - h(uv - vec2(0., px.y));
  vec2 n = vec2(hx, hy);
  float slope = length(n);
  // 死区放宽：只有明显的波才有光，细碎残波一律当平的
  if (slope < 0.0022) { o = vec4(0.); return; }

  vec3 nrm = normalize(vec3(n * 18.0, 1.0));
  // 光从上面来（她要的：我们在水面之下，光从上面射进来）
  float spec = pow(clamp(dot(nrm, normalize(vec3(-0.30, 0.78, 0.55))), 0., 1.), 26.0);

  float lap = h(uv + vec2(px.x, 0.)) + h(uv - vec2(px.x, 0.))
            + h(uv + vec2(0., px.y)) + h(uv - vec2(0., px.y)) - 4. * h(uv);
  float caustic = clamp(-lap * 10.0, 0., 1.);

  // 色散：斜率方向上冷暖分开（和我们液态玻璃那道粉蓝一致）
  vec2 dir = n / max(slope, 1e-5);
  vec3 tint = mix(vec3(0.66, 0.80, 1.0), vec3(1.0, 0.80, 0.90), clamp(0.5 + dir.x * 0.5, 0., 1.));

  // ⚠ 这一层**只能加光，不能变暗**（她 2026-11-13 在手机上看到一圈黑）。
  // 原来的写法把 slope 也算进 alpha：斜率大的地方 a 很高而颜色接近 0，
  // premultiplied 混合下就等于往页面上抹一层黑 —— 波一大就是一个黑圈。
  // 现在用 additive（ONE, ONE）：输出就是加上去的光，alpha 不参与遮挡。
  float light = spec * 0.95 + caustic * 0.55;
  o = vec4(tint * light * 0.5, 0.);
}`

export interface PondOptions {
  /** 水面盖住它（画布插在它里面，跟着内容一起滚） */
  host: HTMLElement
  /**
   * refract = 把 paint 画的那块内容当水下的画面折射（字跟着晃，只能用在自己画的内容上）；
   * overlay = 只画波本身压在内容上面（整页那一层，DOM 照常能点）。默认 refract。
   */
  mode?: 'refract' | 'overlay'
  /** refract 模式：把要泡进水里的那块内容画进离屏画布（CSS 像素坐标，不用管 DPR；t = 秒，给会动的光用） */
  paint?: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void
  /** 在哪一层听手指（默认 host；头部在滚动区里时传滚动容器，免得抢走滑动） */
  touch?: HTMLElement
  /** WebGL 彻底用不了（上下文丢了拿不回来）时通知外面退回 DOM 版 */
  onLost?: () => void
}

export class Pond {
  readonly canvas: HTMLCanvasElement
  private src = document.createElement('canvas')
  private sctx: CanvasRenderingContext2D | null
  private gl: WebGL2RenderingContext | null = null
  private simP: WebGLProgram | null = null
  private drawP: WebGLProgram | null = null
  private uS: Record<string, WebGLUniformLocation | null> = {}
  private uD: Record<string, WebGLUniformLocation | null> = {}
  private quad: WebGLBuffer | null = null
  private fb: Array<{ tex: WebGLTexture; f: WebGLFramebuffer }> = []
  private pageTex: WebGLTexture | null = null
  private drops: Array<[number, number, number]> = []
  private raf = 0
  private paintTimer = 0
  private hot = 0
  private settle = 0
  private t0 = 0
  private w = 0
  private h = 0
  private dpr = 1
  private drawing = false
  private lx = 0
  private ly = 0
  private dead = false
  private ro: ResizeObserver
  private io: IntersectionObserver
  private onScreen = true
  private opts: PondOptions
  private mode: 'refract' | 'overlay' = 'refract'

  constructor(opts: PondOptions) {
    this.opts = opts
    this.dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.mode = opts.mode || 'refract'
    const c = document.createElement('canvas')
    c.className = 'pond-canvas'
    c.setAttribute('aria-hidden', 'true')
    Object.assign(c.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', pointerEvents: 'none' })
    this.canvas = c
    this.src.width = this.src.height = 1
    this.sctx = this.src.getContext('2d')
    opts.host.insertBefore(c, opts.host.firstChild)

    this.init()

    this.ro = new ResizeObserver(() => this.layout())
    this.ro.observe(opts.host)
    this.io = new IntersectionObserver(es => {
      this.onScreen = es.some(e => e.isIntersecting)
      if (this.onScreen && (this.hot > 0 || this.settle > 0)) this.start()
    }, { rootMargin: '80px 0px' })
    this.io.observe(opts.host)

    const t = opts.touch || opts.host
    t.addEventListener('pointerdown', this.onDown, { passive: true })
    t.addEventListener('pointermove', this.onMove, { passive: true })
    for (const e of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      t.addEventListener(e, this.onUp, { passive: true })
    }
    document.addEventListener('visibilitychange', this.onVis)
    c.addEventListener('webglcontextlost', this.onCtxLost as EventListener)

    this.layout()
  }

  /**
   * 让水下那张画面自己活起来（光束闪动）：按 fps 重画 paint。
   * 为什么不每帧：paint 是 2D canvas 画的，每帧重画整块很费；光束很慢，8fps 足够。
   * 她要的「海底光束的动态感」—— 静止的光再亮也是死的。
   */
  animatePaint(fps = 8): void {
    if (this.paintTimer || this.mode !== 'refract' || !this.opts.paint) return
    const step = () => {
      if (this.dead) return
      if (!document.hidden && this.onScreen) this.repaint()
      this.paintTimer = window.setTimeout(step, 1000 / fps)
    }
    this.paintTimer = window.setTimeout(step, 1000 / fps)
  }

  /** 内容变了（取到数、字体加载完、尺寸变了）重画一次水下的画面 */
  repaint(): void {
    if (this.mode === 'overlay') return      // 这一层不画水下的画面，只画波
    if (this.dead || !this.gl || !this.sctx || !this.opts.paint || this.w <= 0 || this.h <= 0) return
    this.src.width = Math.max(1, Math.round(this.w * this.dpr))
    this.src.height = Math.max(1, Math.round(this.h * this.dpr))
    this.sctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.sctx.clearRect(0, 0, this.w, this.h)
    this.opts.paint!(this.sctx, this.w, this.h, (performance.now() - this.t0) / 1000)
    this.uploadPage()
    this.hot = Math.max(this.hot, 2)   // 至少再出一帧，把新画面推上屏
    this.start()
  }

  destroy(): void {
    this.dead = true
    cancelAnimationFrame(this.raf)
    if (this.paintTimer) { clearTimeout(this.paintTimer); this.paintTimer = 0 }
    this.ro.disconnect()
    this.io.disconnect()
    const t = this.opts.touch || this.opts.host
    t.removeEventListener('pointerdown', this.onDown)
    t.removeEventListener('pointermove', this.onMove)
    for (const e of ['pointerup', 'pointercancel', 'pointerleave'] as const) t.removeEventListener(e, this.onUp)
    document.removeEventListener('visibilitychange', this.onVis)
    this.canvas.removeEventListener('webglcontextlost', this.onCtxLost as EventListener)
    const gl = this.gl
    if (gl) {
      for (const b of this.fb) { gl.deleteTexture(b.tex); gl.deleteFramebuffer(b.f) }
      if (this.pageTex) gl.deleteTexture(this.pageTex)
      if (this.quad) gl.deleteBuffer(this.quad)
      if (this.simP) gl.deleteProgram(this.simP)
      if (this.drawP) gl.deleteProgram(this.drawP)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    this.gl = null
    this.canvas.remove()
  }

  // ── 内部 ──

  private init() {
    // 两种模式都要透明底：
    // overlay 只画波（压在页面上）；refract 在有底图时只折射**字**，底图由底下那层透上来。
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false })
    if (!gl) return
    if (!gl.getExtension('EXT_color_buffer_half_float') && !gl.getExtension('EXT_color_buffer_float')) return
    this.gl = gl

    this.quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)

    this.simP = this.program(SIM_FS)
    this.drawP = this.program(this.mode === 'overlay' ? OVERLAY_FS : DRAW_FS)
    if (!this.simP || !this.drawP) { this.gl = null; return }

    const u = (p: WebGLProgram, names: string[]) =>
      names.reduce<Record<string, WebGLUniformLocation | null>>((m, n) => { m[n] = gl.getUniformLocation(p, n); return m }, {})
    this.uS = u(this.simP, ['cur', 'prev', 'px', 'damp', 'drops[0]', 'nDrops'])
    this.uD = u(this.drawP, ['height', 'page', 'px', 't'])
    gl.enable(gl.BLEND)
    if (this.mode === 'overlay') gl.blendFunc(gl.ONE, gl.ONE)                 // 只加光，见 OVERLAY_FS
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)                         // premultiplied：透明处露出底图

    this.fb = [this.makeFbo(), this.makeFbo(), this.makeFbo()]
    this.pageTex = gl.createTexture()
    this.t0 = performance.now()
  }

  private program(fs: string): WebGLProgram | null {
    const gl = this.gl!
    const sh = (src: string, type: number) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src); gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('[pond] shader', gl.getShaderInfoLog(s))
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, sh(VS, gl.VERTEX_SHADER))
    gl.attachShader(p, sh(fs, gl.FRAGMENT_SHADER))
    gl.bindAttribLocation(p, 0, 'p')
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn('[pond] link', gl.getProgramInfoLog(p)); return null }
    return p
  }

  private makeFbo() {
    const gl = this.gl!
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, POND.sim, POND.sim, 0, gl.RED, gl.HALF_FLOAT, null)
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.LINEAR)
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE)
    const f = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, f)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { tex, f }
  }

  private uploadPage() {
    const gl = this.gl!
    gl.bindTexture(gl.TEXTURE_2D, this.pageTex)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.src)
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.LINEAR)
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE)
  }

  private layout() {
    if (this.dead || !this.gl) return
    const r = this.opts.host.getBoundingClientRect()
    const w = Math.round(r.width), h = Math.round(r.height)
    if (w <= 0 || h <= 0) return
    if (w === this.w && h === this.h) return
    this.w = w; this.h = h
    this.canvas.width = Math.round(w * this.dpr)
    this.canvas.height = Math.round(h * this.dpr)
    if (this.mode === 'overlay') { this.hot = Math.max(this.hot, 2); this.start() }
    else this.repaint()
  }

  private push(cx: number, cy: number, strength: number) {
    const r = this.opts.host.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    const x = (cx - r.left) / r.width
    const y = (cy - r.top) / r.height
    if (x < 0 || x > 1 || y < 0 || y > 1) return      // 碰的是底下的格子，不是水面
    this.drops.push([x, 1 - y, strength])
    this.hot = POND.quietFrames
    this.start()
  }

  private onDown = (e: PointerEvent) => {
    this.drawing = true
    this.lx = e.clientX; this.ly = e.clientY
    this.push(e.clientX, e.clientY, POND.press)
  }

  private onMove = (e: PointerEvent) => {
    if (!this.drawing) return
    if (Math.hypot(e.clientX - this.lx, e.clientY - this.ly) < 2) return
    for (const [x, y] of strokePoints(this.lx, this.ly, e.clientX, e.clientY)) this.push(x, y, POND.drag)
    this.lx = e.clientX; this.ly = e.clientY
  }

  private onUp = () => { this.drawing = false }

  private onVis = () => {
    if (document.hidden) cancelAnimationFrame(this.raf), (this.raf = 0)
    else if (this.hot > 0 || this.settle > 0) this.start()
  }

  private onCtxLost = (e: Event) => {
    e.preventDefault()
    cancelAnimationFrame(this.raf); this.raf = 0
    this.gl = null
    this.opts.onLost?.()
  }

  private start() {
    if (this.dead || this.raf || !this.gl || document.hidden || !this.onScreen) return
    this.raf = requestAnimationFrame(this.frame)
  }

  private frame = (now: number) => {
    this.raf = 0
    const gl = this.gl
    if (this.dead || !gl || !this.simP || !this.drawP) return

    // 这一帧手指走过的点：最多 batch 个（多了隔着取），同一步一起落
    const batch = pickBatch(this.drops.splice(0, 64))
    const flat = new Float32Array(POND.batch * 3)
    batch.forEach((d, i) => { flat[i * 3] = d[0]; flat[i * 3 + 1] = d[1]; flat[i * 3 + 2] = d[2] })

    const bind = (p: WebGLProgram) => {
      gl.useProgram(p)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    }

    for (let step = 0; step < POND.steps; step++) {
      const [A, B, C] = this.fb as [typeof this.fb[0], typeof this.fb[0], typeof this.fb[0]]
      gl.bindFramebuffer(gl.FRAMEBUFFER, C.f)
      gl.viewport(0, 0, POND.sim, POND.sim)
      bind(this.simP)
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, B.tex); gl.uniform1i(this.uS.cur!, 0)
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, A.tex); gl.uniform1i(this.uS.prev!, 1)
      gl.uniform2f(this.uS.px!, 1 / POND.sim, 1 / POND.sim)
      // 收尾阶段用重阻尼：**停下来的那一帧必须是平的**。
      // 不这么做就会把没散完的波冻在屏幕上（整页铺开时就是一片同心干涉纹）。
      gl.uniform1f(this.uS.damp!, this.hot > 0 ? POND.damp : POND.settleDamp)
      gl.uniform3fv(this.uS['drops[0]']!, flat)
      gl.uniform1i(this.uS.nDrops!, step === 0 ? batch.length : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      this.fb = [B, C, A]
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    bind(this.drawP)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.fb[1]!.tex); gl.uniform1i(this.uD.height!, 0)
    if (this.mode === 'refract') { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.pageTex); gl.uniform1i(this.uD.page!, 1) }
    gl.uniform2f(this.uD.px!, 1 / POND.sim, 1 / POND.sim)
    gl.uniform1f(this.uD.t!, (now - this.t0) / 1000)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // 安静下来先收尾、再停：水面本来就不自己动，但**停住的那一帧得是平的**。
    // hot 走完进 settle（重阻尼压平），settle 也走完才真的停。
    if (this.drops.length > 0) { this.start(); return }
    if (this.hot > 0) { this.hot--; this.settle = POND.settleFrames; this.start(); return }
    if (this.settle > 0) { this.settle--; this.start() }
  }
}
