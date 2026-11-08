<script setup lang="ts">
// 书房 · 书架特写（2026-11-09）
//
// 书架是一张背景图（书格里是空的），书由代码一本一本摆上去：
//   中间两层：主 Prompt + 每一本世界书 + 一个「添一本」的空位，可以点
//   上下露出半截的两层：装饰用的书，不能点
// 点一本书：从书架抽出来 → 转过来露出封面 → 掀开封面、连翻几页 → 镜头推到右页 → 换成可以编辑的那一页（BookPage）。
// 点「完成」：存好，再倒着放一遍，书合上放回原位。
// 3D 用 CSS transform（preserve-3d），动画用 Web Animations，按顺序 await。
import '@fontsource/zcool-xiaowei/400.css'
import '@fontsource/cinzel-decorative/700.css'
import '@fontsource/noto-serif-sc/900.css'
import '@fontsource/ma-shan-zheng/400.css'
import { ref, computed, nextTick, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import BookPage from './BookPage.vue'
import {
  ASSET, SHELF_IMG, MAIN_LOOK, worldLook, loadWorldbook, saveWorldbook, spineTitle, coverTitle,
  loadBookFont, type BookLook, type WorldbookEntry
} from './books'
import { loadPrompt, savePrompt } from '../../../prompt-store'

const router = useRouter()

const MAIN_TITLE = '主 Prompt'
const NEW_TITLE = '新的一本'

// ── 数据 ──
const entries = ref<WorldbookEntry[]>(loadWorldbook())
const mainText = ref(loadPrompt().main)

// ── 书名字体（在设置页「外观」里选）──
const font = loadBookFont()

// ── 摆书 ──
// 书架图里的位置（比例）：books.py 量出来的搁板亮带，书底贴着它
const H_OVER_W = SHELF_IMG.h / SHELF_IMG.w
const BOOK_H = 0.165         // 最高那本普通书占书架图高度的比例（书格约 0.19）
// 手机上书太细，书名写不下：普通书横向加粗 30%（书脊图拉宽一点，花纹看不太出来）
const WIDEN = { world: 1.3, main: 1.12 }
const GAP = 0.006            // 书和书之间的空隙（占宽度）
const ROWS = [
  { bottom: 0.497, x0: 0.28, x1: 0.965 },   // 上面那层：左边有烛台，从 28% 开始摆
  { bottom: 0.787, x0: 0.105, x1: 0.965 }
]
const DECOR_ROWS = [
  { bottom: 0.196, x0: 0.105, x1: 1.0, seed: 3 },
  { bottom: 1.077, x0: 0.105, x1: 1.0, seed: 11 }
]

interface Item {
  key: string
  kind: 'main' | 'world' | 'add'
  index: number            // 世界书在 entries 里的位置；main/add 为 -1
  look: BookLook
  title: string
  enabled: boolean
}
interface Placed extends Item { x: number; bottom: number; w: number; h: number }

const items = computed<Item[]>(() => [
  { key: 'main', kind: 'main', index: -1, look: MAIN_LOOK, title: MAIN_TITLE, enabled: true },
  ...entries.value.map((e, i): Item => ({ key: `w${i}`, kind: 'world', index: i, look: worldLook(i), title: e.title, enabled: e.enabled })),
  { key: 'add', kind: 'add', index: -1, look: worldLook(entries.value.length), title: '', enabled: true }
])

function size(look: BookLook, k: number) {
  const h = BOOK_H * look.heightScale * k
  return { h, w: h * H_OVER_W * (look.spine.w / look.spine.h) * WIDEN[look.kind] }
}

function place(list: Item[], k: number): { placed: Placed[]; overflow: boolean } {
  const placed: Placed[] = []
  let row = 0
  let x = ROWS[0].x0
  for (const it of list) {
    const s = size(it.look, k)
    while (row < ROWS.length && x + s.w > ROWS[row].x1) { row++; if (row < ROWS.length) x = ROWS[row].x0 }
    if (row >= ROWS.length) return { placed, overflow: true }
    placed.push({ ...it, x, bottom: ROWS[row].bottom, w: s.w, h: s.h })
    x += s.w + GAP
  }
  return { placed, overflow: false }
}

// 书多了就整体缩小一点，最多缩到 0.6
const layout = computed<Placed[]>(() => {
  let k = 1
  let r = place(items.value, k)
  while (r.overflow && k > 0.6) { k -= 0.05; r = place(items.value, k) }
  return r.placed
})

// 装饰用的书：固定的伪随机顺序，每次打开都一样
const decor = computed(() => {
  const out: { key: string; look: BookLook; x: number; bottom: number; w: number; h: number }[] = []
  for (const row of DECOR_ROWS) {
    let seed = row.seed
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280
    let x = row.x0 + rnd() * 0.02
    while (x < row.x1) {
      const look = worldLook(Math.floor(rnd() * 8))
      const s = size(look, 1)
      out.push({ key: `d${row.seed}-${out.length}`, look, x, bottom: row.bottom, w: s.w, h: s.h })
      x += s.w + GAP + (rnd() < 0.18 ? 0.02 + rnd() * 0.03 : 0)
    }
  }
  return out
})

// 书名字体下载好以后再量一次字宽（没下载好时量的是系统字体）
const fontsReady = ref(0)
function spineLabel(it: { look: BookLook; title: string }) {
  void fontsReady.value
  return spineTitle(it.title, it.look.spine, font, WIDEN[it.look.kind])
}
function labelBox(look: BookLook) {
  const l = look.spine.label ?? { x: 0.3, y: 0.25, w: 0.4, h: 0.23 }
  return { left: `${l.x * 100}%`, top: `${l.y * 100}%`, width: `${l.w * 100}%`, height: `${l.h * 100}%` }
}

// ── 打开 / 合上 ──
const spineEls = new Map<string, HTMLElement>()
function setLeafEl(i: number, el: unknown) {
  if (el instanceof HTMLElement) leafEls[i] = el
}
function setSpineEl(key: string, el: unknown) {
  if (el instanceof HTMLElement) spineEls.set(key, el)
  else spineEls.delete(key)
}

interface Anim {
  look: BookLook
  W: number; H: number; T: number
  title: string
  /** 编辑页上的 1px 在书页上是多少 px（= 1 / 推近倍数），书页上的字按它缩 */
  u: number
  /** 书页上字的左右边距、上边距（px，书页自己的坐标），和编辑页对齐 */
  px: number; pt: number
}

// 书页比封面板子小一圈（真书的板子会比书页大一点），不然转书、翻开时纸从封面边上露出来
const INSET_X = 0.035     // 书口那边
const INSET_Y = 0.025     // 天头、地脚
const pageSize = (a: { W: number; H: number }) => ({ w: a.W * (1 - INSET_X), h: a.H * (1 - 2 * INSET_Y) })

function safeTop(): number {
  const d = document.createElement('div')
  d.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top)'
  document.body.appendChild(d)
  const v = parseFloat(getComputedStyle(d).paddingTop) || 0
  d.remove()
  return v
}
const anim = ref<Anim | null>(null)
// 书是不是翻开着：合着的时候书里面那几面（封底里面、封面里面、书页背面）直接藏起来。
// iOS Safari 在一层套一层的 3D 里常常不管 backface-visibility，合着时它们会从书脊旁边露出来（11-09 像一页纸腾空）
const bookOpen = ref(false)
const hiddenKey = ref<string | null>(null)
const busy = ref(false)

