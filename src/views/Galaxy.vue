<script setup lang="ts">
// 星空：3D 星系（星域图谱 Observatory-Ridge, MIT）+ 我们的时间树。
// 行星 = 他写的时间树的每一节，卫星 = 那段日子的记忆卡，小行星带 = 还没认出是谁的事的卡。
// 她在这里只能看、贴便条；时间树只有他能改（open_tree），页面上没有替他改字的按钮。
import { ref, computed, onMounted, onBeforeUnmount, shallowRef } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { loadGalaxy, loadGraph, loadTree, loadVersion, loadSource, loadDays, searchSource, searchQuotes, quoteAround, postNote,
  type GSnapshot, type GGraph, type GMemory, type TreePage, type TreeSection, type SourcePage,
  type DayCount, type SourceLine, type QuoteHit, type QuoteSearch } from '../galaxy/api'
import { mountRidge, hasWebGL2, type Mounted, type Pick, type View } from '../galaxy/bridge'

const router = useRouter()
/** 回上一页；直接打开这个地址（没有上一页）时回 /rooftop */
function goBack() {
  if (window.history.state?.back) router.back()
  else router.push('/rooftop')
}
const route = useRoute()
const stage = ref<HTMLElement | null>(null)
const snap = shallowRef<GSnapshot | null>(null)
const graph = shallowRef<GGraph | null>(null)
const tree = shallowRef<TreePage | null>(null)
const error = ref('')
const view = ref<View>(hasWebGL2() ? '3d' : '2d')
const pick = ref<Pick>(null)
let ridge: Mounted | null = null

function draw() { if (ridge && snap.value) ridge.render(view.value, snap.value, graph.value) }
async function setView(v: View) {
  if (v === 'galaxy' && !graph.value) { try { graph.value = await loadGraph() } catch (e: any) { error.value = e.message; return } }
  view.value = v
  pick.value = null
  resetQuotes()
  draw()
}

onMounted(async () => {
  if (route.query.find !== undefined) findOpen.value = true
  try {
    const [s, t] = await Promise.all([loadGalaxy(), loadTree()])
    snap.value = s
    tree.value = t
    if (stage.value) {
      ridge = mountRidge(stage.value, p => { pick.value = p; resetQuotes() })
      draw()
    }
  } catch (e: any) { error.value = e.message || String(e) }
})
onBeforeUnmount(() => { ridge?.unmount(); ridge = null })

// ── 选中了什么 ──
const allMemories = computed<GMemory[]>(() => snap.value ? [...snap.value.planets.flatMap(p => p.memories ?? []), ...snap.value.asteroids] : [])
const pickedPlanet = computed(() => pick.value?.kind === 'planet' ? snap.value?.planets.find(p => p.id === (pick.value as any).id) ?? null : null)
const pickedSection = computed<TreeSection | null>(() => pickedPlanet.value ? tree.value?.sections.find(s => s.planetId === pickedPlanet.value!.id) ?? null : null)
const pickedMemory = computed(() => pick.value?.kind === 'memory' ? allMemories.value.find(m => m.id === (pick.value as any).id) ?? null : null)
const sheetOpen = computed(() => !!pick.value && (pick.value.kind !== 'planet' || !!pickedPlanet.value))
function closeSheet() { pick.value = null; resetQuotes() }
const fmtRange = (s: TreeSection) => s.from === s.to ? s.from : `${s.from} ～ ${s.to}`

// ── 当时的原话 ──
// 一节常常覆盖好几天（第 12–14 窗那节有 1034 句），所以不一次倒出来：
// 先按天给数量，她点哪天看哪天；要找某句话就在这一段里搜（只给命中那几句 + 前后两句）。
type QMode = 'off' | 'days' | 'day' | 'search'
const qMode = ref<QMode>('off')
const qBusy = ref(false)
const days = ref<DayCount[]>([])
const daysTotal = ref(0)
const openDay = ref('')
const dayPage = ref<SourcePage | null>(null)
const dayLines = ref<string[]>([])
const hits = ref<SourceLine[]>([])
const hitInfo = ref({ total: 0, shown: 0, truncated: false })
const keyword = ref('')
const section = () => pickedSection.value!

