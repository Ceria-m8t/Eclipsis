// 全局视口：算出"真正可用的屏幕区域"，写进 CSS 变量 --app-h / --app-top，所有全屏页面都用它。
//
// 为什么不直接用 100dvh：
// 1. 主屏幕模式 + 透明状态栏时，iOS 报告的视口高度会少掉状态栏那一截，底部就露出一条空白。
// 2. 键盘弹起时只有 visualViewport 知道键盘上方还剩多高。
import { ref } from 'vue'

export const keyboardOpen = ref(false)
export const vvDebug = ref('')

const isStandalone =
  (navigator as any).standalone === true || window.matchMedia('(display-mode: standalone)').matches

// 视口比实际屏幕矮的那一截（没有键盘时测量）。只在主屏幕模式下修正
let deficit = 0

function inputFocused(): boolean {
  const el = document.activeElement as HTMLElement | null
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
}

function update() {
  const vv = window.visualViewport
  const root = document.documentElement
  const vh = vv ? vv.height : window.innerHeight
  const top = vv ? vv.offsetTop : 0

  // 竖屏使用，screen.height 就是整块屏幕的高度
  const full = screen.height
  const focused = inputFocused()
  if (isStandalone && !focused) {
    const gap = full - vh
    // 只认状态栏那么大的缺口（20~70px），其他情况（比如分屏）不修正
    deficit = gap > 0 && gap <= 70 ? gap : 0
  }

  const kb = focused && full - vh > 200
  keyboardOpen.value = kb
  root.classList.toggle('kb-open', kb)
  root.style.setProperty('--app-h', `${Math.round(vh + (kb ? 0 : deficit))}px`)
  root.style.setProperty('--app-top', `${Math.round(top)}px`)

  if (location.search.includes('vv')) {
    vvDebug.value = `standalone ${isStandalone ? 1 : 0} · screen ${full} · inner ${innerHeight} · vv ${Math.round(vh)} · top ${Math.round(top)} · 修正 ${deficit} · 键盘 ${kb ? 1 : 0}`
  }
}

let started = false
export function startViewportTracking() {
  if (started) return
  started = true
  update()
  window.visualViewport?.addEventListener('resize', update)
  window.visualViewport?.addEventListener('scroll', update)
  window.addEventListener('resize', update)
  window.addEventListener('orientationchange', () => setTimeout(update, 300))
  // 聚焦/失焦时键盘状态会变，但 resize 可能晚到
  document.addEventListener('focusin', () => setTimeout(update, 50))
  document.addEventListener('focusout', () => setTimeout(update, 50))
}