// 正在编辑的那本
interface Editing {
  kind: 'main' | 'world'
  index: number            // 世界书位置；新书为 -1
  isNew: boolean
  key: string              // 合上时飞回哪个位置
  draft: WorldbookEntry
}
const editing = ref<Editing | null>(null)
const showPage = ref(false)

const flyer = ref<HTMLElement | null>(null)
const turner = ref<HTMLElement | null>(null)
const cover = ref<HTMLElement | null>(null)
const backdrop = ref<HTMLElement | null>(null)
// 普通数组，不放进响应式：渲染时往里写 ref 不该触发重新渲染
let leafEls: HTMLElement[] = []
const LEAVES = 5

const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
const D = (ms: number) => (reduce ? 1 : ms)

function play(el: HTMLElement | null, frames: Keyframe[], ms: number, easing = 'cubic-bezier(.45,.05,.25,1)', delay = 0) {
  if (!el) return Promise.resolve()
  return el.animate(frames, { duration: D(ms), delay: D(delay), easing, fill: 'forwards' }).finished.then(() => {})
}

function viewport() {
  const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-top')) || 0
  const h = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-h')) || innerHeight
  return { w: innerWidth, h, cx: innerWidth / 2, cy: top + h / 2 }
}

/** 书在书架上的位置 → 飞行层的变换（书脊朝外、和书架上那本一样大） */
function shelfTransform(key: string, a: Anim): { t: string; s: number; r?: DOMRect } {
  const el = spineEls.get(key)
  const v = viewport()
  if (!el) return { t: `translate(0px, ${v.h}px) scale(0.3)`, s: 0.3 }
  const r = el.getBoundingClientRect()
  const s = r.height / a.H
  return { t: `translate(${r.left + r.width / 2 - v.cx}px, ${r.top + r.height / 2 - v.cy}px) scale(${s})`, s, r }
}

function zoomScale(W: number, H: number) {
  const v = viewport()
  return Math.max(v.w / W, v.h / H) * 1.02
}
function zoomTransform(a: Anim) {
  const pg = pageSize(a)
  const s = zoomScale(pg.w, pg.h)
  return `translate(${-s * pg.w / 2}px, 0px) scale(${s})`
}

// 皮扣：铰链在封面右边缘，往右翻开挂着。皮扣有厚度（几层叠起来，中间几层是皮子的侧边）
const claspT = (a: Anim) => Math.max(4, a.W * 0.03)      // 11-09 1.2% 太薄看不出来
const CLASP_CLOSED = (a: Anim) => `translateZ(${a.T / 2 + claspT(a) / 2 + 0.4}px) rotateY(0deg)`
const CLASP_OPEN = (a: Anim) => `translateZ(${a.T / 2 + claspT(a) / 2 + 0.4}px) rotateY(150deg)`
const CLASP_LAYERS = 8
const clasp = ref<HTMLElement | null>(null)

