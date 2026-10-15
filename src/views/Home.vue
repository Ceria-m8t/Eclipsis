<script setup lang="ts">
import { useRouter, useRoute } from 'vue-router'

const router = useRouter()
const route = useRoute()

const isHome = () => route.path !== '/chat' && route.path !== '/settings'
</script>

<template>
  <div class="home-container">
    <!-- 房间内容区 -->
    <div class="room-area">
      <RouterView />
    </div>

    <!-- 底栏导航 -->
    <nav class="bottom-bar">
      <button 
        class="nav-btn" 
        :class="{ active: isHome() }"
        @click="router.push('/living-room')"
      >
        <span class="nav-icon">🏠</span>
        <span class="nav-label">家</span>
      </button>
      <button 
        class="nav-btn"
        :class="{ active: route.path === '/chat' }"
        @click="router.push('/chat')"
      >
        <span class="nav-icon">💬</span>
        <span class="nav-label">聊天</span>
      </button>
      <button 
        class="nav-btn"
        :class="{ active: route.path === '/settings' }"
        @click="router.push('/settings')"
      >
        <span class="nav-icon">⚙️</span>
        <span class="nav-label">设置</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
.home-container {
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: #f5f3f0;
}

.room-area {
  flex: 1;
  overflow: hidden;
  position: relative;
}

.bottom-bar {
  display: flex;
  justify-content: space-around;
  align-items: center;
  height: 60px;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  padding-bottom: env(safe-area-inset-bottom);
}

.nav-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  background: none;
  border: none;
  color: rgba(0, 0, 0, 0.3);
  font-size: 12px;
  cursor: pointer;
  padding: 6px 16px;
  transition: color 0.2s;
}

.nav-btn.active {
  color: rgba(0, 0, 0, 0.75);
}

.nav-icon {
  font-size: 22px;
}

.nav-label {
  font-size: 11px;
}
</style>
