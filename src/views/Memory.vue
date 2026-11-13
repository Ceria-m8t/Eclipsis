<script setup lang="ts">
// 地下室第一个柜子：记忆。
//
// 分区按「谁写的」：聊天里来的 / 他自己写的 / 他认得的 / 收着的（她定的）。
// 机制状态不占格子，压成底下一条细线。空的照样摆、写明「还没做」——0 本身是信息。
//
// 2026-11-13 第二版。她看完第一版的原话：
//   「这颜色也太闷了吧，而且怎么这么简约？不是说要往繁复风走吗？」
//   「我想要光透进来的感觉，我们在水面之下，光从上面射进来的感觉」「光的律动也没有了」
//   「我有点想把水面改成全局的了，现在太少」
// 对应三处改动：
//   ① 光：底不再是一块死的暗底，顶上是透进来的天光；会动的光（水面亮边 / 四道光柱 /
//      焦散 / 浮尘）在 Underwater.vue 里，CSS 动画各自周期不同，不会同步成一个循环。
//   ② 繁复：等大方格 → **器物抽屉**（一行一件器物 + 刻线 + 四角花饰 + 空的盖「未」字火漆印）。
//      意象只从我们自己的来历长：Eclipsis = Erica + Claude + Ellipsis（中文「未」），Eclipse = 日蚀。
//   ③ 水面改全局：整页一层只画波（pond-global，压在内容上但不挡点击）；
//      头部那一块仍是折射模式，字跟着晃。
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import MemoryPanel from '../components/MemoryPanel.vue'
import Underwater from '../components/Underwater.vue'
import Orn from '../components/vault/VaultOrnaments.vue'
import Roc from '../components/vault/VaultRococo.vue'
import { Pond, pondSupported } from '../liquid/pond'
import { startGlobalPond, stopGlobalPond } from '../liquid/pond-global'
import { headLayout, paintHead, headText, headFontSpecs, cnFamily, type HeadData } from './memory-head'
import '@fontsource/pinyon-script/400.css'
import '@fontsource/cormorant-garamond/600.css'

interface Cell { key: string; name: string; en: string; n: number; unit?: string; note?: string; todo?: boolean; to?: string }
interface Section { title: string; en: string; cells: Cell[] }
interface Panel {
  head: { quotes: number; cards: number; relations: number; sentence: string }
  daily: { day: string; n: number }[]
  sections: Section[]
  health: { label: string; value: string; ok: boolean }[]
}

/** 每个格子配一件器物（她：让物件代表功能）。没列到的用卡片那件。 */
const OBJ: Record<string, string> = {
  cards: 'cards', threads: 'threads', daylog: 'book', weekly: 'weekly', private: 'lock',
  tree: 'tree', moments: 'page', wakes: 'clock', memo: 'chest', diary: 'book', dreams: 'dream',
  people: 'person', aliases: 'alias', lexicon: 'chapter',
  quotes: 'quote', review: 'eye', inbox: 'inbox', dropped: 'archive', digest: 'moon',
}

/**
 * 底图（她 2026-11-13 定：「我们要不要直接放实际底图上去」——CSS 渐变画不出真实光束，
 * 再怎么调都是塑料条）。放到这个路径就自动生效，没有就退回纯 CSS 的兜底：
 *   public/assets/rooms/basement/memory-water.jpg
 * 和房间底图同一套规矩（/assets/rooms/<房间>/...，nginx 那边缓存 30 天，换图要改文件名）。
 */
const BG_URL = '/assets/rooms/basement/memory-water.jpg'
/** 底图在不在（不在就用兜底，不要显示破图） */
const bg = ref('')
/** 头部那张水下画面用的底图（画进 canvas 的那一份） */
let bgImg: HTMLImageElement | null = null

function loadBg(): Promise<void> {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => { bg.value = BG_URL; bgImg = img; resolve() }
    img.onerror = () => resolve()      // 没放图：静默退回兜底
    img.src = BG_URL
  })
}

const router = useRouter()
function goBack() {
  if (window.history.state?.back) router.back()
  else router.push('/basement')
}
const data = ref<Panel | null>(null)
const error = ref('')
const sub = ref<'' | 'inbox' | 'review' | 'cards'>('')

