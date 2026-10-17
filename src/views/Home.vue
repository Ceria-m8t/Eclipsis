<script setup lang="ts">
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { keyboardOpen } from '../viewport'
import { pageBackdrop } from '../theme'

const router = useRouter()
const route = useRoute()

// 当前属于哪个标签：聊天、设置（含提示词编辑），其余都算"家"
const tab = computed(() => {
  if (route.path.startsWith('/chat')) return 'chat'
  if (route.path.startsWith('/settings')) return 'settings'
  return 'home'
})

const tabs = [
  { key: 'home', icon: '🏠', label: '家', to: '/living-room' },
  { key: 'chat', icon: '💬', label: '聊天', to: '/chat' },
  { key: 'settings', icon: '⚙️', label: '设置', to: '/settings' },
] as const

function go(t: (typeof tabs)[number]) {
  if (tab.value !== t.key) router.push(t.to)
}
</script>

<template>
  <!-- 应用外壳：上面是页面，下面是常驻底栏，两者上下排开，不重叠 -->
  <div class="app-shell app-screen">
    <!-- 背景层：铺满整屏（包括底栏下面），底栏的玻璃才透得出颜色 -->
    <div class="shell-bg" aria-hidden="true"></div>
    <div v-if="pageBackdrop" class="shell-bg page-backdrop" :style="pageBackdrop" aria-hidden="true"></div>

    <div class="shell-main">
      <RouterView />
    </div>

    <!-- 键盘弹起时收起底栏，把空间留给输入框 -->
    <nav v-show="!keyboardOpen" class="tabbar" aria-label="主导航">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="tab-btn press"
        :class="{ active: tab === t.key }"
        :aria-current="tab === t.key ? 'page' : undefined"
        @click="go(t)"
      >
        <span class="tab-icon" aria-hidden="true">{{ t.icon }}</span>
        <span class="tab-label">{{ t.label }}</span>
      </button>
    </nav>

    <!-- 浮层挂载点：侧栏、底部面板用 Teleport 挂到这里，能盖住底栏 -->
    <div id="shell-overlay"></div>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
}

.shell-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: var(--page-bg);
  background-size: cover;
  background-position: center;
}

#shell-overlay {
  position: absolute;
  inset: 0;
  z-index: 100;
  pointer-events: none;
}
#shell-overlay > * { pointer-events: auto; }

/* 页面区：各页面在这里面铺满（用 .shell-page） */
.shell-main {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* 常驻底栏：横跨整个宽度，底部留出 Home 横条的安全区 */
.tabbar {
  flex-shrink: 0;
  display: flex;
  justify-content: space-around;
  align-items: stretch;
  height: calc(var(--tabbar-h) + var(--safe-bottom));
  padding: 4px 12px var(--safe-bottom);
  position: relative;
  z-index: 50;
  background: var(--tabbar-bg, rgba(255, 255, 255, 0.38));
  -webkit-backdrop-filter: blur(26px) saturate(190%);
  backdrop-filter: blur(26px) saturate(190%);
  /* 上沿一道渐变高光，代替生硬的分隔线 */
  border-top: 0.5px solid rgba(255, 255, 255, 0.75);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.55),
    inset 0 2px 6px -3px rgba(160, 185, 255, 0.25),
    0 -4px 18px rgba(60, 72, 110, 0.06);
}

.tab-btn {
  flex: 1;
  max-width: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  margin: 2px 4px;
  border: none;
  border-radius: 16px;
  background: none;
  color: var(--text-2);
}
.tab-btn.active {
  color: var(--text);
  background: rgba(255, 255, 255, 0.45);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.9),
    inset 0 -1px 1px rgba(255, 255, 255, 0.3),
    0 2px 10px rgba(60, 72, 110, 0.08);
}
.tab-icon { font-size: 20px; line-height: 1.1; }
.tab-label { font-size: 11px; }
.tab-btn.active .tab-label { font-weight: 600; }
</style>

<style>
/* 外壳里的页面统一铺满页面区（不再各自占整屏） */
.shell-page {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
</style>
