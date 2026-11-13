<script setup lang="ts">
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { keyboardOpen } from '../viewport'
import { pageBackdrop, pageDark } from '../theme'
import Icon from '../components/Icon.vue'

const router = useRouter()
const route = useRoute()

// 当前属于哪个标签：聊天、设置（含提示词编辑），其余都算"家"
const tab = computed(() => {
  if (route.path.startsWith('/chat')) return 'chat'
  if (route.path.startsWith('/settings')) return 'settings'
  return 'home'
})

const tabs = [
  { key: 'home', icon: 'home', label: '家', to: '/living-room' },
  { key: 'chat', icon: 'chat', label: '聊天', to: '/chat' },
  { key: 'settings', icon: 'settings', label: '设置', to: '/settings' },
] as const

function go(t: (typeof tabs)[number]) {
  if (tab.value !== t.key) router.push(t.to)
  // 已经在设置的某一项里：再点「设置」回到目录
  else if (t.key === 'settings' && route.path !== '/settings') router.push('/settings')
}
</script>

<template>
  <!-- 应用外壳：上面是页面，下面是常驻底栏，两者上下排开，不重叠 -->
  <div class="app-shell app-screen" :class="{ 'shell-dark': pageDark }">
    <!-- 背景层：铺满整屏（包括底栏下面），底栏的玻璃才透得出颜色 -->
    <div class="shell-bg" data-glass-backdrop aria-hidden="true"></div>
    <div v-if="pageBackdrop" class="shell-bg page-backdrop" data-glass-backdrop :style="pageBackdrop" aria-hidden="true"></div>

    <div class="shell-main">
      <!-- 聊天页切走时不销毁：他正在回的那一轮接着收，切回来还在（以前一切走就把这一轮停掉了） -->
      <RouterView v-slot="{ Component }">
        <KeepAlive include="Chat">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </div>

    <!-- 键盘弹起时收起底栏，把空间留给输入框 -->
    <!-- 深色页（地下室）：底栏退出全站玻璃（liq-skip），否则玻璃会去采外壳那层浅色渐变 → 白条。
         她 2026-11-13：「底栏为什么一直是白色的？我希望它一直是透的。」 -->
    <nav v-show="!keyboardOpen" class="tabbar" :class="pageDark ? 'dark liq-skip' : ''"
         :data-glass="pageDark ? undefined : ''" aria-label="主导航">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="tab-btn press"
        :class="{ active: tab === t.key }"
        :aria-current="tab === t.key ? 'page' : undefined"
        :data-glass="tab === t.key ? '' : undefined"
        @click="go(t)"
      >
        <Icon :name="t.icon" :size="21" :weight="tab === t.key ? 2.1 : 1.6" class="tab-icon" />
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
  top: 0; left: 0; right: 0;
  height: max(100%, var(--app-full-h, 100%));
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
  height: calc(var(--tabbar-h) + var(--tabbar-safe));
  padding: 0 12px var(--tabbar-safe);
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
  margin: 3px 4px;
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
/* 深色页（地下室）：底栏不要白条，透出页面自己的背景 */
.tabbar.dark {
  /* !important：--tabbar-bg 是 applyTheme 写在 :root 上的白色，基类那行会拿到它 */
  background: rgba(10, 22, 42, 0.42) !important;
  -webkit-backdrop-filter: blur(20px);
  backdrop-filter: blur(20px);
  border-top: 0.5px solid rgba(197, 214, 245, 0.2);
  box-shadow:
    inset 0 1px 0 rgba(197, 214, 245, 0.14),
    0 -4px 18px rgba(2, 8, 18, 0.3);
}
.tabbar.dark .tab-btn { color: rgba(233, 238, 246, 0.6); }
.tabbar.dark .tab-btn.active {
  color: #eaf0f8;
  background: rgba(197, 214, 245, 0.16);
  box-shadow: inset 0 1px 0 rgba(233, 238, 246, 0.22), 0 2px 10px rgba(2, 8, 18, 0.25);
}
/* 深色页的页面区铺到底栏下面：底图透过底栏的玻璃显出来 */
.shell-dark .shell-main { margin-bottom: calc((var(--tabbar-h) + var(--tabbar-safe)) * -1); }
.shell-dark .shell-main > * { padding-bottom: calc(var(--tabbar-h) + var(--tabbar-safe)); }

.tab-icon { display: block; }
.tab-label { font-size: 10.5px; line-height: 1.1; }
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
