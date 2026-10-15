<script setup lang="ts">
import { ref, nextTick, computed, onMounted, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { SYSTEM_PROMPT } from '../system-prompt'
import { getSettings } from '../settings'
import { loadMcpServers, buildToolDefinitions, executeToolCall, type McpServer, type ToolCall, type ToolResult } from '../mcp'

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true
})

function renderMd(text: string): string {
  if (!text) return ''
  const raw = marked.parse(text) as string
  return DOMPurify.sanitize(raw)
}

const settings = ref(getSettings())
const mcpServers = ref<McpServer[]>(loadMcpServers())

// ===== Chat Style =====
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
  bgColor: '#f5f3f0',
  bgImage: '',
  aiBubbleBg: '#ffffff',
  aiBubbleOpacity: 0.9,
  userBubbleBg: '#e8e5e0',
  userBubbleOpacity: 0.9,
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

// ===== Message Persistence =====
interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  time: string
  images?: string[]
}

const HISTORY_KEY = 'eclipsis-chat-history'

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.value))
  } catch (e) {
    // localStorage full — trim oldest messages
    if (messages.value.length > 20) {
      messages.value.splice(0, messages.value.length - 20)
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.value))
      } catch {}
    }
  }
}

function loadHistory(): ChatMessage[] {
  try {
    const saved = localStorage.getItem(HISTORY_KEY)
    if (saved) return JSON.parse(saved)
  } catch {}
  return []
}

function clearHistory() {
  if (!confirm('确定清空所有聊天记录？此操作不可撤销。')) return
  messages.value = []
  localStorage.removeItem(HISTORY_KEY)
}

// Context window: only send last N messages to API
const MAX_CONTEXT_MESSAGES = 200

function deleteMessage(index: number) {
  messages.value.splice(index, 1)
  saveHistory()
}

function regenerateMessage(index: number) {
  // Only works on assistant messages
  const msg = messages.value[index]
  if (msg.role !== 'assistant' || loading.value) return
  // Remove this assistant message and re-send
  messages.value.splice(index, 1)
  saveHistory()
  // Trigger a new generation from the last user message
  regenerateFromHistory()
}

async function regenerateFromHistory() {
  await doGenerate()
}

