// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { POND, PROP_MAX, stable, dampFor, strokePoints, pickBatch } from '../src/liquid/pond'
import { headLayout, paintHead, headText, cnFamily, HEAD_FONTS } from '../src/views/memory-head'

describe('水面的参数（她 2026-11-13 定的那一版）', () => {
  it('传播系数在稳定区里：> 0.5 且每帧多步一定自激（她两次看到「一大团」）', () => {
    expect(stable()).toBe(true)
    expect(POND.prop).toBeLessThanOrEqual(PROP_MAX)
    expect(stable(0.6, 3)).toBe(false)   // 失败过的第二次
    expect(stable(0.42, 50)).toBe(true)  // 步数本身不爆，爆的是「一个落点算一步」那种推法
  })

  it('幅度封顶、阻尼小于 1：不许长成一大块、也不许永远不平', () => {
    expect(POND.cap).toBeGreaterThan(0)
    expect(POND.damp).toBeLessThan(1)
    expect(POND.damp).toBeGreaterThan(0.99)
  })

  it('步数变了阻尼要跟着补：2 步 0.9955 ≈ 4 步 0.9978（否则她说「平得变快了」）', () => {
    expect(dampFor(4)).toBeCloseTo(0.9977, 4)
    expect(dampFor(2)).toBeCloseTo(0.9955, 4)
    // 等效：推完同样多步，衰减到同一个地方
    expect(Math.pow(dampFor(4), 4)).toBeCloseTo(Math.pow(0.9955, 2), 6)
  })
})

describe('手指划过是连着的一道', () => {
  it('两次采样之间按每 5px 补点，终点一定在里面', () => {
    const pts = strokePoints(0, 0, 100, 0)
    expect(pts.length).toBe(20)
    expect(pts.at(-1)).toEqual([100, 0])
    for (let i = 1; i < pts.length; i++) {
      expect(Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1])).toBeLessThanOrEqual(POND.strokeGap + 1e-9)
    }
  })

  it('划得再长也有上限（一帧里不许塞进几十个落点）', () => {
    expect(strokePoints(0, 0, 4000, 0).length).toBe(POND.strokeMax)
  })

  it('几乎没动也至少给一个点', () => {
    expect(strokePoints(10, 10, 11, 10).length).toBe(1)
  })

  it('一帧里的落点太多就隔着取，保留两头、顺序不变', () => {
    const list = Array.from({ length: 40 }, (_, i) => i)
    const got = pickBatch(list)
    expect(got.length).toBe(POND.batch)
    expect(got[0]).toBe(0)
    expect(got.at(-1)).toBe(39)
    expect([...got].sort((a, b) => a - b)).toEqual(got)
    expect(pickBatch([1, 2, 3])).toEqual([1, 2, 3])
  })
})

describe('记忆面板的头部（泡在水里那一块）', () => {
  it('版面随安全区整体往下挪，高度跟着变', () => {
    const a = headLayout(0), b = headLayout(47)
    expect(b.script - a.script).toBe(47)
    expect(b.height - a.height).toBe(47)
    expect(a.kicker).toBeLessThan(a.eclipse)
    expect(a.eclipse).toBeLessThan(a.script)
    expect(a.script).toBeLessThan(a.figure)
    expect(a.figure).toBeLessThan(a.line)
    expect(a.line).toBeLessThan(a.height)
  })

  it('标题字固定，不跟她在设置里换的全局字体（她定的）', () => {
    expect(HEAD_FONTS.script).toContain('Pinyon Script')
    expect(HEAD_FONTS.figure).toContain('Cormorant Garamond')
  })

  it('canvas 里不能出现 var()：画上去是不解析的，会悄悄变成系统字', () => {
    const calls = paintProbe({ quotes: 8859, cards: 206, relations: 150 })
    for (const f of calls.fonts) expect(f).not.toContain('var(')
  })

  it('画的是她的数，不是别人那套版面（Memoria / 五个数 / 底栏四字，她一眼看出来过）', () => {
    const calls = paintProbe({ quotes: 8859, cards: 206, relations: 150 })
    const text = calls.texts.join(' | ')
    expect(text).toContain('8,859')
    expect(text).toContain('记 忆 的 柜 子')
    expect(text).toContain('写成 206 张卡，串起 150 条关系')
    expect(text).not.toMatch(/Memoria/i)
  })

  it('意象来自我们自己的来历：ECLIPSIS 和「未」（ellipsis ← 未命名/未来/未完待续）', () => {
    const text = paintProbe({ quotes: 1, cards: 1, relations: 1 }).texts.join(' | ')
    expect(text).toContain('未')
    expect(text).toMatch(/E\s*C\s*L\s*I\s*P\s*S\s*I\s*S/)
  })

  it('有「今天」那一行时画出来（她要的律动之外，数也要活）', () => {
    const text = paintProbe({ quotes: 1, cards: 1, relations: 1, week: '今天 记了 5 张' }).texts.join(' | ')
    expect(text).toContain('今天 记了 5 张')
  })

  it('还没取到数也画得出来（只少大数字那几行）', () => {
    const calls = paintProbe(null)
    expect(calls.texts.join(' ')).toContain('正在数')
  })

  it('读屏软件拿到的是同一份内容（画布里的字它看不见）', () => {
    expect(headText({ quotes: 8859, cards: 206, relations: 150 })).toContain('8,859 句原话')
    expect(headText(null)).toContain('正在数')
  })

  it('她没换字体时回退到思源宋，不会把 --app-font 原样写进 ctx.font', () => {
    expect(cnFamily()).toContain('Noto Serif SC')
  })
})

/** happy-dom 没有真的 2D 上下文，自己记一份调用（只要能看出画了什么字、用了什么字体） */
function paintProbe(data: { quotes: number; cards: number; relations: number } | null) {
  const texts: string[] = []
  const fonts: string[] = []
  const grad = { addColorStop() {} }
  const ctx = {
    canvas: { width: 390, height: 300 },
    set font(v: string) { fonts.push(v) },
    get font() { return fonts.at(-1) || '' },
    fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'left', textBaseline: 'alphabetic',
    letterSpacing: '0px', shadowColor: '', shadowBlur: 0,
    createLinearGradient: () => grad, createRadialGradient: () => grad,
    fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {},
    save() {}, restore() {}, arc() {}, closePath() {}, fill() {}, setLineDash() {},
    fillText(t: string) { texts.push(t) },
  } as unknown as CanvasRenderingContext2D
  paintHead(ctx, 390, headLayout(0).height, data, { cn: '"Noto Serif SC", serif' })
  return { texts, fonts }
}
