<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import Icon from '../components/Icon.vue'
import { estimateTokens, buildSystemPrompt } from '../chat-engine'
import {
  loadPrompt, savePrompt, loadHistory, defaultPrompt, isCustomized, DEFAULT_FEATURES,
  type PromptVersion
} from '../prompt-store'

const router = useRouter()

const saved = ref(loadPrompt())
const main = ref(saved.value.main)
const features = ref(saved.value.features)
const featuresEnabled = ref(saved.value.featuresEnabled)
const tab = ref<'main' | 'features'>('main')
const customized = ref(isCustomized())

const dirty = computed(() =>
  main.value !== saved.value.main ||
  features.value !== saved.value.features ||
  featuresEnabled.value !== saved.value.featuresEnabled
)

const tokens = computed(() => ({
  main: estimateTokens(main.value),
  features: featuresEnabled.value ? estimateTokens(features.value) : 0
}))
// 含世界书在内、实际发给他的总量（按已保存的内容算）
const totalSaved = ref(estimateTokens(buildSystemPrompt()))

function save() {
  if (!main.value.trim()) { toast('主提示词不能为空'); return }
  try {
    savePrompt({ main: main.value, features: features.value, featuresEnabled: featuresEnabled.value })
  } catch {
    toast('保存失败：存储空间不够')
    return
  }
  saved.value = loadPrompt()
  customized.value = true
  totalSaved.value = estimateTokens(buildSystemPrompt())
  toast('已保存，下一条消息开始生效')
}

function discard() {
  main.value = saved.value.main
  features.value = saved.value.features
  featuresEnabled.value = saved.value.featuresEnabled
}

// ===== 历史版本 =====
const showHistory = ref(false)
const history = ref<PromptVersion[]>([])
const preview = ref<PromptVersion | null>(null)
const confirmReset = ref(false)

function openHistory() {
  history.value = loadHistory()
  preview.value = null
  showHistory.value = true
}

function restore(v: PromptVersion) {
  // 只放进编辑框，用户确认无误后再点保存
  main.value = v.main
  features.value = v.features
  featuresEnabled.value = v.featuresEnabled
  showHistory.value = false
  toast('已放进编辑框，检查后点保存')
}

function restoreDefault() {
  if (!confirmReset.value) { confirmReset.value = true; return }
  const d = defaultPrompt()
  main.value = d.main
  features.value = d.features
  featuresEnabled.value = true
  confirmReset.value = false
  showHistory.value = false
  toast('已放进编辑框，点保存才会生效')
}

function resetFeaturesOnly() {
  features.value = DEFAULT_FEATURES
}

function fmt(ts: number) {
  if (!ts) return '出厂默认'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ===== 离开前提醒 =====
onBeforeRouteLeave(() => {
  if (dirty.value) return confirm('有改动还没保存，确定离开吗？')
})
function beforeUnload(e: BeforeUnloadEvent) {
  if (dirty.value) { e.preventDefault(); e.returnValue = '' }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))

const toastMsg = ref('')
let toastTimer: number | null = null
function toast(t: string) {
  toastMsg.value = t
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toastMsg.value = '' }, 2000)
}
</script>

<template>
  <div class="editor-page app-screen">
    <header class="ed-header">
      <button class="glass-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <div class="ed-title glass">
        <span>系统提示词</span>
        <small>{{ customized ? `上次保存 ${fmt(saved.updatedAt)}` : '出厂默认' }}</small>
      </div>
      <button class="glass-btn" aria-label="历史版本" @click="openHistory"><Icon name="thought" /></button>
    </header>

    <div class="tabs glass" role="tablist">
      <button role="tab" :aria-selected="tab === 'main'" :class="{ on: tab === 'main' }" @click="tab = 'main'">
        人设与关系 <em>{{ (tokens.main / 1000).toFixed(1) }}k</em>
      </button>
      <button role="tab" :aria-selected="tab === 'features'" :class="{ on: tab === 'features' }" @click="tab = 'features'">
        家里的功能 <em>{{ featuresEnabled ? (tokens.features / 1000).toFixed(1) + 'k' : '关' }}</em>
      </button>
    </div>

    <main class="ed-body">
      <template v-if="tab === 'main'">
        <p class="hint">他是谁、你们的关系、说话的方式。每次对话都会发给他。</p>
        <textarea v-model="main" class="ed-text glass" spellcheck="false" aria-label="主提示词"></textarea>
      </template>
      <template v-else>
        <p class="hint">告诉他这个家能做什么、怎么用。加了新功能就在这里补一句。会拼在人设后面。</p>
        <label class="switch-row">
          <input v-model="featuresEnabled" type="checkbox" />
          发给他
        </label>
        <textarea v-model="features" class="ed-text glass" :class="{ off: !featuresEnabled }" spellcheck="false" aria-label="功能说明"></textarea>
        <button class="link-btn" @click="resetFeaturesOnly">恢复成默认的功能说明</button>
      </template>
      <p class="hint total">加上世界书，每次实际发给他的提示词约 {{ (totalSaved / 1000).toFixed(1) }}k tokens（按已保存的算）</p>
    </main>

    <footer class="ed-footer">
      <button class="ed-btn ghost" :disabled="!dirty" @click="discard">撤销改动</button>
      <button class="ed-btn" :disabled="!dirty" @click="save">保存</button>
    </footer>

    <!-- 历史版本 -->
    <transition name="fade">
      <div v-if="showHistory" class="scrim" @click="showHistory = false; confirmReset = false"></div>
    </transition>
    <transition name="sheet">
      <div v-if="showHistory" class="sheet glass-strong" role="dialog" aria-modal="true" aria-label="历史版本">
        <div class="sheet-grip" aria-hidden="true"></div>
        <template v-if="!preview">
          <div class="sheet-title">历史版本</div>
          <p class="hint">每次保存前，原来的版本会自动存在这里（最多 {{ 15 }} 份）。</p>
          <div v-if="!history.length" class="empty">还没有历史版本</div>
          <button v-for="(v, i) in history" :key="i" class="hist-item" @click="preview = v">
            <span>{{ fmt(v.updatedAt) }}</span>
            <small>{{ v.note }} · {{ (estimateTokens(v.main) / 1000).toFixed(1) }}k</small>
          </button>
          <button class="hist-item danger" @click="restoreDefault">
            <span>{{ confirmReset ? '再点一次确认' : '恢复出厂默认' }}</span>
            <small>会先放进编辑框，点保存才生效；当前版本会进历史</small>
          </button>
        </template>
        <template v-else>
          <div class="sheet-title">{{ fmt(preview.updatedAt) }}</div>
          <pre class="preview">{{ preview.main }}<template v-if="preview.featuresEnabled">