function nowTime(): string {
  const d = new Date()
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

const messages = ref<ChatMessage[]>(loadHistory())
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

// Scroll to bottom on mount if there's history
onMounted(() => {
  if (messages.value.length > 0) {
    scrollToBottom()
  }
})

function startTyping(index: number) {
  currentAssistantIndex = index
  if (typingTimer) return
  typingTimer = window.setInterval(() => {
    if (charQueue.length === 0) {
      if (!loading.value) {
        window.clearInterval(typingTimer!)
        typingTimer = null
        saveHistory()
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
  const saved = localStorage.getItem('worldbook')
  let beforeEntries: { title: string; content: string; priority: number }[] = []
  let afterEntries: { title: string; content: string; priority: number }[] = []

  if (saved) {
    try {
      const entries = JSON.parse(saved) as {
        title: string; content: string; enabled: boolean;
        group: string; position: string; priority: number
      }[]
      const groupsRaw = localStorage.getItem('worldbook-groups')
      const groupStates: Record<string, { enabled: boolean }> = groupsRaw ? JSON.parse(groupsRaw) : {}

      for (const e of entries) {
        if (!e.enabled) continue
        const gs = groupStates[e.group]
        if (gs && !gs.enabled) continue
        const item = { title: e.title, content: e.content, priority: e.priority ?? 50 }
        if (e.position === 'before') beforeEntries.push(item)
        else afterEntries.push(item)
      }
      beforeEntries.sort((a, b) => b.priority - a.priority)
      afterEntries.sort((a, b) => b.priority - a.priority)
    } catch {}
  }

  let prompt = ''
  if (beforeEntries.length > 0) {
    for (const e of beforeEntries) prompt += e.content + '\n\n'
  }
  prompt += SYSTEM_PROMPT
  if (afterEntries.length > 0) {
    prompt += '\n\n'
    for (const e of afterEntries) prompt += e.content + '\n\n'
  }
  return prompt.trim()
}


// Long press to copy
function handleBubbleLongPress(msg: ChatMessage) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(msg.content).then(() => {
      showToast('已复制')
    })
  }
}

const toastMsg = ref('')
const toastVisible = ref(false)
let toastTimer: number | null = null

function showToast(text: string) {
  toastMsg.value = text
  toastVisible.value = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toastVisible.value = false }, 1500)
}

// Touch-based long press detection
let pressTimer: number | null = null

function onTouchStart(msg: ChatMessage) {
  pressTimer = window.setTimeout(() => {
    handleBubbleLongPress(msg)
  }, 600)
}

function onTouchEnd() {
  if (pressTimer) {
    clearTimeout(pressTimer)
    pressTimer = null
  }
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
  saveHistory()
  scrollToBottom()

  await doGenerate()
}

async function doGenerate() {
  // Reload MCP servers from localStorage (in case settings page updated them)
  mcpServers.value = loadMcpServers()
  loading.value = true
  charQueue = []

  const assistantIndex = messages.value.length
  messages.value.push({ role: 'assistant', content: '', time: nowTime() })
  startTyping(assistantIndex)

  const { apiBase, apiKey, model } = settings.value
  const url = apiBase ? `${apiBase}/chat/completions` : '/api/chat/completions'

  // Build context with truncation
  const contextMessages = messages.value.slice(0, assistantIndex)
  const truncated = contextMessages.length > MAX_CONTEXT_MESSAGES
    ? contextMessages.slice(-MAX_CONTEXT_MESSAGES)
    : contextMessages

  // Build tools from MCP servers
  const tools = buildToolDefinitions(mcpServers.value)
  // Build API messages (filter out internal tool messages for display)
  const apiMessages: any[] = [
    { role: 'system', content: getFullSystemPrompt() }
  ]

  for (const m of truncated) {
    if (m.images && m.images.length > 0) {
      apiMessages.push({
        role: m.role,
        content: [
          ...m.images.map(img => ({
            type: 'image_url' as const,
            image_url: { url: img }
          })),
          { type: 'text' as const, text: m.content || '(图片)' }
        ]
      })
    } else {
      apiMessages.push({ role: m.role, content: m.content })
    }
  }

  const body: any = {
    model,
    messages: apiMessages,
    stream: true
  }
  if (tools.length > 0) {
    body.tools = tools
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      messages.value[assistantIndex].content = `[错误 ${res.status}] ${await res.text()}`
      loading.value = false
      saveHistory()
      return
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let pendingToolCalls: ToolCall[] = []
    let currentToolCall: { id: string; name: string; inputJson: string } | null = null

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
          const choice = parsed.choices?.[0]
          if (!choice) continue

          // Handle text content
          const textDelta = choice.delta?.content
          if (textDelta) {
            charQueue.push(...textDelta.split(''))
          }

          // Handle tool calls
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              if (tc.id) {
                // New tool call starting
                if (currentToolCall && currentToolCall.id) {
                  // Finalize previous
                  try {
                    pendingToolCalls.push({
                      id: currentToolCall.id,
                      name: currentToolCall.name,
                      input: JSON.parse(currentToolCall.inputJson || '{}')
                    })
                  } catch {
                    pendingToolCalls.push({
                      id: currentToolCall.id,
                      name: currentToolCall.name,
                      input: {}
                    })
                  }
                }
                currentToolCall = { id: tc.id, name: tc.function?.name || '', inputJson: tc.function?.arguments || '' }
              } else if (currentToolCall) {
                // Continuing to stream arguments
                if (tc.function?.name) currentToolCall.name += tc.function.name
                if (tc.function?.arguments) currentToolCall.inputJson += tc.function.arguments
              }
            }
          }

          // Check for finish reason
          if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'tool_use') {
            // Finalize last tool call
            if (currentToolCall && currentToolCall.id) {
              try {
                pendingToolCalls.push({
                  id: currentToolCall.id,
                  name: currentToolCall.name,
                  input: JSON.parse(currentToolCall.inputJson || '{}')
                })
              } catch {
                pendingToolCalls.push({
                  id: currentToolCall.id,
                  name: currentToolCall.name,
                  input: {}
                })
              }
            }
          }
        } catch {}
      }
    }

    // Wait for typing to finish
    await new Promise<void>(resolve => {
      const check = () => {
        if (charQueue.length === 0) resolve()
        else setTimeout(check, 50)
      }
      check()
    })

    // If there are tool calls, execute them and continue
    if (pendingToolCalls.length > 0) {
      // Show tool call info in the message
      const toolNames = pendingToolCalls.map(tc => tc.name).join(', ')
      charQueue.push(...`\n\n⚙️ 调用工具: ${toolNames}...`.split(''))

      // Wait for display
      await new Promise(r => setTimeout(r, 300))

      // Execute all tool calls
      const results: ToolResult[] = []
      for (const tc of pendingToolCalls) {
        const result = await executeToolCall(mcpServers.value, tc)
        results.push(result)
      }

      // Save current assistant message content
      // Wait for typing queue to clear
      await new Promise<void>(resolve => {
        const check = () => {
          if (charQueue.length === 0) resolve()
          else setTimeout(check, 50)
        }
        check()
      })

      loading.value = false
      saveHistory()

      // Now do a follow-up request with tool results
      // Add the assistant message with tool_calls and tool results
      await doToolFollowUp(assistantIndex, pendingToolCalls, results, url, apiKey, model, apiMessages)
      return
    }

  } catch (err: any) {
    messages.value[assistantIndex].content = `[请求失败] ${(err as Error).message}`
  } finally {
    loading.value = false
    saveHistory()
    scrollToBottom()
  }
}

