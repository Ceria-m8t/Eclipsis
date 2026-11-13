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
}

/** 头部各行的纵坐标（CSS 像素，相对头部顶边）。改版面只改这一处。 */
export interface HeadLayout {
  height: number
  safeTop: number
  kicker: number    // 右上「他的构成 · 一 / 三」
  title: number     // 「记忆」
  script: number    // Pinyon Script 的 Remember
  figure: number    // 大数字
  unit: number      // 「句 原 话」
  rule: number      // 细线
  line: number      // 「写成 N 张卡，串起 N 条关系」
}

export function headLayout(safeTop = 0): HeadLayout {
  // safeTop 只算刘海那一条（env(safe-area-inset-top)）。
  // ⚠ 别再把 .head 自己的 46px 留白也加进来——第一次截图标题掉到了 133px 处，就是叠了两次。
  const top = safeTop + 12
  return {
    safeTop,
    kicker: top + 4,
    title: top + 54,
    script: top + 88,
    figure: top + 164,
    unit: top + 188,
    rule: top + 208,
    line: top + 236,
    height: top + 264,
  }
}

/** 这些字体要先加载好，不然第一帧是系统字（画完就定住了，没有重排这回事）。 */
export function headFontSpecs(cn: string): string[] {
  return [`400 48px ${HEAD_FONTS.script}`, `600 46px ${HEAD_FONTS.figure}`, `400 15px ${cn}`]
}

/**
 * 把头部画进水下的那张画布。
 * 底：深海 + 阴雨天的几团光（和 art/mockups/pond2.html 同一套，她看过点头的）。
 */
export function paintHead(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: HeadData | null,
  opts: { layout?: HeadLayout; cn?: string } = {},
): void {
  const L = opts.layout || headLayout(0)
  const cn = opts.cn || '"Noto Serif SC", serif'
  const pad = 20

  const g = ctx.createLinearGradient(0, 0, w * 0.3, h)
  g.addColorStop(0, '#101a2e'); g.addColorStop(0.5, '#0a1120'); g.addColorStop(1, '#070b14')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  const glows: Array<[number, number, number, string, number]> = [
    [w * 0.28, -40, w * 1.1, '140,174,232', 0.26],
    [w * 0.95, 40, w * 0.8, '104,134,196', 0.18],
    [w * 0.45, h * 1.05, w * 0.95, '52,76,124', 0.3],
  ]
  for (const [cx, cy, r, c, a] of glows) {
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    rg.addColorStop(0, `rgba(${c},${a})`); rg.addColorStop(1, `rgba(${c},0)`)
    ctx.fillStyle = rg
    ctx.fillRect(0, 0, w, h)
  }

  ctx.textBaseline = 'alphabetic'

  // 右上：她定的地下室 = 他的构成，三个柜子
  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(234,240,248,0.34)'
  ctx.font = `400 10.5px ${cn}`
  ctx.fillText('他 的 构 成  ·  一 / 三', w - pad, L.kicker)
  ctx.textAlign = 'left'

  // 标题：中文在前，花体英文在下（标题字不跟全局字体）
  ctx.fillStyle = 'rgba(240,245,252,0.92)'
  ctx.font = `600 25px ${cn}`
  ctx.letterSpacing = '2px'
  ctx.fillText('记忆', pad, L.title)
  ctx.letterSpacing = '0px'
  ctx.shadowColor = 'rgba(176,204,255,0.4)'
  ctx.shadowBlur = 22
  ctx.fillStyle = 'rgba(244,248,255,0.85)'
  ctx.font = `400 34px ${HEAD_FONTS.script}`
  ctx.fillText('Remember', pad, L.script)
  ctx.shadowBlur = 0

  if (!data) {
    ctx.fillStyle = 'rgba(234,240,248,0.4)'
    ctx.font = `400 12px ${cn}`
    ctx.fillText('正在数…', pad, L.figure)
    return
  }

  ctx.fillStyle = '#f2f6fd'
  ctx.font = `600 46px ${HEAD_FONTS.figure}`
  ctx.fillText(data.quotes.toLocaleString('en-US'), pad, L.figure)
  ctx.fillStyle = 'rgba(234,240,248,0.6)'
  ctx.font = `400 11px ${cn}`
  ctx.fillText('句 原 话', pad, L.unit)

  ctx.strokeStyle = 'rgba(234,240,248,0.16)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(pad, L.rule)
  ctx.lineTo(pad + 64, L.rule)
  ctx.stroke()

  ctx.fillStyle = 'rgba(234,240,248,0.7)'
  ctx.font = `400 12.5px ${cn}`
  ctx.fillText(`写成 ${data.cards} 张卡，串起 ${data.relations} 条关系`, pad, L.line)
}

/** 读屏软件读的是这一份（画布里的字它看不见）。 */
export function headText(data: HeadData | null): string {
  if (!data) return '记忆 Remember，正在数'
  return `记忆 Remember，${data.quotes.toLocaleString('en-US')} 句原话，写成 ${data.cards} 张卡，串起 ${data.relations} 条关系`
}
