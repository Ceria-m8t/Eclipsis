<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()

function goBack() { router.push('/') }
function goChat() { router.push('/living/chat') }
function goStudy() { router.push('/study') }
</script>

<template>
  <div class="living-scene">
    <!--顶部信息栏 -->
    <header class="scene-header">
      <button class="back-btn" @click="goBack">← 玄关</button>
      <span class="scene-title">客厅</span>
    </header>

    <!-- 背景图 + 热区 -->
    <div class="scene-container">
      <img src="/living-room-bg.jpg" class="scene-bg" alt="客厅" />

      <!-- 可点击热区 -->
      <button class="hotspot sofa" @click="goChat">
        <span class="hotspot-label">💬坐下聊天</span>
      </button>

      <button class="hotspot calendar" @click="$router.push('/living/calendar')">
        <span class="hotspot-label">📅 日历</span>
      </button>

      <button class="hotspot bookshelf" @click="goStudy">
        <span class="hotspot-label">📚 书房</span>
      </button>

      <button class="hotspot record-player">
        <span class="hotspot-label">🎵 唱片机</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.living-scene {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  background: #0a0a0f;
  overflow: hidden;
}

.scene-header {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  max-width: 480px;
  margin: 0 auto;
  z-index: 10;
  background: linear-gradient(to bottom, rgba(0,0,0,0.5) 0%, transparent 100%);
}
.back-btn {
  background: none;
  border: none;
  color: rgba(255,255,255,0.8);
  font-size: 14px;
  cursor: pointer;
  padding: 4px 8px;
}
.back-btn:hover { color: #fff; }
.scene-title {
  flex: 1;
  text-align: center;
  font-size: 17px;
  font-weight: 600;
  color: rgba(255,255,255,0.9);
}

/* 场景容器 */
.scene-container {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.scene-bg {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* 热区按钮 */
.hotspot {
  position: absolute;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
.hotspot-label {
  display: inline-block;
  padding: 8px 16px;
  background: rgba(255, 255, 255, 0.85);
  border-radius: 20px;
  font-size: 14px;
  color: #4a3a2a;
  font-weight: 500;
  box-shadow: 0 2px 12px rgba(0,0,0,0.15);
  backdrop-filter: blur(4px);
  transition: all 0.2s;
  white-space: nowrap;
}
.hotspot:hover .hotspot-label {
  background: rgba(255, 255, 255, 0.95);
  box-shadow: 0 4px 16px rgba(0,0,0,0.2);
  transform: scale(1.05);
}
.hotspot:active .hotspot-label {
  transform: scale(0.97);
}

/* 热区位置 — 根据你的背景图调整这些值 */
.hotspot.sofa {
  bottom: 40%;
  left: 50%;
  transform: translateX(-50%);
}
.hotspot.calendar {
  top: 28%;
  right: 12%;
}
.hotspot.bookshelf {
  top: 35%;
  left: 8%;
}
.hotspot.record-player {
  bottom: 25%;
  right: 10%;
}
</style>
