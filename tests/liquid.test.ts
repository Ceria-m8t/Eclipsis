import { describe, it, expect } from 'vitest'
import { coverPlacement, canvasWindow, windowCovers, pickTone, hexToRgb01 } from '../src/liquid/geometry'

describe('液态玻璃几何', () => {
  it('cover 和 CSS 一样：竖屏放横图，按高度撑满、左右居中裁掉', () => {
    const p = coverPlacement({ x: 0, y: 0, w: 390, h: 844 }, 1400, 800)
    expect(p.h).toBeCloseTo(844)
    expect(p.w).toBeCloseTo(1400 * 844 / 800)
    expect(p.x).toBeCloseTo((390 - p.w) / 2)
    expect(p.y).toBeCloseTo(0)
  })

  it('cover：竖图放进更宽的框，按宽度撑满、上下居中', () => {
    const p = coverPlacement({ x: 10, y: 20, w: 400, h: 300 }, 800, 1600)
    expect(p.w).toBeCloseTo(400)
    expect(p.x).toBeCloseTo(10)
    expect(p.y).toBeCloseTo(20 + (300 - 800) / 2)
  })

  it('画布窗口不伸出内容底部（不撑大滚动高度）', () => {
    // 滚到底：scrollTop 最大 = 内容高 - 屏幕高
    const w = canvasWindow(4400, 800, 5200, 240)
    expect(w.top + w.height).toBeLessThanOrEqual(5200)
    expect(w.top).toBeLessThanOrEqual(4400)
    expect(w.top + w.height).toBeGreaterThanOrEqual(4400 + 800)
  })

  it('内容比屏幕短时，画布就是一屏高、贴顶', () => {
    expect(canvasWindow(0, 800, 300, 240)).toEqual({ top: 0, height: 800 })
  })

  it('滚到顶时不出现负的 top', () => {
    expect(canvasWindow(100, 800, 9000, 240).top).toBe(0)
  })

  it('windowCovers：屏幕还在画布里就不挪，快出边了才挪', () => {
    const w = canvasWindow(2000, 800, 9000, 240)
    expect(windowCovers(w.top, w.height, 2000, 800, 9000, 240)).toBe(true)
    expect(windowCovers(w.top, w.height, 2100, 800, 9000, 240)).toBe(true)
    expect(windowCovers(w.top, w.height, 2300, 800, 9000, 240)).toBe(false)
    // 贴着内容底部：不需要额外余量
    const b = canvasWindow(8200, 800, 9000, 240)
    expect(windowCovers(b.top, b.height, 8200, 800, 9000, 240)).toBe(true)
  })

  it('明暗：暗图配黑玻璃', () => {
    expect(pickTone(0.2)).toBe('dark')
    expect(pickTone(0.7)).toBe('light')
  })

  it('hexToRgb01', () => {
    expect(hexToRgb01('#ff8000')).toEqual([1, 128 / 255, 0])
    expect(hexToRgb01('bad')).toEqual([1, 1, 1])
  })
})
