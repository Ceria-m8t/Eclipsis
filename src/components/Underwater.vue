<script setup lang="ts">
// 水面之下：**用真实底图 + 在底图上做动效**。
//
// 她 2026-11-13 的原话：「我不行了，像塑料条。我们要不要直接放实际底图上去？」
// 她说得对：CSS 渐变画不出真实光束的毛边、颗粒和浓淡不均，再怎么调都是塑料条。
// 她那几张参考图本来就是「一张照片/画 + 在上面叠动效」的做法。
//
// 所以这一版的分工变了：
//   **形**（光束长什么样、水有多深、颗粒感）→ 底图负责；
//   **动**（光在变、水在晃、浮尘在飘）→ 这一层负责，而且全部从底图自己长出来。
//
// 动效四件（都极慢，看不出是循环）：
//   ① 底图自己呼吸：极慢的缩放 + 推移，亮度和饱和度跟着微微起伏 —— 光在变
//   ② 亮部闪动：**同一张底图**再叠一层，只留亮部（screen 混合），和底层错着相位推移，
//      亮的地方忽明忽暗 —— 这是「光束在晃」的真来源，比画一条渐变真实得多
//   ③ 焦散扰动：一层极慢横向游动的柔光，压在上部，让水面的光斑不规则地挪
//   ④ 浮尘气泡往上飘，每四粒有一粒更亮（丁达尔效应）
// 没给底图时退回纯 CSS 的那套（渐变 + 光束），**只作兜底**，她见过，就是塑料条。
withDefaults(defineProps<{
  /** 底图地址。给了就用底图那套动效（推荐）；没给就退回纯 CSS */
  src?: string
  /** 水有多深：shallow 光更多更亮（头部那一段），deep 用于整页 */
  depth?: 'shallow' | 'deep'
  /** 底图亮度微调 0.6–1.4，默认 1 */
  gain?: number
  /**
   * 取图的位置（CSS background-position 的纵向值）。
   * ⚠ 她那张 1151×2500 的鱼群图贴顶时，页面只显示到图的上半部分——鱼最密的那一段在下面，
   * 所以她说「并没有把鱼加载在我这张图上面」。'center' 能把鱼群带进画面。
   */
  posY?: string
}>(), { src: '', depth: 'deep', gain: 1, posY: 'center' })

/**
 * 排查用：localStorage['eclipsis-uw-raw']='1' → **只画底图**，所有覆盖层都不画。
 * 用来回答「我看到的和我的图有没有关系」这个问题，不用再靠猜。
 */
const raw = (() => { try { return localStorage.getItem('eclipsis-uw-raw') === '1' } catch { return false } })()

/** 浮尘 / 气泡 */
// 26 粒在 iPhone 上每粒一个合成层，太多了；16 粒看着一样
const motes = Array.from({ length: 16 }, (_, i) => ({
  left: Math.random() * 100,
  top: 30 + Math.random() * 80,
  dur: 14 + Math.random() * 24,
  delay: -Math.random() * 30,
  size: i % 7 === 0 ? 3.5 : Math.random() < 0.35 ? 2.5 : 1.5,
  bright: i % 4 === 0,
}))

/** 纯 CSS 兜底用的光束（没有底图时才画） */
const beams = [
  { rot: -24, w: 11, o: 0.42, dur: 9, delay: 0 },
  { rot: -11, w: 17, o: 0.6, dur: 13, delay: -3 },
  { rot: 3, w: 9, o: 0.5, dur: 7.5, delay: -5 },
  { rot: 15, w: 21, o: 0.44, dur: 15, delay: -1.5 },
  { rot: 28, w: 13, o: 0.32, dur: 11, delay: -6.5 },
]
</script>

