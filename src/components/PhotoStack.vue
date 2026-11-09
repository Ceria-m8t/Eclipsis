<script setup lang="ts">
// 聊天里一次发的好几张图：叠成一摞（顶上一张 + 后面探出两张），左右划翻页，点一下看大图。
// 交互思路参考 Wren036/PhotoStack（PolyForm Noncommercial，作者逐帧量出的微信合并照片卡片规则：
// 恒定三层可见、手指即进度、快甩翻页、纵向滚动交还页面）。这里是自己写的简化实现，没有搬它的代码。
import { ref, computed, onBeforeUnmount } from 'vue'

const props = defineProps<{ images: string[]; side: 'left' | 'right' }>()
const emit = defineEmits<{ (e: 'open', index: number): void }>()

const W = 150, H = 200
const index = ref(0)
const dx = ref(0)            // 顶卡跟手的横向位移
const dragging = ref(false)
let start: { x: number; y: number; t: number; id: number } | null = null
let decided: 'h' | 'v' | null = null
let vel = 0, lastX = 0, lastT = 0
const n = computed(() => props.images.length)

/** 第 k 张相对当前张的位置：0 顶卡，±1、±2 探边，其余藏在后面 */
function visible(k: number) {
  const i = index.value, last = n.value - 1
  if (i === 0) return k <= 2                 // 第一张：探边配额都给右边
  if (i === last) return k >= last - 2       // 最后一张：都给左边
  return Math.abs(k - i) <= 1
}
function cardStyle(k: number) {
  const rel = k - index.value
  if (rel === 0) {
    const p = Math.max(-1, Math.min(1, dx.value / W))
    return { transform: `translateX(${dx.value}px) rotate(${p * 6}deg)`, zIndex: 10, opacity: 1 }
  }
  const side = Math.sign(rel), depth = Math.min(Math.abs(rel), 2)
  const peek = 14 + (depth - 1) * 11
  return {
    transform: `translateX(${side * peek}px) rotate(${side * 2.4 * depth}deg) scale(${1 - 0.07 * depth})`,
    zIndex: 10 - depth,
    opacity: visible(k) ? 1 - 0.1 * (depth - 1) : 0,
  }
}

function down(e: PointerEvent) {
  start = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }
  decided = null; vel = 0; lastX = e.clientX; lastT = start.t
}
function move(e: PointerEvent) {
  if (!start || e.pointerId !== start.id) return
  const mx = e.clientX - start.x, my = e.clientY - start.y
  if (!decided) {
    if (Math.abs(mx) < 8 && Math.abs(my) < 8) return
    // 横着划才接管；竖着划交还给聊天页滚动
    decided = Math.abs(mx) > Math.abs(my) ? 'h' : 'v'
    if (decided === 'h') { dragging.value = true; (e.currentTarget as Element).setPointerCapture?.(e.pointerId) }
  }
  if (decided !== 'h') return
  const now = performance.now()
  vel = 0.7 * ((e.clientX - lastX) / Math.max(1, now - lastT)) + 0.3 * vel
  lastX = e.clientX; lastT = now
  // 到头了还往外拉：只给一点弹性
  const atEdge = (mx > 0 && index.value === 0) || (mx < 0 && index.value === n.value - 1)
  dx.value = atEdge ? Math.sign(mx) * Math.min(24, Math.abs(mx) * 0.3) : mx
}
function up(e: PointerEvent) {
  if (!start || e.pointerId !== start.id) return
  const wasH = decided === 'h'
  const moved = Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y)
  start = null
  dragging.value = false
  if (!wasH) {
    if (moved < 8 && !decided) emit('open', index.value)   // 点一下：看大图
    dx.value = 0
    return
  }
  const fling = Math.abs(vel) > 0.4 && Math.sign(vel) === Math.sign(dx.value) && Math.abs(dx.value) > 10
  if ((Math.abs(dx.value) > W * 0.35 || fling) && dx.value < 0 && index.value < n.value - 1) index.value++
  else if ((Math.abs(dx.value) > W * 0.35 || fling) && dx.value > 0 && index.value > 0) index.value--
  dx.value = 0
}
function cancel() { start = null; dragging.value = false; dx.value = 0 }
onBeforeUnmount(cancel)
</script>

<template>
  <div
    class="photo-stack"
    :class="[side, { dragging }]"
    :style="{ width: W + 'px', height: H + 'px' }"
    role="group"
    :aria-label="`${n} 张图片，左右划翻页，点一下看大图`"
    @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="cancel"
  >
    <div v-for="(img, k) in images" :key="k" class="ps-card" :style="cardStyle(k)">
      <img :src="img" alt="" draggable="false" :loading="Math.abs(k - index) <= 2 ? 'eager' : 'lazy'" />
    </div>
    <span class="ps-count" aria-hidden="true">{{ index + 1 }}/{{ n }}</span>
  </div>
</template>

<style scoped>
.photo-stack {
  position: relative;
  touch-action: pan-y;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  margin: 2px 18px;
}
.ps-card {
  position: absolute; inset: 0;
  border-radius: 12px;
  overflow: hidden;
  background: transparent;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
  transition: transform 0.32s cubic-bezier(0.2, 0.8, 0.25, 1), opacity 0.32s;
  will-change: transform;
}
.dragging .ps-card { transition: none; }
.ps-card img {
  width: 104%; height: 104%; margin: -2%;   /* 放大一点，盖住旋转后边上渗出来的细白线 */
  object-fit: cover; display: block; pointer-events: none;
}
.ps-count {
  position: absolute; right: 8px; bottom: 7px; z-index: 20;
  font-size: 11px; color: #fff;
  background: rgba(0, 0, 0, 0.35);
  border-radius: 999px; padding: 1px 7px;
}
</style>
