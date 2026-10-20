<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import Icon from '../components/Icon.vue'
import { getSettings } from '../settings'
import { loadMcpServers } from '../mcp'
import { renderMd, splitBubbles, splitThink } from '../markdown'
import { generate, finalizeVersion, buildContext, type BuiltContext } from '../chat-engine'
import { compressImage } from '../image'
import { copyText, hexToRgba, hhmm, dividerTime, downloadText } from '../utils'
import { keyboardOpen } from '../viewport'
import { pageBackdrop } from '../theme'
import { aiStatus } from '../status'
import { fontName, setFontFile, clearFont } from '../font'
import {
  type ChatMessage, type MessageVersion,
  getAllMessages, putMessage, deleteMessage as dbDelete, clearMessages,
  migrateFromLocalStorage, requestPersist, exportJson, importJson, newId
} from '../db'

const settings = ref(getSettings())

// ================= 聊天样式 =================
interface ChatStyle {
  bgColor: string
  bgImage: string
  aiBubbleBg: string
  aiBubbleOpacity: number
  userBubbleBg: string
  userBubbleOpacity: number
  headerOpacity: number   // 顶栏玻璃不透明度
  footerOpacity: number   // 输入栏玻璃不透明度
  fontSize: number
  customCSS: string
}

const STYLE_KEY = 'eclipsis-chat-style-v2'
const DEFAULT_STYLE: ChatStyle = {
  bgColor: '',
  bgImage: '',
  aiBubbleBg: '#ffffff',
  aiBubbleOpacity: 0.55,
  userBubbleBg: '#dfe7f5',
  userBubbleOpacity: 0.6,
  headerOpacity: 0.42,
  footerOpacity: 0.68,
  fontSize: 15,
  customCSS: ''
}

function loadStyle(): ChatStyle {
  try {
    const v2 = localStorage.getItem(STYLE_KEY)
    if (v2) {
      // 字体已经改成全局的（font.ts），这里不再带着
      const o = JSON.parse(v2)
      delete o.fontFamily; delete o.fontData
      return { ...DEFAULT_STYLE, ...o }
    }
    // 旧版：只沿用背景图、字体、自定义 CSS，气泡配色换成新的玻璃默认值
    const v1 = localStorage.getItem('eclipsis-chat-style')
    if (v1) {
      const o = JSON.parse(v1)
      return { ...DEFAULT_STYLE, bgImage: o.bgImage || '', fontSize: o.fontSize || 15, customCSS: o.customCSS || '' }
    }
  } catch {}
  return { ...DEFAULT_STYLE }
}

const chatStyle = ref<ChatStyle>(loadStyle())
let customStyleEl: HTMLStyleElement | null = null

function saveStyle() {
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(chatStyle.value))
  } catch {
    toast('样式保存失败：背景图或字体太大了')
  }
  applyCustomCSS()
}
watch(chatStyle, saveStyle, { deep: true })

function applyCustomCSS() {
  if (!customStyleEl) {
    customStyleEl = document.createElement('style')
    customStyleEl.id = 'eclipsis-custom-css'
    document.head.appendChild(customStyleEl)
  }
  customStyleEl.textContent = chatStyle.value.customCSS
}

// 字体是全局的：这里导入后，顶栏、底栏、设置页也一起换
async function handleFontUpload(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  toast('正在加载字体…')
  try { await setFontFile(file); toast('字体已换好，全局生效') }
  catch (err: any) { toast(err.message) }
}

async function handleBgUpload(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  // 背景图存 localStorage，压小一点
  chatStyle.value.bgImage = await compressImage(file, 1400, 0.8)
}

const pageStyle = computed(() => {
  const s: Record<string, string> = {
    '--bubble-ai': hexToRgba(chatStyle.value.aiBubbleBg, chatStyle.value.aiBubbleOpacity),
    '--bubble-user': hexToRgba(chatStyle.value.userBubbleBg, chatStyle.value.userBubbleOpacity),
    '--bubble-font-size': chatStyle.value.fontSize + 'px',
    '--header-bg': `rgba(255, 255, 255, ${chatStyle.value.headerOpacity})`,
    '--footer-bg': `rgba(255, 255, 255, ${chatStyle.value.footerOpacity})`,
  }
  s['--footer-h'] = footerH.value + 'px'
  return s
})

// 聊天背景画在外壳的背景层（铺到底栏下面），没设置时用全局色调
const bgStyle = computed<Record<string, string> | null>(() => {
  const { bgColor, bgImage } = chatStyle.value
  if (!bgColor && !bgImage) return null
  const s: Record<string, string> = { background: bgColor || 'var(--page-bg)' }
  if (bgImage) {
    s.backgroundImage = `url(${bgImage})`
    s.backgroundSize = 'cover'
    s.backgroundPosition = 'center'
  }
  return s
})
watch(bgStyle, v => { pageBackdrop.value = v }, { immediate: true })

// ================= 消息 =================
const messages = ref<ChatMessage[]>([])
const loaded = ref(false)

function curVersion(m: ChatMessage): MessageVersion | undefined {
  return m.versions?.[m.activeVersion ?? 0]
}
function textOf(m: ChatMessage): string {
  return m.role === 'assistant' ? (curVersion(m)?.content ?? m.content) : m.content
}

// 防抖保存：流式输出过程中每 2 秒落盘一次，崩溃或刷新也不会全丢
const saveTimers = new Map<string, number>()
function persist(m: ChatMessage, immediate = false) {
  const t = saveTimers.get(m.id)
  if (t) clearTimeout(t)
  saveTimers.delete(m.id)
  const run = () => putMessage(m).catch(err => toast('保存失败：' + (err?.message || err)))
  if (immediate) return run()
  saveTimers.set(m.id, window.setTimeout(() => { saveTimers.delete(m.id); run() }, 2000))
}

function nextSeq(): number {
  const last = messages.value[messages.value.length - 1]
  return Math.max(Date.now(), last ? last.seq + 1 : 0)
}

// ================= 显示分组 =================
interface Row {
  key: string
  msg: ChatMessage
  index: number
  parts: string[]          // 拆分后的气泡
  thinking: string         // 原生思考 + 正文里 <think> 标签拆出来的部分
  showAvatar: boolean      // 连续消息只有第一条显示头像
  divider?: string         // 上方的居中时间
  isLastOfGroup: boolean
}

const GAP_MS = 5 * 60 * 1000

// 只渲染最近的若干条，记录很长时手机不卡；往上翻可以加载更早的
const PAGE = 150
const visibleCount = ref(PAGE)
const hiddenCount = computed(() => Math.max(0, messages.value.length - visibleCount.value))
function loadEarlier() {
  const el = chatArea.value
  const before = el ? el.scrollHeight - el.scrollTop : 0
  visibleCount.value += PAGE
  nextTick(() => { if (el) el.scrollTop = el.scrollHeight - before })
}

const rows = computed<Row[]>(() => {
  const list = messages.value
  const start = hiddenCount.value
  return list.slice(start).map((m, j) => {
    const i = start + j
    const prev = list[i - 1]
    const next = list[i + 1]
    const gapBefore = !prev || m.createdAt - prev.createdAt > GAP_MS
    const gapAfter = !next || next.createdAt - m.createdAt > GAP_MS
    let text = textOf(m)
    let parts: string[]
    let thinking = ''
    if (m.role === 'assistant') {
      const sp = splitThink(text)
      text = sp.body
      thinking = [curVersion(m)?.thinking?.trim(), sp.think].filter(Boolean).join('\n\n')
      parts = text ? (settings.value.splitBubbles ? splitBubbles(text) : [text]) : []
    } else {
      parts = text ? [text] : []
    }
    return {
      key: m.id,
      msg: m,
      index: i,
      parts,
      thinking,
      showAvatar: gapBefore || prev.role !== m.role,
      divider: gapBefore ? dividerTime(m.createdAt) : undefined,
      isLastOfGroup: gapAfter || next.role !== m.role
    }
  })
})