<template>
  <div class="uw" :class="[depth, src ? 'has-img' : 'no-img', { raw }]" aria-hidden="true"
       :style="{ '--gain': gain, '--pos-y': posY }">
    <template v-if="src">
      <!-- ① 底图自己呼吸：光在变 -->
      <div class="plate" :style="{ backgroundImage: `url(${src})` }"></div>
      <!-- ② 同一张底图只留亮部，错相位推移 → 光束忽明忽暗（动效的主力）
           ⚠ 只留**一层**：两层 `filter: brightness+contrast+blur` 作用在整屏图片上，
           叠在 backdrop-filter 的抽屉下面，iPhone 上每帧要重算好几遍大面积模糊 —— 她说页面越来越卡。 -->
      <div class="plate shine a" :style="{ backgroundImage: `url(${src})` }"></div>
      <!-- ③ 焦散扰动：水面的光斑不规则地挪（一层就够） -->
      <div class="caustic"><i></i></div>
    </template>

    <!-- 没底图时的兜底（纯 CSS，她见过，就是塑料条） -->
    <template v-else>
      <div class="fallback-sky"></div>
      <div class="shafts">
        <i v-for="(b, i) in beams" :key="i" :style="{
          '--rot': b.rot + 'deg', '--w': b.w + 'vw', '--o': b.o, '--dur': b.dur + 's',
          animationDelay: b.delay + 's',
        }"></i>
      </div>
    </template>

    <!-- ④ 浮尘和气泡：两种情况都有 -->
    <div class="motes">
      <i v-for="(m, i) in motes" :key="i" :class="{ bright: m.bright }" :style="{
        left: m.left + 'vw', top: m.top + 'vh', width: m.size + 'px', height: m.size + 'px',
        animationDuration: m.dur + 's', animationDelay: m.delay + 's',
      }"></i>
    </div>
  </div>
</template>

<style scoped>
/*
 * ⚠ 往下多铺出底栏那么高：底栏的玻璃透出的是**同一张底图**，而页面本身的高度不变。
 * 这样 cover 的取景和网页预览里一致（她：「颜色还是不一样」——其实是取到了图的不同段）。
 */
.uw {
  position: absolute; left: 0; right: 0; top: 0;
  bottom: calc((var(--tabbar-h, 42px) + var(--tabbar-safe, 6px)) * -1);
  overflow: hidden; pointer-events: none; background: #091426;
}
/* 只看底图：覆盖层全不画（排查用） */
.uw.raw .plate.shine, .uw.raw .caustic, .uw.raw .motes { display: none; }
.uw.raw .plate:not(.shine) { animation: none; filter: none; }

/* ── 底图那套 ── */
.plate {
  position: absolute; inset: -4%;              /* 留出余量给推移，不露边 */
  background-size: cover; background-position: center var(--pos-y, center);
  will-change: transform, filter;
}
/* ① 呼吸：极慢缩放 + 推移，亮度/饱和度跟着起伏 */
/* 呼吸：只做很慢的缩放推移 + 极轻的亮度起伏（±3%），**不动原图的调子** */
.plate:not(.shine) {
  filter: brightness(var(--gain));
  animation: breathe 26s ease-in-out infinite alternate;
}
/* 她说「似乎没有动效」：位移 1.2% 在手机上根本看不出来。
   现在慢慢游一段明显的距离（缩放 1.02→1.12、横移 4%），26 秒走完，像水在缓缓流过。 */
@keyframes breathe {
  0% { transform: scale(1.02) translate3d(-2%, 0, 0); filter: brightness(calc(var(--gain) * 0.97)); }
  50% { filter: brightness(calc(var(--gain) * 1.04)); }
  100% { transform: scale(1.12) translate3d(2.5%, 2%, 0); filter: brightness(var(--gain)); }
}

/*
 * ② 亮部闪动：同一张底图，用 brightness+contrast 把暗部压掉只留亮部（光束和水面亮斑），
 *    再用 screen 叠回去。两层错着相位慢慢推移 → 亮的地方忽明忽暗。
 *    这是真实感的来源：闪的是底图里真正亮的那些像素，不是我画的一条渐变。
 */
/*
 * ⚠ 力度要很小：**底图是主角，这一层只是让它的光会呼吸**。
 * 第一版 brightness(1.5) contrast(2.6) + opacity .5/.34 把整张图抬亮了 1.29 倍，
 * 她那张鱼群图的中间调全被推成白、鱼都糊掉了，她的话是「并没有把鱼加载在我这张图上面」
 * —— 其实图换对了，是被我洗白到认不出来。
 * 现在：contrast 拉到 9 + brightness 压到 0.42，等于**只留最亮的那一小撮像素**
 * （水面亮斑和光束芯），中间调一律变黑 → screen 叠上去等于不动。opacity 也砍到 1/3。
 */
