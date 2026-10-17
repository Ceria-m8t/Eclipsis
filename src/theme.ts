// 全局外观：整体背景色调、底栏透明度。
// 背景画在外壳（Home.vue）最底层，页面和底栏都叠在上面，所以底栏的玻璃能透出背景，不再显得突兀。
// 聊天页有自己的背景（聊天样式里设的），进入聊天页时通过 pageBackdrop 临时盖掉全局背景。
import { ref, watch } from 'vue'
import { hexToRgba } from './utils'

export interface Theme {
  bgTop: string        // 渐变上端
  bgBottom: string     // 渐变下端
  tabbarOpacity: number
}

export const DEFAULT_THEME: Theme = {
  bgTop: '#e9eef7',
  bgBottom: '#f7f3ee',
  tabbarOpacity: 0.38,
}

// 预设色调（都偏浅）
export const THEME_PRESETS: { name: string; top: string; bottom: string }[] = [
  { name: '雾蓝', top: '#e9eef7', bottom: '#f7f3ee' },
  { name: '樱粉', top: '#f6e8ee', bottom: '#f8f2ef' },
  { name: '薄荷', top: '#e4f2ee', bottom: '#f4f6ef' },
  { name: '薰衣草', top: '#ebe7f6', bottom: '#f5f0f6' },
  { name: '晨杏', top: '#f8ece1', bottom: '#f6f1ea' },
  { name: '月白', top: '#eceef1', bottom: '#f6f6f4' },
]

const KEY = 'eclipsis-theme'

function load(): Theme {
  try {
    const s = localStorage.getItem(KEY)
    if (s) return { ...DEFAULT_THEME, ...JSON.parse(s) }
  } catch {}
  return { ...DEFAULT_THEME }
}

export const theme = ref<Theme>(load())

/** 当前页面想要的背景（CSS background 值的样式对象），空对象表示用全局背景 */
export const pageBackdrop = ref<Record<string, string> | null>(null)

function mix(a: string, b: string): string {
  // 中间色：两端各取一半
  const p = (h: string) => {
    const n = parseInt(h.replace('#', ''), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const [x, y] = [p(a), p(b)]
  return '#' + x.map((v, i) => Math.round((v + y[i]!) / 2).toString(16).padStart(2, '0')).join('')
}

export function applyTheme() {
  const t = theme.value
  const root = document.documentElement.style
  root.setProperty('--page-bg', `linear-gradient(165deg, ${t.bgTop} 0%, ${mix(t.bgTop, t.bgBottom)} 45%, ${t.bgBottom} 100%)`)
  root.setProperty('--tabbar-bg', hexToRgba('#ffffff', t.tabbarOpacity))
  // iOS 状态栏下方、橡皮筋露出的颜色
  document.body.style.backgroundColor = t.bgTop
}

export function startTheme() {
  applyTheme()
  watch(theme, () => {
    try { localStorage.setItem(KEY, JSON.stringify(theme.value)) } catch {}
    applyTheme()
  }, { deep: true })
}