// ================= 输入 =================
const inputText = ref('')
const pendingImages = ref<string[]>([])
const inputEl = ref<HTMLTextAreaElement | null>(null)
const composing = ref(false)

function autoGrow() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

// 回车：把这一句先发出去（不触发回复）；发送按钮：让他回复
function onInputKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey) return
  // 中文输入法选字时的回车不算
  if (composing.value || e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  pushUserMessage()
}

async function pushUserMessage(): Promise<boolean> {
  const text = inputText.value.trim()
  if (!text && !pendingImages.value.length) return false
  const now = Date.now()
  const msg: ChatMessage = {
    id: newId(), seq: nextSeq(), role: 'user', createdAt: now,
    content: text,
    images: pendingImages.value.length ? [...pendingImages.value] : undefined
  }
  messages.value.push(msg)
  inputText.value = ''
  pendingImages.value = []
  nextTick(autoGrow)
  stickToBottom = true
  scrollToBottom()
  await persist(msg, true)
  return true
}

// 等待他回复的用户消息条数（最后一条 assistant 之后的）
const unanswered = computed(() => {
  let n = 0
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].role === 'assistant') break
    n++
  }
  return n
})

async function onSendButton() {
  if (generating.value) { stopGenerating(); return }
  await pushUserMessage()
  if (unanswered.value === 0) { toast('先说点什么吧'); return }
  await runGeneration()
}

async function handleImageSelect(e: Event) {
  showPlus.value = false
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    try { pendingImages.value.push(await compressImage(f)) }
    catch { toast('有一张图片读不出来') }
  }
}

// ================= 生成 =================
const generating = ref(false)

// ---- 顶栏爱心：两段描边沿轮廓逆时针转，前头各一颗小圆点 ----
// 用 JS 驱动，加速/减速时位置连续，不会跳
const heartEl = ref<SVGPathElement | null>(null)
const heartPhase = ref(0)            // 0~100，对应 stroke-dashoffset
const heartDots = ref<[number, number][]>([])
let heartRaf = 0
let heartLast = 0
function heartTick(t: number) {
  const dt = heartLast ? Math.min(t - heartLast, 100) : 0
  heartLast = t
  const period = generating.value ? 2400 : 4800   // 平时慢，他输入时快一倍
  heartPhase.value = (heartPhase.value + dt / period * 100) % 100
  const el = heartEl.value
  if (el) {
    const len = el.getTotalLength()
    // dasharray 42 8 42 8：描边从路径位置 -phase 和 50-phase 开始；
    // 图案朝路径起点方向走，所以描边的"前头"就是这个起点
    heartDots.value = [0, 50].map(o => {
      const f = ((o - heartPhase.value) % 100 + 100) % 100
      const q = el.getPointAtLength(len * f / 100)
      return [q.x, q.y] as [number, number]
    })
  }
  heartRaf = requestAnimationFrame(heartTick)
}
let abortCtrl: AbortController | null = null
const lastCtx = ref<BuiltContext | null>(null)

// target: 要写入的 assistant 消息；不传则新建一条
async function runGeneration(target?: ChatMessage) {
  if (generating.value) return
  settings.value = getSettings()
  generating.value = true
  abortCtrl = new AbortController()

  let msg: ChatMessage
  let history: ChatMessage[]
  if (target) {
    msg = target
    const idx = messages.value.indexOf(target)
    history = messages.value.slice(0, idx)
  } else {
    history = messages.value.slice()
    msg = { id: newId(), seq: nextSeq(), role: 'assistant', createdAt: Date.now(), content: '', versions: [], activeVersion: 0 }
    messages.value.push(msg)
    // 拿到响应式代理，后续改动才会刷新界面
    msg = messages.value[messages.value.length - 1]
  }

  const version: MessageVersion = { content: '', createdAt: Date.now() }
  msg.versions = msg.versions || []
  msg.versions.push(version)
  msg.activeVersion = msg.versions.length - 1
  msg.error = undefined
  const live = msg.versions[msg.activeVersion]   // 响应式版本
  stickToBottom = true
  scrollToBottom()

  try {
    lastCtx.value = await generate(settings.value, history, loadMcpServers(), abortCtrl.signal, live, {
      onUpdate: () => {
        msg.content = live.content
        persist(msg)
        scrollToBottom()
      }
    })
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      msg.error = err?.message || String(err)
    }
  } finally {
    finalizeVersion(live)
    msg.content = live.content
    // 什么都没生成出来又没报错（被立刻停止），去掉这个空版本
    if (!live.content && !live.tools?.length && !msg.error) {
      msg.versions.splice(msg.activeVersion!, 1)
      msg.activeVersion = Math.max(0, msg.versions.length - 1)
      if (!msg.versions.length) removeLocal(msg)
    }
    if (messages.value.includes(msg)) await persist(msg, true)
    else saveTimers.delete(msg.id)
    generating.value = false
    abortCtrl = null
    scrollToBottom()
  }
}

function stopGenerating() {
  abortCtrl?.abort()
}

function removeLocal(m: ChatMessage) {
  const t = saveTimers.get(m.id)
  if (t) { clearTimeout(t); saveTimers.delete(m.id) }
  const i = messages.value.indexOf(m)
  if (i >= 0) messages.value.splice(i, 1)
  dbDelete(m.id).catch(() => {})
}

// ================= 输入栏 + 功能面板 =================
// 以后加功能只改这个列表：ready=false 的先灰着显示"开发中"
interface PlusItem { key: string; label: string; icon: string; ready: boolean; run?: () => void }
const showPlus = ref(false)
const plusPage = ref(0)
const imageInput = ref<HTMLInputElement | null>(null)
const cameraInput = ref<HTMLInputElement | null>(null)
const plusItems = computed<PlusItem[]>(() => [
  // 第一页：聊天里常用
  { key: 'image', label: '图片', icon: 'image', ready: true, run: () => imageInput.value?.click() },
  { key: 'camera', label: '拍照', icon: 'camera', ready: true, run: () => cameraInput.value?.click() },
  { key: 'sticker', label: '表情包', icon: 'smile', ready: false },
  { key: 'voice', label: '语音', icon: 'mic', ready: false },
  { key: 'video', label: '视频', icon: 'video', ready: false },
  { key: 'file', label: '文件', icon: 'file', ready: false },
  { key: 'call', label: '通话', icon: 'phone', ready: false },
  { key: 'regen', label: '重新生成', icon: 'refresh', ready: !generating.value && !!lastAssistant.value, run: regenerateLast },
  // 第二页：管理（原来侧栏里的）
  { key: 'style', label: '聊天样式', icon: 'palette', ready: true, run: () => { showPlus.value = false; showStylePanel.value = true } },
  { key: 'export', label: '导出记录', icon: 'download', ready: true, run: doExport },
  { key: 'import', label: '导入记录', icon: 'upload', ready: true, run: () => { showPlus.value = false; importInput.value?.click() } },
  { key: 'clear', label: '清空记录', icon: 'trash', ready: !!messages.value.length, run: () => { showPlus.value = false; showClearConfirm.value = true } },
])
const PLUS_PER_PAGE = 8
const plusPages = computed(() => {
  const out: PlusItem[][] = []
  for (let i = 0; i < plusItems.value.length; i += PLUS_PER_PAGE) out.push(plusItems.value.slice(i, i + PLUS_PER_PAGE))
  return out
})
const lastAssistant = computed(() => [...messages.value].reverse().find(m => m.role === 'assistant'))

function togglePlus() {
  if (showPlus.value) { showPlus.value = false; return }
  // 键盘开着就先收起，面板占键盘的位置
  inputEl.value?.blur()
  showPlus.value = true
}
function onPlusItem(it: PlusItem) {
  if (!it.ready) { toast(`${it.label}还在做`); return }
  it.run?.()
}
function onPlusScroll(e: Event) {
  const el = e.target as HTMLElement
  plusPage.value = Math.round(el.scrollLeft / Math.max(1, el.clientWidth))
}
function regenerateLast() {
  const m = lastAssistant.value
  if (!m || generating.value) return
  showPlus.value = false
  regenerate(m)
}

