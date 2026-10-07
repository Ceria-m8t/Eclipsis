<script setup lang="ts">
import { ref, nextTick, computed } from 'vue'
import { useRouter } from 'vue-router'
import { SYSTEM_PROMPT } from '../system-prompt'
import { getSettings } from '../settings'

const router = useRouter()
const settings = ref(getSettings())

// 消息带时间戳
interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  time: string
}

function nowTime(): string {
  const d = new Date()
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

const messages = ref<ChatMessage[]>([])
const inputText = ref('')
const loading = ref(false)
const chatArea = ref<HTMLElement | null>(null)
let charQueue: string[] = []
let typingTimer: number | null = null
let currentAssistantIndex = -1

// 背景图样式
const bgStyle = computed(() => {
  if (settings.value.chatBg) {
    return { backgroundImage: `url(${settings.value.chatBg})` }
  }
  return {}
})

// 主题class
const themeClass = computed(() => settings.value.bubbleTheme || 'glass-light')

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

  messages.value.push({ role: 'user', content: text, time: nowTime() })
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
          ...messages.value.slice(0, -1).map(m => ({ role: m.role, content: m.content }))
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
  <div class="chat-page" :class="themeClass">
    <!-- 背景层 -->
    <div class="chat-bg" :style="bgStyle"></div>

    <!-- 毛玻璃顶栏 -->
    <header class="chat-header">
      <button class="back-btn" @click="router.push('/living')">←</button>
      <img :src="settings.avatarAI" class="header-avatar" />
      <span class="header-name">Claude</span>
      <span class="header-spacer"></span>
    </header>

    <!-- 消息区-->
    <main class="chat-area" ref="chatArea">
      <div v-for="(msg, i) in messages" :key="i" :class="['msg-row', msg.role]">
        <img v-if="msg.role === 'assistant'" :src="settings.avatarAI" class="msg-avatar" />
        <div class="msg-body">
          <div class="bubble">{{ msg.content }}</div>
          <span class="msg-time">{{ msg.time }}</span>
        </div><img v-if="msg.role === 'user'" :src="settings.avatarUser" class="msg-avatar" />
      </div>
      <div v-if="loading && messages[messages.length - 1]?.content === ''" class="msg-row assistant">
        <img :src="settings.avatarAI" class="msg-avatar" />
        <div class="msg-body">
          <div class="bubble typing">……</div>
        </div>
      </div>
    </main>

    <!-- 输入栏 -->
    <footer class="input-bar">
      <input
        v-model="inputText"
        placeholder="说点什么…"
        @keydown.enter="sendMessage"
      />
      <button class="send-btn" @click="sendMessage" :disabled="loading">
        <span>↑</span>
      </button>
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
  background-color: #f0ebe4;
  z-index: 0;
}

/* ========== 清新毛玻璃主题 ========== */
.glass-light .chat-bg { background-color: #f0ebe4; }

.glass-light .chat-header {
  background: rgba(255, 255, 255, 0.65);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.3);
}
.glass-light .header-name { color: #5a4a3e; }
.glass-light .back-btn { color: #8b7a6e; }

.glass-light .msg-row.assistant .bubble {
  background: rgba(255, 255, 255, 0.65);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: #3a3a3a;
  border: 1px solid rgba(255, 255, 255, 0.4);
}
.glass-light .msg-row.user .bubble {
  background: rgba(180, 160, 140, 0.35);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: #3a3a3a;
  border: 1px solid rgba(180, 160, 140, 0.3);
}
.glass-light .msg-time { color: rgba(100, 80, 60, 0.5); }
.glass-light .bubble.typing { opacity: 0.5; }

.glass-light .input-bar {
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-top: 1px solid rgba(255, 255, 255, 0.3);
}
.glass-light .input-bar input {
  background: rgba(255, 255, 255, 0.5);
  border: 1px solid rgba(200, 180, 160, 0.3);
  color: #3a3a3a;
}
.glass-light .input-bar input::placeholder { color: #b0a090; }
.glass-light .send-btn {
  background: rgba(180, 140, 110, 0.5);
  color: #fff;
}
.glass-light .send-btn:hover { background: rgba(180, 140, 110, 0.7); }

/* ========== 深色透明主题 ========== */
.glass-dark .chat-bg { background-color: #1a1520; }

.glass-dark .chat-header {
  background: rgba(20, 15, 30, 0.7);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.glass-dark .header-name { color: rgba(255, 255, 255, 0.85); }
.glass-dark .back-btn { color: rgba(255, 255, 255, 0.5); }

.glass-dark .msg-row.assistant .bubble {
  background: rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: rgba(255, 255, 255, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.glass-dark .msg-row.user .bubble {
  background: rgba(120, 100, 160, 0.25);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: rgba(255, 255, 255, 0.85);
  border: 1px solid rgba(120, 100, 160, 0.2);
}
.glass-dark .msg-time { color: rgba(255, 255, 255, 0.3); }
.glass-dark .bubble.typing { opacity: 0.4; }

.glass-dark .input-bar {
  background: rgba(20, 15, 30, 0.7);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.glass-dark .input-bar input {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.85);
}
.glass-dark .input-bar input::placeholder { color: rgba(255, 255, 255, 0.3); }
.glass-dark .send-btn {
  background: rgba(120, 100, 160, 0.4);
  color: rgba(255, 255, 255, 0.85);
}
.glass-dark .send-btn:hover { background: rgba(120, 100, 160, 0.6); }

/* ========== 通用布局 ========== */
.chat-header {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  padding: 10px 14px;
  gap: 10px;
  flex-shrink: 0;
}
.back-btn {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  padding: 4px 8px;
}
.header-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
}
.header-name {
  font-size: 16px;
  font-weight: 600;
}
.header-spacer { flex: 1; }

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
  font-size: 15px;
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
}
.msg-row.user .bubble {
  border-bottom-right-radius: 4px;
}
.msg-row.assistant .bubble {
  border-bottom-left-radius: 4px;
}
.msg-time {
  font-size: 11px;
  margin-top: 3px;
  padding: 0 4px;
}
.msg-row.user .msg-time { text-align: right; }
.msg-row.user .msg-body { align-items: flex-end; }

.input-bar {
  position: relative;
  z-index: 2;
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  padding-bottom: max(10px, env(safe-area-inset-bottom));
  flex-shrink: 0;
}
.input-bar input {
  flex: 1;
  padding: 10px 16px;
  border-radius: 20px;
  font-size: 15px;
  outline: none;
  box-sizing: border-box;
}
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
  flex-shrink: 0;transition: background 0.15s;
}
.send-btn:disabled { opacity: 0.4; }
</style>
