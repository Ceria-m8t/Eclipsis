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

function onHotspot(path: string) {
  if (!hasMoved && path) {
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
  <div class="room">
    <div
      class="room-scroll"
      ref="container"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <div class="room-canvas">
        <!-- 底图层 -->
        <img
          src="/assets/rooms/livingroom-base.png"
          alt="客厅"
          class="room-base"
          draggable="false"
        />

        <!-- 家具层 -->
        <div class="furniture-layer">
        </div>

        <!-- 动画层 -->
        <div class="animation-layer">
        </div>

        <!-- 交互热区层 -->
        <div class="hotspot-layer">
          <button class="hotspot bedroom-door" @click.stop="onHotspot('/bedroom')">
            <span class="hotspot-label">🌙 卧室</span>
          </button>
          <button class="hotspot kitchen-door" @click.stop="onHotspot('/kitchen')">
            <span class="hotspot-label">🍳 厨房</span>
          </button>
          <button class="hotspot study-door" @click.stop="onHotspot('/study')">
            <span class="hotspot-label">📚 书房</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.room {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #1a1a2e;
}

.room-scroll {
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  cursor: grab;
  -ms-overflow-style: none;
  scrollbar-width: none;
  touch-action: pan-x;
}

.room-scroll::-webkit-scrollbar {
  display: none;
}

.room-scroll:active {
  cursor: grabbing;
}

.room-canvas {
  position: relative;
  height: 100%;
  display: inline-block;
}

.room-base {
  height: 100%;
  width: auto;
  display: block;
  image-rendering: pixelated;
  user-select: none;
  -webkit-user-drag: none;
}

.furniture-layer,
.animation-layer,
.hotspot-layer {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.hotspot-layer {
  pointer-events: auto;
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

/* 热区位置 — 先占位，以后对齐底图里的门 */
.hotspot.bedroom-door {
  bottom: 15%;
  left: 20%;
}

.hotspot.kitchen-door {
  top: 30%;
  right: 5%;
}

.hotspot.study-door {
  top: 30%;
  left: 5%;
}
</style>
