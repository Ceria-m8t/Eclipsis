<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { getSettings, saveSettings } from '../settings'

const router = useRouter()
const settings = ref(getSettings())

// 图片上传转base64
function handleImageUpload(event: Event, field: 'chatBg' | 'avatarUser' | 'avatarAI') {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = (e) => {
    settings.value[field] = e.target?.result as string
  }
  reader.readAsDataURL(file)
}

function clearImage(field: 'chatBg' | 'avatarUser' | 'avatarAI') {
  if (field === 'avatarUser') {
    settings.value[field] = '/avatar-erica.jpg'
  } else if (field === 'avatarAI') {
    settings.value[field] = '/avatar-claude.jpg'
  } else {
    settings.value[field] = ''
  }
}

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
      <button class="back-btn" @click="cancel">←玄关</button>
      <span class="room-title">设置</span>
      <div class="spacer"></div>
    </header>

    <main class="content">
      <div class="form">
        <!-- API 设置 -->
        <div class="section-title">连接设置</div>

        <label>
          API 地址
          <input v-model="settings.apiBase" placeholder="留空用默认代理" />
          <span class="hint">本地开发留空即可</span>
        </label>

        <label>
          API Key
          <input v-model="settings.apiKey" type="password" placeholder="网关密钥" />
        </label>

        <label>
          模型名
          <input v-model="settings.model" placeholder="claude-fable-5[次]" />
        </label>

        <!-- 外观设置 -->
        <div class="section-title">外观设置</div>

        <!-- 头像 -->
        <div class="image-setting">
          <span class="image-label">我的头像</span>
          <div class="image-row">
            < img :src="settings.avatarUser" class="avatar-preview" />
            <label class="upload-btn">
              更换
              <input type="file" accept="image/*" hidden @change="handleImageUpload($event, 'avatarUser')" />
            </label><button class="reset-btn" @click="clearImage('avatarUser')">重置</button>
          </div>
        </div>

        <div class="image-setting">
          <span class="image-label">Claude 头像</span>
          <div class="image-row">
            < img :src="settings.avatarAI" class="avatar-preview" />
            <label class="upload-btn">
              更换
              <input type="file" accept="image/*" hidden @change="handleImageUpload($event, 'avatarAI')" />
            </label>
            <button class="reset-btn" @click="clearImage('avatarAI')">重置</button>
          </div>
        </div>

        <!-- 聊天背景 -->
        <div class="image-setting">
          <span class="image-label">聊天背景图</span>
          <div class="image-row">
            <div class="bg-preview" :style="settings.chatBg ? { backgroundImage: `url(${settings.chatBg})` } : {}">
              <span v-if="!settings.chatBg" class="bg-empty">无</span>
            </div>
            <label class="upload-btn">
              上传
              <input type="file" accept="image/*" hidden @change="handleImageUpload($event, 'chatBg')" />
            </label>
            <button class="reset-btn" @click="clearImage('chatBg')">清除</button>
          </div>
        </div>

        <!-- 气泡主题 -->
        <div class="image-setting">
          <span class="image-label">气泡主题</span>
          <div class="theme-options">
            <button
              v-for="theme in [
                { id: 'glass-light', name: '清新毛玻璃' },
                { id: 'glass-dark', name: '深色透明' },
              ]"
              :key="theme.id"
              class="theme-btn"
              :class="{ active: settings.bubbleTheme === theme.id }"
              @click="settings.bubbleTheme = theme.id"
            >
              {{ theme.name }}
            </button>
          </div>
        </div><div class="actions">
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
.back-btn:hover { color: #c8c8d0; }
.room-title {
  flex: 1;
  text-align: center;
  font-size: 18px;
  font-weight: 600;
  color: #c8c8d0;
}
.spacer { width: 60px; }
.content {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}
.form {
  max-width: 400px;
  margin: 0 auto;
}
.section-title {
  font-size: 13px;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-top: 24px;
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid #1a1a2e;
}
.section-title:first-child { margin-top: 0; }
label {
  display: block;
  margin-bottom: 20px;
  font-size: 14px;
  color: #c8c8d0;
}
label input[type="text"],
label input[type="password"],
label input:not([type]) {
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
  box-sizing: border-box;
}
label input:focus { border-color: #4a4a8a; }
.hint {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: #666;
}

/* 图片设置 */
.image-setting {
  margin-bottom: 20px;
}
.image-label {
  display: block;
  font-size: 14px;
  color: #c8c8d0;
  margin-bottom: 8px;
}
.image-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.avatar-preview {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid #2a2a4a;
}
.bg-preview {
  width: 64px;
  height: 40px;
  border-radius: 6px;
  border: 2px solid #2a2a4a;
  background-size: cover;
  background-position: center;
  background-color: #12121e;
  display: flex;
  align-items: center;
  justify-content: center;
}
.bg-empty {
  font-size: 11px;
  color: #555;
}
.upload-btn {
  padding: 6px 14px;
  background: #2a2a4a;
  border-radius: 6px;
  font-size: 12px;
  color: #c8c8d0;
  cursor: pointer;
  transition: background 0.15s;
}
.upload-btn:hover { background: #3a3a6a; }
.reset-btn {
  padding: 6px 10px;
  background: none;
  border: 1px solid #2a2a4a;
  border-radius: 6px;
  font-size: 12px;
  color: #888;
  cursor: pointer;
}
.reset-btn:hover { color: #c8c8d0; border-color: #3a3a5a; }

/* 主题选择 */
.theme-options {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.theme-btn {
  padding: 8px 16px;
  border: 1.5px solid #2a2a4a;
  border-radius: 8px;
  background: #12121e;
  color: #888;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
.theme-btn.active {
  border-color: #6a6aaa;
  color: #c8c8d0;
  background: #2a2a4a;
}
.theme-btn:hover { border-color: #4a4a7a; }

/* 按钮 */
.actions {
  display: flex;
  gap: 12px;
  margin-top: 32px;
  padding-bottom: 24px;
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
.primary { background: #3a3a6a; color: #e0e0e0; }
.primary:hover { background: #4a4a8a; }
</style>
