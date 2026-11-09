// 液态玻璃的几何计算：都是纯函数，方便单独测试。

export interface Box { x: number; y: number; w: number; h: number }

/** background-size: cover + background-position: center 时，图片实际画在哪里（和 CSS 算法一致） */
export function coverPlacement(box: Box, imgW: number, imgH: number): Box {
  const s = Math.max(box.w / imgW, box.h / imgH)
  const w = imgW * s
  const h = imgH * s
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
}

/**
 * 画布放在滚动内容里面（跟着气泡一起滚，形状不会落后于字），只盖住屏幕附近那一段。
 * 画布不能伸出内容底部，否则会把可滚动高度撑大。
 */
export function canvasWindow(scrollTop: number, clientH: number, contentH: number, margin: number) {
  const full = Math.max(contentH, clientH)
  const height = Math.max(1, Math.min(clientH + 2 * margin, full))
  const maxTop = Math.max(0, full - height)
  const top = Math.min(Math.max(0, scrollTop - margin), maxTop)
  return { top, height }
}

/** 当前画布还盖不盖得住屏幕（留 1/4 余量；贴着内容两端时不用留） */
export function windowCovers(top: number, height: number, scrollTop: number, clientH: number, contentH: number, margin: number) {
  const slack = margin / 4
  const needTop = Math.max(0, scrollTop - slack)
  const needBottom = Math.min(Math.max(contentH, clientH), scrollTop + clientH + slack)
  return top <= needTop && top + height >= needBottom
}

/** 平均亮度（0–1，sRGB 近似）决定玻璃明暗：暗图配黑玻璃白字 */
export function pickTone(avgLum: number): 'light' | 'dark' {
  return avgLum < 0.45 ? 'dark' : 'light'
}

export function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [1, 1, 1]
  const n = parseInt(m[1]!, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
