<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

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
        <img
          src="/assets/rooms/livingroom/base-night.jpg"
          alt="客厅"
          class="room-base"
          draggable="false"
        />

        <div class="furniture-layer"></div>
        <div class="animation-layer"></div>
        <div class="people-layer"></div>

        <div class="hotspot-layer">
          <!-- 厨房拱门 -->
          <button class="hotspot kitchen-door" @click.stop="onHotspot('/kitchen')">
            <span class="hotspot-label glass">🍳 厨房</span>
          </button>
          <!-- 走廊口 -->
          <button class="hotspot hallway-door" @click.stop="onHotspot('/hallway')">
            <span class="hotspot-label glass">🚪 走廊</span>
          </button>
          <!-- 鱼缸 -->
          <button class="hotspot aquarium" @click.stop="onHotspot('')">
            <span class="hotspot-label glass">🐙 鱼缸</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.room {
  --room-scale: 0.82;
  background: transparent;
}

.room-scroll {
  height: 100%;
  display: flex;
  align-items: flex-end;
  padding-bottom: 28px;
  overflow-x: auto;
  overflow-y: hidden;
  cursor: grab;
  -ms-overflow-style: none;
  scrollbar-width: none;
  touch-action: pan-x;
}

.room-scroll::-webkit-scrollbar { display: none; }
.room-scroll:active { cursor: grabbing; }

/* 客厅底图 1669×890 */
.room-canvas {
  position: relative;
  flex-shrink: 0;
  height: calc(100% * var(--room-scale));
  aspect-ratio: 1669 / 890;
  margin: 0 auto;
}

.room-base {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 18px;
  filter: drop-shadow(0 10px 24px rgba(20, 28, 60, 0.28));
  user-select: none;
  -webkit-user-drag: none;
}

.furniture-layer,
.animation-layer,
.people-layer,
.hotspot-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.hotspot-layer { pointer-events: auto; }

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

/* ---- 热区位置 ---- */
.hotspot.kitchen-door { bottom: 28%; left: 3%; }
.hotspot.hallway-door { top: 25%; left: 22%; }
.hotspot.aquarium { top: 18%; left: 50%; }
</style>