function resetQuotes() {
  qMode.value = 'off'; days.value = []; daysTotal.value = 0; openDay.value = ''
  dayPage.value = null; dayLines.value = []; hits.value = []; keyword.value = ''
}

async function showDays() {
  const s = section()
  if (!s?.from || !s.to || qBusy.value) return
  qBusy.value = true
  try {
    const d = await loadDays(s.from, s.to)
    days.value = d.days
    daysTotal.value = d.total
    qMode.value = 'days'
    // 只有一天就直接展开
    if (d.days.length === 1) await showDay(d.days[0]!.day)
  } catch (e: any) { error.value = e.message } finally { qBusy.value = false }
}

async function showDay(day: string, more = false) {
  if (qBusy.value) return
  qBusy.value = true
  try {
    const page = await loadSource(day, day, more && dayPage.value?.next ? dayPage.value.next : 0)
    dayLines.value = more ? [...dayLines.value, ...page.lines] : page.lines
    dayPage.value = page
    openDay.value = day
    qMode.value = 'day'
  } catch (e: any) { error.value = e.message } finally { qBusy.value = false }
}

async function runSearch() {
  const s = section()
  const q = keyword.value.trim()
  if (!s?.from || !s.to || !q || qBusy.value) return
  qBusy.value = true
  try {
    const r = await searchSource(s.from, s.to, q)
    hits.value = r.lines
    hitInfo.value = { total: r.total, shown: r.shown, truncated: r.truncated }
    qMode.value = 'search'
  } catch (e: any) { error.value = e.message } finally { qBusy.value = false }
}

const lineWho = (l: string) => (/^\[[^\]]+\] 她：/.test(l) ? 'her' : 'him')
const fmtDay = (d: string) => d.slice(5).replace('-', ' 月 ') + ' 日'
const hhmm = (ts: string) => new Date(ts).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' })
/** 两句之间断开了就画一道分隔（搜出来的几段上下文之间） */
function gapBefore(i: number): boolean {
  if (i === 0) return false
  const a = hits.value[i - 1]!, b = hits.value[i]!
  return b.day !== a.day || Date.parse(b.ts) - Date.parse(a.ts) > 20 * 60_000
}

// ── 全库找一句原话（细目层）──
const findOpen = ref(false)
const findWord = ref('')
const findWho = ref<'' | 'her' | 'him'>('')
const findBusy = ref(false)
const found = ref<QuoteSearch | null>(null)
const foundHits = ref<QuoteHit[]>([])
const ctxOf = ref<Record<number, QuoteHit[]>>({})

async function runFind(more = false) {
  const q = findWord.value.trim()
  if (!q || findBusy.value) return
  findBusy.value = true
  try {
    const r = await searchQuotes(q, { who: findWho.value || undefined, offset: more && found.value?.next ? found.value.next : 0 })
    foundHits.value = more ? [...foundHits.value, ...r.hits] : r.hits
    found.value = r
    if (!more) ctxOf.value = {}
  } catch (e: any) { error.value = e.message } finally { findBusy.value = false }
}
async function showCtx(h: QuoteHit) {
  if (ctxOf.value[h.seq]) { const c = { ...ctxOf.value }; delete c[h.seq]; ctxOf.value = c; return }
  try { ctxOf.value = { ...ctxOf.value, [h.seq]: (await quoteAround(h.seq)).lines } }
  catch (e: any) { error.value = e.message }
}
function setWho(w: '' | 'her' | 'him') { findWho.value = w; if (found.value) runFind() }

