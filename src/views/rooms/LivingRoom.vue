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
  <div class="room shell-page">
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
            <span class="hotspot-label glass">🌙 卧室</span>
          </button>
          <button class="hotspot kitchen-door" @click.stop="onHotspot('/kitchen')">
            <span class="hotspot-label glass">🍳 厨房</span>
          </button>
          <button class="hotspot study-door" @click.stop="onHotspot('/study')">
            <span class="hotspot-label glass">📚 书房</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 房间缩小显示：画面占页面区高度的 --room-scale，上下居中，左右仍可滑动。
   底图透明处先透出页面背景，以后换成氛围层 */
.room {
  --room-scale: 0.78;
  background: transparent;
}

.room-scroll {
  height: 100%;
  display: flex;
  align-items: center;
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
  flex-shrink: 0;
  height: calc(100% * var(--room-scale));
  /* 窄屏时左右留点边，宽屏（图比屏幕窄）时居中 */
  margin: 0 auto;
  padding: 0 12px;
}

.room-base {
  height: 100%;
  border-radius: 18px;
  filter: drop-shadow(0 10px 24px rgba(60, 72, 110, 0.18));
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

/* 热区标签：浅色玻璃（用全局 .glass） */
.hotspot-label {
  display: inline-block;
  padding: 6px 14px;
  border-radius: 20px;
  font-size: 13px;
  color: var(--text);
  letter-spacing: 1px;
  white-space: nowrap;
  transition: transform 0.35s var(--spring);
}
.hotspot:active .hotspot-label {
  transform: scale(var(--press-scale));
  transition-duration: 0.08s;
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
