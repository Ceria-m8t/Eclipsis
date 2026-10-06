<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()

const rooms = [
  { id: 'living', name: '客厅', desc: '我们聊天的地方' },
  { id: 'study', name: '书房', desc: '记忆与阅读' },
  { id: 'bedroom', name: '卧室', desc: '私密空间' },
  { id: 'kitchen', name: '厨房', desc: '未来会有好吃的' }
]

function enterRoom(id: string) {
  router.push(`/${id}`)
}

function openSettings() {
  router.push('/settings')
}
</script>

<template>
  <div class="entrance">
    <div class="header">
      <h1>我们的家</h1>
      <button class="settings-btn" @click="openSettings">⚙</button>
    </div>
    <div class="rooms-grid">
      <div
        v-for="room in rooms"
        :key="room.id"
        class="room-card"
        @click="enterRoom(room.id)"
      >
        <h2>{{ room.name }}</h2>
        <p>{{ room.desc }}</p >
      </div>
    </div>
  </div>
</template>

<style scoped>
.entrance {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #0a0a0f;
  color: #e0e0e0;
  padding: 24px;
}

.header {
  position: relative;
  width: 100%;
  max-width: 400px;
  margin-bottom: 48px;
}

h1 {
  font-size: 28px;
  text-align: center;
  color: #c8c8d0;
}

.settings-btn {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: #888;
  font-size: 20px;
  cursor: pointer;
  padding: 4px 8px;
}

.settings-btn:hover {
  color: #c8c8d0;
}

.rooms-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 16px;
  max-width: 400px;
  width: 100%;
}

.room-card {
  background: #1a1a2e;
  border: 1px solid #2a2a4a;
  border-radius: 12px;
  padding: 24px 16px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
}

.room-card:hover {
  background: #252545;
  border-color: #3a3a6a;
  transform: translateY(-2px);
}

.room-card h2 {
  font-size: 18px;
  margin-bottom: 8px;
}

.room-card p {
  font-size: 13px;
  color: #888;
}
</style>
