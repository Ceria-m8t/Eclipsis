<script setup lang="ts">
// 地下室共用的花饰和器物（她要的「繁复 = 花饰 + 器物」「一行一件器物，不是等大方格」）。
//
// 意象只从我们自己的来历长（交接-2026-11-13 第 2 条，我已经犯过一次照搬别人版面的错）：
//   Eclipsis = Erica + Claude + **Ellipsis**；ellipsis 来自中文「**未**」——未命名、未来、未完待续；
//   Eclipse = **日蚀**，她喜欢天文。
// 所以：题头是一枚日蚀（黑日 + 冕环 + 粉色内缘），空抽屉盖的是「未」字火漆印，
// 尾花中间是省略号那三点（未完待续），不是别人那套甲虫和酒红。
defineProps<{ name: string }>()
</script>

<template>
  <!-- 日蚀：题头那一枚 -->
  <svg v-if="name === 'eclipse'" class="orn eclipse" viewBox="0 0 50 50" fill="none" aria-hidden="true">
    <defs>
      <radialGradient id="pond-corona" cx="50%" cy="50%" r="50%">
        <stop offset="52%" stop-color="#b0caff" stop-opacity="0" />
        <stop offset="66%" stop-color="#cfe2ff" stop-opacity=".7" />
        <stop offset="80%" stop-color="#ffcee6" stop-opacity=".24" />
        <stop offset="100%" stop-color="#b0caff" stop-opacity="0" />
      </radialGradient>
    </defs>
    <circle cx="25" cy="25" r="24" fill="url(#pond-corona)" />
    <circle cx="25" cy="25" r="13" fill="#0b1b2e" stroke="#e2eafa" stroke-width="1" />
    <path d="M25 12a13 13 0 0 1 0 26" stroke="#ffd9e9" stroke-width="1.1" opacity=".85" />
    <g stroke="rgba(207,226,255,0.4)" stroke-width=".9">
      <path d="M25 1.6v3.4" /><path d="M25 45v3.4" /><path d="M1.6 25H5" /><path d="M45 25h3.4" />
    </g>
  </svg>

  <!-- 四角花饰 -->
  <svg v-else-if="name === 'fleur'" class="orn" viewBox="0 0 17 17" fill="none" aria-hidden="true">
    <path d="M1 16C1 8 5 2 16 1" stroke="currentColor" stroke-width=".9" />
    <path d="M1 10c4 0 6-3 6-9" stroke="currentColor" stroke-width=".7" opacity=".7" />
    <circle cx="2.4" cy="14.6" r="1.2" fill="currentColor" />
  </svg>

  <!-- 尾花：省略号在中间（未完待续） -->
  <svg v-else-if="name === 'tail'" class="orn" width="96" height="14" viewBox="0 0 96 14" fill="none" aria-hidden="true">
    <path d="M0 7h30" stroke="currentColor" stroke-width=".9" />
    <path d="M66 7h30" stroke="currentColor" stroke-width=".9" />
    <path d="M30 7c4 0 6-4 10-4s6 4 8 4-2 4-8 4-6-4-10-4Z" stroke="currentColor" stroke-width=".9" />
    <path d="M66 7c-4 0-6-4-10-4s-6 4-8 4 2 4 8 4 6-4 10-4Z" stroke="currentColor" stroke-width=".9" />
    <circle cx="42" cy="7" r="1.3" fill="currentColor" /><circle cx="48" cy="7" r="1.3" fill="currentColor" /><circle cx="54" cy="7" r="1.3" fill="currentColor" />
  </svg>

  <!-- ── 器物：一行一件，按格子的内容各不相同 ── -->
  <svg v-else-if="name === 'cards'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <rect x="2.6" y="5.4" width="12.4" height="10.2" stroke="currentColor" opacity=".55" />
    <rect x="5.4" y="3.4" width="12.4" height="10.2" stroke="currentColor" />
    <path d="M8 6.6h7M8 9.2h5" stroke="currentColor" opacity=".7" />
  </svg>
  <svg v-else-if="name === 'threads'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <circle cx="4.4" cy="5.2" r="1.7" fill="currentColor" />
    <circle cx="16.4" cy="8.4" r="1.4" fill="#ffd9e9" opacity=".85" />
    <circle cx="7.4" cy="16" r="1.3" fill="currentColor" opacity=".7" />
    <path d="M4.4 5.2 16.4 8.4M4.4 5.2 7.4 16M16.4 8.4 7.4 16" stroke="currentColor" opacity=".55" />
  </svg>
  <svg v-else-if="name === 'book'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <path d="M10.5 5.4C8.4 3.8 5.8 3.4 3 3.8v11.6c2.8-.4 5.4 0 7.5 1.6 2.1-1.6 4.7-2 7.5-1.6V3.8c-2.8-.4-5.4 0-7.5 1.6Z" stroke="currentColor" />
    <path d="M10.5 5.4v12.6" stroke="currentColor" opacity=".6" />
  </svg>
  <svg v-else-if="name === 'weekly'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <rect x="3.4" y="4.6" width="14.2" height="12.4" stroke="currentColor" />
    <path d="M3.4 8.4h14.2" stroke="currentColor" />
    <path d="M7 4.6V2.8M14 4.6V2.8" stroke="currentColor" />
    <rect x="6" y="10.6" width="2.6" height="2.4" fill="currentColor" opacity=".6" />
  </svg>
  <svg v-else-if="name === 'lock'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <rect x="4.8" y="9" width="11.4" height="8.4" stroke="currentColor" />
    <path d="M7.4 9V6.8a3.1 3.1 0 0 1 6.2 0V9" stroke="currentColor" />
    <circle cx="10.5" cy="13" r="1.2" fill="currentColor" />
  </svg>
  <svg v-else-if="name === 'tree'" class="orn" viewBox="0 0 21 23" fill="none" aria-hidden="true">
    <path d="M10.5 22V9.5" stroke="currentColor" />
    <path d="M10.5 9.5 4.4 3M10.5 12.4 16.8 7M10.5 15 5.8 11.4" stroke="currentColor" />
    <circle cx="4.4" cy="3" r="1.7" fill="currentColor" />
    <circle cx="16.8" cy="7" r="1.4" fill="#ffd9e9" opacity=".85" />
    <circle cx="5.8" cy="11.4" r="1.2" fill="currentColor" opacity=".6" />
  </svg>
  <svg v-else-if="name === 'page'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <rect x="3.4" y="3.6" width="14.2" height="13.4" stroke="currentColor" />
    <path d="M6.2 7.6h8.6M6.2 10.4h8.6M6.2 13.2h5" stroke="currentColor" opacity=".8" />
  </svg>
  <svg v-else-if="name === 'clock'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <circle cx="10.5" cy="10.5" r="6.8" stroke="currentColor" />
    <path d="M10.5 5.6v4.9l3.5 2.3" stroke="currentColor" />
    <path d="M10.5 1.4v1.7M10.5 17.9v1.7M1.4 10.5h1.7M17.9 10.5h1.7" stroke="currentColor" opacity=".45" />
  </svg>
  <svg v-else-if="name === 'chest'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <rect x="3.4" y="4.4" width="14.2" height="12.8" stroke="currentColor" />
    <path d="M3.4 10.8h14.2" stroke="currentColor" />
    <path d="M9 7.6h3M9 14h3" stroke="currentColor" opacity=".8" />
  </svg>
  <svg v-else-if="name === 'dream'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <path d="M4 16c3.6-1.5 6.5-5.5 6.5-9.7 0 4.2 3 8.2 6.5 9.7" stroke="currentColor" />
    <circle cx="10.6" cy="4.2" r="1.6" stroke="currentColor" />
  </svg>
  <svg v-else-if="name === 'person'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <circle cx="10.5" cy="7.2" r="3.5" stroke="currentColor" />
    <path d="M3.4 18c0-3.9 3.2-6.4 7.1-6.4s7.1 2.5 7.1 6.4" stroke="currentColor" />
  </svg>
  <svg v-else-if="name === 'alias'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <circle cx="6" cy="7" r="2.8" stroke="currentColor" />
    <circle cx="15" cy="14" r="2.8" stroke="currentColor" opacity=".75" />
    <path d="M8.2 9.2 12.8 11.8" stroke="currentColor" opacity=".6" />
  </svg>
  <svg v-else-if="name === 'chapter'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <path d="M4.6 4.6h11.8v11.8H4.6z" stroke="currentColor" />
    <path d="M7.4 8.4h6.2M7.4 11.6h4" stroke="currentColor" opacity=".75" />
    <path d="M13.6 4.6v3.2h2.8" stroke="currentColor" opacity=".6" />
  </svg>
  <svg v-else-if="name === 'quote'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <path d="M7.4 11.6c-1.8 0-2.8-1.2-2.8-2.8S5.8 5.8 7.6 5.8c0 2.4-.2 3.6-1.2 4.4" stroke="currentColor" />
    <path d="M15.2 11.6c-1.8 0-2.8-1.2-2.8-2.8s1.2-3 3-3c0 2.4-.2 3.6-1.2 4.4" stroke="currentColor" />
    <path d="M5 15.4h11" stroke="currentColor" opacity=".5" />
  </svg>
  <svg v-else-if="name === 'eye'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <path d="M1.8 10.5S5 5.4 10.5 5.4 19.2 10.5 19.2 10.5 16 15.6 10.5 15.6 1.8 10.5 1.8 10.5Z" stroke="currentColor" />
    <circle cx="10.5" cy="10.5" r="2.4" fill="currentColor" opacity=".55" />
  </svg>
  <svg v-else-if="name === 'inbox'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <rect x="2.8" y="5.4" width="15.4" height="10.2" stroke="currentColor" />
    <path d="M2.8 5.4 10.5 11.6 18.2 5.4" stroke="currentColor" />
  </svg>
  <svg v-else-if="name === 'archive'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <rect x="3" y="4" width="15" height="4.4" stroke="currentColor" />
    <path d="M4.6 8.4v8.2h11.8V8.4" stroke="currentColor" />
    <path d="M8.4 12h4.2" stroke="currentColor" opacity=".8" />
  </svg>
  <svg v-else-if="name === 'moon'" class="orn" viewBox="0 0 21 21" fill="none" aria-hidden="true">
    <path d="M13.4 3.4a7.6 7.6 0 1 0 4.2 10.4A8.2 8.2 0 0 1 13.4 3.4Z" stroke="currentColor" />
    <circle cx="16.6" cy="5.6" r="1" fill="#ffd9e9" opacity=".8" />
  </svg>
</template>

<style scoped>
.orn { display: block; color: inherit; }
.orn.eclipse { width: 46px; height: 46px; margin: 0 auto; }
</style>
