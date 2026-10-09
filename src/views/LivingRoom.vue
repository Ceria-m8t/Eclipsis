<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

// 拖拽滑动逻辑
const container = ref<HTMLElement | null>(null)
let isDragging = false
let startX = 0
let scrollStart = 0
let hasMoved = false

function onPointerDown(e: PointerEvent) {
  if (!container.value) return
  isDragging = true
  hasMoved = false
  startX = e.clientX
  scrollStart = container.value.scrollLeft
}

function onPointerMove(e: PointerEvent) {
  if (!isDragging || !container.value) return
  const dx = e.clientX - startX
  if (Math.abs(dx) > 5) hasMoved = true
  container.value.scrollLeft = scrollStart - dx
}

function onPointerUp() {
  isDragging = false
}

// 热区点击 — 只有没拖动过才触发
function onHotspot(path: string) {
  if (!hasMoved) {
    router.push(path)
  }
}

// 初始居中
onMounted(() => {
  if (container.value) {
    const el = container.value
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
  }
})
</script>

<template>
  <div class="living-scene">
    <!-- 顶部信息栏 -->
    <header class="scene-header">
      <span class="scene-title">Eclipsis</span>
    </header>

    <!-- 可横向滑动的场景容器 -->
    <div
      class="scene-scroll"
      ref="container"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <div class="scene-inner">
        <img src="/living-room.jpg" class="scene-bg" alt="客厅" draggable="false" />

        <!-- 热区按钮 -->
        <button class="hotspot sofa" @click.stop="onHotspot('/living/chat')">
          <span class="hotspot-label">💬 坐下聊天</span>
        </button>

        <button class="hotspot calendar" @click.stop="onHotspot('/living/calendar')">
          <span class="hotspot-label">📅 日历</span>
        </button>

        <button class="hotspot study" @click.stop="onHotspot('/study')">
          <span class="hotspot-label">📚 书房</span>
        </button>

        <button class="hotspot aquarium" @click.stop="onHotspot('')">
          <span class="hotspot-label">🐙 鱼缸</span>
        </button>

        <button class="hotspot bedroom" @click.stop="onHotspot('')">
          <span class="hotspot-label">🌙 卧室</span>
        </button>

        <button class="hotspot kitchen" @click.stop="onHotspot('')">
          <span class="hotspot-label">🍳 厨房</span>
        </button>
      </div>
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
  position: relative;
}

.scene-header {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 16px;
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  background: linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, transparent 100%);
}

.scene-title {
  font-size: 16px;
  font-weight: 500;
  color: rgba(255,255,255,0.85);
  letter-spacing: 2px;
}

/* 横向滑动容器 */
.scene-scroll {
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
  cursor: grab;
  -ms-overflow-style: none;
  scrollbar-width: none;
  touch-action: pan-x;
}

.scene-scroll::-webkit-scrollbar {
  display: none;
}

.scene-scroll:active {
  cursor: grabbing;
}

/* 内层：图片实际宽度决定可滑动范围 */
.scene-inner {
  position: relative;
  height: 100%;
  display: inline-block;
}

.scene-bg {
  height: 100%;
  width: auto;
  display: block;
  user-select: none;
  -webkit-user-drag: none;
}

/* 热区按钮 */
.hotspot {
  position: absolute;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  z-index: 5;
}

.hotspot-label {
  display: inline-block;
  padding: 6px 14px;
  background: rgba(10, 10, 20, 0.65);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 20px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.9);
  font-weight: 400;
  letter-spacing: 1px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
  transition: all 0.2s;
  white-space: nowrap;
}

.hotspot:hover .hotspot-label {
  background: rgba(10, 10, 20, 0.8);
  border-color: rgba(255, 255, 255, 0.25);
}

.hotspot:active .hotspot-label {
  transform: scale(0.95);
}

/* 热区位置 — 对齐底图元素 */
.hotspot.sofa {
  top: 42%;
  left: 30%;
}

.hotspot.calendar {
  top: 22%;
  left: 10%;
}

.hotspot.study {
  top: 30%;
  right: 1%;
}

.hotspot.aquarium {
  bottom: 26%;
  right: 15%;
}

.hotspot.bedroom {
  bottom: 5%;
  left: 40%;
}

.hotspot.kitchen {
  top: 45%;
  left: 1%;
}
</style>
