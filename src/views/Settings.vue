<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import ToolboxPanel from '../components/ToolboxPanel.vue'
import StationsPanel from '../components/StationsPanel.vue'
import DrawPanel from '../components/DrawPanel.vue'
import { getSettings, saveSettings, apiUrl, apiHeaders } from '../settings'
import { compressImage } from '../image'
import { isViewportDebug, setViewportDebug } from '../viewport'
import { theme, THEME_PRESETS, DEFAULT_THEME } from '../theme'
import { liquidEnabled, liquidActive, setLiquidEnabled } from '../liquid/global'
import { fontName, setFontFile, clearFont } from '../font'
import { BOOK_FONTS, loadBookFont, saveBookFont } from './rooms/shelf/books'

const viewportDebug = ref(isViewportDebug())
function toggleViewportDebug() {
  viewportDebug.value = !viewportDebug.value
  setViewportDebug(viewportDebug.value)
}

const settings = ref(getSettings())
// 上次保存（或读进来）时的样子：对不上就是有改动还没保存
const savedSnap = ref(JSON.stringify(settings.value))
const dirty = computed(() => JSON.stringify(settings.value) !== savedSnap.value)

// ===== 分页：/settings 是目录，/settings/<key> 是一项（iOS 右划能返回，刷新还停在这一项）=====
interface Section { key: string; title: string; to?: string }
const GROUPS: { title: string; items: Section[] }[] = [
  { title: '他和我', items: [
    { key: 'chat', title: '聊天' },
    { key: 'avatar', title: '头像' },
  ] },
  { title: '连接', items: [
    { key: 'connection', title: '连接和模型' },
    { key: 'stations', title: '中转站' },
  ] },
  { title: '他的东西', items: [
    { key: 'toolbox', title: '他的工具箱' },
    { key: 'draw', title: '垫图和画风' },
    { key: 'shelf', title: '世界书和主 Prompt', to: '/study/shelf' },
  ] },
  { title: '其它', items: [
    { key: 'look', title: '外观' },
    { key: 'debug', title: '排查' },
  ] },
]
const SECTIONS = GROUPS.flatMap(g => g.items).filter(s => !s.to)
// 改了要点「保存」的几页（其余的改了马上生效）
const NEEDS_SAVE = new Set(['connection', 'chat', 'avatar'])

const route = useRoute()
const router = useRouter()
const section = computed(() => SECTIONS.find(s => s.key === route.params.section) || null)

function rowHint(key: string): string {
  const v = settings.value
  switch (key) {
    case 'chat': return `${v.nameAI} 和 ${v.nameUser} · 气泡、保活`
    case 'avatar': return '我的、他的'
    case 'connection': return v.model || '还没选模型'
    case 'stations': return '聊天的站、画图的站'
    case 'toolbox': return '箱子开关、顺序、不让他用的'
    case 'draw': return '垫图、默认画风'
    case 'shelf': return '在书房的书架上'
    case 'look': return '色调、液态玻璃、字体'
    case 'debug': return '屏幕尺寸数据'
    default: return ''
  }
}

function openSection(s: Section) { router.push(s.to || `/settings/${s.key}`) }
function backToList() {
  // 从目录点进来的就退回去（不多堆一层历史）；直接打开这一页的才换成目录
  if ((window.history.state as any)?.back === '/settings') router.back()
  else router.replace('/settings')
}

const scroller = ref<HTMLElement | null>(null)
watch(() => route.params.section, () => {
  // 没有没保存的改动时重读一次：中转站那页切站会顺手改模型，这里拿着的还是旧的，一保存就写回去了
  if (!dirty.value) { settings.value = getSettings(); savedSnap.value = JSON.stringify(settings.value) }
  nextTick(() => scroller.value?.scrollTo(0, 0))
})

const fontMsg = ref('')
async function onFontPick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  fontMsg.value = '正在加载…'
  try { await setFontFile(file); fontMsg.value = '' }
  catch (err: any) { fontMsg.value = err.message }
}

async function handleImageUpload(event: Event, field: 'avatarUser' | 'avatarAI') {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  // 头像存在 localStorage 里，压到 256px 足够清楚
  settings.value[field] = await compressImage(file, 256, 0.9)
}

