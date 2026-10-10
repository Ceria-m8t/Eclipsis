<script setup lang="ts">
import { ref, nextTick, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { SYSTEM_PROMPT } from '../system-prompt'
import { getSettings } from '../settings'

const router = useRouter()
const settings = ref(getSettings())

// ===== 聊天样式设置 =====
interface ChatStyle {
  bgColor: string
  bgImage: string
  aiBubbleBg: string
  aiBubbleOpacity: number
  userBubbleBg: string
  userBubbleOpacity: number
  fontSize: number
  fontFamily: string
  customCSS: string
}

const DEFAULT_CHAT_STYLE: ChatStyle = {
  bgColor: '#0d0a14',
  bgImage: '',
  aiBubbleBg: '#1e1a2e',
  aiBubbleOpacity: 0.85,
  userBubbleBg: '#2a1f3d',
  userBubbleOpacity: 0.85,
  fontSize: 15,
  fontFamily: '',
  customCSS: ''
}

const chatStyle = ref<ChatStyle>(loadChatStyle())
const showStylePanel = ref(false)
const customStyleEl = ref<HTMLStyleElement | null>(null)

function loadChatStyle(): ChatStyle {
  try {
    const saved = localStorage.getItem('eclipsis-chat-style')
    if (saved) return { ...DEFAULT_CHAT_STYLE, ...JSON.parse(saved) }
  } catch {}
  return { ...DEFAULT_CHAT_STYLE }
}

function saveChatStyle() {
  localStorage.setItem('eclipsis-chat-style', JSON.stringify(chatStyle.value))
  applyCustomCSS()
}

function resetChatStyle() {
  chatStyle.value = { ...DEFAULT_CHAT_STYLE }
  saveChatStyle()
}

function applyCustomCSS() {
  if (!customStyleEl.value) {
    customStyleEl.value = document.createElement('style')
    customStyleEl.value.id = 'eclipsis-custom-css'
    document.head.appendChild(customStyleEl.value)
  }
  customStyleEl.value.textContent = chatStyle.value.customCSS
}

// 字体上传
function handleFontUpload(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const name = file.name.replace(/\.[^.]+$/, '').replace(/\s+/g, '-')
  const reader = new FileReader()
  reader.onload = (ev) => {
    const url = ev.target?.result as string
    const fontFace = new FontFace(name, `url(${url})`)
    fontFace.load().then((loaded) => {
      document.fonts.add(loaded)
      chatStyle.value.fontFamily = name
      saveChatStyle()
    })
  }
  reader.readAsDataURL(file)
}

// 背景图上传
function handleBgUpload(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = (ev) => {
    chatStyle.value.bgImage = ev.target?.result as string
    saveChatStyle()
  }
  reader.readAsDataURL(file)
}

function clearBg() {
  chatStyle.value.bgImage = ''
  saveChatStyle()
}

// 计算样式
const bgStyle = computed(() => {
  const s: Record<string, string> = {}
  if (chatStyle.value.bgImage) {
    s.backgroundImage = `url(${chatStyle.value.bgImage})`
  }
  s.backgroundColor = chatStyle.value.bgColor
  return s
})

const aiBubbleStyle = computed(() => ({
  backgroundColor: chatStyle.value.aiBubbleBg,
  opacity: chatStyle.value.aiBubbleOpacity,
  fontSize: chatStyle.value.fontSize + 'px',
  fontFamily: chatStyle.value.fontFamily || 'inherit'
}))

const userBubbleStyle = computed(() => ({
  backgroundColor: chatStyle.value.userBubbleBg,
  opacity: chatStyle.value.userBubbleOpacity,
  fontSize: chatStyle.value.fontSize + 'px',
  fontFamily: chatStyle.value.fontFamily || 'inherit'
}))

onMounted(() => {
  applyCustomCSS()
})

watch(chatStyle, saveChatStyle, { deep: true })

// ===== 消息逻辑 =====
interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  time: string
  images?: string[]
}

function nowTime(): string {
  const d = new Date()
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

const messages = ref<ChatMessage[]>([])
const inputText = ref('')
const pendingImages = ref<string[]>([])

function handleImageSelect(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (!files) return
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    const reader = new FileReader()
    reader.onload = (ev) => {
      pendingImages.value.push(ev.target?.result as string)
    }
    reader.readAsDataURL(file)
  }
  (e.target as HTMLInputElement).value = ''
}

function removeImage(index: number) {
  pendingImages.value.splice(index, 1)
}