async function doToolFollowUp(
  prevAssistantIndex: number,
  toolCalls: ToolCall[],
  results: ToolResult[],
  url: string,
  apiKey: string,
  model: string,
  prevApiMessages: any[]
) {
  loading.value = true
  charQueue = []

  // Create new assistant message for the follow-up
  const newAssistantIndex = messages.value.length
  messages.value.push({ role: 'assistant', content: '', time: nowTime() })
  startTyping(newAssistantIndex)

  // Build messages: previous context + assistant tool_calls + tool results
  const followUpMessages = [
    ...prevApiMessages,
    {
      role: 'assistant',
      content: messages.value[prevAssistantIndex].content.replace(/\n\n⚙️ 调用工具:.*$/, ''),
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.input) }
      }))
    },
    ...results.map(r => ({
      role: 'tool',
      tool_call_id: r.tool_use_id,
      content: r.content
    }))
  ]

  const tools = buildToolDefinitions(mcpServers.value)
  const body: any = { model, messages: followUpMessages, stream: true }
  if (tools.length > 0) body.tools = tools

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      messages.value[newAssistantIndex].content = `[工具调用后错误 ${res.status}] ${await res.text()}`
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
    messages.value[newAssistantIndex].content = `[请求失败] ${(err as Error).message}`
  } finally {
    loading.value = false
    saveHistory()
    scrollToBottom()
  }
}

</script>

<template>
  <div class="chat-page">
    <div class="chat-bg" :style="bgStyle"></div>

    <!-- Header -->
    <header class="chat-header">
      <img :src="settings.avatarAI" class="header-avatar" />
      <span class="header-name">小克^ ^</span>
      <span class="header-spacer"></span>
      <button class="header-btn" @click="showStylePanel = !showStylePanel">⚙</button>
    </header>

    <!-- Style Panel -->
    <transition name="panel-slide">
      <div v-if="showStylePanel" class="style-panel">
        <div class="panel-header">
          <span>聊天样式</span>
          <button class="panel-close" @click="showStylePanel = false">✕</button>
        </div>
        <div class="panel-body">
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
          <div class="style-group">
            <label>AI 气泡颜色</label>
            <input type="color" v-model="chatStyle.aiBubbleBg" />
          </div>
          <div class="style-group">
            <label>AI 气泡透明度 {{ Math.round(chatStyle.aiBubbleOpacity * 100) }}%</label>
            <input type="range" min="0.1" max="1" step="0.05" v-model.number="chatStyle.aiBubbleOpacity" />
          </div>
          <div class="style-group">
            <label>我的气泡颜色</label>
            <input type="color" v-model="chatStyle.userBubbleBg" />
          </div>
          <div class="style-group">
            <label>我的气泡透明度 {{ Math.round(chatStyle.userBubbleOpacity * 100) }}%</label>
            <input type="range" min="0.1" max="1" step="0.05" v-model.number="chatStyle.userBubbleOpacity" />
          </div>
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
          <div class="style-group">
            <label>自定义 CSS</label>
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

    <!-- Messages -->
    <main class="chat-area" ref="chatArea">
      <div v-for="(msg, i) in messages" :key="i" :class="['msg-row', msg.role]">
        <img v-if="msg.role === 'assistant'" :src="settings.avatarAI" class="msg-avatar" />
        <div class="msg-body">
          <div v-if="msg.images?.length" class="msg-images">
            <img v-for="(img, j) in msg.images" :key="j" :src="img" class="msg-image" />
          </div>
          <div
            v-if="msg.role === 'assistant'"
            class="bubble markdown-body"
            :style="aiBubbleStyle"
            v-html="renderMd(msg.content)"
            @touchstart="onTouchStart(msg)"
            @touchend="onTouchEnd"
            @touchcancel="onTouchEnd"
          ></div>
          <div
            v-else
            class="bubble"
            :style="userBubbleStyle"
            @touchstart="onTouchStart(msg)"
            @touchend="onTouchEnd"
            @touchcancel="onTouchEnd"
          >{{ msg.content }}</div>
          <div class="msg-actions">
            <span class="msg-time">{{ msg.time }}</span>
            <button v-if="msg.role === 'assistant' && !loading" class="msg-action-btn" @click="regenerateMessage(i)" title="重新生成">🔄</button>
            <button class="msg-action-btn" @click="deleteMessage(i)" title="删除">✕</button>
          </div>
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

    <!-- Toast -->
    <transition name="fade">
      <div v-if="toastVisible" class="toast">{{ toastMsg }}</div>
    </transition>

    <!-- Input -->
    <footer class="input-footer">
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
  height: 100%;
  width: 100%;
  overflow: hidden;
}