// ===== 模型列表 / 连接测试 =====
const models = ref<string[]>([])
const modelsState = ref<'' | 'loading' | 'ok' | 'error'>('')
const modelsError = ref('')

async function fetchModels() {
  modelsState.value = 'loading'
  modelsError.value = ''
  try {
    const res = await fetch(apiUrl(settings.value, '/models'), { headers: apiHeaders(settings.value) })
    if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    models.value = (data.data || []).map((m: any) => m.id).filter(Boolean)
    modelsState.value = 'ok'
  } catch (e: any) {
    modelsState.value = 'error'
    modelsError.value = e.message
  }
}

function clearImage(field: 'avatarUser' | 'avatarAI') {
  if (field === 'avatarUser') {
    settings.value[field] = '/avatar-erica.jpg'
  } else {
    settings.value[field] = '/avatar-claude.jpg'
  }
}

function save() {
  try {
    saveSettings(settings.value)
    savedSnap.value = JSON.stringify(settings.value)
    showToast('已保存')
  } catch {
    showToast('保存失败：存储空间不够')
  }
}

// ===== Toast =====
const toastMsg = ref('')
const toastVisible = ref(false)
let toastTimer: number | null = null

function showToast(text: string) {
  toastMsg.value = text
  toastVisible.value = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toastVisible.value = false }, 1500)
}

// 书房书架上的书名字体
const bookFont = ref<string>(loadBookFont().id)
function pickBookFont(id: string) { bookFont.value = id; saveBookFont(id) }


</script>

