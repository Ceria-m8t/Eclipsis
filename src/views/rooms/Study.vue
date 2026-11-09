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

// 书架：镜头往书架那一段推过去，再换成书架特写页（2026-11-09）
const canvas = ref<HTMLElement | null>(null)
const SHELF_FOCUS = '30% 17%'      // 书房底图里拉近的那一段书架（左边立柱旁边几格）
let zooming = false
function openShelf() {
  if (hasMoved || zooming) return
  zooming = true
  const el = canvas.value
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) { router.push('/study/shelf'); return }
  el.style.transformOrigin = SHELF_FOCUS
  el.animate(
    [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(2.6)', opacity: 0.15 }],
    { duration: 560, easing: 'cubic-bezier(.5,0,.75,.4)', fill: 'forwards' }
  ).finished.then(() => router.push('/study/shelf'))
}

onMounted(() => {
  const el = container.value
  if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
  // 从书架回来：镜头从书架那儿拉回来
  if (sessionStorage.getItem('eclipsis-from-shelf') === '1') {
    sessionStorage.removeItem('eclipsis-from-shelf')
    const c = canvas.value
    if (c && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      c.style.transformOrigin = SHELF_FOCUS
      c.animate(
        [{ transform: 'scale(2.6)', opacity: 0.15 }, { transform: 'scale(1)', opacity: 1 }],
        { duration: 560, easing: 'cubic-bezier(.25,.6,.5,1)' }
      )
    }
  }
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
      <div ref="canvas" class="room-canvas">
        <img src="/assets/rooms/study/base-night.jpg" alt="书房" class="room-base" data-glass-backdrop draggable="false" />

        <div class="furniture-layer"></div>
        <div class="animation-layer"></div>
        <div class="people-layer"></div>

        <div class="hotspot-layer">
          <button class="hotspot shelf" aria-label="书架" @click.stop="openShelf">
            <span class="hotspot-label glass">📚 书架</span>
          </button>
          <button class="hotspot door-hallway" @click.stop="onHotspot('/hallway')">
            <span class="hotspot-label glass">🚪 走廊</span>
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

/* 书房底图 1536×922 */
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

/* ---- 热区位置 ---- */
.hotspot.door-hallway { bottom: 18%; right: 8%; }
.hotspot.shelf { left: 26%; top: 15%; }
</style>