// 合上时书页在封面下面一摞；翻过去以后要压在封面衬页上面，而且角度和封面一样平，
// 不然靠近书脊那一截书页会比衬页低，衬页从缝里露出来（11-09 iOS 上露了一条）。
// 先翻的那页在最下面，后翻的叠在上面。
const OPEN_DEG = -179.6
const COVER_CLOSED = (a: Anim) => `translateZ(${a.T / 2}px) rotateY(0deg)`
const COVER_OPEN = (a: Anim) => `translateZ(${a.T / 2}px) rotateY(${OPEN_DEG}deg)`
const LEAF_CLOSED = (a: Anim, i: number) => `translateZ(${a.T / 2 - 1 - i * 0.35}px) rotateY(0deg)`
const LEAF_OPEN = (a: Anim, i: number) => `translateZ(${a.T / 2 + 1 + i * 0.6}px) rotateY(${OPEN_DEG}deg)`

// ── 按住一本书：书微微抽出来，上方浮出完整书名；松手不打开 ──
const peek = ref<{ key: string; title: string; x: number; top: number } | null>(null)
let pressTimer: ReturnType<typeof setTimeout> | null = null
let pressStart: { x: number; y: number } | null = null
let suppressClick = false
function onPressStart(it: Placed, e: PointerEvent) {
  if (busy.value) return
  suppressClick = false
  pressStart = { x: e.clientX, y: e.clientY }
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = setTimeout(() => {
    pressTimer = null
    suppressClick = true
    const title = it.kind === 'add' ? '添一本' : it.title || '无题'
    // 书名牌放在书的正上方；太靠边就往里挪，不出屏幕
    peek.value = { key: it.key, title, x: Math.min(0.82, Math.max(0.18, it.x + it.w / 2)), top: it.bottom - it.h }
    navigator.vibrate?.(8)
  }, 380)
}
function onPressMove(e: PointerEvent) {
  if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) onPressEnd()
}
function onPressEnd() {
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = null }
  pressStart = null
  peek.value = null
}
function onSpineClick(it: Placed) {
  if (suppressClick) { suppressClick = false; return }
  openItem(it)
}

async function openItem(it: Placed) {
  if (busy.value) return
  busy.value = true
  const look = it.look
  const v = viewport()
  const aspect = look.cover.w / look.cover.h
  const W = Math.min(v.w * 0.44, v.h * 0.58 * aspect)
  const H = W / aspect
  const T = H * (look.spine.w / look.spine.h) * WIDEN[look.kind]   // 和书架上一样粗
  const title = it.kind === 'add' ? NEW_TITLE : it.title
  // 推近以后书页中心对着屏幕中心：屏幕左边缘在书页上的 x = 页宽/2 - 屏宽/2/倍数
  const pg = pageSize({ W, H })
  const zs = zoomScale(pg.w, pg.h)
  const sideVw = it.kind === 'main' ? 0.10 : 0.13          // 和 BookPage 的左右边距一样
  const px = pg.w / 2 - v.w / 2 / zs + (v.w * sideVw + 3) / zs
  const pt = pg.h / 2 - v.h / 2 / zs + (safeTop() + v.h * 0.11 + 5) / zs
  anim.value = { look, W, H, T, title, u: 1 / zs, px, pt }

  if (it.kind === 'main') {
    editing.value = { kind: 'main', index: -1, isNew: false, key: 'main',
      draft: { title: MAIN_TITLE, content: mainText.value, enabled: true, group: '', position: 'after', priority: 50 } }
  } else if (it.kind === 'world') {
    editing.value = { kind: 'world', index: it.index, isNew: false, key: it.key, draft: { ...entries.value[it.index] } }
  } else {
    editing.value = { kind: 'world', index: -1, isNew: true, key: 'add',
      draft: { title: NEW_TITLE, content: '', enabled: true, group: '默认', position: 'after', priority: 50 } }
  }

  await nextTick()
  const a = anim.value
  const start = shelfTransform(it.key, a)
  hiddenKey.value = it.key
  // 起始姿势：书脊朝外，叠在书架上那本的位置
  flyer.value!.style.transform = start.t
  turner.value!.style.transform = 'translateX(0px) rotateY(90deg)'
  cover.value!.style.transform = COVER_CLOSED(a)
  if (clasp.value) clasp.value.style.transform = CLASP_CLOSED(a)
  leafEls.forEach((el, i) => (el.style.transform = LEAF_CLOSED(a, i)))

  // 1. 抽出来一点
  const lift = (start.r?.height ?? 100) * 0.05
  const pulled = start.t.replace(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/,
    (_m, x, y, s) => `translate(${x}px, ${Number(y) - lift}px) scale(${Number(s) * 1.07})`)
  await play(flyer.value, [{ transform: start.t }, { transform: pulled }], 280, 'cubic-bezier(.3,.7,.4,1)')
  // 2. 飞到屏幕中间，转过来露出封面
  await Promise.all([
    play(flyer.value, [{ transform: pulled }, { transform: 'translate(0px, 0px) scale(1)' }], 820),
    play(turner.value, [{ transform: 'translateX(0px) rotateY(90deg)' }, { transform: 'translateX(0px) rotateY(0deg)' }], 820),
    play(backdrop.value, [{ opacity: 0 }, { opacity: 1 }], 600)
  ])
  // 2.5 有皮扣的先解开
  if (clasp.value) await play(clasp.value, [{ transform: CLASP_CLOSED(a) }, { transform: CLASP_OPEN(a) }], 420, 'cubic-bezier(.4,.1,.3,1)')
  // 3. 掀开封面（书往右挪半本，摊开后两页居中）
  bookOpen.value = true
  await Promise.all([
    play(turner.value, [{ transform: 'translateX(0px) rotateY(0deg)' }, { transform: `translateX(${W / 2}px) rotateY(0deg)` }], 620),
    play(cover.value, [{ transform: COVER_CLOSED(a) }, { transform: COVER_OPEN(a) }], 620, 'cubic-bezier(.5,.1,.3,1)')
  ])
  // 4. 连翻几页
  await Promise.all(leafEls.map((el, i) =>
    play(el, [{ transform: LEAF_CLOSED(a, i) }, { transform: LEAF_OPEN(a, i) }], 460, 'cubic-bezier(.45,.1,.3,1)', i * 95)))
  // 5. 镜头推到右页，换成能写字的那一页
  const zoom = play(flyer.value, [{ transform: 'translate(0px, 0px) scale(1)' }, { transform: zoomTransform(a) }], 560, 'cubic-bezier(.5,0,.2,1)')
  setTimeout(() => (showPage.value = true), D(330))
  await zoom
  busy.value = false
}