<template>
  <div ref="scroller" class="settings shell-page">
    <main class="content">
      <!-- 目录 -->
      <template v-if="!section">
        <div v-if="dirty" class="unsaved glass">
          <span>聊天 / 头像 / 连接里有改动还没保存</span>
          <button type="button" class="unsaved-btn" @click="save">保存</button>
        </div>
        <template v-for="g in GROUPS" :key="g.title">
          <div class="menu-label">{{ g.title }}</div>
          <div class="menu-group glass">
            <button v-for="it in g.items" :key="it.key" type="button" class="menu-row" @click="openSection(it)">
              <span class="menu-text">
                <span>{{ it.title }}</span>
                <small>{{ rowHint(it.key) }}</small>
              </span>
              <Icon name="chevron" :size="16" class="menu-chevron" />
            </button>
          </div>
        </template>
        <a class="logout-link glass" href="/logout">退出登录</a>
      </template>

      <!-- 某一项 -->
      <template v-else>
        <header class="sub-header">
          <button class="glass-btn" aria-label="返回" @click="backToList"><Icon name="back" /></button>
          <div class="sub-title glass">{{ section.title }}</div>
          <span class="sub-spacer" aria-hidden="true"></span>
        </header>

        <div class="form glass">
          <template v-if="section.key === 'connection'">
          <label>
            API 地址
            <input v-model="settings.apiBase" placeholder="留空 = 用服务器上的 Dylan 网关" autocapitalize="off" autocorrect="off" />
            <span class="hint">留空时请求走本站 /api，网关 key 由服务器自动带上。填其他地址（以 /v1 结尾）可以直连别的 API。</span>
          </label>

          <label>
            API Key
            <input v-model="settings.apiKey" type="password" placeholder="用默认网关时留空" autocomplete="off" />
            <span class="hint">只在直连其他 API 时需要填。会保存在这台设备的浏览器里。</span>
          </label>

          <label>
            模型
            <span class="model-row">
              <input v-model="settings.model" list="model-options" placeholder="模型名" autocapitalize="off" autocorrect="off" />
              <button type="button" class="reset-btn" :disabled="modelsState === 'loading'" @click="fetchModels">
                {{ modelsState === 'loading' ? '读取中…' : '读取列表' }}
              </button>
            </span>
            <datalist id="model-options">
              <option v-for="m in models" :key="m" :value="m" />
            </datalist>
            <span v-if="modelsState === 'ok'" class="hint">连接正常，共 {{ models.length }} 个模型。点输入框可以选。</span>
            <span v-else-if="modelsState === 'error'" class="hint err">连接失败：{{ modelsError }}</span>
          </label>
          <div v-if="models.length" class="model-chips">
            <button
              v-for="m in models" :key="m" type="button"
              :class="['model-chip', { on: settings.model === m }]"
              @click="settings.model = m"
            >{{ m }}</button>
          </div>
          </template>

          <template v-else-if="section.key === 'chat'">
          <label>
            他的名字
            <input v-model="settings.nameAI" />
          </label>
          <label>
            我的名字
            <input v-model="settings.nameUser" />
          </label>
          <label>
            顶栏小字
            <input v-model="settings.chatSubtitle" placeholder="比如一句签名，可以留空" />
          </label>
          <label>
            聊天记录上限（约 {{ (settings.contextTokens / 1000).toFixed(0) }}k tokens）
            <input v-model.number="settings.contextTokens" type="range" min="10000" max="180000" step="5000" />
            <span class="hint">每次发给他的聊天记录最多这么多，超出的旧消息不发送，本地记录不会删除。不含系统提示词和世界书。</span>
          </label>
          <label class="check-row">
            <input v-model="settings.splitBubbles" type="checkbox" />
            他的回复按行拆成多个气泡
          </label>
          <label class="check-row">
            <input v-model="settings.keepAlive" type="checkbox" />
            他回复时后台保活
          </label>
          <span class="hint">他回复的时候在后台放一段听不见的声音，切到别的 app 也不容易断。代价：会让正在放的音乐暂停。能撑多久由 iOS 决定。</span>
          </template>

          <template v-else-if="section.key === 'avatar'">
          <div class="image-setting">
            <span class="image-label">我的头像</span>
            <div class="image-row">
              <img :src="settings.avatarUser" class="avatar-preview" />
              <label class="upload-btn">
                更换
                <input type="file" accept="image/*" hidden @change="handleImageUpload($event, 'avatarUser')" />
              </label>
              <button class="reset-btn" @click="clearImage('avatarUser')">重置</button>
            </div>
          </div>

          <div class="image-setting">
            <span class="image-label">他的头像</span>
            <div class="image-row">
              <img :src="settings.avatarAI" class="avatar-preview" />
              <label class="upload-btn">
                更换
                <input type="file" accept="image/*" hidden @change="handleImageUpload($event, 'avatarAI')" />
              </label>
              <button class="reset-btn" @click="clearImage('avatarAI')">重置</button>
            </div>
          </div>
          </template>

          <template v-else-if="section.key === 'look'">
          <div class="theme-block">
            <span class="image-label">整体色调</span>
            <div class="theme-presets" role="radiogroup" aria-label="预设色调">
              <button
                v-for="p in THEME_PRESETS"
                :key="p.name"
                type="button"
                role="radio"
                class="theme-swatch"
                :class="{ on: theme.bgTop === p.top && theme.bgBottom === p.bottom }"
                :aria-checked="theme.bgTop === p.top && theme.bgBottom === p.bottom"
                @click="theme.bgTop = p.top; theme.bgBottom = p.bottom"
              >
                <span class="swatch-dot" :style="{ background: `linear-gradient(165deg, ${p.top}, ${p.bottom})` }"></span>
                <span>{{ p.name }}</span>
              </button>
            </div>
            <div class="theme-custom">
              <label class="theme-color">上端 <input type="color" v-model="theme.bgTop" /></label>
              <label class="theme-color">下端 <input type="color" v-model="theme.bgBottom" /></label>
              <button type="button" class="reset-btn" @click="Object.assign(theme, DEFAULT_THEME)">恢复默认</button>
            </div>
            <label class="theme-color liquid-row">
              <input type="checkbox" :checked="liquidEnabled" @change="setLiquidEnabled(($event.target as HTMLInputElement).checked)" />
              液态玻璃（全站，水波）
            </label>
            <span class="hint">{{ liquidEnabled && !liquidActive ? '这台设备画不了液态玻璃，用的是磨砂。' : '打开时所有面板、按钮、底栏都是透明的水波玻璃，底色浓度跟着聊天样式里气泡的「底色浓度」走；关掉回到磨砂。' }}</span>
            <label v-if="!liquidActive" class="theme-range">
              底栏透明度 {{ Math.round((1 - theme.tabbarOpacity) * 100) }}%
              <input type="range" min="0.1" max="0.9" step="0.05" :value="1 - theme.tabbarOpacity"
                @input="theme.tabbarOpacity = +(1 - +($event.target as HTMLInputElement).value).toFixed(2)" />
            </label>
            <div class="theme-custom">
              <span class="image-label" style="margin:0">字体：{{ fontName || '系统默认' }}</span>
              <label class="upload-btn">导入字体<input type="file" accept=".ttf,.otf,.woff,.woff2" hidden @change="onFontPick" /></label>
              <button v-if="fontName" type="button" class="reset-btn" @click="clearFont">恢复系统字体</button>
            </div>
            <span v-if="fontMsg" class="hint">{{ fontMsg }}</span>
            <span class="hint">改了马上生效，不用点保存。字体对整个应用生效（代码块除外）；字体里没有的字会用系统字体补上。聊天页如果在聊天样式里设了背景，会优先用那个。</span>
            <div class="theme-custom">
              <span class="image-label" style="margin:0">书房书名字体</span>
              <button
                v-for="f in BOOK_FONTS" :key="f.id" type="button"
                class="upload-btn" :class="{ picked: bookFont === f.id }"
                @click="pickBookFont(f.id)"
              >{{ f.name }}</button>
            </div>
            <span class="hint">书架上书脊、封面和书页标题用的字体。华丽 = 站酷小薇，庄重 = 思源宋体最粗，毛笔 = 马善政；英文和数字都用 Cinzel Decorative。</span>
          </div>
          </template>

          <!-- 中转站（2026-11-11 从 Leto 管理页搬过来）-->
          <StationsPanel v-else-if="section.key === 'stations'" />
          <!-- 垫图和画风（2026-11-11）-->
          <DrawPanel v-else-if="section.key === 'draw'" />
          <ToolboxPanel v-else-if="section.key === 'toolbox'" />

          <template v-else-if="section.key === 'debug'">
          <label class="check-row">
            <input type="checkbox" :checked="viewportDebug" @change="toggleViewportDebug" />
            在屏幕左上角显示尺寸数据（排查白条、键盘位置用）
          </label>
          </template>

          <div v-if="NEEDS_SAVE.has(section.key)" class="actions">
            <button class="primary" @click="save">保存</button>
          </div>
        </div>
      </template>
    </main>

    <transition name="fade">
      <div v-if="toastVisible" class="toast">{{ toastMsg }}</div>
    </transition>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: transparent;
  color: var(--text);
  overflow-y: auto; overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
}

