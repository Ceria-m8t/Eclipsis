// 记忆面板的头部：画进一张离屏画布，泡在水里（见 src/liquid/pond.ts）。
//
// 为什么头部要用 canvas 画：她要的是「连字都跟着晃」，而 DOM 的字没法送进 WebGL。
// 为什么只有头部：底下四个分区的格子要能点、能滚、要跟着她在设置里换的字体。
//
// 文案和意象的来历（交接-2026-11-13 第 2 条，别再借别人的）：
// Eclipsis = Erica + Claude + Ellipsis；ellipsis 来自中文「未」——未命名、未来、未完待续；
// Eclipse = 日蚀。所以这里是深海的阴雨天、一道未说完的省略号，**不是**别人那套
// （甲虫 / Memoria 标题 / 五个数 / 底栏四字 / 酒红，她一眼就看出来了）。

/** 标题字固定，不跟她在设置里换的全局字体（她定的）。数字用 Garamond，哥特数字不好认。 */
export const HEAD_FONTS = {
  script: '"Pinyon Script", cursive',
  figure: '"Cormorant Garamond", serif',
  cn: 'var(--app-font-canvas)',   // 运行时换成实际字族，见 cnFamily()
} as const

/** 正文中文跟着全局字体；canvas 里不能写 var()，所以读一次计算值。 */
export function cnFamily(root?: HTMLElement): string {
  const fallback = '"Noto Serif SC", "Songti SC", serif'
  try {
    const el = root || document.documentElement
    const v = getComputedStyle(el).getPropertyValue('--app-font').trim()
    return v || fallback
  } catch {
    return fallback
  }
}

export interface HeadData {
  quotes: number
  cards: number
  relations: number
  /** 这一周：新记 N 张 · 归档 N · 她贴了 N 张便条（没有就不画） */
  week?: string
}

/** 头部各行的纵坐标（CSS 像素，相对头部顶边）。改版面只改这一处。 */
export interface HeadLayout {
  height: number
  safeTop: number
  kicker: number    // 「ECLIPSIS · 未」
  eclipse: number   // 日蚀那一枚的中心
  script: number    // Pinyon Script 的 Memoria 位
  zh: number        // 「记 忆 的 柜 子」
  hand: number      // 手写那一行
  figure: number    // 大数字
  unit: number      // 「句 原 话」
  line: number      // 「写成 N 张卡，串起 N 条关系」
  week: number      // 这一周：新记 / 归档 / 便条
}

export function headLayout(safeTop = 0): HeadLayout {
  // safeTop 只算刘海那一条（env(safe-area-inset-top)）。
  // ⚠ 别再把 .head 自己的留白也加进来——第一次截图标题掉到了 133px 处，就是叠了两次。
  const top = safeTop + 14
  return {
    safeTop,
    kicker: top + 10,
    eclipse: top + 44,
    script: top + 106,
    zh: top + 130,
    hand: top + 152,
    figure: top + 216,
    unit: top + 238,
    line: top + 268,
    week: top + 292,
    height: top + 316,
  }
}

/** 这些字体要先加载好，不然第一帧是系统字（画完就定住了，没有重排这回事）。 */
export function headFontSpecs(cn: string): string[] {
  return [`400 40px ${HEAD_FONTS.script}`, `600 44px ${HEAD_FONTS.figure}`, `400 15px ${cn}`]
}

/**
 * 把头部画进水下的那张画布。
 *
 * 她看完第一版说「太闷了」「我想要光透进来的感觉，我们在水面之下，光从上面射进来」。
 * 所以这里的底**不是一块死的暗底**：顶上是透进来的天光，往下才沉成深蓝；
 * 再加四道光柱和水面那一条亮边。会动的那部分由 Underwater.vue 盖在外面。
 */