function regenerate(m: ChatMessage) {
  if (generating.value) return
  closeSheet()
  runGeneration(m)
}

function switchVersion(m: ChatMessage, delta: number) {
  if (!m.versions?.length || generating.value) return
  const n = m.versions.length
  m.activeVersion = ((m.activeVersion ?? 0) + delta + n) % n
  m.content = curVersion(m)?.content ?? ''
  persist(m, true)
}

function retry(m: ChatMessage) {
  // 出错的那个空版本去掉再重来
  const v = curVersion(m)
  if (v && !v.content && m.versions) m.versions.splice(m.activeVersion!, 1)
  m.error = undefined
  runGeneration(m)
}

// ================= 滚动 =================
const chatArea = ref<HTMLElement | null>(null)
let stickToBottom = true
let scrollQueued = false

function onScroll() {
  const el = chatArea.value
  if (!el) return
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}

function scrollToBottom(force = false) {
  if (!force && !stickToBottom) return
  if (scrollQueued) return
  scrollQueued = true
  nextTick(() => requestAnimationFrame(() => {
    scrollQueued = false
    const el = chatArea.value
    if (el) el.scrollTop = el.scrollHeight
  }))
}

// 输入栏高度变化时同步给内容区留白
const footerEl = ref<HTMLElement | null>(null)
const footerH = ref(90)
let ro: ResizeObserver | null = null

// ================= 折叠块 =================
const expanded = ref<Record<string, boolean>>({})
function toggle(key: string) {
  expanded.value[key] = !expanded.value[key]
  if (expanded.value[key]) stickToBottom = false
}

function prettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s }
}

// ================= 长按 / 操作面板 =================
type SheetMode = 'menu' | 'select' | 'edit' | 'confirm-delete' | 'confirm-delete-version'
const sheet = ref<{ msg: ChatMessage; mode: SheetMode } | null>(null)
const editText = ref('')

function openSheet(m: ChatMessage) {
  if (navigator.vibrate) navigator.vibrate(10)
  sheet.value = { msg: m, mode: 'menu' }
}
function closeSheet() { sheet.value = null }

let pressTimer: number | null = null
let pressStart = { x: 0, y: 0 }
function onPressStart(e: PointerEvent, m: ChatMessage) {
  if (e.pointerType === 'mouse') return
  pressStart = { x: e.clientX, y: e.clientY }
  pressTimer = window.setTimeout(() => { pressTimer = null; openSheet(m) }, 500)
}
function onPressMove(e: PointerEvent) {
  if (!pressTimer) return
  if (Math.abs(e.clientX - pressStart.x) > 8 || Math.abs(e.clientY - pressStart.y) > 8) cancelPress()
}
function cancelPress() {
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = null }
}

async function doCopy(m: ChatMessage) {
  // 复制时不带 <think> 里的内容
  const ok = await copyText(m.role === 'assistant' ? splitThink(textOf(m)).body : textOf(m))
  toast(ok ? '已复制' : '复制失败，可以用"选择复制"')
  if (sheet.value) closeSheet()
}

function startEdit() {
  if (!sheet.value) return
  editText.value = textOf(sheet.value.msg)
  sheet.value.mode = 'edit'
}

function saveEdit() {
  if (!sheet.value) return
  const m = sheet.value.msg
  const text = editText.value
  if (m.role === 'assistant') {
    const v = curVersion(m)
    if (v) {
      v.content = text
      // 手动改过的内容不再按原样回放工具调用轮次，以改后的文字为准
      delete v.trail
    }
  }
  m.content = text
  persist(m, true)
  closeSheet()
  toast('已修改')
}

function confirmDelete() {
  if (!sheet.value) return
  removeLocal(sheet.value.msg)
  closeSheet()
  toast('已删除')
}

function confirmDeleteVersion() {
  if (!sheet.value) return
  const m = sheet.value.msg
  if (!m.versions || m.versions.length <= 1) { confirmDelete(); return }
  m.versions.splice(m.activeVersion ?? 0, 1)
  m.activeVersion = Math.min(m.activeVersion ?? 0, m.versions.length - 1)
  m.content = curVersion(m)?.content ?? ''
  persist(m, true)
  closeSheet()
  toast('已删除这个版本')
}

async function shareMsg(m: ChatMessage) {
  const text = textOf(m)
  closeSheet()
  if (navigator.share) {
    try { await navigator.share({ text }) } catch {}
  } else {
    doCopy(m)
  }
}

// ================= 聊天样式面板 / 记录管理 =================
const showStylePanel = ref(false)
const showClearConfirm = ref(false)
const importInput = ref<HTMLInputElement | null>(null)

const ctxInfo = computed(() => {
  const c = lastCtx.value || (loaded.value ? buildContext(messages.value, settings.value.contextTokens) : null)
  if (!c) return ''
  const total = c.historyTokens + c.systemTokens
  let s = `约 ${(total / 1000).toFixed(1)}k tokens（提示词 ${(c.systemTokens / 1000).toFixed(1)}k + 聊天 ${(c.historyTokens / 1000).toFixed(1)}k）`
  if (c.droppedCount > 0) s += `，最早的 ${c.droppedCount} 条没有发送`
  return s
})

async function doExport() {
  showPlus.value = false
  const json = await exportJson()
  const d = new Date()
  const name = `eclipsis-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`
  // iOS 主屏幕模式下下载链接不可靠，优先用系统分享面板（可以存到"文件"）
  const file = new File([json], name, { type: 'application/json' })
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return } catch (e: any) { if (e?.name === 'AbortError') return }
  }
  downloadText(name, json)
}

async function doImport(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const n = await importJson(await file.text())
    messages.value = await getAllMessages()
    toast(`导入了 ${n} 条`)
    scrollToBottom(true)
  } catch (err: any) {
    toast('导入失败：' + err.message)
  }
}

async function doClear() {
  await clearMessages()
  messages.value = []
  showClearConfirm.value = false
  toast('已清空')
}

// 键盘开合时保持在底部
watch(keyboardOpen, () => scrollToBottom())


// ================= 代码块复制（v-html 内容用事件委托）=================
async function onAreaClick(e: MouseEvent) {
  showPlus.value = false
  const btn = (e.target as HTMLElement).closest('.code-copy') as HTMLButtonElement | null
  if (!btn) return
  const code = btn.closest('.code-block')?.querySelector('code')?.textContent || ''
  const ok = await copyText(code)
  btn.textContent = ok ? '已复制' : '失败'
  setTimeout(() => { btn.textContent = '复制' }, 1500)
}

// ================= 图片预览 =================
const previewImg = ref('')

// ================= Toast =================
const toastMsg = ref('')
let toastTimer: number | null = null
function toast(t: string) {
  toastMsg.value = t
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toastMsg.value = '' }, 1800)
}

// ================= 生命周期 =================
onMounted(async () => {
  document.documentElement.classList.add('chat-open')
  heartRaf = requestAnimationFrame(heartTick)
  applyCustomCSS()
  try {
    const migrated = await migrateFromLocalStorage()
    messages.value = await getAllMessages()
    if (migrated) toast(`已把 ${migrated} 条旧记录搬进新存储`)
  } catch (err: any) {
    toast('读取聊天记录失败：' + err.message)
  }
  loaded.value = true
  requestPersist()
  scrollToBottom(true)

  if (footerEl.value && 'ResizeObserver' in window) {
    ro = new ResizeObserver(() => {
      footerH.value = footerEl.value?.offsetHeight || 90
      scrollToBottom()
    })
    ro.observe(footerEl.value)
  }
})

onBeforeUnmount(() => {
  document.documentElement.classList.remove('chat-open')
  cancelAnimationFrame(heartRaf)
  pageBackdrop.value = null
  ro?.disconnect()
  // 离开页面前把待保存的写进去
  for (const [id, t] of saveTimers) {
    clearTimeout(t)
    const m = messages.value.find(x => x.id === id)
    if (m) putMessage(m)
  }
  abortCtrl?.abort()
})

const subtitle = computed(() => settings.value.chatSubtitle || '')
</script>

