<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { keyboardOpen } from '../viewport'
import { pageBackdrop, pageDark } from '../theme'
import Icon from '../components/Icon.vue'

const router = useRouter()
const route = useRoute()

/**
 * KeepAlive 的 key：只给要留着的那几页固定 key（聊天、记忆面板），
 * 其余页面用完整路径 —— 路径一变就是新组件，自然被挤出缓存（max: 3）。
 */
const keepKey = computed(() => {
  if (route.path.startsWith('/chat')) return 'keep:chat'
  if (route.path.startsWith('/memory')) return 'keep:memory'
  return route.fullPath
})

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

/**
 * 「家」这一栏上次停在哪一页。
 *
 * 她 2026-11-13：「我在这个界面切回到聊天界面，再切回到家的界面的时候，
 * 就没有保持在这个界面了，而是在家的默认主界面。」
 * 根因不是页面缓存 —— 是「家」这个按钮**写死跳 /living-room**。
 * 现在记住离开前的那一页（地下室、记忆面板、星空、书架……），点「家」回到那里。
 */
const lastHome = ref(localStorage.getItem('eclipsis-last-home') || '/living-room')
watch(() => route.fullPath, p => {
  if (tab.value === 'home') {
    lastHome.value = p
    try { localStorage.setItem('eclipsis-last-home', p) } catch { /* 隐私模式写不进就算了 */ }
  }
}, { immediate: true })

function go(t: (typeof tabs)[number]) {
  if (tab.value !== t.key) {
    router.push(t.key === 'home' ? lastHome.value : t.to)
    return
  }
  // 已经在设置的某一项里：再点「设置」回到目录
  if (t.key === 'settings' && route.path !== '/settings') router.push('/settings')
  // 已经在「家」这一栏里：再点「家」回客厅（给她一条回主界面的路）
  else if (t.key === 'home' && route.path !== '/living-room') router.push('/living-room')
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
        <!--
          聊天页和记忆面板都留着不销毁。
          ⚠ 用 `:key` 固定成路由名，再让 KeepAlive 无条件缓存这两个 ——
          `include` 匹配的是**组件名**，而这些是异步组件（`() => import(...)`），
          KeepAlive 看到的是包装器、拿不到名字，所以 include 对它们无效
          （她 2026-11-13：「切回到家的界面的时候，就没有保持在这个界面了」）。
        -->
        <KeepAlive :max="3">
          <component :is="Component" :key="keepKey" />
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
/* 深色页声明 dark 配色：PWA 全屏下 iOS 不再按浅色方案补偿 */
.shell-dark { color-scheme: dark; }
/*
 * ⚠ 底栏是半透明的，它底下露出来的是 **.shell-bg 那一层**（absolute 铺满整个外壳、
 * 画的是浅色的 --page-bg）。我前几版分别试过改底栏自己的半透明色、给外壳垫深底、
 * 加 ::after 补背景，都没用，因为浅色那一层压在最上面。
 * 现在直接让深色页的 .shell-bg 变成深底，底栏透出来的就是深色了。
 */
.shell-dark { background: #050d1c; }
.shell-dark .shell-bg { background: #050d1c !important; }
/*
 * 深色页：页面高度**不动**（撑高会改变底图 cover 的取景，她因此看到两种颜色），
 * 底图那一层自己往下多铺出底栏那么高（见 Underwater.vue 的 .uw），底栏的玻璃就透出同一张图。
 * ⚠ 这里曾经加过一个 `::after { background: inherit }` 想补背景，
 * 结果 inherit 到的是 transparent —— 等于一块空白盖在底栏上，她看到底栏「突然有问题」。
 */
.shell-dark .shell-main { position: relative; }

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