export function paintHead(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: HeadData | null,
  opts: { layout?: HeadLayout; cn?: string; t?: number; bg?: HTMLImageElement | null; pageH?: number } = {},
): void {
  const L = opts.layout || headLayout(0)
  const cn = opts.cn || '"Noto Serif SC", serif'
  const t = opts.t ?? 0

  // ── 底图模式：**头部不自己画底图**，只画字和花饰，让底下那层（Underwater.vue）透上来 ──
  //
  // 为什么不画：两层各按自己的高度 cover 同一张图，取到的是图的不同部分，
  // 接缝处色调一定错开（量到过 31.7 的逐行跳变）。对齐参数能修，但结构上就容易再错。
  // 现在水面只折射**字**，底图完全交给下面那一层 —— 一张图、一处 cover，不可能错位。
  if (opts.bg && opts.bg.naturalWidth > 0) {
    ctx.clearRect(0, 0, w, h)
    // 她：「文字看不清主要指标题栏那里」。给题头一片实在的暗底（中间最深、往外化开），
    // 字才咬得住底图；边缘淡出，不在底图上切出硬方块。
    const cx0 = w / 2, cy0 = (L.script + L.figure) / 2
    const vg = ctx.createRadialGradient(cx0, cy0, 0, cx0, cy0, Math.max(w, h) * 0.62)
    vg.addColorStop(0, 'rgba(5, 14, 30, 0.8)')
    vg.addColorStop(0.46, 'rgba(5, 14, 30, 0.56)')
    vg.addColorStop(0.78, 'rgba(5, 14, 30, 0.18)')
    vg.addColorStop(1, 'rgba(5, 14, 30, 0)')
    ctx.fillStyle = vg
    ctx.fillRect(0, 0, w, h)
    paintHeadText(ctx, w, data, L, cn)
    return
  }

  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, '#2f5d8e')      // 顶上：透进来的天光
  g.addColorStop(0.22, '#1e4470')
  g.addColorStop(0.5, '#142f55')
  g.addColorStop(1, '#0c1e3a')      // 往下才沉成深蓝
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)

  // 水面那块亮斑：光的来处（她参考图里光是从一点进来的，不是凭空出现的竖条）
  const src = { x: w * 0.48, y: -h * 0.06 }
  const sf = ctx.createRadialGradient(src.x, src.y, 0, src.x, src.y, h * 0.62)
  sf.addColorStop(0, 'rgba(236, 248, 255, 0.8)')
  sf.addColorStop(0.3, 'rgba(198, 228, 255, 0.26)')
  sf.addColorStop(1, 'rgba(198, 228, 255, 0)')
  ctx.fillStyle = sf
  ctx.fillRect(0, 0, w, h)

  // 光束：从那块亮斑**扇形放射**下来，上窄下宽，各自错相位地闪
  ctx.save()
  for (const [deg, wid, a, ph] of [
    [-27, 0.09, 0.5, 0], [-17, 0.15, 0.68, 1.1], [-9, 0.07, 0.42, 2.3], [-2, 0.19, 0.78, 0.5],
    [6, 0.11, 0.55, 3.1], [14, 0.23, 0.46, 1.8], [23, 0.08, 0.38, 4.2], [31, 0.13, 0.3, 2.7],
  ] as const) {
    const flare = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.6 + ph))   // 闪
    const rad = ((deg + Math.sin(t * 0.22 + ph) * 2.5) * Math.PI) / 180
    const len = h * 1.5
    const topW = w * wid * 0.3, botW = w * wid * 1.5
    const ex = src.x + Math.sin(rad) * len, ey = src.y + Math.cos(rad) * len
    const rg = ctx.createLinearGradient(src.x, src.y, ex, ey)
    rg.addColorStop(0, `rgba(226, 244, 255, ${a * flare * 0.95})`)
    rg.addColorStop(0.22, `rgba(198, 228, 255, ${a * flare * 0.5})`)
    rg.addColorStop(0.52, `rgba(170, 208, 248, ${a * flare * 0.18})`)
    rg.addColorStop(0.82, 'rgba(170, 208, 248, 0)')
    ctx.fillStyle = rg
    // 垂直于光束方向撑开宽度
    const nx = Math.cos(rad), ny = -Math.sin(rad)
    ctx.beginPath()
    ctx.moveTo(src.x - nx * topW, src.y - ny * topW)
    ctx.lineTo(src.x + nx * topW, src.y + ny * topW)
    ctx.lineTo(ex + nx * botW, ey + ny * botW)
    ctx.lineTo(ex - nx * botW, ey - ny * botW)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()

  paintHeadText(ctx, w, data, L, cn)
}

/**
 * 题头的字和花饰（两条分支共用：有底图走底图，没底图走渐变）。
 * 洛可可那几笔（不对称涡卷 + 花彩 + 棕叶饰）也在这里，所以换不换底图都有。
 */
