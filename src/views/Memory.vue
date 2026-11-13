<script setup lang="ts">
// 地下室第一个柜子：记忆。
//
// 分区按「谁写的」：聊天里来的 / 他自己写的 / 他认得的 / 收着的。
// 机制状态不占格子，压成底下一条细线（她说我上一版列得散，就是因为我把开发时的说法摆成了格子）。
// 空的格子照样摆，写明「还没做」——0 本身是信息。
//
// 2026-11-13 她看完样式稿说水面「应该可以了」，所以**头部泡在水里**：
// 标题、大数字和那句话画进 canvas 交给 src/liquid/pond.ts 折射（她要的「连字都跟着晃」），
// 底下的格子还是 DOM —— 要能点、能滚、要跟着她在设置里换的字体。
// 跑不起来（没 WebGL2 / 没半浮点 / 上下文丢了）就显示同样内容的 DOM 头部。
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import MemoryPanel from '../components/MemoryPanel.vue'
import { Pond, pondSupported } from '../liquid/pond'
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

const router = useRouter()
/** 回上一页；直接打开这个地址（没有上一页）时回 /basement */
function goBack() {
  if (window.history.state?.back) router.back()
  else router.push('/basement')
}
const data = ref<Panel | null>(null)
const error = ref('')
const sub = ref<'' | 'inbox' | 'review' | 'cards'>('')

const scrollEl = ref<HTMLElement | null>(null)
const headEl = ref<HTMLElement | null>(null)
/** 水面在跑吗；false = 用 DOM 头部（内容一样，只是不晃） */
const water = ref(false)
const headH = ref(headLayout(0).height)
let pond: Pond | null = null

const headData = computed<HeadData | null>(() => data.value
  ? { quotes: data.value.head.quotes, cards: data.value.head.cards, relations: data.value.head.relations }
  : null)

function safeTop(): number {
  const el = headEl.value
  if (!el) return 0
  const v = getComputedStyle(el).getPropertyValue('padding-top').trim()
  return parseFloat(v) || 0
}

function paint(ctx: CanvasRenderingContext2D, w: number, h: number) {
  paintHead(ctx, w, h, headData.value, { layout: headLayout(safeTop()), cn: cnFamily() })
}

async function startWater() {
  if (pond || !pondSupported()) return
  await nextTick()
  const host = headEl.value, scroller = scrollEl.value
  if (!host || !scroller) return
  headH.value = headLayout(safeTop()).height
  pond = new Pond({
    host,
    touch: scroller,         // 听滚动区，免得水面抢走她的滑动
    paint,
    onLost: () => { water.value = false; pond?.destroy(); pond = null },
  })
  water.value = true
  // 字体加载完再画一次，不然第一帧是系统字（画布上的字画完就定住了）
  try {
    const cn = cnFamily()
    await Promise.all(headFontSpecs(cn).map(s => document.fonts.load(s).catch(() => [])))
    await document.fonts.ready
  } catch { /* 字体加载不了就用系统字，不影响水面 */ }
  pond?.repaint()
}