async function closeBook(after?: () => void) {
  if (busy.value || !anim.value || !editing.value) return
  busy.value = true
  const a = anim.value
  showPage.value = false
  after?.()                       // 先存（新书会在这一步上书架，合上时飞回它的位置）
  const key = editing.value.key
  await nextTick()
  await play(flyer.value, [{ transform: zoomTransform(a) }, { transform: 'translate(0px, 0px) scale(1)' }], 520, 'cubic-bezier(.5,0,.2,1)')
  await Promise.all(leafEls.map((el, i) =>
    play(el, [{ transform: LEAF_OPEN(a, i) }, { transform: LEAF_CLOSED(a, i) }], 420, 'cubic-bezier(.45,.1,.3,1)', (LEAVES - 1 - i) * 85)))
  await Promise.all([
    play(turner.value, [{ transform: `translateX(${a.W / 2}px) rotateY(0deg)` }, { transform: 'translateX(0px) rotateY(0deg)' }], 560),
    play(cover.value, [{ transform: COVER_OPEN(a) }, { transform: COVER_CLOSED(a) }], 560, 'cubic-bezier(.5,.1,.3,1)')
  ])
  bookOpen.value = false
  if (clasp.value) await play(clasp.value, [{ transform: CLASP_OPEN(a) }, { transform: CLASP_CLOSED(a) }], 360, 'cubic-bezier(.5,.1,.3,1)')
  const target = shelfTransform(key, a)
  await Promise.all([
    play(flyer.value, [{ transform: 'translate(0px, 0px) scale(1)' }, { transform: target.t }], 780),
    play(turner.value, [{ transform: 'translateX(0px) rotateY(0deg)' }, { transform: 'translateX(0px) rotateY(90deg)' }], 780),
    play(backdrop.value, [{ opacity: 1 }, { opacity: 0 }], 700)
  ])
  finish()
}

function finish() {
  bookOpen.value = false
  hiddenKey.value = null
  anim.value = null
  editing.value = null
  leafEls = []
  busy.value = false
}

// ── 编辑页回来 ──
const toastMsg = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
function toast(m: string) {
  toastMsg.value = m
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastMsg.value = ''), 2600)
}

async function onDone(v: WorldbookEntry) {
  const ed = editing.value
  if (!ed) return
  if (ed.kind === 'main') {
    if (!v.content.trim()) { toast('主 Prompt 不能是空的'); return }
    let onServer = true
    if (v.content !== mainText.value) {
      const cur = loadPrompt()
      try { onServer = await savePrompt({ main: v.content, features: cur.features, featuresEnabled: cur.featuresEnabled }) }
      catch { toast('没存上：本机存储空间不够'); return }
      mainText.value = v.content
      toast(onServer ? '存好了，下一条消息开始生效' : '先存在了本机，服务器连上后会自动同步')
    }
    await closeBook()
    return
  }
  // 新书：什么都没写就当没拿过
  if (ed.isNew && v.title === NEW_TITLE && !v.content.trim()) { await closeBook(); return }
  await closeBook(() => {
    const list = entries.value.map(e => ({ ...e }))
    if (ed.isNew) {
      list.push(v)
      ed.key = `w${list.length - 1}`
      hiddenKey.value = ed.key
    } else {
      list[ed.index] = v
    }
    const changed = JSON.stringify(list) !== JSON.stringify(entries.value)
    if (changed) {
      entries.value = list
      saveWorldbook(list)
      toast('存好了')
    }
  })
}

async function onDiscard() {
  await closeBook()
}

async function onRemove() {
  const ed = editing.value
  if (!ed || ed.index < 0 || busy.value) return
  busy.value = true
  showPage.value = false
  const list = entries.value.filter((_, i) => i !== ed.index)
  await Promise.all([
    play(flyer.value, [{ opacity: 1 }, { opacity: 0 }], 450),
    play(backdrop.value, [{ opacity: 1 }, { opacity: 0 }], 600)
  ])
  entries.value = list
  saveWorldbook(list)
  toast('这本抽走了')
  finish()
}

function onHistory() {
  router.push('/settings/prompt')
}

const groups = computed(() => [...new Set(entries.value.map(e => e.group))])

