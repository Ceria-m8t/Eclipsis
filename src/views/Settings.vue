<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { getSettings, saveSettings } from '../settings'

const router = useRouter()
const settings = ref(getSettings())

function save() {
  saveSettings(settings.value)
  router.push('/')
}

function cancel() {
  router.push('/')
}
</script>

<template>
  <div class="settings">
    <header class="room-header">
      <button class="back-btn" @click="cancel">← 玄关</button>
      <span class="room-title">设置</span>
      <div class="spacer"></div>
    </header>

    <main class="content">
      <div class="form">
        <label>
          API 地址
          <input v-model="settings.apiBase" placeholder="留空用默认代理" />
          <span class="hint">本地开发留空即可</span>
        </label>
        
        <label>
          API Key
          <input v-model="settings.apiKey" type="password" placeholder="网关密钥" />
          <span class="hint">已配置在服务器nginx中</span>
        </label>
        
        <label>
          模型名
          <input v-model="settings.model" placeholder="claude-fable-5[次]" />
        </label>

        <div class="actions">
          <button class="secondary" @click="cancel">取消</button>
          <button class="primary" @click="save">保存</button>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  background: #0a0a0f;
  color: #e0e0e0;
}

.room-header {
  display: flex;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #1a1a2e;
  flex-shrink: 0;
}

.back-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 4px 8px;
}

.back-btn:hover {
  color: #c8c8d0;
}

.room-title {
  flex: 1;
  text-align: center;
  font-size: 18px;
  font-weight: 600;
  color: #c8c8d0;
}

.spacer {
  width: 60px;
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.form {
  max-width: 400px;
  margin: 0 auto;
}

label {
  display: block;
  margin-bottom: 20px;
  font-size: 14px;
  color: #c8c8d0;
}

label input {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 10px 14px;
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  background: #12121e;
  color: #e0e0e0;
  font-size: 15px;
  outline: none;
}

label input:focus {
  border-color: #4a4a8a;
}

.hint {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: #666;
}

.actions {
  display: flex;
  gap: 12px;
  margin-top: 32px;
}

.actions button {
  flex: 1;
  padding: 12px;
  border: none;
  border-radius: 8px;
  font-size: 15px;
  cursor: pointer;
}

.secondary {
  background: transparent;
  border: 1px solid #2a2a4a !important;
  color: #c8c8d0;
}

.primary {
  background: #3a3a6a;
  color: #e0e0e0;
}

.primary:hover {
  background: #4a4a8a;
}
</style>
