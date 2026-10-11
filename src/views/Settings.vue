<script setup lang="ts">
import { ref } from 'vue'
import { getSettings, saveSettings } from '../settings'

const settings = ref(getSettings())

function handleImageUpload(event: Event, field: 'avatarUser' | 'avatarAI') {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = (e) => {
    settings.value[field] = e.target?.result as string
  }
  reader.readAsDataURL(file)
}

function clearImage(field: 'avatarUser' | 'avatarAI') {
  if (field === 'avatarUser') {
    settings.value[field] = '/avatar-erica.jpg'
  } else {
    settings.value[field] = '/avatar-claude.jpg'
  }
}

function save() {
  saveSettings(settings.value)
}
</script>

<template>
  <div class="settings">
    <main class="content">
      <div class="form">
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

        <div class="section-title">头像设置</div>

        <div class="image-setting">
          <span class="image-label">我的头像</span>
          <div class="image-row">
            < img :src="settings.avatarUser" class="avatar-preview" />
            <label class="upload-btn">
              更换
              <input type="file" accept="image/*" hidden @change="handleImageUpload($event, 'avatarUser')" />
            </label>
            <button class="reset-btn" @click="clearImage('avatarUser')">重置</button>
          </div>
        </div>

        <div class="image-setting">
          <span class="image-label">小克头像</span>
          <div class="image-row">
            < img :src="settings.avatarAI" class="avatar-preview" />
            <label class="upload-btn">
              更换
              <input type="file" accept="image/*" hidden @change="handleImageUpload($event, 'avatarAI')" />
            </label>
            <button class="reset-btn" @click="clearImage('avatarAI')">重置</button>
          </div>
        </div>

        <div class="actions">
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
  height: 100%;
  width: 100%;
  background: #0a0a0f;
  color: #e0e0e0;
  overflow-y: auto;
}

.content {
  flex: 1;
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

.image-setting { margin-bottom: 20px; }

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

.upload-btn {
  padding: 6px 14px;
  background: #2a2a4a;
  border-radius: 6px;
  font-size: 12px;
  color: #c8c8d0;
  cursor: pointer;
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

.reset-btn:hover { color: #c8c8d0; }

.actions {
  margin-top: 32px;
  padding-bottom: 24px;
}

.primary {
  width: 100%;
  padding: 12px;
  border: none;
  border-radius: 8px;
  font-size: 15px;
  cursor: pointer;
  background: #3a3a6a;
  color: #e0e0e0;
}

.primary:hover { background: #4a4a8a; }
</style>