// ── 进出书架 ──
const stage = ref<HTMLElement | null>(null)
onMounted(() => {
  const sample = [MAIN_TITLE, NEW_TITLE, ...entries.value.map(e => e.title)].join('')
  document.fonts?.load(`${font.weight} 20px ${font.family}`, sample).then(() => fontsReady.value++).catch(() => {})
  stage.value?.animate(
    [{ transform: 'translate(-50%, -50%) scale(1.1)', opacity: 0 }, { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 }],
    { duration: D(520), easing: 'cubic-bezier(.2,.7,.3,1)' })
})
function back() {
  if (busy.value) return
  sessionStorage.setItem('eclipsis-from-shelf', '1')
  router.push('/study')
}

const coverLabel = computed(() => {
  const a = anim.value
  if (!a) return null
  const l = a.look.cover.label ?? { x: 0.25, y: 0.34, w: 0.54, h: 0.22 }
  void fontsReady.value
  const t = coverTitle(a.title, a.look.cover, font)
  return { style: { left: `${l.x * 100}%`, top: `${l.y * 100}%`, width: `${l.w * 100}%`, height: `${l.h * 100}%` }, ...t }
})
// 翻页时每一面写一段内容（第 0 段在停下的那页上），只是做样子，每段截 260 字
const pageChunk = (n: number) => {
  const text = editing.value?.draft.content ?? ''
  return text.slice(n * 260, n * 260 + 260)
}
const animSpineLabel = computed(() => anim.value ? (void fontsReady.value, spineTitle(anim.value.title, anim.value.look.spine, font, WIDEN[anim.value.look.kind])) : null)
</script>

