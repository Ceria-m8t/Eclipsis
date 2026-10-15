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
  position: fixed;
  inset: 0;
  height: 100dvh;
  overflow: hidden;
}

.room-area {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

/* 悬浮玻璃胶囊导航 */
.bottom-bar {
  position: absolute;
  left: 50%;
  bottom: calc(var(--safe-bottom) + 12px);
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  gap: 4px;
  padding: 6px;
  border-radius: 999px;
  background: var(--glass-bg-strong);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
}

.nav-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  background: none;
  border: none;
  border-radius: 999px;
  color: var(--text-2);
  padding: 6px 20px;
  transition: background 0.2s, color 0.2s;
}

.nav-btn.active {
  color: var(--text);
  background: rgba(255, 255, 255, 0.75);
}

.nav-icon { font-size: 20px; line-height: 1.1; }
.nav-label { font-size: 11px; }
</style>