<template>
  <div class="chat-page shell-page" :style="pageStyle">
    <!-- ===== 顶栏：通栏卡片，头像在两端，中间心电图爱心、名字、状态 ===== -->
    <header class="chat-header">
      <div class="header-card glass header-glass">
        <img :src="settings.avatarAI" class="h-avatar" :alt="settings.nameAI" />
        <div class="header-mid">
          <!-- 心电图：两边的波形向中间流动，汇到爱心。他回复时跳得更快 -->
          <!-- 心电图（参考图三）：两端圆点 → 平线 → 大尖峰 → 汇入空心爱心。亮段从两边流向爱心 -->
          <svg class="pulse" viewBox="0 0 150 54" aria-hidden="true">
            <!-- 心电图（照红笔）：静止；每边一个波（照红笔）：小上 → 斜着往下 → 大上 → 回到平线，左右同序不镜像，两端不伸到头像边 -->
            <path class="pulse-base" d="M3 30 H18.5 L22.5 23.5 L27.5 44 L40.5 12 L44.5 30 H67.8 M82.2 30 H97.5 L101.5 23.5 L106.5 44 L119.5 12 L123.5 30 H147" />
            <circle class="pulse-dot" cx="3" cy="30" r="2" />
            <circle class="pulse-dot" cx="147" cy="30" r="2" />
            <!-- 空心爱心：两个相对的缺口，一起逆时针转；每段描边的前头一颗小圆点 -->
            <path ref="heartEl" class="heart-line" pathLength="100" :style="{ strokeDashoffset: heartPhase }" d="M75 35 C68 30.5 62 26.5 62 21 C62 17.5 64.8 15 68.2 15 C71.2 15 73.6 16.8 75 19.5 C76.4 16.8 78.8 15 81.8 15 C85.2 15 88 17.5 88 21 C88 26.5 82 30.5 75 35 Z" />
            <circle v-for="(d, i) in heartDots" :key="i" class="pulse-dot" :cx="d[0]" :cy="d[1]" r="1.9" />
          </svg>
          <div class="header-name">{{ settings.nameAI }}</div>
          <!-- 状态：他回复时显示"正在输入"；平时显示他自己设的状态；都没有就显示签名 -->
          <div v-if="generating || aiStatus || subtitle" class="header-status" aria-live="polite">
            <template v-if="generating"><span class="st-dot typing"></span>正在输入…</template>
            <template v-else-if="aiStatus"><span class="st-emoji">{{ aiStatus.emoji }}</span>{{ aiStatus.text }}</template>
            <template v-else>{{ subtitle }}</template>
          </div>
        </div>
        <img :src="settings.avatarUser" class="h-avatar" :alt="settings.nameUser" />
      </div>
    </header>

    <!-- 聊天样式：底部面板，只占下半屏，调的时候能看到上面聊天的变化 -->
    <Teleport defer to="#shell-overlay">
      <transition name="fade">
        <div v-if="showStylePanel" class="scrim scrim-light" @click="showStylePanel = false"></div>
      </transition>
      <transition name="sheet">
        <div v-if="showStylePanel" class="sheet style-sheet glass-strong" role="dialog" aria-modal="true" aria-label="聊天样式">
          <div class="sheet-grip" aria-hidden="true"></div>
          <div class="sheet-title">聊天样式</div>
          <div class="style-scroll">
            <div class="style-grid">
              <label>背景色
                <span class="row"><input type="color" :value="chatStyle.bgColor || '#eef0f5'" @input="chatStyle.bgColor = ($event.target as HTMLInputElement).value" />
                  <button v-if="chatStyle.bgColor" class="mini" @click="chatStyle.bgColor = ''">默认</button></span>
              </label>
              <label>背景图
                <span class="row">
                  <span class="mini upload">上传<input type="file" accept="image/*" hidden @change="handleBgUpload" /></span>
                  <button v-if="chatStyle.bgImage" class="mini" @click="chatStyle.bgImage = ''">清除</button>
                </span>
              </label>
              <label>他的气泡 <input type="color" v-model="chatStyle.aiBubbleBg" /></label>
              <label>透明度 {{ Math.round(chatStyle.aiBubbleOpacity * 100) }}%
                <input type="range" min="0.1" max="1" step="0.05" v-model.number="chatStyle.aiBubbleOpacity" /></label>
              <label>我的气泡 <input type="color" v-model="chatStyle.userBubbleBg" /></label>
              <label>透明度 {{ Math.round(chatStyle.userBubbleOpacity * 100) }}%
                <input type="range" min="0.1" max="1" step="0.05" v-model.number="chatStyle.userBubbleOpacity" /></label>
              <label class="full">顶栏透明度 {{ Math.round((1 - chatStyle.headerOpacity) * 100) }}%
                <input type="range" min="0.05" max="0.95" step="0.05" :value="1 - chatStyle.headerOpacity"
                  @input="chatStyle.headerOpacity = +(1 - +($event.target as HTMLInputElement).value).toFixed(2)" /></label>
              <label class="full">输入栏透明度 {{ Math.round((1 - chatStyle.footerOpacity) * 100) }}%
                <input type="range" min="0.05" max="0.95" step="0.05" :value="1 - chatStyle.footerOpacity"
                  @input="chatStyle.footerOpacity = +(1 - +($event.target as HTMLInputElement).value).toFixed(2)" /></label>
              <label class="full">字号 {{ chatStyle.fontSize }}px
                <input type="range" min="12" max="22" step="1" v-model.number="chatStyle.fontSize" /></label>
              <label class="full">字体（全局）{{ fontName ? '：' + fontName : '' }}
                <span class="row">
                  <span class="mini upload">导入 TTF/OTF<input type="file" accept=".ttf,.otf,.woff,.woff2" hidden @change="handleFontUpload" /></span>
                  <button v-if="fontName" class="mini" @click="clearFont">恢复系统字体</button>
                </span>
              </label>
              <label class="full">自定义 CSS
                <textarea v-model="chatStyle.customCSS" rows="4" spellcheck="false" placeholder=".bubble.ai { border-radius: 8px; }"></textarea>
              </label>
            </div>
          </div>
          <div class="sheet-row">
            <button class="sheet-btn ghost" @click="chatStyle = { ...DEFAULT_STYLE }">恢复默认</button>
            <button class="sheet-btn" @click="showStylePanel = false">完成</button>
          </div>
        </div>
      </transition>

      <!-- 清空确认 -->
      <transition name="fade">
        <div v-if="showClearConfirm" class="scrim" @click="showClearConfirm = false"></div>
      </transition>
      <transition name="sheet">
        <div v-if="showClearConfirm" class="sheet glass-strong" role="alertdialog" aria-modal="true" aria-label="清空聊天记录">
          <div class="sheet-grip" aria-hidden="true"></div>
          <div class="sheet-title">清空全部 {{ messages.length }} 条聊天记录？</div>
          <div class="sheet-hint">只删这台设备上的记录，删了找不回来。想留底的话先用"导出记录"。</div>
          <div class="sheet-row">
            <button class="sheet-btn ghost" @click="showClearConfirm = false">取消</button>
            <button class="sheet-btn danger" @click="doClear">清空</button>
          </div>
        </div>
      </transition>
    </Teleport>
    <input ref="importInput" type="file" accept="application/json,.json" hidden @change="doImport" />

    <!-- ===== 消息区 ===== -->
    <main
      ref="chatArea"
      class="chat-area"
      aria-live="polite"
      @scroll.passive="onScroll"
      @click="onAreaClick"
    >
      <button v-if="hiddenCount" class="load-earlier" @click="loadEarlier">
        还有 {{ hiddenCount }} 条更早的消息
      </button>
      <div v-if="loaded && !messages.length" class="chat-empty">说点什么吧</div>

      <template v-for="row in rows" :key="row.key">
        <div v-if="row.divider" class="time-divider"><span>{{ row.divider }}</span></div>

        <div :class="['msg-row', row.msg.role, { first: row.showAvatar }]">
          <div class="avatar-slot">
            <img
              v-if="row.showAvatar"
              :src="row.msg.role === 'assistant' ? settings.avatarAI : settings.avatarUser"
              class="msg-avatar"
              alt=""
            />
          </div>

          <div class="msg-col">
            <!-- 思考过程 -->
            <template v-if="row.msg.role === 'assistant' && row.thinking">
              <button class="fold-chip" :aria-expanded="!!expanded[row.key + ':think']" @click="toggle(row.key + ':think')">
                <Icon name="thought" :size="15" />
                <span>思考过程</span>
                <Icon name="chevron" :size="14" :class="['chev', { open: expanded[row.key + ':think'] }]" />
              </button>
              <div v-if="expanded[row.key + ':think']" class="fold-body glass">{{ row.thinking }}</div>
            </template>

            <!-- 工具调用 -->
            <template v-if="row.msg.role === 'assistant' && curVersion(row.msg)?.tools?.length">
              <button class="fold-chip" :aria-expanded="!!expanded[row.key + ':tools']" @click="toggle(row.key + ':tools')">
                <Icon name="tool" :size="15" />
                <span>
                  {{ curVersion(row.msg)!.tools!.some(t => t.status === 'running') ? '正在使用' : '使用了' }}
                  {{ [...new Set(curVersion(row.msg)!.tools!.map(t => t.name))].join('、') }}
                </span>
                <span v-if="curVersion(row.msg)!.tools!.some(t => t.status === 'error')" class="chip-err">有失败</span>
                <Icon name="chevron" :size="14" :class="['chev', { open: expanded[row.key + ':tools'] }]" />
              </button>
              <div v-if="expanded[row.key + ':tools']" class="tool-list">
                <div v-for="t in curVersion(row.msg)!.tools" :key="t.id" :class="['tool-item', 'glass', t.status]">
                  <div class="tool-head">
                    <span class="tool-dot" :aria-label="t.status"></span>
                    <span class="tool-name">{{ t.name }}</span>
                  </div>
                  <div class="tool-label">参数</div>
                  <pre class="tool-pre">{{ prettyJson(t.args) }}</pre>
                  <template v-if="t.result !== undefined">
                    <div class="tool-label">结果</div>
                    <pre class="tool-pre">{{ t.result }}</pre>
                  </template>
                </div>
              </div>
            </template>

            <div v-if="row.msg.images?.length" class="msg-images">
              <button v-for="(img, j) in row.msg.images" :key="j" class="img-btn" @click="previewImg = img">
                <img :src="img" class="msg-image" alt="图片" loading="lazy" />
              </button>
            </div>

            <div
              v-for="(part, j) in row.parts"
              :key="j"
              :class="['bubble', row.msg.role === 'assistant' ? 'ai markdown-body' : 'user']"
              @pointerdown="onPressStart($event, row.msg)"
              @pointermove="onPressMove"
              @pointerup="cancelPress"
              @pointercancel="cancelPress"
              @pointerleave="cancelPress"
              @contextmenu.prevent="openSheet(row.msg)"
            >
              <div v-if="row.msg.role === 'assistant'" v-html="renderMd(part)"></div>
              <span v-else v-text="part"></span>
            </div>

            <!-- 正在输入 -->
            <div
              v-if="row.msg.role === 'assistant' && generating && row.index === messages.length - 1 && !row.parts.length && !curVersion(row.msg)?.tools?.some(t => t.status === 'running')"
              class="bubble ai typing"
              aria-label="正在输入"
            ><i></i><i></i><i></i></div>

            <div v-if="row.msg.error" class="msg-error glass" role="alert">
              <Icon name="alert" :size="16" />
              <span class="err-text">{{ row.msg.error }}</span>
              <button class="err-retry" :disabled="generating" @click="retry(row.msg)">重试</button>
            </div>

            <!-- 他的消息下方的操作栏 -->
            <div
              v-if="row.msg.role === 'assistant' && !(generating && row.index === messages.length - 1)"
              class="msg-actions"
            >
              <button aria-label="复制" @click="doCopy(row.msg)"><Icon name="copy" :size="17" /></button>
              <button aria-label="重新生成" :disabled="generating" @click="regenerate(row.msg)"><Icon name="refresh" :size="17" /></button>
              <span v-if="(row.msg.versions?.length || 0) > 1" class="ver-switch">
                <button aria-label="上一个版本" @click="switchVersion(row.msg, -1)"><Icon name="left" :size="15" /></button>
                <span>{{ (row.msg.activeVersion ?? 0) + 1 }}/{{ row.msg.versions!.length }}</span>
                <button aria-label="下一个版本" @click="switchVersion(row.msg, 1)"><Icon name="right" :size="15" /></button>
              </span>
              <button aria-label="更多" @click="openSheet(row.msg)"><Icon name="more" :size="17" /></button>
              <span class="msg-time">{{ hhmm(row.msg.createdAt) }}</span>
            </div>
            <div v-else-if="row.msg.role === 'user' && row.isLastOfGroup" class="msg-time user-time">
              {{ hhmm(row.msg.createdAt) }}
            </div>
          </div>
        </div>
      </template>
      <!-- 底部占位：高度 = 输入栏实际高度，最后一条消息才能滚到输入栏上面 -->
      <div class="chat-tail" aria-hidden="true"></div>
    </main>

    <!-- ===== 输入栏 ===== -->
    <footer ref="footerEl" class="input-footer">
      <div class="input-capsule glass footer-glass">
        <div v-if="pendingImages.length" class="pending-images">
          <div v-for="(img, i) in pendingImages" :key="i" class="pending-thumb">
            <img :src="img" alt="待发送的图片" />
            <button aria-label="移除这张图片" @click="pendingImages.splice(i, 1)"><Icon name="close" :size="12" /></button>
          </div>
        </div>
        <textarea
          ref="inputEl"
          v-model="inputText"
          class="input-text"
          rows="1"
          :placeholder="unanswered ? `已发 ${unanswered} 条，点右边让他回复` : '说点什么…'"
          enterkeyhint="send"
          aria-label="输入消息"
          @input="autoGrow"
          @keydown="onInputKeydown"
          @focus="showPlus = false"
          @compositionstart="composing = true"
          @compositionend="composing = false"
        ></textarea>
        <div class="input-tools">
          <button
            :class="['tool-btn', 'plus-btn', { open: showPlus }]"
            :aria-label="showPlus ? '收起功能面板' : '更多功能'"
            :aria-expanded="showPlus"
            aria-controls="plus-panel"
            @click="togglePlus"
          >
            <Icon name="plus" />
          </button>
          <input ref="imageInput" type="file" accept="image/*" multiple hidden @change="handleImageSelect" />
          <input ref="cameraInput" type="file" accept="image/*" capture="environment" hidden @change="handleImageSelect" />
          <span class="input-model">{{ settings.model }}</span>
          <button
            :class="['send-btn', { stop: generating, ready: inputText.trim() || unanswered || pendingImages.length }]"
            :aria-label="generating ? '停止生成' : '让他回复'"
            @click="onSendButton"
          >
            <Icon :name="generating ? 'stop' : 'send'" />
          </button>
        </div>
        <!-- + 功能面板：和输入栏是同一张卡片，向下展开，可左右翻页 -->
        <transition name="plus">
          <div v-if="showPlus" id="plus-panel" class="plus-panel" role="region" aria-label="更多功能">
            <div class="plus-pages" @scroll.passive="onPlusScroll">
              <div v-for="(page, pi) in plusPages" :key="pi" class="plus-page">
                <button
                  v-for="it in page"
                  :key="it.key"
                  :class="['plus-item', { soon: !it.ready }]"
                  :aria-disabled="!it.ready"
                  @click="onPlusItem(it)"
                >
                  <span class="plus-icon"><Icon :name="it.icon" :size="24" /></span>
                  <span class="plus-label">{{ it.label }}</span>
                </button>
              </div>
            </div>
            <div v-if="plusPages.length > 1" class="plus-dots" aria-hidden="true">
              <span v-for="(_, pi) in plusPages" :key="pi" :class="{ on: pi === plusPage }"></span>
            </div>
            <div v-if="plusPage === plusPages.length - 1 && ctxInfo" class="plus-foot">{{ ctxInfo }}</div>
          </div>
        </transition>
      </div>

    </footer>

    <!-- ===== 消息操作面板（挂到外壳浮层，盖住底栏） ===== -->
    <Teleport defer to="#shell-overlay">
    <transition name="fade">
      <div v-if="sheet" class="scrim" @click="closeSheet"></div>
    </transition>
    <transition name="sheet">
      <div v-if="sheet" class="sheet glass-strong" role="dialog" aria-modal="true" aria-label="消息操作">
        <div class="sheet-grip" aria-hidden="true"></div>

        <template v-if="sheet.mode === 'menu'">
          <button class="sheet-item" @click="doCopy(sheet.msg)"><Icon name="copy" />复制全文</button>
          <button class="sheet-item" @click="editText = textOf(sheet.msg); sheet.mode = 'select'"><Icon name="select" />选择复制</button>
          <button class="sheet-item" @click="startEdit"><Icon name="edit" />编辑</button>
          <button class="sheet-item" @click="shareMsg(sheet.msg)"><Icon name="share" />分享</button>
          <button v-if="sheet.msg.role === 'assistant'" class="sheet-item" :disabled="generating" @click="regenerate(sheet.msg)"><Icon name="refresh" />重新生成</button>
          <button
            v-if="sheet.msg.role === 'assistant' && (sheet.msg.versions?.length || 0) > 1"
            class="sheet-item danger"
            @click="sheet.mode = 'confirm-delete-version'"
          ><Icon name="trash" />删除这个版本</button>
          <button class="sheet-item danger" @click="sheet.mode = 'confirm-delete'"><Icon name="trash" />删除这条消息</button>
        </template>

        <template v-else-if="sheet.mode === 'select'">
          <div class="sheet-title">选择要复制的文字</div>
          <textarea class="sheet-text" readonly :value="editText"></textarea>
          <button class="sheet-btn" @click="closeSheet">完成</button>
        </template>

        <template v-else-if="sheet.mode === 'edit'">
          <div class="sheet-title">编辑消息</div>
          <textarea v-model="editText" class="sheet-text" aria-label="消息内容"></textarea>
          <div class="sheet-row">
            <button class="sheet-btn ghost" @click="closeSheet">取消</button>
            <button class="sheet-btn" @click="saveEdit">保存</button>
          </div>
        </template>

        <template v-else>
          <div class="sheet-title">
            {{ sheet.mode === 'confirm-delete'
              ? (sheet.msg.versions && sheet.msg.versions.length > 1 ? `删除这条消息和它的全部 ${sheet.msg.versions.length} 个版本？` : '删除这条消息？')
              : '只删除当前这个版本？' }}
          </div>
          <div class="sheet-preview">{{ textOf(sheet.msg).slice(0, 120) || '（图片）' }}</div>
          <div class="sheet-hint">删除后找不回来</div>
          <div class="sheet-row">
            <button class="sheet-btn ghost" @click="closeSheet">取消</button>
            <button class="sheet-btn danger" @click="sheet.mode === 'confirm-delete' ? confirmDelete() : confirmDeleteVersion()">删除</button>
          </div>
        </template>
      </div>
    </transition>
    </Teleport>

    <!-- 图片预览 -->
    <transition name="fade">
      <div v-if="previewImg" class="img-preview" role="dialog" aria-label="图片预览" @click="previewImg = ''">
        <img :src="previewImg" alt="图片预览" />
      </div>
    </transition>

    <transition name="fade">
      <div v-if="toastMsg" class="toast glass-strong" role="status">{{ toastMsg }}</div>
    </transition>
  </div>