<template>
  <!-- 放到 body 下：底栏在外层的层级里，不挪出去会盖在书架上 -->
  <Teleport to="body">
  <div class="shelf-page">
    <div ref="stage" class="stage" :style="{ aspectRatio: `${SHELF_IMG.w} / ${SHELF_IMG.h}`, '--hw': H_OVER_W }">
      <img class="shelf-img" :src="ASSET + SHELF_IMG.file" alt="书架" draggable="false" />

      <!-- 装饰用的书 -->
      <div
        v-for="d in decor"
        :key="d.key"
        class="spine decor"
        :style="{ left: `${d.x * 100}%`, bottom: `${(1 - d.bottom) * 100}%`, width: `${d.w * 100}%`, height: `${d.h * 100}%`, '--mask': `url(${ASSET + d.look.spine.file}) center / 100% 100% no-repeat` }"
      >
        <img :src="ASSET + d.look.spine.file" alt="" draggable="false" />
      </div>

      <!-- 能拿的书 -->
      <button
        v-for="it in layout"
        :key="it.key"
        :ref="el => setSpineEl(it.key, el)"
        class="spine"
        :class="[it.kind, { off: !it.enabled, hidden: hiddenKey === it.key, peeking: peek?.key === it.key }]"
        :style="{ left: `${it.x * 100}%`, bottom: `${(1 - it.bottom) * 100}%`, width: `${it.w * 100}%`, height: `${it.h * 100}%`, '--mask': `url(${ASSET + it.look.spine.file}) center / 100% 100% no-repeat` }"
        :aria-label="it.kind === 'add' ? '添一本世界书' : it.title"
        @click="onSpineClick(it)"
        @pointerdown="onPressStart(it, $event)"
        @pointermove="onPressMove"
        @pointerup="onPressEnd"
        @pointercancel="onPressEnd"
        @pointerleave="onPressEnd"
        @contextmenu.prevent
      >
        <template v-if="it.kind !== 'add'">
          <img :src="ASSET + it.look.spine.file" alt="" draggable="false" />
          <!-- 主 Prompt 的书脊太窄，写不下字，靠日食徽章认；书名在封面上 -->
          <span v-if="it.kind !== 'main'" class="spine-title" :style="{ ...labelBox(it.look), fontFamily: font.family, fontWeight: font.weight }">
            <span :style="{ fontSize: `${spineLabel(it).size}cqh` }">{{ spineLabel(it).text }}</span>
          </span>
        </template>
        <span v-else class="add-slot"><span>＋</span></span>
      </button>

      <Transition name="peek">
        <div
          v-if="peek"
          class="peek glass"
          :style="{ left: `${peek.x * 100}%`, bottom: `calc(${(1 - peek.top) * 100}% + 10px)`, fontFamily: font.family, fontWeight: font.weight }"
        >{{ peek.title }}</div>
      </Transition>
    </div>

    <!-- 拿出来的那本（3D） -->
    <div v-if="anim" class="stage3d" :class="{ open: bookOpen }" :style="{ '--W': `${anim.W}px`, '--H': `${anim.H}px`, '--T': `${anim.T}px`, '--u': `${anim.u}px`, '--px': `${anim.px}px`, '--pt': `${anim.pt}px` }">
      <div ref="backdrop" class="backdrop"></div>
      <div ref="flyer" class="flyer">
        <div ref="turner" class="turner">
          <div class="book3d">
            <div class="face f-back" :style="{ backgroundImage: `url(${ASSET + anim.look.cover.file})` }"></div>
            <!-- 封底的里面（贴着衬页）：板子比书页大一圈，翻开后书页右边、上下露出来的就是它 -->
            <div class="face f-inback" :style="{ backgroundImage: `url(${ASSET + anim.look.endpaper.file})` }"></div>
            <div class="face f-spine">
              <img :src="ASSET + anim.look.spine.file" alt="" />
              <span v-if="animSpineLabel && anim.look.kind !== 'main'" class="spine-title" :style="{ ...labelBox(anim.look), fontFamily: font.family, fontWeight: font.weight }">
                <span :style="{ fontSize: `${animSpineLabel.size}cqh` }">{{ animSpineLabel.text }}</span>
              </span>
            </div>
            <div class="face f-fore"></div>
            <div class="face f-top"></div>
            <div class="face f-bottom"></div>
            <div class="face f-block" :class="anim.look.kind" :style="{ backgroundImage: `url(${ASSET + anim.look.page.file})` }">
              <div class="page-text first">
                <div class="pt-title" :style="{ fontFamily: font.family, fontWeight: font.weight }">{{ anim.title }}</div>
                <div class="pt-meta"></div>
                <div class="pt-body">{{ pageChunk(0) }}</div>
              </div>
            </div>
            <div
              v-for="i in LEAVES"
              :key="i"
              :ref="el => setLeafEl(i - 1, el)"
              class="leaf"
            >
              <div class="face lf" :class="anim.look.kind" :style="{ backgroundImage: `url(${ASSET + anim.look.page.file})` }">
                <div class="page-text"><div class="pt-body">{{ pageChunk(i * 2 - 1) }}</div></div>
              </div>
              <div class="face lb" :class="anim.look.kind" :style="{ backgroundImage: `url(${ASSET + anim.look.page.file})` }">
                <div class="page-text"><div class="pt-body">{{ pageChunk(i * 2) }}</div></div>
              </div>
            </div>
            <!-- 皮扣绕过书口的那一段（钉在封底上，翻开以后皮扣从这里挂出去） -->
            <div
              v-if="anim.look.clasp"
              class="clasp-band"
              :style="{ top: `${anim.look.clasp.box.y * 100}%`, height: `${anim.look.clasp.box.h * 100}%`, '--ct': `${claspT(anim)}px` }"
            ></div>
            <div
              v-if="anim.look.clasp"
              ref="clasp"
              class="clasp"
              :style="{ left: `${anim.look.clasp.box.x * 100}%`, top: `${anim.look.clasp.box.y * 100}%`, width: `${anim.look.clasp.box.w * 100}%`, height: `${anim.look.clasp.box.h * 100}%`, '--clasp': `url(${ASSET + anim.look.clasp.file})`, '--ct': `${claspT(anim)}px` }"
            >
              <img
                v-for="k in CLASP_LAYERS"
                :key="k"
                class="clasp-edge"
                :src="ASSET + anim.look.clasp.edge.file"
                alt=""
                :style="{ transform: `translateZ(calc(var(--ct) * ${(k / (CLASP_LAYERS + 1) - 0.5).toFixed(3)}))` }"
              />
              <img class="face clasp-front" :src="ASSET + anim.look.clasp.file" alt="" />
              <img class="face clasp-back" :src="ASSET + anim.look.clasp.back.file" alt="" />
            </div>
            <div ref="cover" class="cover">
              <div class="face cf">
                <img :src="ASSET + anim.look.cover.file" alt="" />
                <span v-if="coverLabel" class="cover-title" :style="{ ...coverLabel.style, fontFamily: font.family, fontWeight: font.weight }">
                  <span :style="{ fontSize: `${coverLabel.size}cqw` }">{{ coverLabel.text }}</span>
                </span>
              </div>
              <div class="face cb" :style="{ backgroundImage: `url(${ASSET + anim.look.endpaper.file})` }"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <Transition name="page">
      <BookPage
        v-if="showPage && editing && anim"
        :kind="editing.kind"
        :page="ASSET + anim.look.page.file"
        :title="editing.draft.title"
        :content="editing.draft.content"
        :enabled="editing.draft.enabled"
        :group="editing.draft.group"
        :position="editing.draft.position"
        :priority="editing.draft.priority"
        :groups="groups"
        :is-new="editing.isNew"
        :title-font="font.family"
        :title-weight="font.weight"
        @done="onDone"
        @discard="onDiscard"
        @remove="onRemove"
        @history="onHistory"
      />
    </Transition>

    <button class="glass corner back" :disabled="!!anim" @click="back">‹ 书房</button>
    <div v-if="toastMsg" class="toast glass">{{ toastMsg }}</div>
  </div>
  </Teleport>
</template>

<style scoped>
.shelf-page {
  position: fixed;
  left: 0; right: 0;
  top: var(--app-top, 0px);
  height: var(--app-h, 100dvh);
  z-index: 200;
  overflow: hidden;
  background: #0e1526;
}
/* 书架图铺满屏幕（像 background-size: cover），书按图里的比例摆，所以都放在这个盒子里 */
.stage {
  position: absolute;
  left: 50%; top: 50%;
  width: max(100vw, calc(var(--app-h, 100dvh) / var(--hw)));
  transform: translate(-50%, -50%);
}
.shelf-img {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  display: block;
  user-select: none; -webkit-user-drag: none;
}

