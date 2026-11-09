<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const BASE = '/assets/rooms/bedroom/'

// ---- 人物 ----
const WALL_Y = 58
const FAR_SCALE = 0.8
type View = 'front' | 'side' | 'back'
interface Person { key: 'girl' | 'boy'; name: string; height: number; x: number; y: number; view: View; flip: boolean }

const people = ref<Person[]>([
  { key: 'girl', name: 'Erica', height: 29, x: 43, y: 82, view: 'side', flip: false },
  { key: 'boy', name: '小克', height: 31.5, x: 55, y: 82, view: 'side', flip: true }
])

function depthScale(y: number) {
  const t = Math.min(1, Math.max(0, (y - WALL_Y) / (100 - WALL_Y)))
  return FAR_SCALE + (1 - FAR_SCALE) * t
}
function spriteStyle(p: Person) {
  const h = p.height * depthScale(p.y)
  return {
    left: p.x + '%',
    top: p.y + '%',
    height: h + '%',
    zIndex: Math.round(p.y * 10)
  }
}
function shadowStyle(p: Person) {
  const h = p.height * depthScale(p.y)
  return {
    left: p.x + '%',
    top: p.y + '%',
    width: (h * 0.4 * 2 / 3) + '%',
    height: (h * 0.08) + '%',
    zIndex: Math.round(p.y * 10) - 1
  }
}

// ---- 横向拖动 ----
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
  <div class="room bedroom shell-page">
    <div
      ref="container"
      class="room-scroll"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <div class="room-canvas">
        <img :src="BASE + 'base-night.webp'" alt="卧室" class="room-base" data-glass-backdrop draggable="false" />

        <!-- 人物层 -->
        <div class="people-layer">
          <template v-for="p in people" :key="p.key">
            <div class="person-shadow" :style="shadowStyle(p)" aria-hidden="true"></div>
            <img
              :src="BASE + p.key + '-' + p.view + '.webp'"
              :alt="p.name"
              :class="['person', { flip: p.flip }]"
              :style="spriteStyle(p)"
              draggable="false"
            />
          </template>
        </div>

        <!-- 热区层 -->
        <div class="hotspot-layer">
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
  --room-bottom-gap: 28px;
  background: transparent;
}

.room-scroll {
  height: 100%;
  display: flex;
  align-items: flex-end;
  padding-bottom: var(--room-bottom-gap);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  touch-action: pan-x;
}
.room-scroll::-webkit-scrollbar { display: none; }

/* 卧室底图 1536×1024 */
.room-canvas {
  position: relative;
  flex-shrink: 0;
  height: calc(100% * var(--room-scale));
  aspect-ratio: 1536 / 1024;
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

.people-layer,
.hotspot-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.hotspot-layer { pointer-events: auto; }

.person {
  position: absolute;
  transform: translate(-50%, -100%);
  user-select: none;
  -webkit-user-drag: none;
}
.person.flip { transform: translate(-50%, -100%) scaleX(-1); }
.person-shadow {
  position: absolute;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: radial-gradient(closest-side, rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0));
}

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
.hotspot.door-hallway { bottom: 20%; right: 6%; }
</style>