const loading = ref(false)
const chatArea = ref<HTMLElement | null>(null)
let charQueue: string[] = []
let typingTimer: number | null = null
let currentAssistantIndex = -1

function scrollToBottom() {
  nextTick(() => {
    if (chatArea.value) {
      chatArea.value.scrollTop = chatArea.value.scrollHeight
    }
  })
}

function startTyping(index: number) {
  currentAssistantIndex = index
  if (typingTimer) return
  typingTimer = window.setInterval(() => {
    if (charQueue.length === 0) {
      if (!loading.value) {
        window.clearInterval(typingTimer!)
        typingTimer = null
      }
      return
    }
    const count = charQueue.length > 20 ? 3 : charQueue.length > 5 ? 2 : 1
    const chars = charQueue.splice(0, count).join('')
    messages.value[currentAssistantIndex].content += chars
    scrollToBottom()
  }, 30)
}

function getFullSystemPrompt(): string {
  let prompt = SYSTEM_PROMPT
  const saved = localStorage.getItem('worldbook')
  if (saved) {
    try {
      const entries = JSON.parse(saved) as { title: string; content: string; enabled: boolean }[]
      const active = entries.filter(e => e.enabled)
      if (active.length > 0) {
        prompt += '\n\n--- 世界书 ---\n'
        for (const e of active) {
          prompt += `\n【${e.title}】\n${e.content}\n`
        }
      }
    } catch {}
  }
  return prompt
}

async function sendMessage() {
  const text = inputText.value.trim()
  if (!text || loading.value) return

  messages.value.push({
  role: 'user',
  content: text,
  time: nowTime(),
  images: pendingImages.value.length > 0 ? [...pendingImages.value] : undefined
  })
  pendingImages.value = []
  inputText.value = ''
  loading.value = true
  charQueue = []
  scrollToBottom()

  const assistantIndex = messages.value.length
  messages.value.push({ role: 'assistant', content: '', time: nowTime() })
  startTyping(assistantIndex)

  const { apiBase, apiKey, model } = settings.value
  const url = apiBase ? `${apiBase}/chat/completions` : '/api/chat/completions'

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
       messages: [
          { role: 'system', content: getFullSystemPrompt() },
          ...messages.value.slice(0, -1).map(m => {
            if (m.images && m.images.length > 0) {
              return {
                role: m.role,
                content: [
                  ...m.images.map(img => ({
                    type: 'image_url' as const,
                    image_url: { url: img }
                  })),
                  { type: 'text' as const, text: m.content || '(图片)' }
                ]
              }
            }
            return { role: m.role, content: m.content }
          })
        ],
        stream: true
      })
    })
    if (!res.ok) {
      messages.value[assistantIndex].content = `[错误 ${res.status}] ${await res.text()}`
      return
    }
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') break
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta?.content
          if (delta) {
            charQueue.push(...delta.split(''))
          }
        } catch {}
      }
    }
  } catch (err: any) {
    messages.value[assistantIndex].content = `[请求失败] ${err.message}`
  } finally {
    loading.value = false
    scrollToBottom()
  }
}
</script>