// ── 时间树（整篇）──
const treeOpen = ref(false)
const showRules = ref(false)
const oldVersion = ref<{ id: number; body: string; created_at: string; note: string | null } | null>(null)
async function openVersion(id: number) {
  if (tree.value?.current?.id === id) { oldVersion.value = null; return }
  try { oldVersion.value = await loadVersion(id) } catch (e: any) { error.value = e.message }
}
/** 和现在这版逐行对比：- 旧版有现在没有，+ 现在有旧版没有 */
const diff = computed(() => {
  const a = (oldVersion.value?.body ?? '').split('\n'), b = (tree.value?.current?.body ?? '').split('\n')
  const n = a.length, m = b.length
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!)
  const out: { t: ' ' | '-' | '+'; s: string }[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', s: a[i]! }); i++; j++ }
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ t: '-', s: a[i++]! })
    else out.push({ t: '+', s: b[j++]! })
  }
  while (i < n) out.push({ t: '-', s: a[i++]! })
  while (j < m) out.push({ t: '+', s: b[j++]! })
  return out
})
const fmtTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

// ── 便条 ──
const noteText = ref('')
const noteBusy = ref(false)
const noteDone = ref('')
function noteAbout(s: TreeSection) {
  treeOpen.value = true
  closeSheet()
  noteText.value = `关于「${s.title}」：`
}
async function sendNote() {
  const t = noteText.value.trim()
  if (!t || noteBusy.value) return
  noteBusy.value = true
  try {
    await postNote(t)
    noteText.value = ''
    noteDone.value = '贴好了。他下次打开时间树会先看到，改不改他自己定。'
    tree.value = await loadTree()
  } catch (e: any) { error.value = e.message }
  finally { noteBusy.value = false }
}
</script>