</template>

<style scoped>
.chat-page {
  color: var(--text);
  /* 心电图上沿：比安全区上沿高 10px，正好落在灵动岛/刘海下面，和它错开而不是整块空出。
     浏览器里没有安全区时按 30px 算 */
  --ecg-top: calc(max(var(--safe-top), 30px) - 10px);
}


/* ===== 顶栏 ===== */
.chat-header {
  position: absolute;
  top: 0; left: 0; right: 0;
  z-index: 20;
  display: flex;
  justify-content: center;
  /* 卡片贴到屏幕最顶上（延伸到状态栏后面），内容留在状态栏下方 */
  padding: 0 12px;
  pointer-events: none;
}
.chat-header > * { pointer-events: auto; }



/* 顶栏、输入栏用全局 .glass，只把底色换成可调透明度 */
.glass.header-glass { background: var(--header-bg); }
.glass.footer-glass { background: var(--footer-bg); }

/* 通栏卡片（参考图三）：圆角大卡片，头像在两端，中间一列 */
/* 按参考图二的比例：头像往里收，和中间一列靠拢；整组居中 */
/* 独立的圆角卡片，上沿收在状态栏下面一点 */
.header-card {
  width: 100%;
  margin-top: 8px;
  border-radius: 30px;
  /* 卡片上沿和灵动岛上沿齐平，内容从 --ecg-top 开始 */
  /* 头像位置回到 5dfa86b：左右内边距 16、间距 12，整组居中 */
  padding: calc(var(--ecg-top) - 8px) 16px 8px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 12px;
}
.h-avatar {
  width: 60px; height: 60px;
  flex-shrink: 0;
  /* 圆心和 5dfa86b 时一样（心电图上沿往下 18px），只是放大了一点 */
  margin-top: -12px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid rgba(255, 255, 255, 0.95);
  box-shadow: 0 3px 10px rgba(60, 72, 110, 0.16);
}
.header-mid {
  position: relative;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 名字和签名位置不变；心电图绝对定位，不占高度，尖峰可以落到名字两侧 */
  padding-top: 28px;
  /* 中间列宽 142：头像圆心正好回到 5dfa86b 的位置（iPhone 13 上 x=80） */
  flex: 0 1 142px;
}