.chat-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  z-index: 0;
}

/* Header — light frosted */
.chat-header {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: center;
  padding: 10px 14px;
  gap: 10px;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.75);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.header-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
}

.header-name {
  font-size: 16px;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.75);
}

.header-spacer { flex: 1; }

.header-btn {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  color: rgba(0, 0, 0, 0.35);
  padding: 4px 8px;
}
.header-btn:hover { color: rgba(0, 0, 0, 0.6); }

/* Chat area */
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
  width: 34px;
  height: 34px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
  margin-top: 2px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}

.msg-body {
  display: flex;
  flex-direction: column;
  max-width: 72%;
}

/* Bubbles — light, clean */
.bubble {
  padding: 10px 14px;
  border-radius: 18px;
  line-height: 1.6;
  word-break: break-word;
  color: rgba(0, 0, 0, 0.8);
  border: 1px solid rgba(0, 0, 0, 0.06);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  user-select: text;
  -webkit-user-select: text;
  box-shadow: 0 1px 2px rgba(0,0,0,0.04);
}

.msg-row.user .bubble { white-space: pre-wrap; }

/* Markdown — light theme */
.bubble.markdown-body :deep(p) { margin: 0 0 0.5em 0; }
.bubble.markdown-body :deep(p:last-child) { margin-bottom: 0; }
.bubble.markdown-body :deep(strong) { color: rgba(0, 0, 0, 0.85); }
.bubble.markdown-body :deep(em) { color: rgba(80, 70, 100, 0.85); }
.bubble.markdown-body :deep(code) {
  background: rgba(0, 0, 0, 0.05);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.9em;
  font-family: 'Menlo', 'Consolas', monospace;
  color: rgba(0, 0, 0, 0.7);
}
.bubble.markdown-body :deep(pre) {
  background: rgba(0, 0, 0, 0.04);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
  margin: 6px 0;
  border: 1px solid rgba(0,0,0,0.06);
}
.bubble.markdown-body :deep(pre code) {
  background: none;
  padding: 0;
  font-size: 0.85em;
  line-height: 1.5;
}
.bubble.markdown-body :deep(ul), .bubble.markdown-body :deep(ol) {
  padding-left: 1.4em;
  margin: 4px 0;
}
.bubble.markdown-body :deep(li) { margin: 2px 0; }
.bubble.markdown-body :deep(blockquote) {
  border-left: 3px solid rgba(0, 0, 0, 0.15);
  padding-left: 10px;
  margin: 6px 0;
  color: rgba(0, 0, 0, 0.5);
}
.bubble.markdown-body :deep(a) {
  color: rgba(80, 70, 120, 0.8);
  text-decoration: underline;
}
.bubble.markdown-body :deep(h1),
.bubble.markdown-body :deep(h2),
.bubble.markdown-body :deep(h3) {
  margin: 8px 0 4px 0;
  font-size: 1em;
  color: rgba(0, 0, 0, 0.85);
}

.msg-row.user .bubble { border-bottom-right-radius: 4px; }
.msg-row.assistant .bubble { border-bottom-left-radius: 4px; }

