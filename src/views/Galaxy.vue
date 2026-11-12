<script setup lang="ts">
// 星空：3D 星系（星域图谱 Observatory-Ridge, MIT）+ 我们的时间树。
// 行星 = 他写的时间树的每一节，卫星 = 那段日子的记忆卡，小行星带 = 还没认出是谁的事的卡。
// 她在这里只能看、贴便条；时间树只有他能改（open_tree），页面上没有替他改字的按钮。
import { ref, computed, onMounted, onBeforeUnmount, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { loadGalaxy, loadGraph, loadTree, loadVersion, loadSource, postNote,
  type GSnapshot, type GGraph, type GMemory, type TreePage, type TreeSection, type SourcePage } from '../galaxy/api'
import { mountRidge, hasWebGL2, type Mounted, type Pick, type View } from '../galaxy/bridge'

const router = useRouter()
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
  draw()
}

onMounted(async () => {
  try {
    const [s, t] = await Promise.all([loadGalaxy(), loadTree()])
    snap.value = s
    tree.value = t
    if (stage.value) {
      ridge = mountRidge(stage.value, p => { pick.value = p; source.value = null })
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
function closeSheet() { pick.value = null; source.value = null }
const fmtRange = (s: TreeSection) => s.from === s.to ? s.from : `${s.from} ～ ${s.to}`

// ── 当时的原话 ──
const source = ref<SourcePage | null>(null)
const sourceLines = ref<string[]>([])
const sourceBusy = ref(false)
async function openSource(s: TreeSection, more = false) {
  if (!s.from || !s.to || sourceBusy.value) return
  sourceBusy.value = true
  try {
    const page = await loadSource(s.from, s.to, more && source.value?.next ? source.value.next : 0)
    sourceLines.value = more ? [...sourceLines.value, ...page.lines] : page.lines
    source.value = page
  } catch (e: any) { error.value = e.message }
  finally { sourceBusy.value = false }
}
const lineWho = (l: string) => (/^\[[^\]]+\] 她：/.test(l) ? 'her' : 'him')

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

    <button class="back press" @click="router.push('/rooftop')" aria-label="回天台">‹</button>

    <div class="dock">
      <div class="seg">
        <button :class="{ on: view === '3d' }" @click="setView('3d')">3D 星系</button>
        <button :class="{ on: view === '2d' }" @click="setView('2d')">星图</button>
        <button :class="{ on: view === 'galaxy' }" @click="setView('galaxy')">全部连线</button>
      </div>
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
                <button class="act" :disabled="sourceBusy" @click="openSource(pickedSection)">看当时的原话</button>
                <button class="act ghost" @click="noteAbout(pickedSection)">给这一节贴便条</button>
              </div>
              <div v-if="source" class="quotes">
                <p class="muted">{{ source.from }} ～ {{ source.to }} · 共 {{ source.total }} 句（他的念头不在这里，只有说出口的）</p>
                <p v-for="(l, i) in sourceLines" :key="i" class="q" :class="lineWho(l)">{{ l }}</p>
                <button v-if="source.next !== null" class="act ghost" :disabled="sourceBusy" @click="openSource(pickedSection, true)">再往下看</button>
              </div>
            </template>
            <p v-else class="muted">{{ pickedPlanet.definition }}</p>
            <h3>那段日子的记忆卡 · {{ pickedPlanet.memoryCount }} 张</h3>
            <ul class="mems"><li v-for="m in pickedPlanet.memories" :key="m.id"><b>{{ m.title }}</b><span class="d">{{ m.date }} · {{ m.category }}</span><p>{{ m.preview }}</p></li></ul>
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