const pageEl = ref<HTMLElement | null>(null)
const scrollEl = ref<HTMLElement | null>(null)
const headEl = ref<HTMLElement | null>(null)
const water = ref(false)
const headH = ref(headLayout(0).height)
let pond: Pond | null = null

const headData = computed<HeadData | null>(() => {
  const d = data.value
  if (!d) return null
  const today = d.health.find(h => h.label === '今天')?.value
  return {
    quotes: d.head.quotes, cards: d.head.cards, relations: d.head.relations,
    week: today ? `今天 ${today}` : undefined,
  }
})

function safeTop(): number {
  const el = headEl.value
  if (!el) return 0
  return parseFloat(getComputedStyle(el).getPropertyValue('padding-top')) || 0
}

function paint(ctx: CanvasRenderingContext2D, w: number, h: number, t = 0) {
  paintHead(ctx, w, h, headData.value, { layout: headLayout(safeTop()), cn: cnFamily(), t, bg: bgImg })
}

async function startWater() {
  if (pond || !pondSupported()) return
  await nextTick()
  const host = headEl.value, scroller = scrollEl.value, page = pageEl.value
  if (!host || !scroller) return
  headH.value = headLayout(safeTop()).height
  pond = new Pond({
    host, touch: scroller, paint, mode: 'refract',
    onLost: () => { water.value = false; pond?.destroy(); pond = null },
  })
  water.value = true
  // 整页那一层：只画波，压在内容上面但不挡点击（她要的「水面改成全局的」）
  if (page) startGlobalPond(page)
  try {
    await Promise.all(headFontSpecs(cnFamily()).map(f => document.fonts.load(f).catch(() => [])))
    await document.fonts.ready
  } catch { /* 字体加载不了就用系统字，不影响水面 */ }
  pond?.repaint()
  // 水下那张画面自己活起来：光束闪动（她要的「海底光束的动态感」）
  pond?.animatePaint()
}