.bubble.typing { opacity: 0.4; }

.msg-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  padding: 0 4px;
}

.msg-time {
  font-size: 11px;
  color: rgba(0, 0, 0, 0.3);
}

.msg-action-btn {
  background: none;
  border: none;
  font-size: 11px;
  color: rgba(0, 0, 0, 0.2);
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.15s;
}

.msg-row:hover .msg-action-btn,
.msg-actions:active .msg-action-btn {
  opacity: 1;
}

.msg-action-btn:hover { color: rgba(0, 0, 0, 0.5); }

.msg-row.user .msg-actions { justify-content: flex-end; }
.msg-row.user .msg-body { align-items: flex-end; }

/* Input footer — light */
.input-footer {
  position: relative;
  z-index: 2;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}

.input-bar {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  padding-bottom: max(10px, env(safe-area-inset-bottom));
}

.input-bar input {
  flex: 1;
  padding: 10px 16px;
  border-radius: 20px;
  font-size: 15px;
  outline: none;
  box-sizing: border-box;
  background: rgba(0, 0, 0, 0.04);
  border: 1px solid rgba(0, 0, 0, 0.08);
  color: rgba(0, 0, 0, 0.8);
}
.input-bar input::placeholder { color: rgba(0, 0, 0, 0.3); }

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
  background: rgba(0, 0, 0, 0.08);
  color: rgba(0, 0, 0, 0.6);
}
.send-btn:hover { background: rgba(0, 0, 0, 0.14); }
.send-btn:disabled { opacity: 0.4; }

.attach-btn {
  font-size: 20px;
  cursor: pointer;
  padding: 4px;
  user-select: none;
}

/* Images */
.image-preview-bar {
  display: flex;
  gap: 8px;
  padding: 8px 14px 0;
  overflow-x: auto;
}

.preview-thumb { position: relative; flex-shrink: 0; }

.preview-thumb img {
  width: 60px;
  height: 60px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.08);
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
  border: 1px solid rgba(0, 0, 0, 0.06);
}

/* Style Panel — light */
.style-panel {
  position: absolute;
  top: 56px;
  right: 0;
  width: 280px;
  max-height: 70vh;
  z-index: 20;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(0, 0, 0, 0.08);
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
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  color: rgba(0, 0, 0, 0.7);
  font-size: 14px;
  font-weight: 500;
}

.panel-close {
  background: none;
  border: none;
  color: rgba(0, 0, 0, 0.35);
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
  color: rgba(0, 0, 0, 0.45);
}

.style-group input[type="color"] {
  width: 40px;
  height: 28px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  padding: 0;
}

.style-group input[type="range"] {
  width: 100%;
  accent-color: #999;
}

.style-group textarea {
  width: 100%;
  background: rgba(0, 0, 0, 0.03);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 8px;
  color: rgba(0, 0, 0, 0.7);
  font-family: monospace;
  font-size: 12px;
  padding: 8px;
  resize: vertical;
  outline: none;
}
.style-group textarea::placeholder { color: rgba(0, 0, 0, 0.25); }

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.upload-btn {
  padding: 4px 12px;
  background: rgba(0, 0, 0, 0.05);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 6px;
  color: rgba(0, 0, 0, 0.5);
  font-size: 12px;
  cursor: pointer;
}
.upload-btn:hover { background: rgba(0, 0, 0, 0.08); }

.clear-btn {
  padding: 4px 10px;
  background: none;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 6px;
  color: rgba(0, 0, 0, 0.35);
  font-size: 12px;
  cursor: pointer;
}

.font-name {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.reset-all-btn {
  margin-top: 8px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.03);
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 8px;
  color: rgba(0, 0, 0, 0.35);
  font-size: 12px;
  cursor: pointer;
}
.reset-all-btn:hover { color: rgba(0, 0, 0, 0.5); }

.panel-slide-enter-active,
.panel-slide-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}
.panel-slide-enter-from,
.panel-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

/* Toast — light */
.toast {
  position: fixed;
  bottom: 120px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(255, 255, 255, 0.92);
  color: rgba(0, 0, 0, 0.7);
  padding: 8px 20px;
  border-radius: 20px;
  font-size: 13px;
  z-index: 100;
  pointer-events: none;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  border: 1px solid rgba(0,0,0,0.06);
}

.fade-enter-active, .fade-leave-active {
  transition: opacity 0.3s;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>
