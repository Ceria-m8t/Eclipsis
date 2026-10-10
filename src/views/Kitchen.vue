<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()

function goBack() {
  router.push('/living')
}
</script>

<template>
  <div class="kitchen">
    <header class="room-header">
      <button class="back-btn" @click="goBack">←  客厅</button>
      <span class="room-title">厨房</span>
      <div class="spacer"></div>
    </header>

    <main class="content">
      <div class="placeholder">
        <p>一起做饭</p >
        <p>模拟经营</p >
        <p class="hint">功能正在开发中...</p >
      </div>
    </main>
  </div>
</template>

<style scoped>
.kitchen {
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
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.placeholder {
  text-align: center;
  color: #888;
}

.placeholder p {
  margin: 8px 0;
  font-size: 15px;
}

.placeholder .hint {
  margin-top: 24px;
  font-size: 13px;
  color: #555;
}
</style>