.content { flex: 1; padding: calc(var(--safe-top) + 16px) 14px 24px; }
.form {
  max-width: 520px;
  margin: 0 auto;
  padding: 18px 16px 22px;
  border-radius: 28px;
}

.section-title {
  font-size: 13px; color: rgba(0, 0, 0, 0.4); text-transform: uppercase;
  letter-spacing: 1px; margin-top: 24px; margin-bottom: 16px;
  padding-bottom: 8px; border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}
.section-title:first-child { margin-top: 0; }

/* 外观 */
.theme-block { margin-bottom: 20px; display: flex; flex-direction: column; gap: 12px; }
.theme-presets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.theme-swatch {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.8);
  border-radius: 14px;
  background: var(--glass-bg-soft);
  font-size: 13px;
  color: var(--text-2);
  transition: transform 0.35s var(--spring);
}
.theme-swatch:active { transform: scale(var(--press-scale)); transition-duration: 0.08s; }
.theme-swatch.on { color: var(--text); border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.swatch-dot { width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0; border: 1px solid rgba(60, 72, 110, 0.12); }
.theme-custom { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.theme-color { display: flex !important; align-items: center; gap: 6px; margin: 0 !important; font-size: 13px; }
.theme-color input { width: 40px; height: 28px; border: none; background: none; padding: 0; }
.theme-range { margin: 0 !important; font-size: 13px; display: flex !important; flex-direction: column; gap: 6px; }
.theme-range input { width: 100%; accent-color: var(--accent); }

label { display: block; margin-bottom: 20px; font-size: 14px; color: rgba(0, 0, 0, 0.6); }

label input[type="text"],
label input[type="password"],
label input:not([type]) {
  display: block; width: 100%; margin-top: 8px; padding: 10px 14px;
  border: 1px solid rgba(255, 255, 255, 0.8); border-radius: 14px; background: rgba(255, 255, 255, 0.6);
  color: var(--text); font-size: 16px; outline: none; box-sizing: border-box;
}
label input:focus { border-color: rgba(0, 0, 0, 0.25); }

.hint { display: block; margin-top: 4px; font-size: 12px; color: rgba(0, 0, 0, 0.35); }

.image-setting { margin-bottom: 20px; }
.image-label { display: block; font-size: 14px; color: rgba(0, 0, 0, 0.6); margin-bottom: 8px; }
.image-row { display: flex; align-items: center; gap: 10px; }

.avatar-preview {
  width: 48px; height: 48px; border-radius: 50%;
  object-fit: cover; border: 2px solid rgba(0, 0, 0, 0.08);
}

.upload-btn {
  padding: 6px 14px; background: rgba(0, 0, 0, 0.05); border-radius: 6px;
  font-size: 12px; color: rgba(0, 0, 0, 0.5); cursor: pointer;
  border: 1px solid rgba(0, 0, 0, 0.08);
}
.upload-btn:hover { background: rgba(0, 0, 0, 0.08); }
.upload-btn.picked { background: rgba(111, 134, 184, 0.22); color: rgba(0, 0, 0, 0.85); font-weight: 600; }

.reset-btn {
  padding: 6px 10px; background: none; border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 6px; font-size: 12px; color: rgba(0, 0, 0, 0.35); cursor: pointer;
}
.reset-btn:hover { color: rgba(0, 0, 0, 0.6); }

.actions { margin-top: 32px; }

.primary {
  width: 100%; padding: 13px; border: none; border-radius: 16px;
  font-size: 15px; cursor: pointer; background: rgba(111, 134, 184, 0.88); color: #fff;
}
.primary:hover { background: rgba(0, 0, 0, 0.12); }

/* ===== Worldbook ===== */
.worldbook-hint { font-size: 12px; color: rgba(0, 0, 0, 0.35); margin-bottom: 16px; }
.worldbook-list { display: flex; flex-direction: column; gap: 12px; margin-bottom: 12px; }

/* Group */
.wb-group {
  border: 1px solid rgba(0, 0, 0, 0.08); border-radius: 10px;
  overflow: hidden; background: rgba(255, 255, 255, 0.5);
}

.wb-group-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; background: rgba(255, 255, 255, 0.6);
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.wb-group-toggle {
  background: none; border: none; font-size: 14px;
  cursor: pointer; padding: 0 4px; color: rgba(0, 0, 0, 0.25); flex-shrink: 0;
}
.wb-group-toggle.enabled { color: rgba(0, 0, 0, 0.5); }

.wb-group-name {
  flex: 1; font-size: 14px; font-weight: 500;
  color: rgba(0, 0, 0, 0.7); cursor: pointer; user-select: none;
}

.wb-group-count { font-size: 11px; color: rgba(0, 0, 0, 0.35); }

.wb-group-add {
  background: none; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 4px;
  color: rgba(0, 0, 0, 0.35); font-size: 14px; width: 24px; height: 24px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.wb-group-add:hover { color: rgba(0, 0, 0, 0.6); border-color: rgba(0, 0, 0, 0.2); }

.wb-group-del {
  background: none; border: none; font-size: 14px;
  cursor: pointer; color: rgba(0, 0, 0, 0.25); padding: 0 4px;
}
.wb-group-del:hover { color: rgba(200, 60, 60, 0.7); }

.wb-group-body { padding: 4px; }

/* Entry */
.wb-entry {
  border: 1px solid rgba(0, 0, 0, 0.04); border-radius: 6px;
  margin: 2px 0; background: rgba(255, 255, 255, 0.4);
}

.wb-header {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; cursor: pointer; user-select: none;
}
.wb-header:hover { background: rgba(0, 0, 0, 0.02); }

.wb-toggle {
  background: none; border: none; font-size: 12px;
  cursor: pointer; padding: 0 2px; color: rgba(0, 0, 0, 0.2); flex-shrink: 0;
}
.wb-toggle.enabled { color: rgba(0, 0, 0, 0.5); }

.wb-title-text {
  flex: 1; font-size: 13px; color: rgba(0, 0, 0, 0.6);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.wb-position-tag {
  font-size: 10px; padding: 1px 6px; border-radius: 3px;
  flex-shrink: 0; letter-spacing: 0.5px;
}
.wb-position-tag.before {
  background: rgba(180, 120, 60, 0.1); color: rgba(160, 110, 50, 0.8);
  border: 1px solid rgba(180, 120, 60, 0.2);
}
.wb-position-tag.after {
  background: rgba(80, 100, 180, 0.08); color: rgba(70, 90, 160, 0.7);
  border: 1px solid rgba(80, 100, 180, 0.15);
}

.wb-priority { font-size: 10px; color: rgba(0, 0, 0, 0.3); flex-shrink: 0; font-family: monospace; }
.wb-expand { font-size: 9px; color: rgba(0, 0, 0, 0.25); flex-shrink: 0; }

.wb-body {
  padding: 4px 10px 10px; display: flex; flex-direction: column; gap: 8px;
}

.wb-title-input {
  width: 100%; padding: 8px 10px; border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 6px; background: rgba(255, 255, 255, 0.8); color: rgba(0, 0, 0, 0.8);
  font-size: 14px; outline: none; box-sizing: border-box;
}
.wb-title-input:focus { border-color: rgba(0, 0, 0, 0.25); }

.wb-meta-row { display: flex; gap: 12px; flex-wrap: wrap; }

.wb-meta-item { display: flex; flex-direction: column; gap: 4px; }
.wb-meta-label { font-size: 11px; color: rgba(0, 0, 0, 0.35); }

.wb-meta-btn {
  padding: 4px 10px; background: rgba(0, 0, 0, 0.03);
  border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 4px;
  color: rgba(0, 0, 0, 0.6); font-size: 12px; cursor: pointer;
}
.wb-meta-btn:hover { border-color: rgba(0, 0, 0, 0.2); }

.wb-priority-ctrl {
  display: flex; align-items: center; gap: 2px;
}
.wb-priority-ctrl button {
  width: 26px; height: 26px; background: rgba(0, 0, 0, 0.03);
  border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 4px;
  color: rgba(0, 0, 0, 0.5); font-size: 14px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.wb-priority-ctrl button:hover { border-color: rgba(0, 0, 0, 0.2); }

.wb-priority-input {
  width: 44px; text-align: center; padding: 4px;
  background: rgba(255, 255, 255, 0.8); border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 4px;
  color: rgba(0, 0, 0, 0.7); font-size: 13px; font-family: monospace;
  outline: none; box-sizing: border-box;
  -moz-appearance: textfield;
}
.wb-priority-input::-webkit-inner-spin-button,
.wb-priority-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }

.wb-content-input {
  width: 100%; padding: 8px 10px; border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 6px; background: rgba(255, 255, 255, 0.8); color: rgba(0, 0, 0, 0.75);
  font-size: 13px; font-family: 'Menlo', 'Consolas', monospace;
  line-height: 1.5; outline: none; resize: vertical;
  box-sizing: border-box; min-height: 120px;
}
.wb-content-input:focus { border-color: rgba(0, 0, 0, 0.25); }

.wb-actions { display: flex; align-items: center; justify-content: space-between; }
.wb-char-count { font-size: 11px; color: rgba(0, 0, 0, 0.3); }

.wb-delete {
  padding: 4px 12px; background: none;
  border: 1px solid rgba(200, 60, 60, 0.2); border-radius: 6px;
  color: rgba(200, 60, 60, 0.6); font-size: 12px; cursor: pointer;
}
.wb-delete:hover { background: rgba(200, 60, 60, 0.05); color: rgba(200, 60, 60, 0.8); }

/* Add group */
.wb-add {
  width: 100%; padding: 10px; background: rgba(0, 0, 0, 0.02);
  border: 1px dashed rgba(0, 0, 0, 0.12); border-radius: 8px;
  color: rgba(0, 0, 0, 0.3); font-size: 13px; cursor: pointer; margin-bottom: 32px;
}
.wb-add:hover { background: rgba(0, 0, 0, 0.04); color: rgba(0, 0, 0, 0.5); }

.wb-add-group-form {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px; border: 1px dashed rgba(0, 0, 0, 0.12);
  border-radius: 8px; margin-bottom: 32px;
}
.wb-add-group-btns { display: flex; gap: 8px; }
.wb-add-group-confirm {
  flex: 1; padding: 8px; background: rgba(0, 0, 0, 0.08); border: none;
  border-radius: 6px; color: rgba(0, 0, 0, 0.6); font-size: 13px; cursor: pointer;
}
.wb-add-group-cancel {
  flex: 1; padding: 8px; background: none; border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 6px; color: rgba(0, 0, 0, 0.4); font-size: 13px; cursor: pointer;
}

/* MCP */









/* Toast */
.toast {
  position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
  background: rgba(255, 255, 255, 0.92); color: rgba(0, 0, 0, 0.7);
  padding: 8px 20px; border-radius: 20px; font-size: 13px;
  z-index: 100; pointer-events: none;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1); border: 1px solid rgba(0,0,0,0.06);
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.model-row { display: flex; gap: 8px; align-items: center; }
.model-row input { flex: 1; min-width: 0; }
.model-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: -4px 0 12px; }
.model-chip {
  border: 1px solid var(--glass-border, rgba(0,0,0,0.08));
  background: rgba(255, 255, 255, 0.5);
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 13px;
}
.model-chip.on { background: rgba(111, 134, 184, 0.85); color: #fff; }
.hint.err { color: var(--danger, #d0566a); }
.check-row { flex-direction: row !important; align-items: center; gap: 8px; }
.check-row input { width: auto !important; }
.logout-link {
  display: block; text-align: center; padding: 12px; border-radius: 16px; margin-bottom: 16px;
  background: rgba(255, 255, 255, 0.6); color: var(--danger, #d0566a); text-decoration: none; font-size: 15px;
}
/* 目录 */
.menu-label, .menu-group, .logout-link, .unsaved { max-width: 520px; margin-left: auto; margin-right: auto; }
.menu-label {
  font-size: 12px; color: var(--text-2); letter-spacing: 1px;
  margin-top: 18px; margin-bottom: 8px; padding-left: 14px;
}
.menu-label:first-child { margin-top: 0; }
.unsaved + .menu-label { margin-top: 4px; }
.menu-group { border-radius: 22px; overflow: hidden; }
.menu-row {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 13px 16px; border: none; background: none; text-align: left;
  color: var(--text); font-size: 15px; cursor: pointer;
}
.menu-row + .menu-row { border-top: 1px solid rgba(0, 0, 0, 0.06); }
.menu-row:active { background: rgba(0, 0, 0, 0.04); }
.menu-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.menu-text small {
  font-size: 12px; color: var(--text-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.menu-chevron { color: rgba(0, 0, 0, 0.25); flex-shrink: 0; }
.logout-link { margin-top: 24px; }
.unsaved {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px 10px 16px; margin-bottom: 14px; border-radius: 18px;
  font-size: 13px; color: var(--text-2);
}
.unsaved span { flex: 1; }
.unsaved-btn {
  border: none; border-radius: 999px; padding: 6px 14px;
  background: rgba(111, 134, 184, 0.88); color: #fff; font-size: 13px;
}

/* 某一项的顶栏 */
.sub-header {
  display: flex; align-items: center; gap: 10px;
  max-width: 520px; margin: 0 auto 12px;
}
.sub-header .glass-btn { width: 40px; height: 40px; flex-shrink: 0; }
.sub-title {
  flex: 1; min-width: 0; text-align: center;
  border-radius: 22px; padding: 10px 16px;
  font-weight: 600; font-size: 16px;
}
.sub-spacer { width: 40px; flex-shrink: 0; }

.prompt-entry {
  display: flex; flex-direction: column; gap: 2px;
  padding: 13px 16px; margin: 4px 0 20px; border-radius: 18px;
  background: rgba(255, 255, 255, 0.6); border: 1px solid rgba(255, 255, 255, 0.85);
  color: var(--text); text-decoration: none; font-size: 15px;
}
.prompt-entry small { font-size: 12px; color: var(--text-2); }
</style>