onMounted(async () => {
  void startWater()
  try {
    const r = await fetch('/api/eclipsis/memory/panel', { cache: 'no-store' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    data.value = await r.json()
  } catch (e: any) { error.value = e.message || String(e) }
})

// 取到数、她换了字体 → 重画水下那张画面
watch(headData, () => pond?.repaint())

onBeforeUnmount(() => { pond?.destroy(); pond = null })

const maxDaily = computed(() => Math.max(1, ...(data.value?.daily ?? []).map(d => d.n)))
const todayNone = computed(() => (data.value?.daily.at(-1)?.n ?? 0) === 0)

function open(c: Cell) {
  if (!c.to) return
  if (c.to === 'galaxy') router.push('/galaxy')
  else if (c.to === 'find') router.push('/galaxy?find=1')
  else sub.value = c.to as any
}
const subTitle = computed(() => sub.value === 'inbox' ? '沉淀信箱' : sub.value === 'review' ? '等你看一眼' : '记忆卡')
</script>

<template>
  <div class="mem-page shell-page">
    <div class="paper" data-glass-backdrop></div>

    <div class="scroll" ref="scrollEl">
      <!-- 头部：水面在跑时这一块是画布（水面画布由 Pond 插在最前面） -->
      <header class="head" ref="headEl" :class="{ water }" :style="water ? { height: headH + 'px' } : undefined">
        <button class="back press" @click="goBack()" aria-label="返回">‹</button>
        <!-- 画布里的字读屏软件看不见，给它一份一样的 -->
        <p v-if="water" class="sr-only">{{ headText(headData) }}</p>
        <template v-else>
          <h1>记忆</h1>
          <p class="en">Remember</p>
          <template v-if="data">
            <p class="big">{{ data.head.quotes.toLocaleString() }}</p>
            <p class="sub">句原话，写成 {{ data.head.cards }} 张卡，串起 {{ data.head.relations }} 条关系</p>
          </template>
        </template>
      </header>

      <template v-if="data">
        <!-- 最近 30 天每天记了几张 -->
        <div class="spark card">
          <div class="spark-head">
            <span>{{ todayNone ? '今天还没有' : '今天记了 ' + data.daily.at(-1)!.n + ' 张' }}</span>
            <span class="muted">最多一天 {{ maxDaily }}</span>
          </div>
          <div class="bars">
            <i v-for="d in data.daily" :key="d.day" :style="{ height: Math.round((d.n / maxDaily) * 100) + '%' }" :title="`${d.day} ${d.n} 张`"></i>
          </div>
          <div class="spark-foot muted"><span>{{ data.daily[0]!.day.slice(5).replace('-', ' 月 ') }} 日</span><span>今天</span></div>
        </div>

        <section v-for="s in data.sections" :key="s.title">
          <h2>{{ s.title }}<span class="en">{{ s.en }}</span></h2>
          <div class="grid">
            <button v-for="c in s.cells" :key="c.key" class="card cell" :class="{ todo: c.todo, tappable: !!c.to }" @click="open(c)">
              <span class="cn">{{ c.name }}</span>
              <span class="cen">{{ c.en }}</span>
              <span class="num">{{ c.n.toLocaleString() }}<i v-if="c.unit">{{ c.unit }}</i></span>
              <span v-if="c.note" class="note">{{ c.note }}</span>
              <span v-if="c.to" class="go">›</span>
            </button>
          </div>
        </section>

        <!-- 在运转吗：不占格子 -->
        <section>
          <h2>在运转吗<span class="en">Pulse of it</span></h2>
          <ul class="health card">
            <li v-for="h in data.health" :key="h.label">
              <i :class="{ bad: !h.ok }"></i><b>{{ h.label }}</b><span>{{ h.value }}</span>
            </li>
          </ul>
        </section>

        <p class="foot muted">心潮和脉的柜子还没做。记忆只有他能写，你能划掉、能贴便条——这里没有替他改写的按钮。</p>
      </template>

      <p v-else-if="error" class="err">{{ error }}</p>
      <p v-else-if="!water" class="muted load">正在数…</p>
    </div>

    <!-- 信箱 / 等你看一眼 / 全部卡片：复用设置里那套 -->
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
/* 地下室是另一个世界（她定的）：上面的家是浅色液态玻璃，这里是阴雨天 / 深海海底。
   三个柜子共用这套暗底，皮肤各做——记忆是档案 / 标本，心潮是波形和情绪的月相，脉是生命监护仪。
   要回到原来那版奶油纸，只改下面这一组变量就行。 */
.mem-page {
  --ink: rgba(234, 240, 248, 0.92);
  --ink-2: rgba(226, 234, 246, 0.72);
  --ink-3: rgba(216, 226, 242, 0.5);
  --ink-4: rgba(206, 218, 238, 0.34);
  --edge: rgba(150, 178, 220, 0.16);
  --card-bg: rgba(146, 176, 220, 0.07);
  position: absolute; inset: 0; overflow: hidden; color: var(--ink);
}
.paper {
  position: absolute; inset: 0;
  background:
    radial-gradient(120% 80% at 28% -10%, rgba(140, 174, 232, 0.26), rgba(140, 174, 232, 0) 62%),
    radial-gradient(90% 60% at 95% 4%, rgba(104, 134, 196, 0.18), rgba(104, 134, 196, 0) 60%),
    linear-gradient(160deg, #101a2e, #0a1120 52%, #070b14);
}
.scroll {
  position: relative; height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding: 0 18px 28px;
  font-family: var(--app-font, "Noto Serif SC", "Songti SC", serif);
}
/* 头部自己带安全区留白：水面要盖住这一整块（包括刘海那一条） */
.head {
  position: relative; margin: 0 -18px 18px; padding: calc(env(safe-area-inset-top, 0px) + 46px) 18px 0;
}
/* 水面那一版自己排版面（memory-head.ts），所以这里只留刘海那一条，不要那 46px */
.head.water { padding: env(safe-area-inset-top, 0px) 18px 0; overflow: hidden; }
/* 水面画布由 Pond 插在 .head 最前面，字压在它上面；这里只管返回键 */
.back {
  position: absolute; left: 12px; top: calc(env(safe-area-inset-top, 0px) + 10px);
  width: 34px; height: 34px; border-radius: 17px; z-index: 2;
  border: 1px solid rgba(186, 208, 240, 0.22); background: rgba(16, 26, 46, 0.42);
  color: var(--ink-2); font-size: 22px; line-height: 28px; backdrop-filter: blur(6px);
}
.sr-only {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
h1 { margin: 0 0 2px 40px; font-size: 26px; font-weight: 600; letter-spacing: 2px; color: var(--ink); }
.head .en { margin: 0 0 0 40px; font-size: 12px; letter-spacing: 3px; color: var(--ink-3); font-style: italic; }
.big { margin: 6px 0 0; font-size: 46px; line-height: 1.1; font-weight: 600; letter-spacing: -1px; color: #f2f6fd; }
.sub { margin: 2px 0 16px; font-size: 13px; color: var(--ink-2); }
.card {
  background: var(--card-bg); border: 1px solid var(--edge);
  border-radius: 16px; box-shadow: 0 1px 2px rgba(4, 8, 18, 0.3), 0 10px 26px -18px rgba(2, 6, 14, 0.8);
}
.spark { padding: 12px 14px; margin-bottom: 20px; }
.spark-head { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--ink-2); }
.bars { display: flex; align-items: flex-end; gap: 2px; height: 46px; margin: 8px 0 4px; }
.bars i { flex: 1; min-height: 2px; border-radius: 1px; background: rgba(164, 194, 238, 0.42); }
.spark-foot { display: flex; justify-content: space-between; font-size: 11px; }
h2 { font-size: 13px; font-weight: 600; letter-spacing: 1px; color: var(--ink-2); margin: 0 0 8px; }
h2 .en { margin-left: 8px; font-size: 11px; font-style: italic; letter-spacing: 1.5px; color: var(--ink-4); }
section { margin-bottom: 20px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.cell {
  position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  padding: 12px 13px 13px; text-align: left; font-family: inherit; color: inherit;
}
.cell:first-child { grid-column: 1 / -1; }
.cn { font-size: 14px; font-weight: 600; color: var(--ink); }
.cen { font-size: 10.5px; font-style: italic; letter-spacing: 1.2px; color: var(--ink-4); }
.num { font-size: 27px; font-weight: 600; line-height: 1.25; color: #f2f6fd; }
.num i { font-size: 13px; font-weight: 400; margin-left: 2px; font-style: normal; color: var(--ink-3); }
.note { font-size: 11.5px; line-height: 1.5; color: var(--ink-3); }
.cell.todo { background: rgba(146, 176, 220, 0.035); border-style: dashed; }
.cell.todo .num, .cell.todo .cn { color: var(--ink-4); }
.cell.tappable:active { background: rgba(150, 180, 226, 0.14); }
.go { position: absolute; right: 11px; top: 11px; font-size: 17px; color: var(--ink-4); }
.health { list-style: none; margin: 0; padding: 4px 14px; }
.health li { display: flex; align-items: center; gap: 8px; padding: 9px 0; border-bottom: 1px solid rgba(150, 178, 220, 0.1); font-size: 12.5px; }
.health li:last-child { border-bottom: none; }
.health i { width: 6px; height: 6px; border-radius: 3px; background: #7fa8c4; flex: none; }
.health i.bad { background: #d79a5c; }
.health b { font-weight: 600; color: var(--ink-2); min-width: 68px; }
.health span { color: var(--ink-3); }
.muted { color: var(--ink-3); font-size: 12px; }
.foot { margin: 18px 0 0; line-height: 1.7; }
.load { text-align: center; padding: 40px 0; }
.err { color: #e59a86; font-size: 13px; }

/* 信箱那张纸还是浅色（它复用设置里那套 MemoryPanel，吃的是全局 --text 系列；
   而且它 Teleport 到 #shell-overlay，这里的 --ink 不会传过去）：
   从深海里升起来的一张纸，不跟着变暗。 */
.sheet { position: absolute; inset: 0; display: flex; align-items: flex-end; background: rgba(4, 8, 18, 0.46); }
.sheet-card {
  width: 100%; max-height: 86%; display: flex; flex-direction: column;
  background: #f6f3ea; border-radius: 20px 20px 0 0; border-top: 1px solid rgba(77, 83, 60, 0.12);
}
.sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 6px; font-family: var(--app-font, "Noto Serif SC", serif); }
.sheet-head b { font-size: 15px; color: #3a4130; }
.x { border: none; background: none; font-size: 24px; color: rgba(60, 67, 48, 0.45); }
.sheet-body { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 0 14px calc(16px + env(safe-area-inset-bottom, 0px)); }
</style>
