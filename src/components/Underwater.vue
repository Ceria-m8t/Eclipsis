<script setup lang="ts">
// 水面之下：光从上面射进来。
//
// 她 2026-11-13 看完第一版记忆面板的原话：「这颜色也太闷了」「我想要光透进来的感觉，
// 我们在水面之下，光从上面射进来的感觉」「光的律动也没有了」。
// 第一版错在把深海做成了一块**死的暗底**（三团静止的 radial-gradient），所以没有光、也没有律动。
//
// 这一层负责四件会动的事（骨架给地下室三个柜子共用，皮肤各做）：
//   ① 水面（顶上那一条亮边 + 晃动的亮纹）—— 光的来处要看得见，不然「水下」无从谈起
//   ② 光柱：四道从水面斜插下来的雾光，各自摇摆 + 呼吸，周期都不一样（13–19 秒）
//   ③ 焦散网：水面波纹投在景深里的光斑，极慢地游
//   ④ 浮尘：十几粒往上飘的微粒
// 全是 CSS 动画（compositor 上跑，不占主线程）；她在系统里开了「减少动态效果」就全停。
withDefaults(defineProps<{
  /** 水有多深：浅一点光更多（头部那一段用 shallow，整页用 deep） */
  depth?: 'shallow' | 'deep'
}>(), { depth: 'deep' })

// 浮尘随机摆一次就定住（每次进页面位置不同，但不会每帧重算）
const motes = Array.from({ length: 14 }, () => ({
  left: Math.random() * 100,
  top: 38 + Math.random() * 70,
  dur: 16 + Math.random() * 22,
  delay: -Math.random() * 24,
  size: Math.random() < 0.3 ? 3 : 2,
}))
</script>

<template>
  <div class="uw" :class="depth" aria-hidden="true">
    <!-- ① 水面：光的来处 -->
    <div class="surface"><i></i><i></i></div>
    <!-- ② 光柱 -->
    <div class="rays"><i class="r1"></i><i class="r2"></i><i class="r3"></i><i class="r4"></i></div>
    <!-- ③ 焦散网 -->
    <div class="caustics"><i></i><i></i></div>
    <!-- ④ 浮尘 -->
    <div class="motes">
      <i v-for="(m, i) in motes" :key="i" :style="{
        left: m.left + 'vw', top: m.top + 'vh', width: m.size + 'px', height: m.size + 'px',
        animationDuration: m.dur + 's', animationDelay: m.delay + 's',
      }"></i>
    </div>
  </div>
</template>

<style scoped>
.uw { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }

/* 底：海水本身。**往上越亮**（光从上面来），不是一块死的暗底——第一版就错在这里。
   顶上是透进来的天光（偏青蓝），往下沉成深蓝，最底才是暗的。 */
