<script setup lang="ts">
// 洛可可白描纹样（照 Erica 2026-11-13 发的参考图描的）。
//
// 她发了三类：①细线白描的小图样（卷草 + 星芒 + 垂珠）②黑描的洛可可垂饰和卷叶角花
// ③贝壳里那张白描卡图什边框。她的话：「你觉得能用的，你直接就是描上去。」
//
// 从参考图里提炼出的四条特征（我之前凭想象画，画出了蜗牛，这次照着描）：
//   1. **卷叶不是螺线**：一条 C 形主脊，外缘翻出叶瓣，叶瓣末端再卷出小尖，带分叉
//   2. **必有垂饰**：链珠 + 坠子从卷叶末端垂下来（参考图里几乎每一枚都有）
//   3. **星芒点缀**：四角长芒的小星，散在卷草周围，疏密不均
//   4. **线很细、留白多**：描边 0.6–1.1px，靠疏密而不是靠粗重
defineProps<{ name: string }>()
</script>

<template>
  <!-- 卷叶角花：参考图最后一张左上那一枚（C 形主脊 + 翻卷叶瓣 + 垂饰） -->
  <svg v-if="name === 'corner'" class="fg" viewBox="0 0 120 120" fill="none" aria-hidden="true">
    <g stroke="currentColor" stroke-linecap="round" fill="none">
      <!-- 主脊：从角里长出来，向外舒展再回卷 -->
      <path d="M4 116C4 74 16 40 44 22c14-9 30-10 40-4" stroke-width="1.1" />
      <path d="M44 22c8-6 10-14 6-20" stroke-width=".8" opacity=".7" />
      <!-- 外缘翻出的叶瓣，末端卷小尖 -->
      <path d="M10 104c2-30 14-52 36-64 10-5 20-5 26-1 5 4 5 11 0 14-4 2-9 0-9-5 0-3 2-5 5-5"
            stroke-width=".9" opacity=".85" />
      <path d="M18 92c4-22 14-38 30-47" stroke-width=".65" opacity=".5" />
      <!-- 内侧分叉的小卷草 -->
      <path d="M30 70c-6 2-9 8-8 15 4-4 9-5 13-2-1-6-2-10-5-13Z" stroke-width=".7" opacity=".6" />
      <path d="M52 44c5-4 11-4 15 0-4 3-8 4-12 2" stroke-width=".7" opacity=".55" />
      <!-- 垂饰：链珠 + 坠子 -->
      <path d="M70 18v10" stroke-width=".6" opacity=".5" />
      <path d="M70 34v8" stroke-width=".6" opacity=".45" />
      <path d="M70 48c-3 3-3 7 0 10 3-3 3-7 0-10Z" stroke-width=".7" opacity=".55" />
    </g>
    <g fill="currentColor">
      <circle cx="70" cy="31" r="1.3" opacity=".7" />
      <circle cx="70" cy="45" r="1" opacity=".6" />
      <circle cx="26" cy="86" r="1.1" opacity=".55" />
    </g>
    <!-- 星芒 -->
    <g stroke="currentColor" stroke-width=".55" opacity=".5">
      <path d="M86 36h7M89.5 32.5v7" /><path d="M58 12h5M60.5 9.5v5" />
    </g>
  </svg>

  <!-- 题头冠饰：参考图里那种「两道卷叶捧住中心 + 下垂链珠」 -->
  <svg v-else-if="name === 'crest'" class="fg" viewBox="0 0 320 80" fill="none" aria-hidden="true">
    <g stroke="currentColor" stroke-linecap="round" fill="none">
      <!-- 左卷叶 -->
      <path d="M8 44c14-20 36-30 56-24 11 3 16 12 12 20-3 7-12 8-17 3-3-4-2-9 2-11 3-1 6 1 6 4"
            stroke-width="1" />
      <path d="M14 52c12-16 30-24 48-20" stroke-width=".7" opacity=".55" />
      <path d="M40 30c-3-6-2-11 2-15 3 5 3 10-2 15Z" stroke-width=".7" opacity=".6" />
      <!-- 左垂饰 -->
      <path d="M26 56v7M26 68v5" stroke-width=".6" opacity=".45" />
      <path d="M26 76c-2.5 2.5-2.5 6 0 8.5 2.5-2.5 2.5-6 0-8.5Z" stroke-width=".65" opacity=".5" />
      <!-- 右卷叶（小一号，不对称） -->
      <path d="M312 40c-12-17-30-25-47-20-9 3-13 10-10 17 3 6 10 7 14 2 2-3 1-7-2-9"
            stroke-width="1" />
      <path d="M306 48c-10-14-26-21-41-18" stroke-width=".7" opacity=".5" />
      <path d="M284 28c3-5 2-10-1-13-3 4-3 9 1 13Z" stroke-width=".7" opacity=".55" />
      <path d="M296 52v6M296 62v4" stroke-width=".6" opacity=".4" />
      <!-- 中间向上的棕叶 -->
      <path d="M160 26c-4-8-3-15 0-21 3 6 4 13 0 21Z" stroke-width=".85" opacity=".7" />
      <path d="M146 30c-5-4-8-9-8-15M174 30c5-4 8-9 8-15" stroke-width=".6" opacity=".4" />
    </g>
    <g fill="currentColor">
      <circle cx="26" cy="65.5" r="1.1" opacity=".6" />
      <circle cx="296" cy="59.5" r="1" opacity=".55" />
      <circle cx="70" cy="40" r="1.5" opacity=".7" />
      <circle cx="255" cy="38" r="1.2" opacity=".6" />
    </g>
    <g stroke="currentColor" stroke-width=".55" opacity=".45">
      <path d="M100 18h6M103 15v6" /><path d="M218 22h5M220.5 19.5v5" />
    </g>
  </svg>

  <!-- 分区题左侧：一小枝卷草 -->
  <svg v-else-if="name === 'sprig'" class="fg" viewBox="0 0 34 18" fill="none" aria-hidden="true">
    <g stroke="currentColor" stroke-linecap="round" fill="none">
      <path d="M1 14c8 0 12-10 20-10 5 0 8 3 8 7s-3 6-6 6c-2 0-4-2-4-4s1-3 3-3" stroke-width=".85" />
      <path d="M9 10c-2-3-1-6 1-8 2 3 2 6-1 8Z" stroke-width=".6" opacity=".6" />
    </g>
    <circle cx="23" cy="13" r="1.2" fill="currentColor" opacity=".6" />
    <g stroke="currentColor" stroke-width=".5" opacity=".45"><path d="M31 4h4M33 2v4" /></g>
  </svg>

  <!-- 分区题右侧的长线 + 星芒收尾 -->
  <svg v-else-if="name === 'rule'" class="fg" viewBox="0 0 60 10" fill="none" aria-hidden="true">
    <path d="M0 5h44" stroke="currentColor" stroke-width=".7" opacity=".4" />
    <path d="M44 5c3-2 6-2 8 0-2 2-5 2-8 0Z" stroke="currentColor" stroke-width=".65" opacity=".55" />
    <g stroke="currentColor" stroke-width=".5" opacity=".5"><path d="M55 5h5M57.5 2.5v5" /></g>
  </svg>

  <!-- 页底尾花：两道卷叶 + 中间省略号（未完待续）+ 两侧垂珠 -->
  <svg v-else-if="name === 'tail'" class="fg" viewBox="0 0 240 40" fill="none" aria-hidden="true">
    <g stroke="currentColor" stroke-linecap="round" fill="none">
      <path d="M4 18c20-14 44-16 62-6 8 5 10 13 5 18-4 4-11 3-13-2-1-4 1-7 5-7" stroke-width=".9" />
      <path d="M236 18c-18-13-40-15-57-6-8 4-10 11-6 16 4 4 10 3 12-2 1-3-1-6-4-6" stroke-width=".9" />
      <path d="M40 10c-3-5-2-9 1-12 3 4 3 8-1 12Z" stroke-width=".65" opacity=".6" />
      <path d="M198 11c3-4 2-8-1-11-3 4-2 8 1 11Z" stroke-width=".65" opacity=".55" />
      <path d="M78 26v6M162 26v5" stroke-width=".55" opacity=".4" />
    </g>
    <g fill="currentColor">
      <circle cx="112" cy="20" r="1.6" opacity=".8" />
      <circle cx="120" cy="20" r="1.6" opacity=".8" />
      <circle cx="128" cy="20" r="1.6" opacity=".8" />
      <circle cx="78" cy="34" r="1.1" opacity=".55" />
      <circle cx="162" cy="33" r="1" opacity=".5" />
    </g>
  </svg>

  <!-- 空抽屉的「未」字印：卡图什式小框（参考图里那种带卷边的小盾） -->
  <svg v-else-if="name === 'seal'" class="fg" viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <g stroke="currentColor" fill="none">
      <path d="M20 3c5 0 9 2 11 5 3 4 4 9 3 14-1 6-5 11-11 14-1 1-3 1-4 0C13 33 9 28 8 22c-1-5 0-10 3-14 2-3 6-5 9-5Z"
            stroke-width=".8" opacity=".7" />
      <path d="M20 6.5c4 0 7 1.5 8.5 4 2.5 3 3 7 2.5 11-1 5-4 9-9 11.5-.8.5-2.4.5-3 0-5-2.5-8-6.5-9-11.5-.5-4 0-8 2.5-11 1.5-2.5 4.5-4 8-4Z"
            stroke-width=".5" stroke-dasharray="1 2.6" opacity=".5" />
      <!-- 顶上和底下的小卷边 -->
      <path d="M20 3c-2-2-2-3 0-3 2 0 2 1 0 3Z" stroke-width=".6" opacity=".6" />
      <path d="M14 34c-3 2-5 2-5 0M26 34c3 2 5 2 5 0" stroke-width=".55" opacity=".45" />
    </g>
  </svg>

  <!-- 器物托架：卷叶托住图标 -->
  <svg v-else-if="name === 'bracket'" class="fg" viewBox="0 0 44 44" fill="none" aria-hidden="true">
    <g stroke="currentColor" stroke-linecap="round" fill="none">
      <path d="M5 36C5 18 13 8 28 6c7-1 11 3 11 8 0 5-4 8-8 8-3 0-6-2-6-5 0-2 2-4 4-4" stroke-width=".85" opacity=".8" />
      <path d="M8 39c9 2 18 1 25-4" stroke-width=".6" opacity=".4" />
      <path d="M18 14c-3-3-3-6-1-8 2 3 2 6 1 8Z" stroke-width=".55" opacity=".5" />
    </g>
    <circle cx="26" cy="18" r="1.2" fill="currentColor" opacity=".6" />
  </svg>
</template>

<style scoped>
.fg { display: block; color: inherit; }
</style>