<template>
  <div class="chat-page">
    <!-- 背景层 -->
    <div class="chat-bg" :style="bgStyle"></div>

    <!-- 顶栏 -->
    <header class="chat-header">
      <button class="back-btn" @click="router.push('/living')">←</button>
      <img :src="settings.avatarAI" class="header-avatar" />
      <span class="header-name">Claude</span>
      <span class="header-spacer"></span>
      <button class="style-btn" @click="showStylePanel = !showStylePanel">⚙</button>
    </header>

    <!-- 样式设置面板 -->
    <transition name="panel-slide">
      <div v-if="showStylePanel" class="style-panel">
        <div class="panel-header">
          <span>聊天样式</span>
          <button class="panel-close" @click="showStylePanel = false">✕</button>
        </div>
        <div class="panel-body">
          <!-- 背景 -->
          <div class="style-group">
            <label>背景色</label>
            <input type="color" v-model="chatStyle.bgColor" />
          </div>
          <div class="style-group">
            <label>背景图</label>
            <div class="row">
              <label class="upload-btn">
                上传
                <input type="file" accept="image/*" hidden @change="handleBgUpload" />
              </label>
              <button v-if="chatStyle.bgImage" class="clear-btn" @click="clearBg">清除</button>
            </div>
          </div>

          <!-- AI气泡 -->
          <div class="style-group">
            <label>AI 气泡颜色</label>
            <input type="color" v-model="chatStyle.aiBubbleBg" />
          </div>
          <div class="style-group">
            <label>AI 气泡透明度 {{ Math.round(chatStyle.aiBubbleOpacity * 100) }}%</label>
            <input type="range" min="0.1" max="1" step="0.05" v-model.number="chatStyle.aiBubbleOpacity" />
          </div>

          <!-- 用户气泡 -->
          <div class="style-group">
            <label>我的气泡颜色</label>
            <input type="color" v-model="chatStyle.userBubbleBg" />
          </div>
          <div class="style-group">
            <label>我的气泡透明度 {{ Math.round(chatStyle.userBubbleOpacity * 100) }}%</label>
            <input type="range" min="0.1" max="1" step="0.05" v-model.number="chatStyle.userBubbleOpacity" />
          </div>

          <!-- 字体 -->
          <div class="style-group">
            <label>字号 {{ chatStyle.fontSize }}px</label>
            <input type="range" min="12" max="24" step="1" v-model.number="chatStyle.fontSize" />
          </div>
          <div class="style-group">
            <label>自定义字体</label>
            <div class="row">
              <label class="upload-btn">
                导入 TTF/OTF
                <input type="file" accept=".ttf,.otf,.woff,.woff2" hidden @change="handleFontUpload" />
              </label>
              <span v-if="chatStyle.fontFamily" class="font-name">{{ chatStyle.fontFamily }}</span>
              <button v-if="chatStyle.fontFamily" class="clear-btn" @click="chatStyle.fontFamily = ''; saveChatStyle()">重置</button>
            </div>
          </div>

          <!-- 自定义CSS -->
          <div class="style-group">
            <label>自定义 CSS 覆盖</label>
            <textarea
              v-model="chatStyle.customCSS"
              placeholder=".bubble { border-radius: 8px; }"
              rows="4"
              spellcheck="false"
            ></textarea>
          </div>

          <button class="reset-all-btn" @click="resetChatStyle">恢复默认</button>
        </div>
      </div>
    </transition>

    <!-- 消息区 -->
    <main class="chat-area" ref="chatArea">
      <div v-for="(msg, i) in messages" :key="i" :class="['msg-row', msg.role]">
        <img v-if="msg.role === 'assistant'" :src="settings.avatarAI" class="msg-avatar" />
        <div class="msg-body">
          <div v-if="msg.images?.length" class="msg-images">
            <img v-for="(img, j) in msg.images" :key="j" :src="img" class="msg-image" />
          </div>
          <div
            class="bubble"
            :style="msg.role === 'assistant' ? aiBubbleStyle : userBubbleStyle"
          >{{ msg.content }}</div>
          <span class="msg-time">{{ msg.time }}</span>
        </div>
        <img v-if="msg.role === 'user'" :src="settings.avatarUser" class="msg-avatar" />
      </div>
      <div v-if="loading && messages[messages.length - 1]?.content === ''" class="msg-row assistant">
        <img :src="settings.avatarAI" class="msg-avatar" />
        <div class="msg-body">
          <div class="bubble typing" :style="aiBubbleStyle">……</div>
        </div>
      </div>
    </main>

    <!-- 输入栏 -->
    <footer class="input-footer">
      <!-- 图片预览条 -->
      <div v-if="pendingImages.length" class="image-preview-bar">
        <div v-for="(img, i) in pendingImages" :key="i" class="preview-thumb">
          <img :src="img" />
          <button class="remove-img" @click="removeImage(i)">✕</button>
        </div>
      </div>
      <div class="input-bar">
        <label class="attach-btn">
          📎
          <input type="file" accept="image/*" multiple hidden @change="handleImageSelect" />
        </label>
        <input
          v-model="inputText"
          placeholder="说点什么…"
          @keydown.enter="sendMessage"
        />
        <button class="send-btn" @click="sendMessage" :disabled="loading">
          <span>↑</span>
        </button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.chat-page {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  overflow: hidden;
}

/* 背景图层 */
.chat-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  z-index: 0;
}

/* 顶栏 */
.chat-header {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: center;
  padding: 10px 14px;
  gap: 10px;
  flex-shrink: 0;
  background: rgba(10, 8, 18, 0.75);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.back-btn {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  padding: 4px 8px;
  color: rgba(255, 255, 255, 0.5);
}
.back-btn:hover { color: rgba(255, 255, 255, 0.8); }

.header-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
}

.header-name {
  font-size: 16px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.85);
}

.header-spacer { flex: 1; }