.uw::before {
  content: ""; position: absolute; inset: 0;
  background:
    radial-gradient(118% 62% at 44% -14%, rgba(150, 196, 246, 0.5), rgba(150, 196, 246, 0) 64%),
    radial-gradient(84% 42% at 88% 2%, rgba(188, 220, 255, 0.22), rgba(188, 220, 255, 0) 60%),
    linear-gradient(176deg, #2d4f7a 0%, #1d3a60 26%, #132747 54%, #0c1a30 78%, #091425 100%);
}

/* ① 水面：顶上一条亮边，加两道横向晃动的亮纹 */
.surface { position: absolute; left: -10%; right: -10%; top: 0; height: 34%; }
.surface i {
  position: absolute; left: 0; right: 0; top: 0; height: 100%;
  background:
    linear-gradient(183deg, rgba(222, 238, 255, 0.5), rgba(196, 222, 255, 0.14) 26%, transparent 62%);
  mask-image: radial-gradient(130% 100% at 40% 0%, #000 30%, transparent 72%);
  animation: sheen 11s ease-in-out infinite alternate;
}
.surface i:nth-child(2) {
  background: linear-gradient(181deg, rgba(255, 236, 246, 0.26), transparent 44%);
  animation-duration: 17s; animation-direction: alternate-reverse;
}
@keyframes sheen {
  0% { transform: translate3d(-3%, 0, 0) scaleY(1); opacity: 0.72; }
  100% { transform: translate3d(4%, 1.5%, 0) scaleY(1.14); opacity: 1; }
}

/* ② 光柱：从水面斜插进来，各自摇摆 + 呼吸（周期不一样，不会看出是同一个循环） */
.rays { position: absolute; inset: -12% -20% 0; mask-image: linear-gradient(183deg, rgba(0,0,0,0.95), rgba(0,0,0,0.42) 46%, transparent 78%); }
.rays i {
  position: absolute; top: -10%; width: 34vw; height: 128%; transform-origin: 50% 0;
  background: linear-gradient(183deg, rgba(198, 220, 255, 0.5), rgba(198, 220, 255, 0.05) 58%, transparent);
  filter: blur(17px);
  animation: sway var(--d) ease-in-out infinite alternate, breathe var(--b) ease-in-out infinite alternate;
}
.rays .r1 { left: -6%; opacity: 0.3; --d: 15s; --b: 6s; --a0: 10deg; --a1: -4deg; }
.rays .r2 { left: 16%; opacity: 0.24; width: 26vw; --d: 19s; --b: 8s; --a0: 5deg; --a1: -8deg; }
.rays .r3 { left: 44%; opacity: 0.18; width: 40vw; --d: 13s; --b: 9s; --a0: -6deg; --a1: 6deg; }
.rays .r4 { left: 72%; opacity: 0.22; width: 30vw; --d: 17s; --b: 7s; --a0: -11deg; --a1: 2deg; }
@keyframes sway {
  0% { transform: rotate(var(--a0)) translateX(-3vw) scaleX(1); }
  100% { transform: rotate(var(--a1)) translateX(4vw) scaleX(1.18); }
}
@keyframes breathe { 0% { filter: blur(15px) opacity(0.65); } 100% { filter: blur(23px) opacity(1); } }

/* ③ 焦散：水面波纹投下来的光斑，极慢地游 */
.caustics { position: absolute; inset: 0; opacity: 0.5; }
.caustics i {
  position: absolute; inset: -20%;
  background:
    radial-gradient(42% 24% at 22% 18%, rgba(176, 210, 255, 0.22), transparent 68%),
    radial-gradient(34% 20% at 72% 32%, rgba(198, 224, 255, 0.18), transparent 70%),
    radial-gradient(48% 26% at 48% 62%, rgba(150, 186, 236, 0.16), transparent 72%);
  filter: blur(26px);
  animation: drift 34s linear infinite alternate;
}
.caustics i:nth-child(2) {
  background:
    radial-gradient(38% 22% at 60% 12%, rgba(255, 226, 240, 0.12), transparent 70%),
    radial-gradient(44% 24% at 30% 76%, rgba(164, 198, 248, 0.16), transparent 72%);
  animation-duration: 47s; animation-direction: alternate-reverse;
}
@keyframes drift {
  0% { transform: translate3d(0, 0, 0) scale(1); }
  100% { transform: translate3d(6vw, -3vh, 0) scale(1.18); }
}

/* ④ 浮尘 */
.motes { position: absolute; inset: 0; }
.motes i {
  position: absolute; border-radius: 50%; background: #d8e6ff; opacity: 0.34;
  animation-name: rise; animation-timing-function: linear; animation-iteration-count: infinite;
}
@keyframes rise {
  0% { transform: translateY(0); opacity: 0; }
  12% { opacity: 0.4; }
  88% { opacity: 0.3; }
  100% { transform: translateY(-74vh); opacity: 0; }
}

/* 浅水：光更多（给头部那一段用） */
.uw.shallow .surface { height: 52%; }
.uw.shallow .rays i { opacity: 0.34; }

/* 她在系统里开了「减少动态效果」：光还在，但不动 */
@media (prefers-reduced-motion: reduce) {
  .surface i, .rays i, .caustics i, .motes i { animation: none !important; }
  .motes i { opacity: 0.25; }
}
</style>