.spine {
  position: absolute;
  padding: 0; border: none; background: none;
  container-type: size;
  filter: drop-shadow(-1.5px 1px 1.5px rgba(0, 0, 0, 0.45));
  -webkit-tap-highlight-color: transparent;
}
.spine img {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
  display: block;
  pointer-events: none;
}
/* 灯从上面照下来：上亮下暗 */
.spine::after {
  content: '';
  position: absolute; inset: 0;
  pointer-events: none;
  background: linear-gradient(to bottom, rgba(255, 214, 150, 0.14), rgba(255, 214, 150, 0) 35%, rgba(0, 0, 0, 0.28));
  -webkit-mask: var(--mask);
  mask: var(--mask);
}
.spine.decor { filter: brightness(0.82) drop-shadow(-1.5px 1px 1.5px rgba(0, 0, 0, 0.45)); pointer-events: none; }
.spine.off img, .spine.off .spine-title { filter: saturate(0.45) brightness(0.62); }
.spine.hidden { visibility: hidden; }
.spine:not(.decor):active { transform: translateY(-2%); }
.spine.peeking { transform: translateY(-5%); }
.spine:not(.decor) {
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

/* 按住时浮出的书名牌 */
.peek {
  position: absolute;
  transform: translateX(-50%);
  z-index: 5;
  max-width: 64vw;
  padding: 7px 14px;
  border-radius: 14px;
  font-size: 16px;
  line-height: 1.3;
  letter-spacing: 1px;
  text-align: center;
  color: var(--text);
  white-space: normal;
  word-break: break-word;
  pointer-events: none;
}
.peek-enter-active { transition: opacity 0.18s ease, transform 0.25s var(--spring); }
.peek-leave-active { transition: opacity 0.12s ease; }
.peek-enter-from { opacity: 0; transform: translateX(-50%) translateY(6px) scale(0.92); }
.peek-leave-to { opacity: 0; }
.spine { transition: transform 0.2s ease; }

.spine-title {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  pointer-events: none;
}
.spine-title > span {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  line-height: 1;
  white-space: nowrap;
  color: #3a210e;
  text-shadow: 0 0.04em 0 rgba(255, 240, 210, 0.45);
  letter-spacing: 0.04em;
}

.add-slot {
  position: absolute; inset: 4% 8%;
  border: 1.5px dashed rgba(240, 210, 150, 0.55);
  border-radius: 4px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(20, 24, 40, 0.18);
}
.add-slot span { color: rgba(250, 225, 170, 0.85); font-size: 22cqw; }
.spine.add { filter: none; }
.spine.add::after { display: none; }

/* ── 3D ── */
.stage3d {
  position: absolute; inset: 0;
  z-index: 220;
  perspective: 2200px;
  pointer-events: auto;
}
.backdrop {
  position: absolute; inset: 0;
  opacity: 0;
  background: radial-gradient(ellipse at center, rgba(10, 12, 24, 0.55), rgba(5, 6, 14, 0.82));
}
.flyer {
  position: absolute;
  left: 50%; top: 50%;
  width: var(--W); height: var(--H);
  margin-left: calc(var(--W) / -2);
  margin-top: calc(var(--H) / -2);
  transform-style: preserve-3d;
  will-change: transform;
}
.turner, .book3d {
  position: absolute; inset: 0;
  transform-style: preserve-3d;
}
.face {
  position: absolute;
  -webkit-backface-visibility: hidden;
  backface-visibility: hidden;
  background-size: 100% 100%;
}
.f-back {
  left: 0; top: 0; width: var(--W); height: var(--H);
  transform: rotateY(180deg) translateZ(calc(var(--T) / 2));
  filter: brightness(0.7);
  border-radius: 3px;
}
.stage3d:not(.open) .f-inback,
.stage3d:not(.open) .cb,
.stage3d:not(.open) .lb { visibility: hidden; }
.f-inback {
  left: 0; top: 0; width: var(--W); height: var(--H);
  transform: translateZ(calc(var(--T) / -2 + 0.6px));
  background-size: 100% 100%;
  border-radius: 3px;
  filter: brightness(0.85);
}
/* 皮扣绕过书口的那段：在书的右边缘，从封底到封面那么宽，朝右 */
.clasp-band {
  position: absolute;
  left: calc(var(--W) - var(--T) / 2 - var(--ct) / 2);
  width: calc(var(--T) + var(--ct));
  transform: rotateY(90deg) translateZ(0.5px);
  background: linear-gradient(#7a5528, #4a3016 60%, #2e1e0e);
  border-radius: 2px;
}
.f-spine {
  left: calc((var(--W) - var(--T)) / 2); top: 0;
  width: var(--T); height: var(--H);
  transform: rotateY(-90deg) translateZ(calc(var(--W) / 2));
  container-type: size;
}
.f-spine img { width: 100%; height: 100%; display: block; }
/* 书口、天头、地脚：一摞纸的边，金边书口 */
.book3d { --ix: calc(var(--W) * 0.035); --iy: calc(var(--H) * 0.025); }
.f-fore {
  left: calc((var(--W) - var(--T)) / 2 + 1px); top: var(--iy);
  width: calc(var(--T) - 2px); height: calc(var(--H) - 2 * var(--iy));
  transform: rotateY(90deg) translateZ(calc(var(--W) / 2 - var(--ix)));
  background: repeating-linear-gradient(to right, #e8d3a0 0 1px, #c9a75e 1px 2px), linear-gradient(#d8b874, #b08a40);
  background-blend-mode: multiply;
}
.f-top, .f-bottom {
  left: 0; top: calc((var(--H) - var(--T)) / 2 + 1px);
  width: calc(var(--W) - var(--ix)); height: calc(var(--T) - 2px);
  background: repeating-linear-gradient(to bottom, #efe2c2 0 1px, #d7c39a 1px 2px);
}
.f-top { transform: rotateX(90deg) translateZ(calc(var(--H) / 2 - var(--iy))); }
.f-bottom { transform: rotateX(-90deg) translateZ(calc(var(--H) / 2 - var(--iy))); }
.f-block {
  left: 0; top: var(--iy);
  width: calc(var(--W) - var(--ix)); height: calc(var(--H) - 2 * var(--iy));
  transform: translateZ(calc(var(--T) / 2 - 3px));
  background-size: cover;
  background-position: center;
  box-shadow: inset 10px 0 14px -8px rgba(60, 40, 20, 0.35);
}
.leaf {
  position: absolute;
  left: 0; top: var(--iy);
  width: calc(var(--W) - var(--ix)); height: calc(var(--H) - 2 * var(--iy));
  transform-origin: left center;
  transform-style: preserve-3d;
}
.leaf .face { inset: 0; background-size: cover; background-position: center; }
/* 书页上的字：照编辑页的排版按比例缩（编辑页 16px 字、31px 行、左右各 13vw），书页宽对应屏幕宽 */
.f-block, .leaf .face { container-type: size; overflow: hidden; }
.page-text {
  position: absolute; inset: 0;
  /* 停下那页推到满屏后，和编辑页的位置一一对上：--pt/--px/--u 由 openItem 按推近的倍数算好 */
  padding: var(--pt) var(--px) 0;
  color: #000;
  pointer-events: none;
}
.pt-title {
  text-align: center;
  font-size: calc(26 * var(--u));
  line-height: 1.3;
  color: #2a1a0c;
  letter-spacing: calc(2 * var(--u));
  white-space: pre-wrap;
  word-break: break-word;
}
.main .pt-title { color: #1d2140; }
.pt-meta { height: calc(25 * var(--u)); }
.pt-body {
  margin-top: calc(18 * var(--u));
  font-family: var(--app-font, var(--sans));
  font-size: calc(16 * var(--u));
  line-height: calc(31 * var(--u));
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 100%;
  overflow: hidden;
  background-image: repeating-linear-gradient(to bottom, transparent 0, transparent calc(31 * var(--u) - var(--u)),
    rgba(95, 70, 40, 0.24) calc(31 * var(--u) - var(--u)), rgba(95, 70, 40, 0.24) calc(31 * var(--u)));
}
.page-text:not(.first) .pt-body { margin-top: 0; }
.leaf .lf { box-shadow: inset 8px 0 12px -8px rgba(60, 40, 20, 0.35); }
.leaf .lb { transform: rotateY(180deg); filter: brightness(0.93); }
.clasp {
  position: absolute;
  transform-origin: right center;
  transform-style: preserve-3d;
}
.clasp .face, .clasp-edge { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.clasp-front {
  transform: translateZ(calc(var(--ct) / 2));
  filter: drop-shadow(-1px 1px 1.2px rgba(0, 0, 0, 0.55));
}
/* 背面：皮扣内侧是没有金属件的素皮子；中间几层是皮子侧边，斜着看时连成一条边。
   都是和正面同轮廓的图（books.py 生成），不用 CSS 遮罩：iOS 上翻过来的 3D 元素遮罩会失效，成了方口 */
.clasp-back { transform: rotateY(180deg) translateZ(calc(var(--ct) / 2)); }
.cover {
  position: absolute;
  left: 0; top: 0; width: var(--W); height: var(--H);
  transform-origin: left center;
  transform-style: preserve-3d;
}
.cover .face { inset: 0; }
.cf { container-type: size; }
.cf img { width: 100%; height: 100%; display: block; }
.cb { transform: rotateY(180deg); background-size: 100% 100%; border-radius: 3px; }
.cover-title {
  position: absolute;
  display: flex; align-items: center; justify-content: center;
  overflow: hidden;
  pointer-events: none;
}
.cover-title > span {
  white-space: pre;
  text-align: center;
  line-height: 1.15;
  color: #3a210e;
  text-shadow: 0 0.04em 0 rgba(255, 240, 210, 0.5);
  letter-spacing: 0.06em;
}

/* ── 角上的按钮 ── */
.corner {
  position: absolute;
  top: calc(var(--safe-top, 0px) + 12px);
  z-index: 210;
  border-radius: 18px;
  padding: 7px 14px;
  font-size: 13px;
  color: var(--text);
}
.corner:disabled { opacity: 0; pointer-events: none; }
.back { left: 14px; white-space: nowrap; }
.toast {
  position: absolute;
  left: 50%;
  bottom: calc(var(--safe-bottom, 0px) + 80px);
  transform: translateX(-50%);
  z-index: 240;
  padding: 8px 16px;
  border-radius: 16px;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
}

.page-enter-active { transition: opacity 0.28s ease; }
.page-leave-active { transition: opacity 0.22s ease; }
.page-enter-from, .page-leave-to { opacity: 0; }
</style>