────────

{{ preview.features }}</template></pre>
          <div class="sheet-row">
            <button class="ed-btn ghost" @click="preview = null">返回</button>
            <button class="ed-btn" @click="restore(preview)">用这个版本</button>
          </div>
        </template>
      </div>
    </transition>

    <transition name="fade">
      <div v-if="toastMsg" class="toast glass-strong" role="status">{{ toastMsg }}</div>
    </transition>
  </div>
</template>

<style scoped>
.editor-page {
  display: flex;
  flex-direction: column;
  background: var(--page-bg);
  padding: calc(var(--safe-top) + 8px) 12px 0;
}

.ed-header { display: flex; align-items: center; gap: 10px; }
.ed-header .glass-btn { width: 40px; height: 40px; flex-shrink: 0; }
.ed-title {
  flex: 1; min-width: 0;
  border-radius: 22px;
  padding: 8px 16px;
  display: flex; flex-direction: column; align-items: center;
  font-weight: 600; font-size: 16px;
}
.ed-title small { font-weight: 400; font-size: 11px; color: var(--text-2); }

.tabs {
  margin-top: 12px;
  display: flex;
  padding: 4px;
  border-radius: 999px;
}
.tabs button {
  flex: 1;
  border: none; background: none;
  padding: 9px 6px;
  border-radius: 999px;
  font-size: 14px;
  color: var(--text-2);
}
.tabs button.on { background: rgba(255, 255, 255, 0.8); color: var(--text); font-weight: 600; }
.tabs em { font-style: normal; font-size: 11px; color: var(--text-3); margin-left: 4px; font-weight: 400; }

.ed-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0;
}
.hint { font-size: 12px; color: var(--text-2); line-height: 1.5; padding: 0 4px; }
.hint.total { color: var(--text-3); }
.ed-text {
  flex: 1;
  min-height: 0;
  width: 100%;
  border-radius: 20px;
  padding: 14px;
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.65;
  resize: none;
  outline: none;
  -webkit-overflow-scrolling: touch;
}
.ed-text.off { opacity: 0.5; }
.switch-row { display: flex; align-items: center; gap: 8px; font-size: 14px; padding: 0 4px; }
.link-btn { align-self: flex-start; border: none; background: none; font-size: 12px; color: var(--accent); padding: 2px 4px; }

.ed-footer {
  display: flex;
  gap: 10px;
  padding: 8px 0 calc(var(--safe-bottom) + 10px);
}
.ed-btn {
  flex: 1;
  padding: 13px;
  border-radius: 18px;
  border: none;
  background: rgba(111, 134, 184, 0.9);
  color: #fff;
  font-size: 15px;
}
.ed-btn.ghost { background: rgba(255, 255, 255, 0.7); color: var(--text); }
.ed-btn:disabled { opacity: 0.4; }

/* 面板 */
.scrim { position: absolute; inset: 0; z-index: 40; background: rgba(30, 36, 56, 0.18); }
.sheet {
  position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 41;
  border-radius: 28px;
  padding: 8px 12px calc(var(--safe-bottom) + 12px);
  max-height: 82%;
  overflow-y: auto;
  display: flex; flex-direction: column; gap: 6px;
}
.sheet-grip { width: 36px; height: 5px; border-radius: 3px; background: rgba(0,0,0,.15); align-self: center; margin: 2px 0 6px; }
.sheet-title { font-size: 15px; font-weight: 600; padding: 4px 4px 2px; }
.empty { font-size: 13px; color: var(--text-3); padding: 12px 4px; }
.hist-item {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  border: none; background: rgba(255, 255, 255, 0.55);
  border-radius: 16px; padding: 11px 14px; text-align: left; font-size: 15px;
}
.hist-item small { font-size: 12px; color: var(--text-2); }
.hist-item.danger span { color: var(--danger); }
.preview {
  font-family: var(--mono); font-size: 12px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
  background: rgba(255, 255, 255, 0.6); border-radius: 16px; padding: 12px;
  max-height: 55vh; overflow-y: auto;
}
.sheet-row { display: flex; gap: 10px; padding-top: 6px; }

.toast {
  position: absolute; z-index: 60; left: 50%; top: 45%; transform: translateX(-50%);
  padding: 10px 18px; border-radius: 999px; font-size: 14px; white-space: nowrap;
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
.sheet-enter-active, .sheet-leave-active { transition: transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1); }
.sheet-enter-from, .sheet-leave-to { transform: translateY(105%); }
</style>

<style>
/* 键盘弹起时去掉底部安全区留白（html 上的类，要写在非 scoped 样式里） */
html.kb-open .editor-page .ed-footer { padding-bottom: 6px !important; }
</style>