onMounted(async () => {
  await loadBg()          // 先知道有没有底图，再起水面（头部那张画面要用它）
  void startWater()
  try {
    const r = await fetch('/api/eclipsis/memory/panel', { cache: 'no-store' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    data.value = await r.json()
  } catch (e: any) { error.value = e.message || String(e) }
})

watch(headData, () => pond?.repaint())
onBeforeUnmount(() => { pond?.destroy(); pond = null; stopGlobalPond() })

const maxDaily = computed(() => Math.max(1, ...(data.value?.daily ?? []).map(d => d.n)))
const todayNone = computed(() => (data.value?.daily.at(-1)?.n ?? 0) === 0)

/** 抽屉编号用罗马数字（参考图里那种 No. VII / Pl. VI 的标号感） */
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']
function roman(n: number): string { return ROMAN[n] || String(n) }

function open(c: Cell) {
  if (!c.to) return
  if (c.to === 'galaxy') router.push('/galaxy')
  else if (c.to === 'find') router.push('/galaxy?find=1')
  else sub.value = c.to as any
}
const subTitle = computed(() => sub.value === 'inbox' ? '沉淀信箱' : sub.value === 'review' ? '等你看一眼' : '记忆卡')
</script>

<template>
  <div class="mem-page shell-page" ref="pageEl">
    <!-- 水下：光从上面射进来，会动（水面亮边 / 四道光柱 / 焦散 / 浮尘） -->
    <Underwater :src="bg" depth="shallow" />
    <!-- 整页四角：洛可可涡卷角花（不是直角刻线——那是新古典，方向正好相反） -->
    <div class="edge">
      <Roc name="corner" class="cnr tl" /><Roc name="corner" class="cnr tr" />
      <Roc name="corner" class="cnr bl" /><Roc name="corner" class="cnr br" />
    </div>

    <div class="scroll" ref="scrollEl">
      <header class="head" ref="headEl" :class="{ water }" :style="water ? { height: headH + 'px' } : undefined">
        <button class="back press" @click="goBack()" aria-label="返回">‹</button>
        <p v-if="water" class="sr-only">{{ headText(headData) }}</p>
        <!-- 水面跑不起来：同样内容的 DOM 题头（铜牌 + 日蚀 + 四角花饰） -->
        <div v-else class="plate">
          <Roc name="corner" class="cnr tl" /><Roc name="corner" class="cnr tr" />
          <p class="eyebrow">E C L I P S I S &nbsp;·&nbsp; 未</p>
          <Roc name="crown" />
          <h1>Remember</h1>
          <p class="zh">记 忆 的 柜 子</p>
          <template v-if="data">
            <p class="big">{{ data.head.quotes.toLocaleString() }}</p>
            <p class="sub">句原话，写成 {{ data.head.cards }} 张卡，串起 {{ data.head.relations }} 条关系</p>
          </template>
        </div>
      </header>

      <template v-if="data">
        <!-- 最近 30 天每天记了几张 -->
        <div class="spark drawer-face">
          <div class="spark-head">
            <span>{{ todayNone ? '今天还没有' : '今天记了 ' + data.daily.at(-1)!.n + ' 张' }}</span>
            <span class="muted">最多一天 {{ maxDaily }}</span>
          </div>
          <div class="bars">
            <i v-for="d in data.daily" :key="d.day" :style="{ height: Math.round((d.n / maxDaily) * 100) + '%' }" :title="`${d.day} ${d.n} 张`"></i>
          </div>
          <div class="spark-foot muted"><span>{{ data.daily[0]!.day.slice(5).replace('-', ' 月 ') }} 日</span><span>今天</span></div>
        </div>

        <!-- 分区题：刻线 + 书名号 -->
        <section v-for="s in data.sections" :key="s.title">
          <div class="sec">
            <Roc name="shell" class="shell" /><b>{{ s.title }}</b>
            <Roc name="curl" class="curl" /><em>{{ s.en }}</em><hr>
          </div>
          <!-- 器物抽屉：一行一件（她：不是等大方格） -->
          <div class="drawers">
            <button v-for="(c, i) in s.cells" :key="c.key" class="drawer drawer-face"
                    :class="{ empty: c.todo, tappable: !!c.to }" @click="open(c)">
              <span class="edge-l"></span>
              <span class="idx">{{ roman(i + 1) }}</span>
              <span class="obj"><Roc name="bracket" class="bracket" /><Orn :name="OBJ[c.key] || 'cards'" /></span>
              <span class="txt">
                <b>{{ c.name }}</b>
                <span class="cen">{{ c.en }}</span>
                <u v-if="c.note">{{ c.note }}</u>
              </span>
              <span v-if="c.todo" class="seal"><Roc name="seal" /><b>未</b></span>
              <span class="val"><em>{{ c.n.toLocaleString() }}</em><i v-if="c.unit">{{ c.unit }}</i></span>
              <span class="pull"><s></s><s></s></span>
            </button>
          </div>
        </section>

        <!-- 在运转吗：不占格子 -->
        <section>
          <div class="sec"><Roc name="shell" class="shell" /><b>在 运 转 吗</b><Roc name="curl" class="curl" /><em>Pulse of it</em><hr></div>
          <ul class="health drawer-face">
            <li v-for="h in data.health" :key="h.label">
              <i :class="{ bad: !h.ok }"></i><b>{{ h.label }}</b><span>{{ h.value }}</span>
            </li>
          </ul>
        </section>

        <div class="tailpiece"><Roc name="tail" /></div>
        <p class="foot muted">心潮和脉的柜子还没做。记忆只有他能写，你能划掉、能贴便条——这里没有替他改写的按钮。</p>
      </template>

      <p v-else-if="error" class="err">{{ error }}</p>
      <p v-else-if="!water" class="muted load">正在数…</p>
    </div>

    <Teleport to="#shell-overlay">
      <div v-if="sub" class="sheet" @click.self="sub = ''">
        <div class="sheet-card">
          <div class="sheet-head"><b>{{ subTitle }}</b><button class="x" @click="sub = ''">×</button></div>
          <div class="sheet-body">
            <MemoryPanel :initial-tab="sub === 'cards' ? 'all' : sub" />
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* 地下室是另一个世界（她定的）：上面的家是浅色液态玻璃，这里是水面之下。
   三个柜子共用这套骨架和这组变量，皮肤各做——记忆是档案 / 标本，心潮是波形和情绪的月相，脉是生命监护仪。 */
.mem-page {
  --moon: #e9eef6;
  --moon-2: rgba(233, 238, 246, 0.64);
  --moon-3: rgba(233, 238, 246, 0.36);
  --mist: #9db4dd;
  --hair: rgba(233, 238, 246, 0.17);
  --hair-2: rgba(233, 238, 246, 0.09);
  --iris-a: rgba(176, 202, 255, 0.55);
  --iris-b: rgba(255, 206, 230, 0.45);
  position: absolute; inset: 0; overflow: hidden; color: var(--moon);
}

/* 整页四角：洛可可涡卷角花 */
.edge { position: absolute; inset: 6px; z-index: 3; pointer-events: none; }
.cnr { position: absolute; width: 46px; height: 46px; color: rgba(197, 214, 245, 0.42); }
.cnr.tl { left: 0; top: 0; }
.cnr.tr { right: 0; top: 0; transform: scaleX(-1); }
.cnr.bl { left: 0; bottom: 0; transform: scaleY(-1); }
.cnr.br { right: 0; bottom: 0; transform: scale(-1); }

.scroll {
  position: relative; z-index: 2; height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding: 0 16px 28px;
  font-family: var(--app-font, "Noto Serif SC", "Songti SC", serif);
}

.head { position: relative; margin: 0 -16px 16px; padding: calc(env(safe-area-inset-top, 0px) + 46px) 16px 0; }
/* 水面那一版自己排版面（memory-head.ts），这里只留刘海那一条 */
.head.water { padding: env(safe-area-inset-top, 0px) 16px 0; overflow: hidden; }
.back {
  position: absolute; left: 10px; top: calc(env(safe-area-inset-top, 0px) + 10px);
  width: 34px; height: 34px; border-radius: 17px; z-index: 4;
  border: 1px solid rgba(186, 208, 240, 0.22); background: rgba(16, 30, 52, 0.4);
  color: var(--moon-2); font-size: 22px; line-height: 28px; backdrop-filter: blur(6px);
}
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* 题头铜牌（只在水面跑不起来时出现） */
.plate {
  position: relative; margin: 10px 2px 0; padding: 16px 16px 14px; text-align: center;
  border: 1px solid var(--hair);
  background: linear-gradient(180deg, rgba(233, 238, 246, 0.075), rgba(233, 238, 246, 0.02));
  backdrop-filter: blur(9px) saturate(150%);
}
.plate::before { content: ""; position: absolute; inset: 4px; border: 1px solid var(--hair-2); pointer-events: none; }
.plate::after {
  content: ""; position: absolute; left: 10%; right: 10%; top: -1px; height: 1px;
  background: linear-gradient(90deg, transparent, var(--iris-a) 35%, var(--iris-b) 65%, transparent);
}
.plate .cnr { width: 34px; height: 34px; color: var(--mist); opacity: 0.6; }
.eyebrow { margin: 0 0 8px; font-size: 8px; letter-spacing: 4.8px; color: var(--moon-3); }
h1 { font-family: "Pinyon Script", cursive; font-weight: 400; font-size: 36px; line-height: 1; margin: 6px 0 0; color: #f3f6fb; text-shadow: 0 0 20px rgba(176, 202, 255, 0.3); }
.zh { margin: 7px 0 0; font-size: 11px; letter-spacing: 6.5px; color: var(--moon-2); }
.big { margin: 14px 0 0; font-family: "Cormorant Garamond", serif; font-size: 42px; line-height: 1; color: #f3f6fb; text-shadow: 0 0 18px rgba(176, 202, 255, 0.32); }
.sub { margin: 4px 0 0; font-size: 12px; color: var(--moon-2); }

/* 抽屉面：刻线玻璃 + 顶沿虹彩 + 二重内框 + 极细斜纹底（繁复的密度靠层数，不靠加重颜色） */
.drawer-face {
  position: relative; border: 1px solid var(--hair); overflow: hidden; isolation: isolate;
  background:
    repeating-linear-gradient(118deg, rgba(233, 238, 246, 0.028) 0 1px, transparent 1px 7px),
    linear-gradient(180deg, rgba(233, 238, 246, 0.095), rgba(233, 238, 246, 0.026));
  backdrop-filter: blur(11px) saturate(160%);
  box-shadow:
    inset 0 1px 0 rgba(233, 238, 246, 0.16),
    inset 0 -1px 0 rgba(8, 18, 34, 0.3),
    0 10px 26px -20px #000;
}
/* 二重内框：外细内虚 */
.drawer-face::after {
  content: ""; position: absolute; inset: 3px; pointer-events: none;
  border: 1px solid var(--hair-2);
  box-shadow: inset 0 0 0 2.5px rgba(8, 18, 34, 0.12), inset 0 0 0 3.5px rgba(233, 238, 246, 0.05);
}
/* 顶沿一道虹彩：我们玻璃那道色散 */
.drawer-face::before {
  content: ""; position: absolute; left: 8%; right: 8%; top: 0; height: 1px; pointer-events: none;
  background: linear-gradient(90deg, transparent, var(--iris-a) 32%, var(--iris-b) 68%, transparent);
}

.spark { padding: 11px 13px; margin-bottom: 18px; }
.spark-head { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--moon-2); }
.bars { display: flex; align-items: flex-end; gap: 2px; height: 44px; margin: 8px 0 4px; }
.bars i { flex: 1; min-height: 2px; border-radius: 1px; background: linear-gradient(180deg, rgba(198, 222, 255, 0.72), rgba(157, 180, 221, 0.4)); }
.spark-foot { display: flex; justify-content: space-between; font-size: 11px; }

/* 分区题 */
.sec { display: flex; align-items: center; gap: 8px; margin: 20px 2px 9px; }
.sec b { font-size: 12px; font-weight: 600; letter-spacing: 3.4px; white-space: nowrap; color: #eaf0f8; }
.sec em { font-style: normal; font-size: 8px; letter-spacing: 2.4px; color: var(--moon-3); white-space: nowrap; }
.sec .shell { width: 22px; height: 17px; flex: none; color: var(--mist); opacity: 0.8; }
.sec .curl { width: 28px; height: 13px; flex: none; color: var(--mist); opacity: 0.6; }
.sec hr { flex: 1; border: none; border-top: 1px solid var(--hair); border-bottom: 1px solid var(--hair-2); height: 3px; margin: 0; }

/* 器物抽屉：一行一件 */
.drawers { display: flex; flex-direction: column; gap: 8px; }
.drawer {
  display: flex; align-items: center; gap: 10px; padding: 11px 12px; width: 100%;
  text-align: left; font-family: inherit; color: inherit;
  transition: transform 0.22s cubic-bezier(.34, 1.56, .64, 1), background 0.22s;
}
/* 抽屉左沿一道竖虹彩（横的那道在 .drawer-face::before） */
.drawer .edge-l {
  position: absolute; left: 0; top: 0; bottom: 0; width: 1px;
  background: linear-gradient(180deg, transparent, var(--iris-a) 45%, var(--iris-b) 70%, transparent);
}
.drawer.tappable:active { transform: scale(0.985); background: linear-gradient(180deg, rgba(233, 238, 246, 0.12), rgba(233, 238, 246, 0.04)); }
/* 器物坐在涡卷托架里（洛可可：曲线托着物件，不是方框圈着） */
.obj {
  position: relative; width: 40px; height: 40px; flex: none; display: grid; place-items: center;
  color: #d2e2ff;
  background: radial-gradient(70% 70% at 40% 28%, rgba(157, 180, 221, 0.22), transparent 74%);
}
.obj .bracket { position: absolute; inset: 0; width: 40px; height: 40px; color: rgba(197, 214, 245, 0.5); }
.obj :deep(svg.orn) { width: 20px; height: 20px; }
/* 小字标号：压在抽屉左上角 */
.idx {
  position: absolute; left: 7px; top: 5px; font-family: "Cormorant Garamond", serif;
  font-size: 8.5px; letter-spacing: 1.6px; color: rgba(197, 214, 245, 0.42);
}
.txt { flex: 1; min-width: 0; padding-left: 2px; }
.txt b { display: block; font-size: 13.5px; font-weight: 600; letter-spacing: 0.6px; }
.txt .cen { display: block; font-size: 8px; letter-spacing: 2.3px; color: var(--moon-3); margin-top: 2px; }
.txt u { display: block; text-decoration: none; font-size: 10.5px; color: var(--moon-2); margin-top: 4px; line-height: 1.55; }
.val { text-align: right; padding-left: 4px; }
.val em { font-style: normal; font-family: "Cormorant Garamond", serif; font-size: 20px; color: #f1f5fb; }
.val i { font-style: normal; font-size: 9.5px; color: var(--moon-3); margin-left: 2px; }
.pull { width: 11px; margin-left: 7px; display: flex; flex-direction: column; gap: 3px; opacity: 0.45; }
.pull s { display: block; height: 1px; background: var(--moon); text-decoration: none; }
.pull s:nth-child(2) { width: 7px; }

/* 空抽屉：盖一枚「未」字火漆印（Ellipsis 那个「未」） */
.drawer.empty { background: linear-gradient(180deg, rgba(233, 238, 246, 0.03), rgba(233, 238, 246, 0.012)); border-style: dashed; }
.drawer.empty .obj { border-style: dashed; opacity: 0.5; }
.drawer.empty .txt b { color: var(--moon-2); }
.drawer.empty .val em { color: var(--moon-3); font-size: 17px; }
/* 空抽屉盖一枚「未」字火漆印，外圈是扇贝边（rocaille 本义就是贝壳饰） */
.seal {
  position: absolute; right: 42px; top: 50%; transform: translateY(-50%) rotate(-11deg);
  width: 34px; height: 34px; display: grid; place-items: center;
  color: rgba(197, 214, 245, 0.72); opacity: 0.9;
}
.seal :deep(svg) { position: absolute; inset: 0; width: 34px; height: 34px; }
.seal b { font-weight: 400; font-size: 14px; }

.health { list-style: none; margin: 0; padding: 4px 13px; }
.health li { display: flex; align-items: center; gap: 8px; padding: 9px 0; border-bottom: 1px solid var(--hair-2); font-size: 12.5px; }
.health li:last-child { border-bottom: none; }
.health i { width: 6px; height: 6px; border-radius: 3px; background: #8fb8d8; flex: none; }
.health i.bad { background: #d79a5c; }
.health b { font-weight: 600; color: var(--moon-2); min-width: 68px; }
.health span { color: var(--moon-3); }

.tailpiece { display: flex; justify-content: center; margin: 22px 0 6px; color: var(--mist); opacity: 0.6; }
.tailpiece :deep(svg) { width: 200px; height: auto; }
.muted { color: var(--moon-3); font-size: 12px; }
.foot { margin: 10px 0 0; line-height: 1.7; }
.load { text-align: center; padding: 40px 0; }
.err { color: #e59a86; font-size: 13px; }

/* 信箱那张纸还是浅色（复用设置里的 MemoryPanel，它吃全局 --text 系列，
   而且 Teleport 到 #shell-overlay 之后拿不到这里的变量）：从水底升起来的一张纸。 */
.sheet { position: absolute; inset: 0; display: flex; align-items: flex-end; background: rgba(4, 10, 22, 0.5); }
.sheet-card {
  width: 100%; max-height: 86%; display: flex; flex-direction: column;
  background: #f6f3ea; border-radius: 20px 20px 0 0; border-top: 1px solid rgba(77, 83, 60, 0.12);
}
.sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 6px; font-family: var(--app-font, "Noto Serif SC", serif); }
.sheet-head b { font-size: 15px; color: #3a4130; }
.x { border: none; background: none; font-size: 24px; color: rgba(60, 67, 48, 0.45); }
.sheet-body { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 0 14px calc(16px + env(safe-area-inset-bottom, 0px)); }
</style>