.pulse {
  position: absolute;
  /* 基线落在名字上沿上方约 5px，爱心底尖贴着名字 */
  top: -7px; left: 50%;
  /* 两端离头像各留约 8px */
  width: 150px; height: 54px;
  transform: translateX(-50%);
  overflow: visible;
}
.pulse path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.pulse-base { stroke: #1d1d22; stroke-width: 1.3; }
.pulse-dot { fill: #1d1d22; }
/* 一圈 100：两段描边各 42、两个缺口各 8，缺口正好相对；偏移量由 heartTick 推进 */
.heart-line {
  stroke: #1d1d22;
  stroke-width: 1.5;
  stroke-dasharray: 42 8 42 8;
}

.header-name {
  margin-top: 0;
  line-height: 1.15;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
.header-status {
  margin-top: 0;
  line-height: 1.2;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.st-emoji { font-size: 12px; }
.st-dot { width: 6px; height: 6px; border-radius: 50%; background: #8fc7a0; flex-shrink: 0; }
.st-dot.typing { animation: st-blink 1s ease-in-out infinite; }
@keyframes st-blink { 50% { opacity: 0.3; } }

/* 聊天样式面板：浅遮罩、只占下半屏 */
.scrim-light { background: rgba(30, 36, 56, 0.06); }
.sheet.style-sheet { max-height: 58%; }
.style-scroll { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding-top: 4px; }
.plus-foot { padding: 8px 16px 0; font-size: 11px; line-height: 1.5; color: var(--text-3); text-align: center; }

/* ===== 消息区 ===== */
.chat-area {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  /* 卡片下沿 + 10px */
  padding: calc(var(--ecg-top) + 73px) 12px 0;
  display: flex;
  flex-direction: column;
}

.chat-tail { flex-shrink: 0; height: calc(var(--footer-h, 90px) + 16px); }

.load-earlier, .chat-empty {
  align-self: center;
  margin: 8px 0 16px;
  font-size: 12px;
  color: var(--text-2);
}
.load-earlier {
  border: 1px solid var(--glass-border);
  background: var(--glass-bg-soft);
  border-radius: 999px;
  padding: 6px 14px;
}
.chat-empty { margin-top: 30vh; font-size: 14px; color: var(--text-3); }

.time-divider {
  display: flex;
  justify-content: center;
  margin: 14px 0 8px;
}
.time-divider span {
  font-size: 11px;
  color: var(--text-2);
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(var(--glass-tint), 0.35);
  -webkit-backdrop-filter: var(--glass-blur-soft);
  backdrop-filter: var(--glass-blur-soft);
}

.msg-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 4px;
}
.msg-row.first { margin-top: 10px; }
.msg-row.user { flex-direction: row-reverse; }

.avatar-slot { width: 36px; flex-shrink: 0; }
.msg-avatar {
  width: 36px; height: 36px;
  border-radius: 50%;
  object-fit: cover;
  border: 1.5px solid rgba(255, 255, 255, 0.85);
  box-shadow: 0 2px 6px rgba(60, 72, 110, 0.12);
}

.msg-col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  max-width: calc(100% - 88px);
  min-width: 0;
}
.msg-row.user .msg-col { align-items: flex-end; }

/* ===== 气泡 ===== */
.bubble {
  max-width: 100%;
  /* 内边距和圆角跟着字号走（15px 时约 6/11、圆角 17），气泡更贴字 */
  padding: 0.4em 0.75em;
  border-radius: 1.15em;
  font-size: var(--bubble-font-size, 15px);
  font-family: inherit;
  line-height: 1.5;
  word-break: break-word;
  overflow-wrap: anywhere;
  border: 1px solid rgba(255, 255, 255, 0.65);
  -webkit-backdrop-filter: var(--glass-blur-soft);
  backdrop-filter: var(--glass-blur-soft);
  box-shadow: var(--glass-shadow-soft);
  /* 长按用自己的菜单，关掉系统的选择/放大镜 */
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
.bubble.ai { background: var(--bubble-ai); }
.bubble.user { background: var(--bubble-user); white-space: pre-wrap; }

.bubble.typing { display: flex; gap: 4px; padding: 13px 16px; }
.bubble.typing i {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--text-3);
  animation: dot 1.2s infinite ease-in-out;
}
.bubble.typing i:nth-child(2) { animation-delay: 0.15s; }
.bubble.typing i:nth-child(3) { animation-delay: 0.3s; }
@keyframes dot { 0%, 80%, 100% { transform: translateY(0); opacity: 0.4; } 40% { transform: translateY(-4px); opacity: 1; } }

/* Markdown */
.markdown-body :deep(p) { margin: 0 0 0.45em; }
.markdown-body :deep(p:last-child) { margin-bottom: 0; }
.markdown-body :deep(strong) { font-weight: 600; }
.markdown-body :deep(em) { color: rgba(70, 80, 120, 0.9); }
.markdown-body :deep(ul), .markdown-body :deep(ol) { padding-left: 1.3em; margin: 2px 0; }
.markdown-body :deep(li) { margin: 1px 0; }
.markdown-body :deep(h1), .markdown-body :deep(h2), .markdown-body :deep(h3), .markdown-body :deep(h4) {
  font-size: 1.02em; font-weight: 600; margin: 4px 0;
}
.markdown-body :deep(blockquote) {
  border-left: 3px solid rgba(111, 134, 184, 0.45);
  padding-left: 10px;
  color: var(--text-2);
}
.markdown-body :deep(a) { color: var(--accent); text-decoration: underline; }
.markdown-body :deep(:not(pre) > code) {
  font-family: var(--mono);
  font-size: 0.88em;
  background: rgba(0, 0, 0, 0.05);
  padding: 1px 5px;
  border-radius: 5px;
}
.markdown-body :deep(table) { border-collapse: collapse; font-size: 0.92em; display: block; overflow-x: auto; }
.markdown-body :deep(th), .markdown-body :deep(td) { border: 1px solid rgba(0, 0, 0, 0.08); padding: 4px 8px; }
.markdown-body :deep(img) { max-width: 100%; border-radius: 10px; }
.markdown-body :deep(hr) { border: none; border-top: 1px solid rgba(0, 0, 0, 0.08); margin: 6px 0; }

.markdown-body :deep(.code-block) {
  margin: 4px -4px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(0, 0, 0, 0.05);
  overflow: hidden;
}
.markdown-body :deep(.code-head) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px 4px 12px;
  background: rgba(0, 0, 0, 0.03);
  font-size: 12px;
}
.markdown-body :deep(.code-lang) { color: var(--text-2); font-family: var(--mono); }
.markdown-body :deep(.code-copy) {
  border: none;
  background: rgba(255, 255, 255, 0.8);
  border-radius: 8px;
  padding: 3px 10px;
  font-size: 12px;
  color: var(--text-2);
}
.markdown-body :deep(pre) {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.markdown-body :deep(pre code) {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.55;
  white-space: pre;
}

/* ===== 折叠块 ===== */
.fold-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: none;
  padding: 2px 4px;
  font-size: 13px;
  color: var(--text-2);
  max-width: 100%;
}
.fold-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip-err { color: var(--danger); font-size: 12px; }
.chev { transition: transform 0.2s; opacity: 0.7; }
.chev.open { transform: rotate(90deg); }
.fold-body {
  border-radius: 14px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  max-height: 40vh;
  overflow-y: auto;
  user-select: text;
  -webkit-user-select: text;
}
.tool-list { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.tool-item { border-radius: 14px; padding: 8px 10px; font-size: 12px; }
.tool-head { display: flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; }
.tool-dot { width: 7px; height: 7px; border-radius: 50%; background: #7fb08a; }
.tool-item.running .tool-dot { background: #d9b45a; animation: dot 1.2s infinite; }
.tool-item.error .tool-dot { background: var(--danger); }
.tool-label { margin-top: 6px; color: var(--text-3); font-size: 11px; }
.tool-pre {
  font-family: var(--mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow-y: auto;
  color: var(--text-2);
  user-select: text;
  -webkit-user-select: text;
}

/* ===== 图片 ===== */
.msg-images { display: flex; flex-wrap: wrap; gap: 6px; }
.img-btn { border: none; background: none; padding: 0; border-radius: 14px; overflow: hidden; }
.msg-image {
  display: block;
  max-width: 200px;
  max-height: 260px;
  border-radius: 14px;
  object-fit: cover;
  border: 1px solid rgba(255, 255, 255, 0.7);
}

/* ===== 错误 ===== */
.msg-error {
  display: flex;
  align-items: center;
  gap: 8px;
  border-radius: 14px;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--danger);
  max-width: 100%;
}
.err-text { flex: 1; min-width: 0; word-break: break-all; max-height: 4.8em; overflow: hidden; }
.err-retry {
  border: none;
  border-radius: 10px;
  padding: 4px 10px;
  background: rgba(255, 255, 255, 0.8);
  color: var(--text);
  flex-shrink: 0;
}

/* ===== 操作栏 ===== */
.msg-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 1px;
  color: var(--text-3);
}
.msg-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  width: 32px; height: 30px;
  border-radius: 10px;
  color: inherit;
}
.msg-actions button:active { background: var(--glass-bg-soft); }
.msg-actions button:disabled { opacity: 0.35; }
.ver-switch { display: inline-flex; align-items: center; font-size: 12px; }
.ver-switch button { width: 24px; }
.msg-time { font-size: 11px; color: var(--text-3); margin-left: 4px; }
.user-time { margin-top: 1px; padding: 0 4px; }

/* ===== + 功能面板 ===== */
.plus-btn { border: none; background: none; }
.plus-btn .icon { transition: transform 0.3s var(--spring); }
.plus-btn.open .icon { transform: rotate(45deg); }
.plus-btn.open { color: var(--text); }

/* 面板是输入栏卡片的下半部分：抵消卡片左右内边距，用一条淡分隔线隔开 */
.plus-panel {
  margin: 10px -10px 0 -18px;
  padding: 14px 0 2px;
  border-top: 1px solid rgba(60, 72, 110, 0.08);
  overflow: hidden;
}
.plus-pages {
  display: flex;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}
.plus-pages::-webkit-scrollbar { display: none; }
.plus-page {
  flex: 0 0 100%;
  scroll-snap-align: start;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  grid-template-rows: repeat(2, auto);
  gap: 14px 4px;
  padding: 0 10px;
  align-content: start;
}
.plus-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  border: none;
  background: none;
  color: var(--text);
  transition: transform 0.35s var(--spring);
}
.plus-item:active { transform: scale(var(--press-scale)); transition-duration: 0.08s; }
.plus-icon {
  width: 54px; height: 54px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 18px;
  background: var(--glass-bg-soft);
  border: 1px solid rgba(255, 255, 255, 0.8);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 2px 8px rgba(60, 72, 110, 0.07);
  color: var(--accent);
}
.plus-label { font-size: 12px; color: var(--text-2); }
.plus-item.soon .plus-icon { color: var(--text-3); background: rgba(255, 255, 255, 0.3); }
.plus-item.soon .plus-label { color: var(--text-3); }
.plus-dots { display: flex; justify-content: center; gap: 6px; padding-top: 10px; }
.plus-dots span { width: 6px; height: 6px; border-radius: 3px; background: rgba(60, 72, 110, 0.18); transition: width 0.25s, background 0.25s; }
.plus-dots span.on { width: 16px; background: rgba(60, 72, 110, 0.5); }
.plus-enter-active, .plus-leave-active { transition: transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.2s; }
.plus-enter-from, .plus-leave-to { transform: translateY(16px); opacity: 0; }

/* ===== 输入栏 ===== */
.input-footer {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  z-index: 20;
  padding: 0 12px 10px;
}
/* 键盘弹起时底部横条区域被键盘盖住，不需要再留安全区 */

.input-capsule {
  border-radius: 28px;
  padding: 14px 10px 10px 18px;
  display: flex;
  flex-direction: column;
}
.pending-images { display: flex; gap: 8px; padding: 2px 0 8px; overflow-x: auto; }
.pending-thumb { position: relative; flex-shrink: 0; }
.pending-thumb img { width: 56px; height: 56px; object-fit: cover; border-radius: 12px; display: block; }
.pending-thumb button {
  position: absolute; top: -5px; right: -5px;
  width: 20px; height: 20px;
  border-radius: 50%;
  border: none;
  background: rgba(40, 44, 60, 0.7);
  color: #fff;
  display: flex; align-items: center; justify-content: center;
}
.input-text {
  display: block;
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  font-size: 16px;   /* 小于 16px 时 iOS 聚焦会自动放大页面 */
  line-height: 1.5;
  max-height: 120px;
  padding: 4px 0 8px;
}
.input-text::placeholder { color: var(--text-3); }
.input-tools { display: flex; align-items: center; gap: 6px; }
.tool-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px;
  border-radius: 50%;
  color: var(--text-2);
  cursor: pointer;
}
.input-model {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.send-btn {
  width: 38px; height: 38px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.55);
  color: var(--text-3);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  transition: background 0.2s, color 0.2s, transform 0.35s var(--spring);
}
.send-btn.ready { background: rgba(111, 134, 184, 0.85); color: #fff; }
.send-btn.stop { background: rgba(40, 44, 60, 0.75); color: #fff; }
/* 按压回弹（参数在 style.css） */
.send-btn:active, .sheet-btn:active, .sheet-item:active, .msg-actions button:active,
.fold-chip:active, .tool-btn:active {
  transform: scale(var(--press-scale));
  transition-duration: 0.08s;
}
.sheet-btn, .sheet-item, .msg-actions button, .fold-chip, .tool-btn {
  transition: transform 0.35s var(--spring), background 0.15s;
}

/* ===== 底部面板 ===== */
.scrim {
  position: absolute; inset: 0;
  z-index: 40;
  background: rgba(30, 36, 56, 0.18);
}
.sheet {
  position: absolute;
  left: 8px; right: 8px; bottom: 8px;
  z-index: 41;
  border-radius: 28px;
  padding: 8px 10px calc(var(--safe-bottom) + 10px);
  max-height: 80%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.sheet-grip {
  width: 36px; height: 5px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.15);
  align-self: center;
  margin: 2px 0 8px;
  flex-shrink: 0;
}
.sheet-item {
  display: flex; align-items: center; gap: 14px;
  padding: 14px 14px;
  border: none; background: none;
  border-radius: 16px;
  font-size: 16px;
  text-align: left;
}
.sheet-item:active { background: var(--glass-bg-soft); }
.sheet-item:disabled { opacity: 0.4; }
.sheet-item.danger { color: var(--danger); }
.sheet-title { font-size: 15px; font-weight: 600; padding: 6px 8px 10px; }
.sheet-preview {
  margin: 0 8px;
  padding: 10px 12px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.55);
  font-size: 14px;
  color: var(--text-2);
  max-height: 120px;
  overflow: hidden;
}
.sheet-hint { font-size: 12px; color: var(--text-3); padding: 8px 10px 4px; }
.sheet-text {
  margin: 0 4px;
  min-height: 180px;
  max-height: 50vh;
  border-radius: 16px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  background: rgba(255, 255, 255, 0.7);
  padding: 12px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
  -webkit-user-select: text;
  user-select: text;
}
.sheet-row { display: flex; gap: 10px; padding: 12px 4px 2px; }
.sheet-btn {
  flex: 1;
  padding: 12px;
  border-radius: 16px;
  border: none;
  background: rgba(111, 134, 184, 0.9);
  color: #fff;
  font-size: 15px;
  margin: 10px 4px 0;
}
.sheet-row .sheet-btn { margin: 0; }
.sheet-btn.ghost { background: rgba(255, 255, 255, 0.75); color: var(--text); }
.sheet-btn.danger { background: var(--danger); }

.style-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px 14px;
  padding: 4px 6px;
  font-size: 13px;
  color: var(--text-2);
}
.style-grid label { display: flex; flex-direction: column; gap: 6px; }
.style-grid .full { grid-column: 1 / -1; }
.style-grid .row { display: flex; gap: 6px; align-items: center; }
.style-grid input[type=color] { width: 44px; height: 30px; border: none; background: none; padding: 0; }
.style-grid input[type=range] { width: 100%; accent-color: var(--accent); }
.style-grid textarea {
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  background: rgba(255, 255, 255, 0.7);
  padding: 8px 10px;
  font-family: var(--mono);
  font-size: 13px;
}
.mini {
  border: none;
  border-radius: 10px;
  padding: 5px 10px;
  background: rgba(255, 255, 255, 0.75);
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
}

/* ===== 图片预览 / toast ===== */
.img-preview {
  position: absolute; inset: 0;
  z-index: 50;
  background: rgba(20, 24, 36, 0.85);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
}
.img-preview img { max-width: 100%; max-height: 100%; border-radius: 12px; }

.toast {
  position: absolute;
  z-index: 60;
  left: 50%;
  top: 45%;
  transform: translateX(-50%);
  padding: 10px 18px;
  border-radius: 999px;
  font-size: 14px;
  white-space: nowrap;
  max-width: 85%;
  overflow: hidden;
  text-overflow: ellipsis;
}



/* ===== 动画 ===== */
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.sheet-enter-active, .sheet-leave-active { transition: transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1), opacity 0.2s; }
.sheet-enter-from, .sheet-leave-to { transform: translateY(105%); opacity: 0.6; }

.pop-enter-active, .pop-leave-active { transition: transform 0.18s, opacity 0.18s; transform-origin: top right; }
.pop-enter-from, .pop-leave-to { transform: scale(0.9); opacity: 0; }
</style>

<style>
/* 键盘弹起时贴紧键盘。
   html 上的 .kb-open 由 viewport.ts 切换；放在非 scoped 样式里才能跨组件匹配 */
html.kb-open .chat-page .input-footer { padding-bottom: 6px !important; }
/* 聊天页：顶栏卡片已经垫在状态栏后面，去掉全局的灰色渐变条 */
html.chat-open body::before { display: none !important; }
</style>
