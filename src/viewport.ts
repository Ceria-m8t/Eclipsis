// 全局视口：算出"页面该占多高"，写进 CSS 变量 --app-h / --app-top，所有全屏页面都用它。
//
// - 没有键盘时：取几种测量里最大的那个（innerHeight / 100lvh / 主屏幕模式下的 screen.height），
//   iOS 在主屏幕模式下报告的 innerHeight 有时会少掉状态栏那一截，取最大值能把底部铺满。
// - 键盘弹起时：用 visualViewport，只占键盘上方那块。
import { ref } from 'vue'

export const keyboardOpen = ref(false)
export const vvDebug = ref('')

const DEBUG_KEY = 'eclipsis-viewport-debug'
export function isViewportDebug(): boolean {
  return localStorage.getItem(DEBUG_KEY) === '1' || location.search.includes('vv')
}
export function setViewportDebug(on: boolean) {
  if (on) localStorage.setItem(DEBUG_KEY, '1')
  else localStorage.removeItem(DEBUG_KEY)
  update()
}

const isStandalone = () =>
  (navigator as any).standalone === true || window.matchMedia('(display-mode: standalone)').matches ||
  location.search.includes('force-standalone')   // 仅测试用

// 用一个隐藏元素量 100lvh（"最大视口高度"）和安全区
let probe: HTMLDivElement | null = null
function measureProbe() {
  if (!probe) {
    probe = document.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:100lvh;visibility:hidden;pointer-events:none;' +
      'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);box-sizing:content-box'
    document.body.appendChild(probe)
  }
  const cs = getComputedStyle(probe)
  return {
    lvh: parseFloat(cs.height) || 0,
    safeTop: parseFloat(cs.paddingTop) || 0,
    safeBottom: parseFloat(cs.paddingBottom) || 0
  }
}

function inputFocused(): boolean {
  const el = document.activeElement as HTMLElement | null
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
}

function update() {
  const vv = window.visualViewport
  const root = document.documentElement
  const vh = vv ? vv.height : window.innerHeight
  const standalone = isStandalone()
  const { lvh, safeTop, safeBottom } = measureProbe()

  const kb = inputFocused() && screen.height - vh > 200
  keyboardOpen.value = kb
  root.classList.toggle('kb-open', kb)

  let h: number
  let top = 0
  if (kb) {
    h = vh
    top = vv ? vv.offsetTop : 0
  } else {
    h = Math.max(window.innerHeight, lvh, vh)
    // 主屏幕模式下页面就是整块屏幕
    if (standalone) h = Math.max(h, screen.height)
  }
  root.style.setProperty('--app-h', `${Math.round(h)}px`)
  // 主屏幕模式且没键盘时，把文档撑到整屏高（见 style.css 里的说明）
  root.classList.toggle('fill-screen', standalone && !kb)
  // 键盘收起后，iOS 可能把文档滚动过的距离留着，归零
  if (!kb && (window.scrollY || document.scrollingElement?.scrollTop)) window.scrollTo(0, 0)
  root.style.setProperty('--app-top', `${Math.round(top)}px`)

  vvDebug.value = isViewportDebug()
    ? `主屏幕 ${standalone ? '是' : '否'} · screen ${screen.height} · inner ${innerHeight} · lvh ${Math.round(lvh)} · vv ${Math.round(vh)} · top ${Math.round(vv?.offsetTop || 0)}\n` +
      `安全区 上${Math.round(safeTop)} 下${Math.round(safeBottom)} · 页面高 ${Math.round(h)} · 文档高 ${root.clientHeight}/${Math.round(document.body.getBoundingClientRect().height)} · 页面底 ${Math.round(document.querySelector('.app-screen')?.getBoundingClientRect().bottom || 0)} · 键盘 ${kb ? '开' : '关'}`
    : ''
}

let started = false
export function startViewportTracking() {
  if (started) return
  started = true
  update()
  // 首次进入时 iOS 的尺寸可能还没稳定，过一会儿再量一次
  setTimeout(update, 300)
  setTimeout(update, 1000)
  // 诊断模式下每秒刷新一次显示的数据
  setInterval(() => { if (isViewportDebug()) update() }, 1000)
  window.visualViewport?.addEventListener('resize', update)
  window.visualViewport?.addEventListener('scroll', update)
  window.addEventListener('resize', update)
  window.addEventListener('pageshow', update)
  document.addEventListener('visibilitychange', update)
  document.addEventListener('focusin', () => setTimeout(update, 50))
  document.addEventListener('focusout', () => setTimeout(update, 50))
}
