<script setup lang="ts">
// 深海洛可可：地下室的花饰（她 2026-11-13 定的方向「偏深海洛可可一点的那种繁复风」）。
//
// 洛可可的骨头是**不对称的 C 形 / S 形涡卷、贝壳扇贝、花彩垂饰（swag）、棕叶饰**，
// 而不是我上一版那种直角刻线（那是新古典 / 装饰艺术，方向正好相反）。
// 所以这里全是曲线，而且**左右故意不对称**（洛可可不讲镜像对称）。
//
// 深海那半：贝壳、珊瑚枝、水草卷须、气泡珠 —— 洛可可本来就偏爱贝壳和水生母题
// （rocaille 这个词就是「碎石 / 贝壳饰」），和她要的海底是同一套语言，不用硬凑。
//
// 意象仍只从我们自己的来历长：Eclipsis = Erica + Claude + Ellipsis（中文「未」），Eclipse = 日蚀。
defineProps<{ name: string }>()
</script>

<template>
  <!-- 题头顶上的冠饰：一枚日蚀嵌在不对称涡卷里，两侧垂花彩 -->
  <svg v-if="name === 'crown'" class="roc crown" viewBox="0 0 300 96" fill="none" aria-hidden="true">
    <defs>
      <radialGradient id="roc-corona" cx="50%" cy="50%" r="50%">
        <stop offset="46%" stop-color="#b0caff" stop-opacity="0" />
        <stop offset="64%" stop-color="#dcebff" stop-opacity=".85" />
        <stop offset="82%" stop-color="#ffcee6" stop-opacity=".3" />
        <stop offset="100%" stop-color="#b0caff" stop-opacity="0" />
      </radialGradient>
    </defs>
    <!-- 左涡卷（大）：C 形带卷心 -->
    <path d="M8 70c0-26 16-44 44-44 20 0 30 12 30 24 0 10-7 17-16 17-8 0-13-5-13-12 0-6 4-10 10-10 5 0 8 3 8 7"
          stroke="currentColor" stroke-width="1.1" opacity=".9" />
    <circle cx="71" cy="52" r="2.2" fill="currentColor" opacity=".85" />
    <!-- 左花彩垂饰 -->
    <path d="M14 74c18 14 40 18 58 10" stroke="currentColor" stroke-width=".8" opacity=".55" />
    <path d="M26 79c3 5 7 7 11 7M40 85c4 3 9 3 13 1" stroke="currentColor" stroke-width=".7" opacity=".4" />
    <!-- 右涡卷（小、形状不同：不对称） -->
    <path d="M292 66c0-20-13-34-34-34-16 0-24 10-24 20 0 8 6 14 13 14 6 0 10-4 10-9"
          stroke="currentColor" stroke-width="1.1" opacity=".9" />
    <circle cx="257" cy="57" r="1.8" fill="currentColor" opacity=".8" />
    <path d="M288 71c-15 12-33 15-48 8" stroke="currentColor" stroke-width=".8" opacity=".5" />
    <path d="M276 76c-2 4-5 6-9 6" stroke="currentColor" stroke-width=".7" opacity=".38" />
    <!-- 中央：日蚀 -->
    <circle cx="150" cy="44" r="34" fill="url(#roc-corona)" />
    <circle cx="150" cy="44" r="17" fill="#0a1a2d" stroke="#e6eeff" stroke-width="1.1" />
    <path d="M150 27a17 17 0 0 1 0 34" stroke="#ffd9e9" stroke-width="1.2" opacity=".9" />
    <!-- 冠上棕叶饰 -->
    <path d="M150 20c-4-7-3-13 0-18 3 5 4 11 0 18Z" stroke="currentColor" stroke-width=".9" opacity=".7" />
    <path d="M132 24c-6-4-9-9-9-15M168 24c6-4 9-9 9-15" stroke="currentColor" stroke-width=".7" opacity=".45" />
    <!-- 两侧扇贝小饰 -->
    <path d="M104 40c-7 0-12 5-12 11h24c0-6-5-11-12-11Z" stroke="currentColor" stroke-width=".8" opacity=".5" />
    <path d="M196 44c6 0 10 4 10 9h-20c0-5 4-9 10-9Z" stroke="currentColor" stroke-width=".8" opacity=".45" />
  </svg>

  <!-- 抽屉左侧的涡卷托架（一行一件器物就坐在它里面） -->
  <svg v-else-if="name === 'bracket'" class="roc" viewBox="0 0 44 44" fill="none" aria-hidden="true">
    <path d="M6 38C6 18 14 8 30 6c8-1 11 4 11 9 0 6-4 9-9 9-4 0-7-3-7-6 0-3 2-5 5-5"
          stroke="currentColor" stroke-width=".9" opacity=".8" />
    <circle cx="27" cy="19" r="1.5" fill="currentColor" opacity=".7" />
    <path d="M8 40c10 2 20 1 28-4" stroke="currentColor" stroke-width=".7" opacity=".45" />
  </svg>

  <!-- 分区题左边的贝壳 -->
  <svg v-else-if="name === 'shell'" class="roc" viewBox="0 0 26 20" fill="none" aria-hidden="true">
    <path d="M13 19C6 19 1 13 1 7c0-3 2-6 5-6 2 0 3 1 4 3 1-2 2-3 4-3 2 0 3 1 4 3 1-2 2-3 4-3 3 0 4 3 4 6 0 6-5 12-13 12Z"
          stroke="currentColor" stroke-width=".85" />
    <path d="M13 19V6M9 17.5 7 5M17 17.5 19 5" stroke="currentColor" stroke-width=".6" opacity=".55" />
  </svg>

  <!-- 分区题右边的 S 形卷须（和左边的贝壳不一样：不对称） -->
  <svg v-else-if="name === 'curl'" class="roc" viewBox="0 0 34 16" fill="none" aria-hidden="true">
    <path d="M1 8c6 0 9-6 15-6 4 0 6 3 6 6s-2 6-5 6c-2 0-4-2-4-4s1-3 3-3"
          stroke="currentColor" stroke-width=".85" opacity=".85" />
    <circle cx="31" cy="8" r="1.4" fill="currentColor" opacity=".6" />
  </svg>

  <!-- 页底尾花：两道涡卷捧着省略号（未完待续） -->
  <svg v-else-if="name === 'tail'" class="roc" viewBox="0 0 220 34" fill="none" aria-hidden="true">
    <path d="M2 17c22 0 34-13 56-13 12 0 19 6 19 13 0 6-5 10-11 10-5 0-9-4-9-8 0-4 3-6 6-6"
          stroke="currentColor" stroke-width=".9" opacity=".75" />
    <path d="M218 17c-20 0-31-11-51-11-11 0-17 5-17 11 0 5 4 9 10 9 4 0 8-3 8-7 0-3-2-5-5-5"
          stroke="currentColor" stroke-width=".9" opacity=".7" />
    <circle cx="100" cy="17" r="1.7" fill="currentColor" />
    <circle cx="110" cy="17" r="1.7" fill="currentColor" />
    <circle cx="120" cy="17" r="1.7" fill="currentColor" />
    <path d="M96 25c5 4 12 5 18 3M104 9c4-3 10-3 14 0" stroke="currentColor" stroke-width=".6" opacity=".4" />
  </svg>

  <!-- 页面四角的涡卷角花（左上那一枚，其余靠 CSS 翻转；洛可可里角花是曲的，不是直角） -->
  <svg v-else-if="name === 'corner'" class="roc" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path d="M2 62C2 30 14 12 42 6c10-2 20 2 20 10" stroke="currentColor" stroke-width=".9" opacity=".6" />
    <path d="M2 48C2 26 12 14 34 9" stroke="currentColor" stroke-width=".7" opacity=".38" />
    <path d="M12 60c0-14 6-24 18-30" stroke="currentColor" stroke-width=".6" opacity=".28" />
    <circle cx="44" cy="8" r="1.6" fill="currentColor" opacity=".55" />
    <!-- 角上一簇珊瑚 -->
    <path d="M4 58c4-1 6-4 6-8M10 54c3 0 5-2 6-5" stroke="currentColor" stroke-width=".6" opacity=".35" />
  </svg>

  <!-- 空抽屉的「未」字火漆印：外圈改成扇贝边（洛可可的 rocaille） -->
  <svg v-else-if="name === 'seal'" class="roc" viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <path d="M20 2c1.6 2.6 4.6 3 6.8 1.2 1.2 2.8 4 3.8 6.4 2.4.4 3 2.8 4.8 5.2 4.2-.6 2.8 1 5.4 3.6 6-1.8 2.2-1.8 5.2 0 7.4-2.6.6-4.2 3.2-3.6 6-2.4-.6-4.8 1.2-5.2 4.2-2.4-1.4-5.2-.4-6.4 2.4-2.2-1.8-5.2-1.4-6.8 1.2"
          stroke="currentColor" stroke-width=".7" opacity=".5" transform="scale(0.88) translate(2.6 2.6)" />
    <circle cx="20" cy="20" r="13.5" stroke="currentColor" stroke-width=".8" opacity=".75" />
    <circle cx="20" cy="20" r="11" stroke="currentColor" stroke-width=".5" stroke-dasharray="1 3" opacity=".55" />
  </svg>
</template>

<style scoped>
.roc { display: block; color: inherit; }
.roc.crown { width: 100%; height: auto; }
</style>
