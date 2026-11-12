<script setup lang="ts">
// 地下室第一个柜子：记忆。
//
// 分区按「谁写的」：聊天里来的 / 他自己写的 / 他认得的 / 收着的。
// 机制状态不占格子，压成底下一条细线（她说我上一版列得散，就是因为我把开发时的说法摆成了格子）。
// 空的格子照样摆，写明「还没做」——0 本身是信息。
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import MemoryPanel from '../components/MemoryPanel.vue'

interface Cell { key: string; name: string; en: string; n: number; unit?: string; note?: string; todo?: boolean; to?: string }
interface Section { title: string; en: string; cells: Cell[] }
interface Panel {
  head: { quotes: number; cards: number; relations: number; sentence: string }
  daily: { day: string; n: number }[]
  sections: Section[]
  health: { label: string; value: string; ok: boolean }[]
}

const router = useRouter()
const data = ref<Panel | null>(null)
const error = ref('')
const sub = ref<'' | 'inbox' | 'review' | 'cards'>('')

onMounted(async () => {
  try {
    const r = await fetch('/api/eclipsis/memory/panel', { cache: 'no-store' })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    data.value = await r.json()
  } catch (e: any) { error.value = e.message || String(e) }
})

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

    <div class="scroll">
      <header class="head">
        <button class="back press" @click="router.push('/basement')" aria-label="回地下室">‹</button>
        <h1>记忆</h1>
        <p class="en">Remember</p>
      </header>

      <template v-if="data">
        <p class="big">{{ data.head.quotes.toLocaleString() }}</p>
        <p class="sub">句原话，写成 {{ data.head.cards }} 张卡，串起 {{ data.head.relations }} 条关系</p>

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
      <p v-else class="muted load">正在数…</p>
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
/* 奶油纸 + 深空：档案馆的感觉（脉那个柜子会是另一套皮肤——生命监护仪） */
.mem-page { position: absolute; inset: 0; overflow: hidden; color: #2f3326; }
.paper {
  position: absolute; inset: 0;
  background:
    radial-gradient(120% 80% at 50% -10%, rgba(255, 252, 242, 0.96), rgba(244, 240, 228, 0.92) 55%, rgba(233, 228, 213, 0.95)),
    #f3efe4;
}
.scroll {
  position: relative; height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding: calc(env(safe-area-inset-top, 0px) + 46px) 18px 28px;
  font-family: "Noto Serif SC", "Songti SC", serif;
}
.head { position: relative; margin-bottom: 18px; }
.back {
  position: absolute; left: -6px; top: -4px; width: 34px; height: 34px; border-radius: 17px;
  border: 1px solid rgba(77, 83, 60, 0.18); background: rgba(255, 255, 255, 0.5); color: #4d533c; font-size: 22px; line-height: 28px;
}
h1 { margin: 0 0 2px 40px; font-size: 26px; font-weight: 600; letter-spacing: 2px; color: #3c4330; }
.head .en { margin: 0 0 0 40px; font-size: 12px; letter-spacing: 3px; color: rgba(77, 83, 60, 0.5); font-style: italic; }
.big { margin: 6px 0 0; font-size: 46px; line-height: 1.1; font-weight: 600; letter-spacing: -1px; color: #333a28; }
.sub { margin: 2px 0 16px; font-size: 13px; color: rgba(60, 67, 48, 0.62); }
.card {
  background: rgba(255, 255, 255, 0.62); border: 1px solid rgba(77, 83, 60, 0.1);
  border-radius: 16px; box-shadow: 0 1px 2px rgba(80, 76, 58, 0.04), 0 8px 24px -16px rgba(80, 76, 58, 0.25);
}
.spark { padding: 12px 14px; margin-bottom: 20px; }
.spark-head { display: flex; justify-content: space-between; font-size: 12.5px; color: rgba(60, 67, 48, 0.8); }
.bars { display: flex; align-items: flex-end; gap: 2px; height: 46px; margin: 8px 0 4px; }
.bars i { flex: 1; min-height: 2px; border-radius: 1px; background: rgba(123, 128, 99, 0.55); }
.spark-foot { display: flex; justify-content: space-between; font-size: 11px; }
h2 { font-size: 13px; font-weight: 600; letter-spacing: 1px; color: rgba(60, 67, 48, 0.78); margin: 0 0 8px; }
h2 .en { margin-left: 8px; font-size: 11px; font-style: italic; letter-spacing: 1.5px; color: rgba(77, 83, 60, 0.4); }
section { margin-bottom: 20px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.cell {
  position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  padding: 12px 13px 13px; text-align: left; font-family: inherit; color: inherit;
}
.cell:first-child { grid-column: 1 / -1; }
.cn { font-size: 14px; font-weight: 600; color: #3a4130; }
.cen { font-size: 10.5px; font-style: italic; letter-spacing: 1.2px; color: rgba(77, 83, 60, 0.42); }
.num { font-size: 27px; font-weight: 600; line-height: 1.25; color: #333a28; }
.num i { font-size: 13px; font-weight: 400; margin-left: 2px; font-style: normal; color: rgba(60, 67, 48, 0.6); }
.note { font-size: 11.5px; line-height: 1.5; color: rgba(60, 67, 48, 0.55); }
.cell.todo { background: rgba(255, 255, 255, 0.34); border-style: dashed; }
.cell.todo .num, .cell.todo .cn { color: rgba(60, 67, 48, 0.42); }
.cell.tappable:active { background: rgba(255, 255, 255, 0.85); }
.go { position: absolute; right: 11px; top: 11px; font-size: 17px; color: rgba(77, 83, 60, 0.35); }
.health { list-style: none; margin: 0; padding: 4px 14px; }
.health li { display: flex; align-items: center; gap: 8px; padding: 9px 0; border-bottom: 1px solid rgba(77, 83, 60, 0.08); font-size: 12.5px; }
.health li:last-child { border-bottom: none; }
.health i { width: 6px; height: 6px; border-radius: 3px; background: #7f9a6e; flex: none; }
.health i.bad { background: #c9823f; }
.health b { font-weight: 600; color: rgba(60, 67, 48, 0.85); min-width: 68px; }
.health span { color: rgba(60, 67, 48, 0.62); }
.muted { color: rgba(60, 67, 48, 0.55); font-size: 12px; }
.foot { margin: 18px 0 0; line-height: 1.7; }
.load { text-align: center; padding: 40px 0; }
.err { color: #a4452f; font-size: 13px; }

.sheet { position: absolute; inset: 0; display: flex; align-items: flex-end; background: rgba(40, 38, 30, 0.22); }
.sheet-card {
  width: 100%; max-height: 86%; display: flex; flex-direction: column;
  background: #f6f3ea; border-radius: 20px 20px 0 0; border-top: 1px solid rgba(77, 83, 60, 0.12);
}
.sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 6px; font-family: "Noto Serif SC", serif; }
.sheet-head b { font-size: 15px; color: #3a4130; }
.x { border: none; background: none; font-size: 24px; color: rgba(60, 67, 48, 0.45); }
.sheet-body { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 0 14px calc(16px + env(safe-area-inset-bottom, 0px)); }
</style>