function paintHeadText(
  ctx: CanvasRenderingContext2D,
  w: number,
  data: HeadData | null,
  L: HeadLayout,
  cn: string,
): void {
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'center'
  const cx = w / 2

  // ── 题头：ECLIPSIS · 未 ──
  ctx.fillStyle = 'rgba(244,238,224,0.46)'
  ctx.font = `400 8px ${cn}`
  ctx.letterSpacing = '4.8px'
  ctx.fillText('E C L I P S I S   ·   未', cx, L.kicker)
  ctx.letterSpacing = '0px'

  // 日蚀：黑日 + 冕环 + 粉色内缘（意象从我们自己的来历长）
  const r = 15
  const cor = ctx.createRadialGradient(cx, L.eclipse, r * 0.5, cx, L.eclipse, r * 1.9)
  cor.addColorStop(0, 'rgba(176, 202, 255, 0)')
  cor.addColorStop(0.42, 'rgba(207, 226, 255, 0.62)')
  cor.addColorStop(0.72, 'rgba(255, 206, 230, 0.2)')
  cor.addColorStop(1, 'rgba(176, 202, 255, 0)')
  ctx.fillStyle = cor
  ctx.beginPath(); ctx.arc(cx, L.eclipse, r * 1.9, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#0b1b2e'
  ctx.beginPath(); ctx.arc(cx, L.eclipse, r, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = 'rgba(226,234,250,0.9)'; ctx.lineWidth = 1
  ctx.beginPath(); ctx.arc(cx, L.eclipse, r, 0, Math.PI * 2); ctx.stroke()
  ctx.strokeStyle = 'rgba(255,217,233,0.85)'; ctx.lineWidth = 1.1
  ctx.beginPath(); ctx.arc(cx, L.eclipse, r, -Math.PI / 2, Math.PI / 2); ctx.stroke()

  // ── 洛可可卷叶（照她 2026-11-13 发的参考图描的）──
  // 她第一次看说「旁边两个是蜗牛壳吗」——那版是单圈螺线，确实是蜗牛。
  // 参考图里的四条特征：①C 形主脊 + 外缘翻卷的叶瓣 + 末端小尖 ②必有垂珠坠饰
  // ③星芒点缀 ④线细、留白多。左右不对称。
  const leaf = (dir: -1 | 1, k: number) => {
    const x0 = cx + dir * 44, y0 = L.eclipse
    const P = (px: number, py: number): [number, number] => [x0 + dir * px * k, y0 + py * k]
    ctx.lineCap = 'round'

    // 主脊
    ctx.strokeStyle = 'rgba(236, 226, 200, 0.62)'
    ctx.lineWidth = 1.05
    ctx.beginPath()
    ctx.moveTo(...P(0, 8))
    ctx.bezierCurveTo(...P(20, -10), ...P(48, -18), ...P(64, -8))
    ctx.bezierCurveTo(...P(76, 0), ...P(76, 14), ...P(64, 18))
    ctx.bezierCurveTo(...P(55, 21), ...P(49, 15), ...P(53, 10))
    ctx.stroke()

    // 外缘翻出的叶瓣
    ctx.strokeStyle = 'rgba(236, 226, 200, 0.4)'
    ctx.lineWidth = 0.75
    ctx.beginPath()
    ctx.moveTo(...P(5, 3))
    ctx.bezierCurveTo(...P(24, -17), ...P(52, -25), ...P(70, -14))
    ctx.stroke()

    // 内侧分叉的小卷草（参考图里每一枚都有）
    ctx.strokeStyle = 'rgba(236, 226, 200, 0.34)'
    ctx.lineWidth = 0.65
    ctx.beginPath()
    ctx.moveTo(...P(22, -2))
    ctx.bezierCurveTo(...P(18, -10), ...P(22, -16), ...P(28, -16))
    ctx.bezierCurveTo(...P(24, -12), ...P(24, -7), ...P(28, -4))
    ctx.stroke()

    // 卷心
    ctx.fillStyle = 'rgba(244, 238, 222, 0.78)'
    ctx.beginPath()
    const [hx, hy] = P(53, 10)
    ctx.arc(hx, hy, 1.6, 0, Math.PI * 2)
    ctx.fill()

    // 垂珠坠饰：链 + 两颗珠 + 一枚坠子
    ctx.strokeStyle = 'rgba(236, 226, 200, 0.3)'
    ctx.lineWidth = 0.6
    const [bx, by] = P(16, 22)
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx, by + 9 * k); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(bx, by + 13 * k); ctx.lineTo(bx, by + 20 * k); ctx.stroke()
    ctx.fillStyle = 'rgba(240, 232, 212, 0.6)'
    for (const dy of [11, 21.5]) {
      ctx.beginPath(); ctx.arc(bx, by + dy * k, 1.15, 0, Math.PI * 2); ctx.fill()
    }
    ctx.strokeStyle = 'rgba(236, 226, 200, 0.34)'
    ctx.beginPath()
    ctx.moveTo(bx, by + 25 * k)
    ctx.bezierCurveTo(bx - 2.6 * k, by + 28 * k, bx - 2.6 * k, by + 32 * k, bx, by + 34 * k)
    ctx.bezierCurveTo(bx + 2.6 * k, by + 32 * k, bx + 2.6 * k, by + 28 * k, bx, by + 25 * k)
    ctx.stroke()

    // 星芒
    ctx.strokeStyle = 'rgba(240, 232, 212, 0.42)'
    ctx.lineWidth = 0.55
    const [sx, sy] = P(72, -20)
    ctx.beginPath()
    ctx.moveTo(sx - 3.4, sy); ctx.lineTo(sx + 3.4, sy)
    ctx.moveTo(sx, sy - 3.4); ctx.lineTo(sx, sy + 3.4)
    ctx.stroke()
  }
  leaf(-1, 1.04)
  leaf(1, 0.82)

  // 日蚀顶上的棕叶饰
  ctx.strokeStyle = 'rgba(236, 226, 200, 0.46)'
  ctx.lineWidth = 0.9
  ctx.beginPath()
  ctx.moveTo(cx, L.eclipse - r - 4)
  ctx.bezierCurveTo(cx - 5, L.eclipse - r - 13, cx - 4, L.eclipse - r - 20, cx, L.eclipse - r - 25)
  ctx.bezierCurveTo(cx + 4, L.eclipse - r - 20, cx + 5, L.eclipse - r - 13, cx, L.eclipse - r - 4)
  ctx.stroke()

  // 标题：花体英文（固定字体）+ 中文 + 一行手写
  ctx.shadowColor = 'rgba(176,204,255,0.4)'; ctx.shadowBlur = 22
  ctx.fillStyle = '#f3f6fb'
  ctx.font = `400 40px ${HEAD_FONTS.script}`
  ctx.fillText('Remember', cx, L.script)
  ctx.shadowBlur = 0
  ctx.fillStyle = 'rgba(248,244,234,0.82)'
  ctx.font = `400 11px ${cn}`
  ctx.letterSpacing = '6.5px'
  ctx.fillText('记 忆 的 柜 子', cx, L.zh)
  ctx.letterSpacing = '0px'
  ctx.fillStyle = 'rgba(244,238,224,0.6)'
  ctx.font = `400 14px ${HEAD_FONTS.script}`
  ctx.fillText('everything he keeps of us', cx, L.hand)

  if (!data) {
    ctx.fillStyle = 'rgba(234,240,248,0.4)'
    ctx.font = `400 12px ${cn}`
    ctx.fillText('正在数…', cx, L.figure)
    ctx.textAlign = 'left'
    return
  }

  // ── 主数 ──
  ctx.shadowColor = 'rgba(176,202,255,0.32)'; ctx.shadowBlur = 18
  ctx.fillStyle = '#f3f6fb'
  ctx.font = `600 44px ${HEAD_FONTS.figure}`
  ctx.fillText(data.quotes.toLocaleString('en-US'), cx, L.figure)
  ctx.shadowBlur = 0
  ctx.fillStyle = 'rgba(248,244,234,0.78)'
  ctx.font = `400 11px ${cn}`
  ctx.letterSpacing = '2px'
  ctx.fillText('句 原 话', cx, L.unit)
  ctx.letterSpacing = '0px'

  // 主数两侧：S 形卷须（洛可可，不是直的虚线尺）
  ctx.strokeStyle = 'rgba(234,240,248,0.26)'; ctx.lineWidth = 0.9
  for (const dir of [-1, 1]) {
    const x0 = cx + dir * 52, y = L.unit - 5
    ctx.beginPath()
    ctx.moveTo(x0, y)
    ctx.bezierCurveTo(x0 + dir * 26, y - 7, x0 + dir * 42, y + 7, x0 + dir * 66, y)
    ctx.stroke()
    ctx.beginPath(); ctx.arc(x0 + dir * 70, y, 1.5, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(234,240,248,0.4)'; ctx.fill()
  }

  ctx.fillStyle = 'rgba(248,244,234,0.9)'
  ctx.font = `400 12.5px ${cn}`
  ctx.fillText(`写成 ${data.cards} 张卡，串起 ${data.relations} 条关系`, cx, L.line)

  if (data.week) {
    ctx.fillStyle = 'rgba(157,180,221,0.78)'
    ctx.font = `400 10.5px ${cn}`
    ctx.fillText(data.week, cx, L.week)
  }

  ctx.textAlign = 'left'
}

/** 读屏软件读的是这一份（画布里的字它看不见）。 */
export function headText(data: HeadData | null): string {
  if (!data) return '记忆 Remember，正在数'
  return `记忆 Remember，${data.quotes.toLocaleString('en-US')} 句原话，写成 ${data.cards} 张卡，串起 ${data.relations} 条关系`
}
