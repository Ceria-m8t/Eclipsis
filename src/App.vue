<script setup lang="ts">
import { SYSTEM_PROMPT } from './system-prompt'
import { getSettings, saveSettings } from './settings'
import { ref, nextTick } from 'vue'

const settings = ref(getSettings())
const showSettings = ref(false)
const tempSettings = ref({ ...settings.value })

function openSettings() {
  tempSettings.value = { ...settings.value }
  showSettings.value = true
}

function applySettings() {
  saveSettings(tempSettings.value)
  settings.value = { ...tempSettings.value }
  showSettings.value = false
}

const messages = ref<{ role: 'user' | 'assistant'; content: string }[]>([])
const inputText = ref('')
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

async function sendMessage() {
  const text = inputText.value.trim()
  if (!text || loading.value) return

  messages.value.push({ role: 'user', content: text })
  inputText.value = ''
  loading.value = true
  charQueue = []
  scrollToBottom()

  const assistantIndex = messages.value.length
  messages.value.push({ role: 'assistant', content: '' })
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
        model: model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
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
        } catch {
          // 忽略
        }
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
  <div class="app">
    <header class="top-bar">
      <span>我们的家</span>
      <button class="settings-btn" @click="openSettings">⚙</button>
    </header>

    <!-- 设置面板 -->
    <div v-if="showSettings" class="settings-overlay" @click.self="showSettings = false">
      <div class="settings-panel">
        <h3>设置</h3>
        <label>
          API 地址
          <input v-model="tempSettings.apiBase" placeholder="留空用默认代理" />
        </label>
        <label>
          API Key
          <input v-model="tempSettings.apiKey" type="password" placeholder="sk-..." />
        </label>
        <label>
          模型名
          <input v-model="tempSettings.model" placeholder="claude-opus-4-6" />
        </label>
        <div class="settings-actions">
          <button @click="showSettings = false">取消</button>
          <button class="primary" @click="applySettings">保存</button>
        </div>
      </div>
    </div>

    <main class="chat-area" ref="chatArea">
      <div
        v-for="(msg, i) in messages"
        :key="i"
        :class="['bubble', msg.role]"
      >
        {{ msg.content }}
      </div>
      <div v-if="loading && messages[messages.length - 1]?.content === ''" class="bubble assistant typing">……</div>
    </main>

    <footer class="input-bar">
      <input
        v-model="inputText"
        placeholder="说点什么…"
        @keydown.enter="sendMessage"
      />
      <button @click="sendMessage" :disabled="loading">发送</button>
    </footer>
  </div>
</template>

<style scoped>
* { margin: 0; padding: 0; box-sizing: border-box; }

.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  background: #0a0a0f;
  color: #e0e0e0;
  font-family: system-ui, sans-serif;
}

.top-bar {
  padding: 16px;
  text-align: center;
  font-size: 18px;
  font-weight: 600;
  border-bottom: 1px solid #1a1a2e;
  color: #c8c8d0;
  flex-shrink: 0;position: relative;
}

.settings-btn {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: #888;
  font-size: 18px;
  cursor: pointer;
}

.settings-btn:hover { color: #c8c8d0; }

.settings-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.settings-panel {
  background: #12121e;
  border: 1px solid #2a2a4a;
  border-radius: 16px;
  padding: 24px;
  width: 90%;
  max-width: 400px;
}

.settings-panel h3 {
  margin-bottom: 16px;
  font-size: 16px;
  color: #c8c8d0;
}

.settings-panel label {
  display: block;
  margin-bottom: 12px;
  font-size: 13px;
  color: #888;
}

.settings-panel input {
  display: block;
  width: 100%;
  margin-top: 4px;
  padding: 8px 12px;
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  background: #0a0a0f;
  color: #e0e0e0;
  font-size: 14px;
  outline: none;
}

.settings-panel input:focus {
  border-color: #4a4a8a;
}

.settings-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}

.settings-actions button {
  padding: 8px 16px;
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  background: transparent;
  color: #c8c8d0;
  font-size: 14px;
  cursor: pointer;
}

.settings-actions .primary {
  background: #3a3a6a;
  border-color: #3a3a6a;
}

.chat-area {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  -webkit-overflow-scrolling: touch;
}

.bubble {
  max-width: 78%;
  padding: 10px 14px;
  border-radius: 16px;
  font-size: 15px;
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
}

.bubble.user {
  align-self: flex-end;
  background: #2a2a4a;
  border-bottom-right-radius: 4px;
}

.bubble.assistant {
  align-self: flex-start;
  background: #1a1a2e;
  border-bottom-left-radius: 4px;
}

.bubble.typing { opacity: 0.5; }

.input-bar {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  padding-bottom: max(12px, env(safe-area-inset-bottom));
  border-top: 1px solid #1a1a2e;
  background: #0d0d14;
  flex-shrink: 0;
}

.input-bar input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid #2a2a4a;
  border-radius: 20px;
  background: #12121e;
  color: #e0e0e0;
  font-size: 15px;
  outline: none;
}

.input-bar input::placeholder { color: #555; }

.input-bar button {
  padding: 10px 20px;
  border: none;
  border-radius: 20px;
  background: #3a3a6a;
  color: #e0e0e0;
  font-size: 14px;
  cursor: pointer;
}

.input-bar button:disabled { opacity: 0.4; }
.input-bar button:hover:not(:disabled) { background: #4a4a8a; }
</style>