.style-btn {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.4);
  padding: 4px 8px;
}
.style-btn:hover { color: rgba(255, 255, 255, 0.7); }

/* 消息区 */
.chat-area {
  position: relative;
  z-index: 1;
  flex: 1;
  overflow-y: auto;
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  -webkit-overflow-scrolling: touch;
}

.msg-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.msg-row.user {
  flex-direction: row;
  justify-content: flex-end;
}

.msg-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
  margin-top: 2px;
}

.msg-body {
  display: flex;
  flex-direction: column;
  max-width: 72%;
}

.bubble {
  padding: 10px 14px;
  border-radius: 16px;
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
  color: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.msg-row.user .bubble { border-bottom-right-radius: 4px; }
.msg-row.assistant .bubble { border-bottom-left-radius: 4px; }

.bubble.typing { opacity: 0.4; }

.msg-time {
  font-size: 11px;
  margin-top: 3px;
  padding: 0 4px;
  color: rgba(255, 255, 255, 0.3);
}
.msg-row.user .msg-time { text-align: right; }
.msg-row.user .msg-body { align-items: flex-end; }

/* 输入栏 */
.input-bar {
  position: relative;
  z-index: 2;
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  padding-bottom: max(10px, env(safe-area-inset-bottom));
  flex-shrink: 0;
  background: rgba(10, 8, 18, 0.75);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.input-bar input {
  flex: 1;
  padding: 10px 16px;
  border-radius: 20px;
  font-size: 15px;
  outline: none;
  box-sizing: border-box;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.85);
}
.input-bar input::placeholder { color: rgba(255, 255, 255, 0.3); }

.send-btn {
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 50%;
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s;
  background: rgba(120, 100, 160, 0.4);
  color: rgba(255, 255, 255, 0.85);
}
.send-btn:hover { background: rgba(120, 100, 160, 0.6); }
.send-btn:disabled { opacity: 0.4; }

/* ===== 样式设置面板 ===== */
.style-panel {
  position: absolute;
  top: 56px;
  right: 0;
  width: 280px;
  max-height: 70vh;
  z-index: 20;
  background: rgba(15, 12, 25, 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px 0 0 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.8);
  font-size: 14px;
  font-weight: 500;
}

.panel-close {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.4);
  font-size: 16px;
  cursor: pointer;
}

.panel-body {
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.style-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.style-group label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.style-group input[type="color"] {
  width: 40px;
  height: 28px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  padding: 0;
}

.style-group input[type="range"] {
  width: 100%;
  accent-color: #7864a0;
}

.style-group textarea {
  width: 100%;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.8);
  font-family: monospace;
  font-size: 12px;
  padding: 8px;
  resize: vertical;
  outline: none;
}
.style-group textarea::placeholder { color: rgba(255, 255, 255, 0.25); }

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.upload-btn {
  padding: 4px 12px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.6);
  font-size: 12px;
  cursor: pointer;
}
.upload-btn:hover { background: rgba(255, 255, 255, 0.12); }

.clear-btn {
  padding: 4px 10px;
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.4);
  font-size: 12px;
  cursor: pointer;
}

.font-name {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.reset-all-btn {
  margin-top: 8px;
  padding: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.4);
  font-size: 12px;
  cursor: pointer;
}
.reset-all-btn:hover { color: rgba(255, 255, 255, 0.6); }

/* 面板滑入动画 */
.panel-slide-enter-active,
.panel-slide-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}
.panel-slide-enter-from,
.panel-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

/* 图片相关 */
.input-footer {
  position: relative;
  z-index: 2;
  flex-shrink: 0;
  background: rgba(25, 20, 40, 0.85);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-top: 1px solid rgba(140, 120, 180, 0.15);
}

.image-preview-bar {
  display: flex;
  gap: 8px;
  padding: 8px 14px 0;
  overflow-x: auto;
}

.preview-thumb {
  position: relative;
  flex-shrink: 0;
}

.preview-thumb img {
  width: 60px;
  height: 60px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.remove-img {
  position: absolute;
  top: -4px;
  right: -4px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: rgba(200, 60, 60, 0.8);
  color: white;
  font-size: 10px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.attach-btn {
  font-size: 20px;
  cursor: pointer;
  padding: 4px;
  user-select: none;
}

.msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
}

.msg-image {
  max-width: 200px;
  max-height: 200px;
  border-radius: 12px;
  object-fit: cover;
  border: 1px solid rgba(255, 255, 255, 0.08);
}
</style>
