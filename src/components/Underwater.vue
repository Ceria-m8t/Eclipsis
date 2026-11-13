<script setup lang="ts">
// 水面之下：光从上面射进来（她 2026-11-13 发的最后两张参考图就是要的那个样子）。
//
// 第一版太弱：四条平行的淡竖条（透明度 0.18–0.3），既没有「从一点射出来」的收束，
// 也几乎看不出在动。她的原话：「光并没有做成动态感，我想要的海底光束的动态感」。
//
// 参考图里真正在起作用的是四件事，这一版逐条做到：
//   ① 水面有一块**亮斑**（破碎的焦散亮区），光是从那里进来的，不是凭空出现的竖条
//   ② 光束**从水面那一点呈扇形放射下来**（上窄下宽），而不是上下等宽
//   ③ 光束会**闪**：各自错着相位明暗变化 + 轻微摆动，像水面在晃
//   ④ 水里有**浮尘和气泡**往上飘，光束里的那几粒更亮（丁达尔效应）
// 全部 CSS 动画（compositor 上跑，不占主线程）；她开了「减少动态效果」就只留静态的光。
//
// 光束用 mix-blend-mode: screen 叠加 —— 只会加亮不会压暗，这样深处仍然是深的。
withDefaults(defineProps<{
  /** 水有多深：shallow 光更多更亮（头部那一段），deep 用于整页 */
  depth?: 'shallow' | 'deep'
}>(), { depth: 'deep' })

/** 光束：角度、宽度、亮度、闪动周期各不相同（不能同步，否则一眼看出是循环） */
const beams = [
  { rot: -27, w: 9, o: 0.5, dur: 7.5, delay: 0, sway: 13 },
  { rot: -17, w: 15, o: 0.68, dur: 11, delay: -2.4, sway: 9 },
  { rot: -9, w: 7, o: 0.42, dur: 6.2, delay: -4.1, sway: 15 },
  { rot: -2, w: 19, o: 0.78, dur: 13, delay: -1.2, sway: 7 },
  { rot: 6, w: 11, o: 0.55, dur: 8.8, delay: -5.6, sway: 11 },
  { rot: 14, w: 23, o: 0.46, dur: 15, delay: -3.3, sway: 6 },
  { rot: 23, w: 8, o: 0.38, dur: 9.4, delay: -6.8, sway: 14 },
  { rot: 31, w: 13, o: 0.3, dur: 12, delay: -0.7, sway: 8 },
]

/** 浮尘 / 气泡 */
const motes = Array.from({ length: 26 }, (_, i) => ({
  left: Math.random() * 100,
  top: 30 + Math.random() * 80,
  dur: 14 + Math.random() * 24,
  delay: -Math.random() * 30,
  size: i % 7 === 0 ? 3.5 : Math.random() < 0.35 ? 2.5 : 1.5,
  bright: i % 4 === 0,
}))
</script>

<template>
  <div class="uw" :class="depth" aria-hidden="true">
    <!-- ① 水面的亮斑：光的来处 -->
    <div class="surface">
      <i class="glow"></i>
      <i class="crack c1"></i><i class="crack c2"></i><i class="crack c3"></i>
    </div>

    <!-- ② ③ 从水面那一点扇形放射下来的光束，各自错相位地闪 -->
    <div class="shafts">
      <i v-for="(b, i) in beams" :key="i" :style="{
        '--rot': b.rot + 'deg', '--w': b.w + 'vw', '--o': b.o,
        '--dur': b.dur + 's', '--sway': b.sway + 's',
        animationDelay: b.delay + 's, ' + (b.delay * 0.6) + 's',
      }"></i>
    </div>

    <!-- 水体里的雾（让光束有「穿过水」的厚度） -->
    <div class="haze"><i></i><i></i></div>

    <!-- ④ 浮尘和气泡 -->
    <div class="motes">
      <i v-for="(m, i) in motes" :key="i" :class="{ bright: m.bright }" :style="{
        left: m.left + 'vw', top: m.top + 'vh', width: m.size + 'px', height: m.size + 'px',
        animationDuration: m.dur + 's', animationDelay: m.delay + 's',
      }"></i>
    </div>
  </div>
</template>

<style scoped>
.uw { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }

/* 海水：**往上越亮**（光从上面来）。顶上是透进来的天光，往下才沉成深蓝。 */
.uw::before {
  content: ""; position: absolute; inset: 0;
  background:
    radial-gradient(110% 46% at 46% -8%, rgba(176, 216, 255, 0.62), rgba(176, 216, 255, 0) 60%),
    radial-gradient(70% 30% at 82% -4%, rgba(198, 230, 255, 0.3), rgba(198, 230, 255, 0) 58%),
    linear-gradient(177deg, #2f5d8e 0%, #1e4470 22%, #142f55 48%, #0c1e3a 74%, #081426 100%);
}

/* ── ① 水面亮斑 ── */
.surface { position: absolute; left: -12%; right: -12%; top: -6%; height: 30%; }
.surface .glow {
  position: absolute; inset: 0;
  background: radial-gradient(60% 100% at 48% 22%, rgba(236, 248, 255, 0.85), rgba(198, 228, 255, 0.28) 42%, transparent 74%);
  filter: blur(14px);
  animation: surge 9s ease-in-out infinite alternate;
}
/* 破碎的焦散纹：水面不是一块平的亮板 */
.surface .crack {
  position: absolute; border-radius: 50%;
  background: radial-gradient(closest-side, rgba(255, 255, 255, 0.72), rgba(220, 240, 255, 0.12) 56%, transparent 78%);
  filter: blur(9px); mix-blend-mode: screen;
}
.surface .c1 { left: 24%; top: 10%; width: 34%; height: 46%; animation: shimmer 6.5s ease-in-out infinite alternate; }
.surface .c2 { left: 52%; top: 4%; width: 26%; height: 38%; animation: shimmer 8.5s ease-in-out infinite alternate-reverse; }
.surface .c3 { left: 8%; top: 18%; width: 22%; height: 30%; animation: shimmer 11s ease-in-out infinite alternate; }
@keyframes surge {
  0% { transform: translate3d(-2%, 0, 0) scale(1); opacity: 0.8; }
  100% { transform: translate3d(3%, 1%, 0) scale(1.1); opacity: 1; }
}
@keyframes shimmer {
  0% { transform: translate3d(0, 0, 0) scaleX(1); opacity: 0.55; }
  50% { opacity: 1; }
  100% { transform: translate3d(5%, 2%, 0) scaleX(1.3); opacity: 0.7; }
}

/* ── ② ③ 光束：扇形放射 + 闪动 ── */
/* 所有光束共一个旋转原点（水面那块亮斑的位置），所以是「从一点射下来」而不是平行条 */
.shafts {
  position: absolute; left: 50%; top: 4%; width: 0; height: 0;
  mix-blend-mode: screen;
}
.shafts i {
  position: absolute; left: 0; top: 0;
  width: var(--w); height: 170vh;
  margin-left: calc(var(--w) / -2);
  transform-origin: 50% 0;
  transform: rotate(var(--rot));
  background: linear-gradient(185deg,
    rgba(226, 244, 255, calc(var(--o) * 0.95)) 0%,
    rgba(198, 228, 255, calc(var(--o) * 0.5)) 22%,
    rgba(170, 208, 248, calc(var(--o) * 0.18)) 52%,
    transparent 82%);
  filter: blur(10px);
  /* 上窄下宽 + 边缘化开：真光束不是一条等宽的带子 */
  clip-path: polygon(38% 0, 62% 0, 100% 100%, 0% 100%);
  animation: flare var(--dur) ease-in-out infinite alternate,
             tilt var(--sway) ease-in-out infinite alternate;
}
/* 闪：亮度和宽度一起变，像水面在晃 */
@keyframes flare {
  0% { opacity: 0.45; filter: blur(12px); }
  40% { opacity: 0.95; filter: blur(8px); }
  100% { opacity: 0.62; filter: blur(14px); }
}
@keyframes tilt {
  0% { transform: rotate(var(--rot)) scaleX(0.88); }
  100% { transform: rotate(calc(var(--rot) + 3deg)) scaleX(1.16); }
}

/* 水体里的雾 */
.haze { position: absolute; inset: 0; opacity: 0.5; mix-blend-mode: screen; }
.haze i {
  position: absolute; inset: -20%; filter: blur(34px);
  background:
    radial-gradient(44% 24% at 26% 22%, rgba(170, 212, 255, 0.26), transparent 70%),
    radial-gradient(38% 20% at 74% 38%, rgba(198, 228, 255, 0.2), transparent 72%);
  animation: drift 38s linear infinite alternate;
}
.haze i:nth-child(2) {
  background: radial-gradient(46% 26% at 44% 70%, rgba(150, 190, 240, 0.2), transparent 74%);
  animation-duration: 52s; animation-direction: alternate-reverse;
}
@keyframes drift {
  0% { transform: translate3d(0, 0, 0) scale(1); }
  100% { transform: translate3d(7vw, -4vh, 0) scale(1.2); }
}

/* ── ④ 浮尘 / 气泡 ── */
.motes { position: absolute; inset: 0; mix-blend-mode: screen; }
.motes i {
  position: absolute; border-radius: 50%; background: rgba(226, 242, 255, 0.5);
  animation-name: rise; animation-timing-function: linear; animation-iteration-count: infinite;
}
/* 光束里那几粒更亮（丁达尔效应） */
.motes i.bright { background: #f0f8ff; box-shadow: 0 0 6px rgba(214, 238, 255, 0.9); }
@keyframes rise {
  0% { transform: translate3d(0, 0, 0); opacity: 0; }
  10% { opacity: 0.75; }
  50% { transform: translate3d(2vw, -38vh, 0); }
  85% { opacity: 0.5; }
  100% { transform: translate3d(-1vw, -82vh, 0); opacity: 0; }
}

/* 浅水（头部那一段）：光更多更亮 */
.uw.shallow .surface { height: 56%; }
.uw.shallow .shafts i { filter: blur(8px); }

/* 她在系统里开了「减少动态效果」：光还在，但不动 */
@media (prefers-reduced-motion: reduce) {
  .surface .glow, .surface .crack, .shafts i, .haze i, .motes i { animation: none !important; }
  .shafts i { opacity: 0.7; }
  .motes i { opacity: 0.45; }
}
</style>
