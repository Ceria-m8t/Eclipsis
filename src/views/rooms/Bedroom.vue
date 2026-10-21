<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../../components/Icon.vue'

const router = useRouter()
const BASE = '/assets/rooms/bedroom/'

// ---- 人物 ----
// x、y 是脚点在底图上的位置（百分比）；height 是站在最前面时占画面高度的百分比（定稿：女 29、男 31.5）。
// 往里站按透视缩小：depthScale 按脚点 y 在"后墙脚 → 画面底"之间插值
const WALL_Y = 58      // 后墙和地板交界大约在画面高度 58%
const FAR_SCALE = 0.8  // 站在墙脚时的缩放
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
    // 越靠前越在上层
    zIndex: Math.round(p.y * 10)
  }
}
function shadowStyle(p: Person) {
  const h = p.height * depthScale(p.y)
  return {
    left: p.x + '%',
    top: p.y + '%',
    // 底图 3:2，宽度百分比要按宽算
    width: (h * 0.4 * 2 / 3) + '%',
    height: (h * 0.08) + '%',
    zIndex: Math.round(p.y * 10) - 1
  }
}

// ---- 横向拖动（和客厅一样） ----
const container = ref<HTMLElement | null>(null)
let dragging = false
let startX = 0
let scrollStart = 0
function onPointerDown(e: PointerEvent) {
  if (!container.value) return
  dragging = true
  startX = e.clientX
  scrollStart = container.value.scrollLeft
}
function onPointerMove(e: PointerEvent) {
  if (!dragging || !container.value) return
  container.value.scrollLeft = scrollStart - (e.clientX - startX)
}
function onPointerUp() { dragging = false }

onMounted(() => {
  const el = container.value
  if (el) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
})
</script>

<template>
  <div class="room bedroom shell-page">
    <button class="room-back glass press" aria-label="回客厅" @click="router.push('/living-room')">
      <Icon name="chevron" :size="18" class="back-icon" />
      <span>客厅</span>
    </button>

    <div
      ref="container"
      class="room-scroll"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <div class="room-canvas">
        <img :src="BASE + 'base-night.webp'" alt="卧室" class="room-base" draggable="false" />

        <!-- 人物层：按脚点 y 排前后 -->
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
      </div>
    </div>
  </div>
</template>

<style scoped>
.room {
  /* 房间占页面区高度的比例；底边贴着底栏上方留一点空（按 iPhone 实测调的） */
  --room-scale: 0.82;
  --room-bottom-gap: 28px;
  /* 定位由 .shell-page（absolute 铺满）负责，这里不要再写 position */
  background: transparent;
}

.room-back {
  position: absolute;
  top: calc(var(--safe-top) + 10px);
  left: 12px;
  z-index: 10;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 7px 14px 7px 8px;
  border-radius: 999px;
  font-size: 14px;
  color: var(--text);
}
.back-icon { transform: scaleX(-1); }

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

.room-canvas {
  position: relative;
  flex-shrink: 0;
  height: calc(100% * var(--room-scale));
  aspect-ratio: 3 / 2;
  margin: 0 auto;
}

.room-base {
  /* 绝对定位：不让图片原始尺寸把画布撑大，画布大小只由高度和 3:2 决定 */
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

.people-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
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
</style>
