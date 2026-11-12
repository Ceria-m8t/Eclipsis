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
        <img src="/assets/rooms/rooftop/base-night.jpg" alt="露天天台" class="room-base" data-glass-backdrop draggable="false" />

        <div class="furniture-layer"></div>
        <div class="animation-layer"></div>
        <div class="people-layer"></div>

        <div class="hotspot-layer">
          <button class="hotspot door-greenhouse" @click.stop="onHotspot('/greenhouse')">
            <span class="hotspot-label glass">🌿 温室</span>
          </button>
          <button class="hotspot telescope" @click.stop="onHotspot('/galaxy')">
            <span class="hotspot-label glass">🔭 星空</span>
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

/* 天台底图 1468×979 */
.room-canvas {
  position: relative;
  flex-shrink: 0;
  height: calc(100% * var(--room-scale));
  aspect-ratio: 1468 / 979;
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
.hotspot.door-greenhouse { bottom: 18%; left: 6%; }
.hotspot.telescope { top: 22%; left: 50%; transform: translateX(-50%); }
</style>
