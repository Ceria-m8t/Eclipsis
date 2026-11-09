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
function onPointerUp() { isDragging = false }

function onHotspot(path: string) {
  if (!hasMoved && path) router.push(path)
}

onMounted(() => {
  const el = container.value
  if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
})
</script>

<template>
  <div class="room shell-page">
    <div
      ref="container"
      class="room-scroll"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <div class="room-canvas">
        <img src="/assets/rooms/hallway/base-night.jpg" alt="走廊" class="room-base" data-glass-backdrop draggable="false" />

        <div class="furniture-layer"></div>
        <div class="animation-layer"></div>
        <div class="people-layer"></div>

        <div class="hotspot-layer">
          <!-- 回客厅 -->
          <button class="hotspot door-livingroom" @click.stop="onHotspot('/living-room')">
            <span class="hotspot-label glass">🏠 客厅</span>
          </button>
          <!-- 卧室 -->
          <button class="hotspot door-bedroom" @click.stop="onHotspot('/bedroom')">
            <span class="hotspot-label glass">🌙 卧室</span>
          </button>
          <!-- 书房 -->
          <button class="hotspot door-study" @click.stop="onHotspot('/study')">
            <span class="hotspot-label glass">📚 书房</span>
          </button>
          <!-- 浴室 -->
          <button class="hotspot door-bathroom" @click.stop="onHotspot('/bathroom')">
            <span class="hotspot-label glass">🛁 浴室</span>
          </button>
          <!-- 温室 -->
          <button class="hotspot door-greenhouse" @click.stop="onHotspot('/greenhouse')">
            <span class="hotspot-label glass">🌿 温室</span>
          </button>
          <!-- 地下室 -->
          <button class="hotspot door-basement" @click.stop="onHotspot('/basement')">
            <span class="hotspot-label glass">🔬 地下室</span>
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
  scrollbar-width: none;
  touch-action: pan-x;
}
.room-scroll::-webkit-scrollbar { display: none; }

/* 走廊底图 1536×922 */
.room-canvas {
  position: relative;
  flex-shrink: 0;
  height: calc(100% * var(--room-scale));
  aspect-ratio: 1536 / 922;
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

/* ---- 热区位置（占位，待对齐底图微调） ---- */
.hotspot.door-livingroom { bottom: 40%; right: 5%; }
.hotspot.door-bedroom { top: 25%; left: 8%; }
.hotspot.door-study { top: 25%; left: 35%; }
.hotspot.door-bathroom { top: 25%; right: 35%; }
.hotspot.door-greenhouse { top: 20%; right: 8%; }
.hotspot.door-basement { bottom: 20%; left: 45%; }
</style>