.plate.shine {
  mix-blend-mode: screen;
  filter: brightness(0.42) contrast(9) saturate(0.9) blur(2px);
  mask-image: linear-gradient(180deg, #000 0%, rgba(0, 0, 0, 0.5) 44%, transparent 82%);
}
.plate.shine.a { animation: shineA 17s ease-in-out infinite alternate; }

/* 亮部闪动：幅度要能看见（0.1 看不出来），但只作用在最亮那一撮像素上，不会洗白整张图 */
@keyframes shineA {
  0% { transform: scale(1.05) translate3d(-2.5%, 0, 0); opacity: 0.16; }
  45% { opacity: 0.44; }
  100% { transform: scale(1.14) translate3d(3%, 2%, 0); opacity: 0.24; }
}


/* ③ 焦散扰动 */
.caustic { position: absolute; inset: 0; mix-blend-mode: screen; opacity: 0.4; }
.caustic i {
  position: absolute; left: -20%; right: -20%; top: -10%; height: 62%;
  background:
    radial-gradient(42% 40% at 30% 18%, rgba(198, 230, 255, 0.3), transparent 70%),
    radial-gradient(34% 32% at 68% 10%, rgba(226, 244, 255, 0.24), transparent 72%);
  filter: blur(26px);
  animation: wander 31s ease-in-out infinite alternate;
}

@keyframes wander {
  0% { transform: translate3d(-4%, 0, 0) scale(1); opacity: 0.55; }
  50% { opacity: 1; }
  100% { transform: translate3d(5%, 2%, 0) scale(1.22); opacity: 0.7; }
}

/* ── 没底图的兜底 ── */
.fallback-sky {
  position: absolute; inset: 0;
  background:
    radial-gradient(110% 46% at 46% -8%, rgba(176, 216, 255, 0.6), rgba(176, 216, 255, 0) 60%),
    linear-gradient(177deg, #2f5d8e 0%, #1e4470 22%, #142f55 48%, #0c1e3a 74%, #081426 100%);
}
.shafts { position: absolute; left: 50%; top: 2%; width: 0; height: 0; mix-blend-mode: screen; }
.shafts i {
  position: absolute; left: 0; top: 0; width: var(--w); height: 170vh;
  margin-left: calc(var(--w) / -2); transform-origin: 50% 0; transform: rotate(var(--rot));
  background: linear-gradient(185deg, rgba(226, 244, 255, calc(var(--o) * 0.9)) 0%,
    rgba(198, 228, 255, calc(var(--o) * 0.42)) 24%, transparent 78%);
  filter: blur(12px); clip-path: polygon(40% 0, 60% 0, 100% 100%, 0% 100%);
  animation: flare var(--dur) ease-in-out infinite alternate;
}
@keyframes flare {
  0% { opacity: 0.4; filter: blur(14px); }
  100% { opacity: 0.85; filter: blur(9px); }
}

/* ── 浮尘 / 气泡 ── */
.motes { position: absolute; inset: 0; mix-blend-mode: screen; }
.motes i {
  position: absolute; border-radius: 50%; background: rgba(226, 242, 255, 0.5);
  animation-name: rise; animation-timing-function: linear; animation-iteration-count: infinite;
}
.motes i.bright { background: #f0f8ff; box-shadow: 0 0 6px rgba(214, 238, 255, 0.9); }
@keyframes rise {
  0% { transform: translate3d(0, 0, 0); opacity: 0; }
  10% { opacity: 0.7; }
  50% { transform: translate3d(2vw, -38vh, 0); }
  85% { opacity: 0.45; }
  100% { transform: translate3d(-1vw, -82vh, 0); opacity: 0; }
}

/* 浅水（头部那一段）：光更多 */

.uw.shallow .caustic { opacity: 0.5; }

/* 她在系统里开了「减少动态效果」：画面还在，但不动 */
@media (prefers-reduced-motion: reduce) {
  .plate, .plate.shine, .caustic i, .shafts i, .motes i { animation: none !important; }
  .plate.shine.a { opacity: 0.16; }
}
</style>