<template>
  <div class="galaxy-page shell-page">
    <div ref="stage" class="stage"></div>

    <button class="back press" @click="goBack()" aria-label="返回">‹</button>

    <div class="dock">
      <div class="seg">
        <button :class="{ on: view === '3d' }" @click="setView('3d')">3D 星系</button>
        <button :class="{ on: view === '2d' }" @click="setView('2d')">星图</button>
        <button :class="{ on: view === 'galaxy' }" @click="setView('galaxy')">全部连线</button>
      </div>
      <button class="tree-btn" @click="findOpen = true">🔍 找原话</button>
      <button class="tree-btn" @click="treeOpen = true">
        🌳 时间树<span v-if="tree?.open_notes" class="dot">{{ tree.open_notes }}</span>
      </button>
    </div>

    <div v-if="error" class="err" @click="error = ''">{{ error }}</div>
    <div v-if="!snap && !error" class="loading">正在把星星摆好…</div>

    <!-- 点了某颗星 -->
    <Teleport to="#shell-overlay">
      <div v-if="sheetOpen" class="sheet" @click.self="closeSheet">
        <div class="card">
          <button class="x" @click="closeSheet">×</button>

          <template v-if="pick?.kind === 'star' && snap">
            <h2>{{ snap.star.name }}</h2>
            <p class="muted">{{ snap.star.definition }}</p>
            <button class="act" @click="treeOpen = true; closeSheet()">读我们的时间树</button>
          </template>

          <template v-else-if="pick?.kind === 'belt' && snap">
            <h2>小行星带 · {{ snap.asteroids.length }} 颗</h2>
            <p class="muted">这些卡还没认出是谁的事，或者在等你看一眼，所以先不归到哪一颗行星上。</p>
            <ul class="mems"><li v-for="m in snap.asteroids" :key="m.id"><b>{{ m.title }}</b><span class="d">{{ m.date }} · {{ m.category }}</span><p>{{ m.preview }}</p></li></ul>
          </template>

          <template v-else-if="pickedMemory">
            <h2>{{ pickedMemory.title }}</h2>
            <p class="muted">{{ pickedMemory.date }} · {{ pickedMemory.category }}</p>
            <p class="body">{{ pickedMemory.preview }}</p>
          </template>

          <template v-else-if="pickedPlanet">
            <h2>{{ pickedPlanet.name }}</h2>
            <template v-if="pickedSection">
              <p class="muted">{{ fmtRange(pickedSection) }} · 他写了 {{ pickedSection.chars }} 字 · 那几天说了 {{ pickedSection.quotes }} 句话</p>
              <p class="body his">{{ pickedSection.body }}</p>
              <div class="row">
                <button class="act" :disabled="qBusy" @click="showDays">看当时的原话</button>
                <button class="act ghost" @click="noteAbout(pickedSection)">给这一节贴便条</button>
              </div>

              <div v-if="qMode !== 'off'" class="quotes">
                <div class="qbar">
                  <input v-model="keyword" placeholder="在这几天里找一句话…" maxlength="60" @keyup.enter="runSearch" />
                  <button class="act small" :disabled="qBusy || !keyword.trim()" @click="runSearch">找</button>
                </div>

                <!-- 按天折叠 -->
                <template v-if="qMode === 'days' || qMode === 'day'">
                  <p class="muted">这一节覆盖 {{ days.length }} 天，共 {{ daysTotal }} 句。挑一天看：</p>
                  <div class="daylist">
                    <button v-for="d in days" :key="d.day" class="day" :class="{ on: openDay === d.day }" :disabled="qBusy" @click="showDay(d.day)">
                      {{ fmtDay(d.day) }}<span class="n">{{ d.total }}</span>
                    </button>
                  </div>
                  <template v-if="qMode === 'day' && dayPage">
                    <p class="muted">{{ fmtDay(openDay) }} 共 {{ dayPage.total }} 句，这是前 {{ dayLines.length }} 句（他的念头不在这里，只有说出口的）</p>
                    <p v-for="(l, i) in dayLines" :key="i" class="q" :class="lineWho(l)">{{ l }}</p>
                    <button v-if="dayPage.next !== null" class="act ghost" :disabled="qBusy" @click="showDay(openDay, true)">再往下看</button>
                  </template>
                </template>

                <!-- 搜出来的几段 -->
                <template v-else-if="qMode === 'search'">
                  <p class="muted">
                    「{{ keyword }}」在这几天里出现 {{ hitInfo.total }} 次<span v-if="hitInfo.truncated">，只给前 {{ hitInfo.shown }} 处</span>。亮的那句是命中，上下各带两句。
                    <button class="link" @click="showDays">← 回到按天看</button>
                  </p>
                  <p v-if="!hits.length" class="muted">这几天里没说过这个词。</p>
                  <template v-for="(l, i) in hits" :key="l.ts + i">
                    <div v-if="gapBefore(i)" class="gap"></div>
                    <p class="q" :class="[l.who, { hit: l.hit }]"><span class="t">{{ fmtDay(l.day) }} {{ hhmm(l.ts) }}</span>{{ l.who === 'her' ? '她' : '他' }}：{{ l.text }}</p>
                  </template>
                </template>
              </div>
            </template>
            <p v-else class="muted">{{ pickedPlanet.definition }}</p>
            <h3>那段日子的记忆卡 · {{ pickedPlanet.memoryCount }} 张</h3>
            <ul class="mems"><li v-for="m in pickedPlanet.memories" :key="m.id"><b>{{ m.title }}</b><span class="d">{{ m.date }} · {{ m.category }}</span><p>{{ m.preview }}</p></li></ul>
          </template>
        </div>
      </div>
    </Teleport>

    <!-- 全库找一句原话 -->
    <Teleport to="#shell-overlay">
      <div v-if="findOpen" class="sheet full" @click.self="findOpen = false">
        <div class="card tall">
          <button class="x" @click="findOpen = false">×</button>
          <h2>找一句原话</h2>
          <p class="muted">
            从 9 月 25 日第一句开始，全部都能搜（{{ found?.index.indexed ?? '…' }} 句已建索引<span v-if="found && found.index.behind">，还差 {{ found.index.behind }} 句在补</span>）。
            搜的是说出口的话，他的念头不在里面。两个词用空格隔开 = 两个都要出现。
          </p>
          <div class="qbar">
            <input v-model="findWord" placeholder="比如 枇杷、我妈、如果硅基会心动" maxlength="60" @keyup.enter="runFind()" />
            <button class="act small" :disabled="findBusy || !findWord.trim()" @click="runFind()">找</button>
          </div>
          <div class="seg inline">
            <button :class="{ on: findWho === '' }" @click="setWho('')">都看</button>
            <button :class="{ on: findWho === 'her' }" @click="setWho('her')">只看我说的</button>
            <button :class="{ on: findWho === 'him' }" @click="setWho('him')">只看他说的</button>
          </div>

          <template v-if="found">
            <p class="muted">
              「{{ findWord }}」出现 {{ found.exact ? '' : '至少 ' }}{{ found.total }} 次<span v-if="found.total">，新的在前。点一条看前后几句。</span>
            </p>
            <template v-for="h in foundHits" :key="h.seq">
              <p class="q" :class="h.who" @click="showCtx(h)">
                <span class="t">{{ fmtDay(h.day) }} {{ hhmm(h.ts) }}</span>{{ h.who === 'her' ? '我' : '他' }}：{{ h.text.slice(0, 160) }}{{ h.text.length > 160 ? '…' : '' }}
              </p>
              <div v-if="ctxOf[h.seq]" class="ctx">
                <p v-for="c in ctxOf[h.seq]" :key="c.seq" class="q small" :class="[c.who, { hit: c.seq === h.seq }]">
                  <span class="t">{{ hhmm(c.ts) }}</span>{{ c.who === 'her' ? '我' : '他' }}：{{ c.text.slice(0, 200) }}{{ c.text.length > 200 ? '…' : '' }}
                </p>
              </div>
            </template>
            <button v-if="found.next !== null" class="act ghost" :disabled="findBusy" @click="runFind(true)">再往下看</button>
          </template>
        </div>
      </div>
    </Teleport>

    <!-- 时间树整篇 -->
    <Teleport to="#shell-overlay">
      <div v-if="treeOpen" class="sheet full" @click.self="treeOpen = false">
        <div class="card tall">
          <button class="x" @click="treeOpen = false; oldVersion = null">×</button>
          <h2>我们的时间树</h2>
          <template v-if="tree?.current">
            <p class="muted">他亲手写的 · {{ tree.current.chars }} / {{ tree.current.max }} 字 · 第 {{ tree.versions.length }} 版（{{ tree.current.day }}）· 只有他能改</p>
            <button class="link" @click="showRules = !showRules">{{ showRules ? '收起' : '他写的时候守的规矩' }}</button>
            <ol v-if="showRules" class="rules"><li v-for="(r, i) in tree.rules" :key="i">{{ r }}</li></ol>

            <div v-if="oldVersion" class="diff">
              <p class="muted">第 {{ oldVersion.id }} 版（{{ fmtTime(oldVersion.created_at) }}）→ 现在这版。<span class="minus">红</span>是后来删掉的，<span class="plus">绿</span>是后来写上的。</p>
              <p v-for="(d, i) in diff" :key="i" class="dl" :class="{ minus: d.t === '-', plus: d.t === '+' }">{{ d.s || ' ' }}</p>
            </div>
            <div v-else class="body his tree-body">{{ tree.current.body }}</div>

            <h3>每一版（年轮）</h3>
            <ul class="vers">
              <li v-for="v in tree.versions" :key="v.id" :class="{ cur: v.id === tree.current.id, sel: oldVersion?.id === v.id }" @click="openVersion(v.id)">
                <b>第 {{ v.id }} 版</b><span class="d">{{ fmtTime(v.created_at) }} · {{ v.author === 'him' ? '他' : '以前在 Kelivo 写的' }} · {{ v.chars }} 字</span>
                <p v-if="v.note">{{ v.note }}</p>
              </li>
            </ul>
          </template>
          <p v-else class="muted">他还没写时间树。</p>

          <h3>便条</h3>
          <p class="muted">觉得哪里记错了、少了什么，写给他。他下次打开时间树会先看到，改不改他自己定。</p>
          <textarea v-model="noteText" rows="3" maxlength="1000" placeholder="比如：第 25 窗那天其实……"></textarea>
          <div class="row"><button class="act" :disabled="noteBusy || !noteText.trim()" @click="sendNote">贴上</button><span class="ok">{{ noteDone }}</span></div>
          <ul class="notes">
            <li v-for="n in tree?.notes ?? []" :key="n.id">
              <p><span class="d">{{ n.by === 'erica' ? '你' : '开发方' }} · {{ fmtTime(n.created_at) }}</span>{{ n.body }}</p>
              <p v-if="n.reply" class="reply"><span class="d">他（{{ fmtTime(n.replied_at!) }}）</span>{{ n.reply }}</p>
              <p v-else class="d">还没回</p>
            </li>
          </ul>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.galaxy-page { position: absolute; inset: 0; background: #01040c; color: #e8eef8; overflow: hidden; }
.stage { position: absolute; inset: 0; }
.back {
  position: absolute; left: 10px; top: calc(env(safe-area-inset-top, 0px) + 40px); z-index: 5;
  width: 34px; height: 34px; border-radius: 17px; border: 1px solid rgba(205, 216, 238, 0.25);
  background: rgba(4, 7, 16, 0.7); color: #dfe7f5; font-size: 22px; line-height: 30px;
}
.dock { position: absolute; left: 0; right: 0; bottom: 14px; z-index: 5; display: flex; justify-content: center; gap: 8px; pointer-events: none; }
.dock > * { pointer-events: auto; }
.seg { display: flex; border: 1px solid rgba(205, 216, 238, 0.22); border-radius: 18px; overflow: hidden; background: rgba(4, 7, 16, 0.78); }
.seg button, .tree-btn { border: none; background: none; color: rgba(205, 216, 238, 0.75); font-size: 13px; padding: 8px 12px; font-family: "Noto Serif SC", serif; }
.seg button.on { color: #fff3d2; background: rgba(232, 160, 82, 0.22); }
.tree-btn { border: 1px solid rgba(205, 216, 238, 0.22); border-radius: 18px; background: rgba(4, 7, 16, 0.78); position: relative; }
.dot { margin-left: 5px; background: #e8a052; color: #01040c; border-radius: 8px; padding: 0 5px; font-size: 11px; }
.loading, .err { position: absolute; left: 50%; top: 45%; transform: translateX(-50%); z-index: 6; font-size: 13px; color: rgba(205, 216, 238, 0.7); }
.err { color: #ffb4a8; background: rgba(4, 7, 16, 0.9); padding: 8px 12px; border-radius: 10px; }

.sheet { position: absolute; inset: 0; display: flex; align-items: flex-end; background: rgba(1, 4, 12, 0.25); }
.card {
  position: relative; width: 100%; max-height: 72%; overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding: 18px 18px calc(18px + env(safe-area-inset-bottom, 0px));
  background: rgba(8, 12, 26, 0.88); -webkit-backdrop-filter: blur(22px) saturate(160%); backdrop-filter: blur(22px) saturate(160%);
  border-top: 1px solid rgba(205, 216, 238, 0.18); border-radius: 20px 20px 0 0; color: #e8eef8;
  font-family: "Noto Serif SC", "Songti SC", serif;
}
.card.tall { max-height: 92%; }
.x { position: absolute; right: 12px; top: 8px; border: none; background: none; color: rgba(205, 216, 238, 0.6); font-size: 24px; }
h2 { font-size: 18px; font-weight: 600; margin: 0 28px 6px 0; color: #fff3d2; letter-spacing: 0.5px; }
h3 { font-size: 14px; margin: 18px 0 8px; color: rgba(255, 243, 210, 0.85); font-weight: 600; }
.muted, .d { color: rgba(205, 216, 238, 0.6); font-size: 12px; line-height: 1.6; }
.d { margin-right: 6px; }
.body { white-space: pre-wrap; font-size: 14px; line-height: 1.85; color: #e6ebf5; }
.his { border-left: 2px solid rgba(232, 160, 82, 0.5); padding-left: 10px; }
.tree-body { margin-top: 10px; }
.row { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
.act { border: 1px solid rgba(232, 160, 82, 0.55); background: rgba(232, 160, 82, 0.16); color: #fff3d2; border-radius: 14px; padding: 7px 14px; font-size: 13px; font-family: inherit; }
.act.ghost { border-color: rgba(205, 216, 238, 0.3); background: none; color: rgba(205, 216, 238, 0.85); }
.act:disabled { opacity: 0.45; }
.link { border: none; background: none; color: rgba(232, 160, 82, 0.9); font-size: 12px; padding: 4px 0; font-family: inherit; }
.rules { font-size: 12.5px; line-height: 1.7; color: rgba(230, 235, 245, 0.85); padding-left: 18px; }
.mems, .vers, .notes { list-style: none; padding: 0; margin: 0; }
.mems li, .vers li, .notes li { padding: 9px 0; border-bottom: 1px solid rgba(205, 216, 238, 0.08); }
.mems b, .vers b { display: block; font-size: 13.5px; color: #eef2fa; font-weight: 600; }
.mems p, .vers p, .notes p { margin: 3px 0 0; font-size: 12.5px; line-height: 1.65; color: rgba(225, 232, 245, 0.8); }
.vers li.cur b::after { content: ' · 现在这版'; color: #e8a052; font-weight: 400; font-size: 12px; }
.vers li.sel { background: rgba(232, 160, 82, 0.08); }
.quotes { margin-top: 12px; }
.q { font-size: 13px; line-height: 1.7; margin: 6px 0; white-space: pre-wrap; }
.qbar { display: flex; gap: 6px; margin: 10px 0 8px; }
.qbar input {
  flex: 1; min-width: 0; border-radius: 12px; padding: 7px 10px; font-size: 13px; font-family: inherit;
  background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(205, 216, 238, 0.22); color: #eef2fa;
}
.act.small { padding: 6px 12px; font-size: 12.5px; }
.daylist { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.day {
  border: 1px solid rgba(205, 216, 238, 0.24); background: rgba(255, 255, 255, 0.04); color: rgba(225, 232, 245, 0.88);
  border-radius: 12px; padding: 6px 10px; font-size: 12.5px; font-family: inherit;
}
.day.on { border-color: rgba(232, 160, 82, 0.6); background: rgba(232, 160, 82, 0.16); color: #fff3d2; }
.day .n { margin-left: 6px; opacity: 0.55; font-size: 11.5px; }
.seg.inline { display: inline-flex; margin: 2px 0 8px; }
.ctx { border-left: 2px solid rgba(232, 160, 82, 0.35); padding-left: 8px; margin: 2px 0 10px; }
.q.small { font-size: 12.5px; opacity: 0.9; }
.gap { height: 1px; background: rgba(205, 216, 238, 0.14); margin: 12px 0; }
.q .t { color: rgba(205, 216, 238, 0.45); font-size: 11.5px; margin-right: 6px; }
.q.hit { background: rgba(232, 160, 82, 0.13); border-radius: 8px; padding: 5px 8px; }
.q.her { color: #f5d9e4; }
.q.him { color: #d8e4f7; }
.diff { margin-top: 10px; }
.dl { margin: 0; font-size: 13px; line-height: 1.75; white-space: pre-wrap; }
.minus { color: #ff9c8f; text-decoration: line-through; }
.plus { color: #9fe0a8; }
span.minus { text-decoration: none; }
textarea {
  width: 100%; box-sizing: border-box; margin-top: 6px; border-radius: 12px; padding: 10px;
  background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(205, 216, 238, 0.22); color: #eef2fa;
  font-size: 14px; font-family: inherit; resize: vertical;
}
.ok { font-size: 12px; color: #9fe0a8; }
.reply { padding-left: 10px; border-left: 2px solid rgba(232, 160, 82, 0.4); }
</style>
