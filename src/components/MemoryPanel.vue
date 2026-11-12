<script setup lang="ts">
// 设置页「记忆」：沉淀信箱 + 库里现在有什么（后端 server/src/memory/）。
//
// 她在这里只做两件事：**选入** / **跳过**（可以批量）。
// 记忆只有他能写，她能划掉——界面上没有「替他改写」的按钮，这是定下来的规矩。
import { ref, computed, onMounted } from 'vue'
import {
  memoryStats, memoryInbox, memoryList, decideCandidates, retractMemory,
  memoryProposals, decideProposals, runRejudgeBatch,
  memoryDetail, addCorrection, setMemoryPrivate, tryRecall, recallStats,
  listAliases, addAlias, removeAlias, vectorIndex, buildVectorIndex,
  replayRecall, graduation, spotcheck, type ReplayItem,
  type MemoryDetail, type RecallTry, type RecallStats as RStats,
  LAYER_NAMES, KIND_NAMES, when, whenDate, type MemoryStats, type Candidate, type MemoryItem, type Proposal,
} from '../memory'

const stats = ref<MemoryStats | null>(null)
const inbox = ref<Candidate[]>([])
const list = ref<MemoryItem[]>([])
const picked = ref<Set<number>>(new Set())
const props = defineProps<{ initialTab?: 'inbox' | 'fix' | 'recall' | 'all' | 'review' }>()
const tab = ref<'inbox' | 'fix' | 'recall' | 'all' | 'review'>(props.initialTab ?? 'inbox')
const recall = ref<RStats | null>(null)
const tryQ = ref('')
const tried = ref<RecallTry | null>(null)
const aliases = ref<{ id: number; term: string; canonical: string }[]>([])
const vindex = ref<{ total: number; indexed: number; model: string | null; queryCache: number; configured: boolean } | null>(null)
const replay = ref<{ turns: number; withPicks: number; empty: number; avgPicked: number; wouldUseRate: number | null; items: ReplayItem[] } | null>(null)
const grad = ref<{ shadowDays: number | null; shadowTurns: number; spotChecked: number; wrongMarked: number; ready: boolean; missing: string[] } | null>(null)

async function doReplay() {
  if (busy.value) return
  busy.value = true
  rejudgeMsg.value = '正在拿最近几十轮真实对话回放…（只读，不写任何东西）'
  try {
    replay.value = await replayRecall(30)
    rejudgeMsg.value = ''
  } catch (e: any) { rejudgeMsg.value = e.message }
  busy.value = false
}
async function loadGrad() {
  try { grad.value = await graduation() } catch { grad.value = null }
}
/** 抽看：这一条该给还是不该给。标过的会变成判官的新规则 */
async function mark(it: ReplayItem, p: { id: number; title: string } | null, verdict: 'right' | 'wrong') {
  busy.value = true
  try {
    const r = await spotcheck(it.said, verdict, p?.id)
    if (!r.ok) err.value = r.error || '没记下'
    await loadGrad()
  } catch (e: any) { err.value = e.message }
  busy.value = false
}

async function loadIndex() {
  try { vindex.value = await vectorIndex() } catch { vindex.value = null }
}
async function rebuildIndex() {
  busy.value = true
  rejudgeMsg.value = '正在给卡片算向量…（一次性，之后只补新的）'
  try {
    const r = await buildVectorIndex()
    rejudgeMsg.value = r.error
      ? `算到一半出错了：${r.error}`
      : `算好了 ${r.embedded} 条，用了 ${(r.ms / 1000).toFixed(1)} 秒${r.failed ? `，${r.failed} 条失败` : ''}`
    await loadIndex()
  } catch (e: any) { rejudgeMsg.value = e.message }
  busy.value = false
}

async function loadAliases() {
  try { aliases.value = (await listAliases()).aliases } catch (e: any) { err.value = e.message }
}
async function newAlias() {
  const term = window.prompt('你平时怎么说？（比如「我妈」「大姨妈」「糯米团」）')
  if (!term || !term.trim()) return
  const canonical = window.prompt(`库里写的是什么？（「${term.trim()}」会和它当成同一个说法搜）`)
  if (!canonical || !canonical.trim()) return
  busy.value = true
  try {
    const r = await addAlias(term.trim(), canonical.trim())
    if (!r.ok) err.value = r.error || '没加上'
    await loadAliases()
  } catch (e: any) { err.value = e.message }
  busy.value = false
}
async function dropAlias(id: number) {
  busy.value = true
  try { await removeAlias(id); await loadAliases() } catch (e: any) { err.value = e.message }
  busy.value = false
}
const proposals = ref<Proposal[]>([])
const rejudgeMsg = ref('')
const err = ref('')
const busy = ref(false)
const expanded = ref<Set<number>>(new Set())

const layerName = (l: string) => LAYER_NAMES[l] || l

async function reload() {
  err.value = ''
  try {
    stats.value = await memoryStats()
    if (tab.value === 'inbox') {
      inbox.value = (await memoryInbox()).candidates
      picked.value = new Set()
    } else if (tab.value === 'recall') {
      recall.value = await recallStats()
      await loadAliases()
      await loadIndex()
      await loadGrad()
    } else if (tab.value === 'fix') {
      proposals.value = (await memoryProposals()).proposals
      picked.value = new Set()
    } else {
      list.value = (await memoryList({ review: tab.value === 'review', limit: 60 })).memories
    }
  } catch (e: any) { err.value = e.message }
}
onMounted(reload)

function switchTab(t: 'inbox' | 'fix' | 'recall' | 'all' | 'review') { tab.value = t; void reload() }

/** 试一句：看这句话现在会想起哪几条、哪几条被判官挡了。不写库 */
async function doTry() {
  if (!tryQ.value.trim() || busy.value) return
  busy.value = true
  try { tried.value = await tryRecall(tryQ.value.trim()) } catch (e: any) { err.value = e.message }
  busy.value = false
}
const STATE_NAMES: Record<string, string> = { asked: '算出来了（没给他）', delivered: '给过他', used: '他用上了', dropped: '他没用上' }

const allFixPicked = computed(() => proposals.value.length > 0 && picked.value.size === proposals.value.length)
function pickAllFix() { picked.value = allFixPicked.value ? new Set() : new Set(proposals.value.map(p => p.id)) }

async function decideFix(ids: number[], action: 'take' | 'drop') {
  if (!ids.length || busy.value) return
  busy.value = true
  try {
    const r = await decideProposals(ids, action)
    const bad = r.results.find(x => !x.ok)
    if (bad) err.value = bad.error || '有一条没处理成功'
    await reload()
  } catch (e: any) { err.value = e.message }
  busy.value = false
}

async function rejudge() {
  if (busy.value) return
  busy.value = true
  rejudgeMsg.value = '正在看这一批…（他的字一个都不会被改，只会给建议）'
  try {
    const r = await runRejudgeBatch(20)
    rejudgeMsg.value = r.error
      ? `这一批失败了：${r.error}`
      : `看了 ${r.cards} 张，给了 ${r.proposals} 条建议，${r.skipped} 张不用动` +
        (r.rewrote ? `，${r.rewrote} 条因为它擅自改了原文被作废` : '')
    await reload()
  } catch (e: any) { rejudgeMsg.value = e.message }
  busy.value = false
}

const kindName = (k: string) => KIND_NAMES[k] || k

// 展开一条记忆时顺手把关系和便条读回来
const details = ref<Record<number, MemoryDetail>>({})
async function loadDetail(id: number) {
  if (details.value[id]) return
  try { details.value = { ...details.value, [id]: await memoryDetail(id) } } catch (e: any) { err.value = e.message }
}
function toggleMemory(id: number) {
  toggleBody(id)
  if (expanded.value.has(id)) void loadDetail(id)
}

/** 私密：不进群聊、不进 Leto、夜里整理也不读；面板里默认折叠 */
async function flipPrivate(m: MemoryItem) {
  busy.value = true
  try {
    const r = await setMemoryPrivate(m.id, m.privacy !== 'private')
    if (!r.ok) err.value = r.error || '改不了'
    else await reload()
  } catch (e: any) { err.value = e.message }
  busy.value = false
}

/** 贴便条：她只写「哪里记错了」，改不改他定 */
async function stickNote(m: MemoryItem) {
  const note = window.prompt(`在「${m.title}」上贴一张便条。写哪里记错了——他下次会看到，改不改由他定（原文不会被改掉）。`)
  if (!note || !note.trim()) return
  busy.value = true
  try {
    const r = await addCorrection(m.id, note.trim())
    if (!r.ok) err.value = r.error || '没贴上'
    else {
      delete details.value[m.id]
      await loadDetail(m.id)
      await reload()
    }
  } catch (e: any) { err.value = e.message }
  busy.value = false
}

function toggle(id: number) {
  const s = new Set(picked.value)
  s.has(id) ? s.delete(id) : s.add(id)
  picked.value = s
}
function toggleBody(id: number) {
  const s = new Set(expanded.value)
  s.has(id) ? s.delete(id) : s.add(id)
  expanded.value = s
}
const allPicked = computed(() => inbox.value.length > 0 && picked.value.size === inbox.value.length)
function pickAll() { picked.value = allPicked.value ? new Set() : new Set(inbox.value.map(c => c.id)) }

async function decide(ids: number[], action: 'accept' | 'skip') {
  if (!ids.length || busy.value) return
  busy.value = true
  try {
    const r = await decideCandidates(ids, action)
    const bad = r.results.find(x => !x.ok)
    if (bad) err.value = bad.error || '有一条没处理成功'
    await reload()
  } catch (e: any) { err.value = e.message }
  busy.value = false
}

async function strike(m: MemoryItem) {
  if (!confirm(`划掉「${m.title}」？他那边就不会再带上它了（不是真删，库里留着）。`)) return
  busy.value = true
  try { await retractMemory(m.id, '她划掉的'); await reload() } catch (e: any) { err.value = e.message }
  busy.value = false
}
</script>

<template>
  <div class="mem">
    <p class="mem-hint">
      他记的东西分三层：<b>事实</b>（一直有效）、<b>近况</b>（几天就沉下去）、<b>我们之间</b>。
      拿不准的先停在<b>沉淀信箱</b>里等你看一眼——你只用点「选入」或「跳过」。
      记忆只有他能写：你能<b>划掉</b>，也能<b>贴便条</b>说哪里记错了——他下次会看到，改不改由他定，原文不会被盖掉。
    </p>

    <div v-if="stats" class="mem-stats">
      <span>共 {{ stats.total }} 条</span>
      <span>事实 {{ stats.byLayer.fact || 0 }}</span>
      <span>近况 {{ stats.byLayer.state || 0 }}</span>
      <span>我们之间 {{ stats.byLayer.bond || 0 }}</span>
      <span v-if="stats.relations">关系 {{ stats.relations }} 条</span>
      <span v-if="stats.private?.memories">私密 {{ stats.private.memories }} 条</span>
      <span v-if="stats.corrections">便条 {{ stats.corrections }} 张等他看</span>
      <span v-if="stats.digest.runs">夜里整理过 {{ stats.digest.runs }} 次</span>
    </div>

    <div class="mem-tabs">
      <button :class="['mem-tab', { on: tab === 'inbox' }]" @click="switchTab('inbox')">
        信箱<span v-if="stats?.inbox" class="mem-dot">{{ stats.inbox }}</span>
      </button>
      <button :class="['mem-tab', { on: tab === 'review' }]" @click="switchTab('review')">
        等看一眼<span v-if="stats?.needsReview" class="mem-dot">{{ stats.needsReview }}</span>
      </button>
      <button :class="['mem-tab', { on: tab === 'fix' }]" @click="switchTab('fix')">
        整理建议<span v-if="proposals.length" class="mem-dot">{{ proposals.length }}</span>
      </button>
      <button :class="['mem-tab', { on: tab === 'recall' }]" @click="switchTab('recall')">召回</button>
      <button :class="['mem-tab', { on: tab === 'all' }]" @click="switchTab('all')">全部</button>
    </div>

    <p v-if="err" class="mem-err">{{ err }}</p>

    <!-- 沉淀信箱 -->
    <template v-if="tab === 'inbox'">
      <p v-if="!inbox.length" class="mem-empty">信箱是空的。</p>
      <template v-else>
        <div class="mem-bulk">
          <label class="mem-flag"><input type="checkbox" :checked="allPicked" @change="pickAll" />全选</label>
          <span class="mem-spacer"></span>
          <button class="mem-btn" :disabled="!picked.size || busy" @click="decide([...picked], 'skip')">跳过</button>
          <button class="mem-btn primary" :disabled="!picked.size || busy" @click="decide([...picked], 'accept')">选入</button>
        </div>
        <div v-for="c in inbox" :key="c.id" class="mem-item">
          <div class="mem-head">
            <input type="checkbox" :checked="picked.has(c.id)" @change="toggle(c.id)" />
            <span class="mem-title" @click="toggleBody(c.id)">{{ c.payload.title || '（没写标题）' }}</span>
            <span class="mem-tag">{{ layerName(c.payload.layer) }}</span>
            <span class="mem-tag">{{ c.payload.subjectLabel }}</span>
            <span class="mem-tag">{{ c.origin === 'digest' ? '夜里整理' : '他随手记' }}</span>
          </div>
          <p class="mem-why">为什么记：{{ c.payload.why }}</p>
          <p class="mem-unsure">拿不准：{{ c.unsure }}</p>
          <template v-if="expanded.has(c.id)">
            <p class="mem-body">{{ c.payload.fact }}</p>
            <p v-if="c.payload.feeling" class="mem-feeling">{{ c.payload.feeling }}</p>
            <p v-if="c.similarTitle" class="mem-meta">像已有的「{{ c.similarTitle }}」{{ Math.round((c.overlap || 0) * 100) }}%</p>
            <p v-if="c.thread" class="mem-meta">话题线：{{ c.thread }}</p>
          </template>
          <div class="mem-row">
            <button class="mem-link" @click="toggleBody(c.id)">{{ expanded.has(c.id) ? '收起' : '看全文' }}</button>
            <span class="mem-spacer"></span>
            <button class="mem-btn" :disabled="busy" @click="decide([c.id], 'skip')">跳过</button>
            <button class="mem-btn primary" :disabled="busy" @click="decide([c.id], 'accept')">选入</button>
          </div>
        </div>
      </template>
    </template>

    <!-- 召回（第三期：影子运行） -->
    <template v-else-if="tab === 'recall'">
      <p class="mem-hint">
        每轮算一遍「这句话该想起哪几条」。<b>现在是影子运行：算出来只记录，不进他的上下文</b>——
        你先看它捞得准不准，再决定要不要真的接到他眼前。
        纸条开头永远写着：旧记忆只作证据不作处方，跟你此刻说的有出入以此刻为准。
      </p>
      <div class="mem-bulk">
        <input v-model="tryQ" class="wb-title-input" placeholder="试一句：比如「糯糯今天怎么样」" @keyup.enter="doTry" />
        <button class="mem-btn primary" :disabled="busy || !tryQ.trim()" @click="doTry">试一下</button>
      </div>
      <div v-if="tried" class="mem-item">
        <div class="mem-head">
          <span class="mem-title">卡片 {{ tried.candidates }} 条 → 想起 {{ tried.picked.length }} 条｜原话 {{ tried.quotes.length }} 条</span>
          <span class="mem-tag">{{ tried.mode === 'live' ? '已经真的在给他' : '影子' }}</span>
        </div>
        <p v-if="tried.expanded.length" class="mem-meta">也当成同一个说法搜了：{{ tried.expanded.join('、') }}</p>
        <p class="mem-meta">
          语义这一层：{{ tried.semantic.used ? `用上了，${tried.semantic.ms} 毫秒${tried.semantic.cached ? '（缓存命中）' : ''}` : `没用上——${tried.semantic.why || ''}` }}
        </p>
        <p v-for="p in tried.picked" :key="p.id" class="mem-why">
          ✓ {{ p.title }}（{{ layerName(p.layer) }}·{{ p.score.toFixed(2) }}
          <template v-if="p.sem !== null">｜字面 {{ (p.lex ?? 0).toFixed(2) }} / 意思 {{ p.sem.toFixed(2) }}</template>）{{ p.why }}
          <template v-if="p.axis.length >= 2"> · 这件事浮现过 {{ p.axis.length }} 次</template>
        </p>
        <p v-for="r in tried.rejected" :key="'r' + r.id" class="mem-unsure">✗ {{ r.title }}：{{ r.why }}</p>
        <p v-if="tried.suppressed" class="mem-meta">
          筛掉的原因：{{ Object.entries(tried.suppressed).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join('、') || '（没有被筛掉的）' }}
        </p>
        <p v-if="!tried.picked.length" class="mem-meta">
          卡片一条都没给。这时候纸条上会**明说没搜到、让他自己去搜**——
          每轮都摆着几条「已记得」的话，他就再也不会主动翻记忆了。
        </p>
        <template v-if="tried.quotes.length">
          <p class="mem-why">
            原话（一字不改，{{ tried.quoteSpan.total }} 次里最像的几条{{ tried.quoteSpan.first ? '，最早 ' + whenDate(tried.quoteSpan.first) : '' }}）：
          </p>
          <p v-for="q in tried.quotes" :key="q.seq" class="mem-body">
            {{ when(q.ts) }}　{{ q.who }}：{{ q.text }}
          </p>
        </template>
      </div>

      <div v-if="grad" class="mem-item">
        <div class="mem-head">
          <span class="mem-title">能不能切成真给他</span>
          <span class="mem-tag">{{ grad.ready ? '条件齐了' : '还差几件' }}</span>
          <span class="mem-spacer"></span>
          <button class="mem-btn" :disabled="busy" @click="doReplay">回放最近 30 轮</button>
        </div>
        <p class="mem-meta">
          影子 {{ grad.shadowDays ?? 0 }} 天 · 观测 {{ grad.shadowTurns }} 轮 · 你抽看过 {{ grad.spotChecked }} 条{{ grad.wrongMarked ? `（其中 ${grad.wrongMarked} 条你标了不该给）` : '' }}
        </p>
        <p v-for="(m, i) in grad.missing" :key="i" class="mem-unsure">· {{ m }}</p>
      </div>

      <template v-if="replay">
        <div class="mem-stats">
          <span>回放 {{ replay.turns }} 轮</span>
          <span>给了东西的 {{ replay.withPicks }} 轮</span>
          <span>平均 {{ replay.avgPicked }} 条</span>
        </div>
        <p class="mem-meta">
          下面是「那一轮如果给了他，会给什么」。他当时**没看到**这些，所以「他回复里对上」的比例天然很低，
          别拿它当准确率——**准不准要你自己看**：不该给的点「不该给」，会记进错题本。
        </p>
        <div v-for="(it, i) in replay.items.slice().reverse()" :key="i" class="mem-item">
          <div class="mem-head">
            <span class="mem-title">{{ it.said }}</span>
            <span class="mem-tag">{{ when(it.at) }}</span>
          </div>
          <p v-if="it.empty" class="mem-meta">一条都没给（纸条上会明说没搜到）</p>
          <p v-for="p in it.picked" :key="p.id" class="mem-why">
            ✓ {{ p.title }}（{{ p.score.toFixed(2) }}｜字 {{ p.lex.toFixed(2) }} / 义 {{ p.sem.toFixed(2) }}）{{ p.why }}
            <button class="mem-link" :disabled="busy" @click="mark(it, p, 'wrong')">不该给</button>
            <button class="mem-link" :disabled="busy" @click="mark(it, p, 'right')">该给</button>
          </p>
          <p v-if="it.quotes" class="mem-meta">还会给 {{ it.quotes }} 条原话</p>
        </div>
      </template>

      <div v-if="vindex" class="mem-item">
        <div class="mem-head">
          <span class="mem-title">语义索引</span>
          <span class="mem-tag">{{ vindex.model || '没配' }}</span>
          <span class="mem-spacer"></span>
          <button class="mem-btn" :disabled="busy || !vindex.configured" @click="rebuildIndex">算一遍</button>
        </div>
        <p class="mem-meta">
          {{ vindex.indexed }} / {{ vindex.total }} 条卡片算过向量；问过的句子缓存了 {{ vindex.queryCache }} 条。
          卡片向量一次性算好，聊天时只用缓存里的查询向量——这条路上一毫秒都不等网络。
        </p>
      </div>

      <div class="mem-item">
        <div class="mem-head">
          <span class="mem-title">说法对照表</span>
          <span class="mem-spacer"></span>
          <button class="mem-btn" :disabled="busy" @click="newAlias">+ 加一组</button>
        </div>
        <p class="mem-meta">
          你说「我妈」、他记成「妈妈」——对照表让两种说法互相认得。
          人物卡上的名字和别名自动算，例假/大姨妈这类出厂就带了几组。
        </p>
        <p v-for="a in aliases" :key="a.id" class="mem-why">
          「{{ a.term }}」=「{{ a.canonical }}」
          <button class="mem-link" :disabled="busy" @click="dropAlias(a.id)">删</button>
        </p>
      </div>
      <template v-if="recall">
        <div class="mem-stats">
          <span>一共算过 {{ recall.total }} 条</span>
          <span v-for="(n, k) in recall.byState" :key="k">{{ STATE_NAMES[k] || k }} {{ n }}</span>
          <span v-if="recall.usedRate !== null">用上的比例 {{ Math.round(recall.usedRate * 100) }}%</span>
        </div>
        <div v-for="(d, i) in recall.recent" :key="i" class="mem-item">
          <div class="mem-head">
            <span class="mem-title">{{ d.title }}</span>
            <span class="mem-tag">{{ STATE_NAMES[d.state] || d.state }}</span>
            <span v-if="d.score" class="mem-tag">{{ d.score.toFixed(2) }}</span>
          </div>
          <p class="mem-meta">她当时说：{{ d.query }}</p>
        </div>
      </template>
    </template>

    <!-- 旧卡重整的建议 -->
    <template v-else-if="tab === 'fix'">
      <p class="mem-hint">
        旧卡太碎的话，让程序看一批、提建议：合并、拆开、换层、补「为什么记」。
        <b>它一个字都改不了他的原文</b>——要拆开只能从原文里原样复制片段，改过字的建议会直接作废。
        采不采纳你说。
      </p>
      <div class="mem-bulk">
        <button class="mem-btn" :disabled="busy" @click="rejudge">看一批（20 张）</button>
        <span class="mem-spacer"></span>
        <template v-if="proposals.length">
          <label class="mem-flag"><input type="checkbox" :checked="allFixPicked" @change="pickAllFix" />全选</label>
          <button class="mem-btn" :disabled="!picked.size || busy" @click="decideFix([...picked], 'drop')">不采纳</button>
          <button class="mem-btn primary" :disabled="!picked.size || busy" @click="decideFix([...picked], 'take')">采纳</button>
        </template>
      </div>
      <p v-if="rejudgeMsg" class="mem-meta">{{ rejudgeMsg }}</p>
      <p v-if="!proposals.length" class="mem-empty">现在没有待处理的建议。</p>
      <div v-for="p in proposals" :key="p.id" class="mem-item">
        <div class="mem-head">
          <input type="checkbox" :checked="picked.has(p.id)" @change="toggle(p.id)" />
          <span class="mem-tag">{{ kindName(p.kind) }}</span>
          <span class="mem-title" @click="toggleBody(p.id)">{{ p.memory?.title || ('#' + p.memoryId) }}</span>
          <span class="mem-tag">{{ layerName(p.memory?.layer || '') }}</span>
          <span class="mem-tag">{{ p.memory?.subjectLabel }}</span>
          <span v-if="p.memory?.voice === 'machine'" class="mem-tag">程序整理的</span>
        </div>
        <p class="mem-unsure">{{ p.reason }}</p>
        <p v-if="p.kind === 'why'" class="mem-why">草稿：{{ p.payload.why }}</p>
        <p v-if="p.kind === 'relayer'" class="mem-why">{{ layerName(p.payload.from) }} → {{ layerName(p.payload.to) }}</p>
        <template v-if="p.kind === 'split'">
          <p v-for="(part, i) in p.payload.parts" :key="i" class="mem-body">［{{ part.subject }}］{{ part.quote }}</p>
        </template>
        <template v-if="expanded.has(p.id)">
          <p class="mem-body">{{ p.memory?.fact }}</p>
          <p v-if="p.memory?.why" class="mem-meta">原来的为什么记：{{ p.memory.why }}</p>
        </template>
        <div class="mem-row">
          <button class="mem-link" @click="toggleBody(p.id)">{{ expanded.has(p.id) ? '收起' : '看原卡' }}</button>
          <span class="mem-spacer"></span>
          <button class="mem-btn" :disabled="busy" @click="decideFix([p.id], 'drop')">不采纳</button>
          <button class="mem-btn primary" :disabled="busy" @click="decideFix([p.id], 'take')">采纳</button>
        </div>
      </div>
    </template>

    <!-- 库里的 -->
    <template v-else>
      <p v-if="!list.length" class="mem-empty">{{ tab === 'review' ? '没有等着看的。' : '库里还没有东西。' }}</p>
      <div v-for="m in list" :key="m.id" class="mem-item">
        <div class="mem-head">
          <span class="mem-title" @click="toggleMemory(m.id)">{{ m.title || '（没写标题）' }}</span>
          <span class="mem-tag">{{ layerName(m.layer) }}</span>
          <span class="mem-tag">{{ m.subjectLabel }}</span>
          <span v-if="m.grade === 'resident'" class="mem-tag">常驻</span>
          <span v-if="m.bucket_id" class="mem-tag">从 OB 搬来</span>
          <span v-if="m.privacy === 'private'" class="mem-tag priv">私密</span>
        </div>
        <p v-if="m.review_note" class="mem-unsure">{{ m.review_note }}</p>
        <p v-if="m.why" class="mem-why">为什么记：{{ m.why }}</p>
        <template v-if="expanded.has(m.id)">
          <p class="mem-body">{{ m.fact_body }}</p>
          <p v-if="m.feeling" class="mem-feeling">{{ m.feeling }}</p>
          <p v-if="m.privacy === 'private'" class="mem-meta">私密：夜里整理不读它，群聊和别的 AI 永远拿不到。</p>
          <p class="mem-meta">
            {{ when(m.created_at, true) }}
            · {{ m.voice === 'machine' ? '程序整理的' : '他自己写的' }}
            {{ m.tags.length ? ' · ' + m.tags.slice(0, 8).join('、') : '' }}
          </p>
          <template v-if="details[m.id]">
            <p v-for="r in details[m.id].relations" :key="r.id" class="mem-meta">
              连着「{{ r.other.title }}」· {{ r.kindLabel }}{{ r.auto ? '（自动连的）' : '' }}{{ r.reason ? ' · ' + r.reason : '' }}
            </p>
            <p v-for="c in details[m.id].corrections" :key="'c' + c.id" class="mem-unsure">
              便条：{{ c.note }}
              <template v-if="c.status === 'open'">（他还没看到）</template>
              <template v-else-if="c.status === 'accepted'">（他认了：{{ c.hisReply }}）</template>
              <template v-else-if="c.status === 'kept'">（他留着原样：{{ c.hisReply }}）</template>
            </p>
          </template>
        </template>
        <div class="mem-row">
          <button class="mem-link" @click="toggleMemory(m.id)">{{ expanded.has(m.id) ? '收起' : '看全文' }}</button>
          <span class="mem-spacer"></span>
          <button class="mem-btn" :disabled="busy" @click="flipPrivate(m)">{{ m.privacy === 'private' ? '取消私密' : '设为私密' }}</button>
          <button class="mem-btn" :disabled="busy" @click="stickNote(m)">贴便条</button>
          <button class="mem-btn danger" :disabled="busy" @click="strike(m)">划掉</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mem { display: flex; flex-direction: column; gap: 10px; margin-bottom: 8px; }
.mem-hint { font-size: 12px; line-height: 1.6; color: var(--text-2); }
.mem-stats { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11.5px; color: var(--text-3); }
.mem-tabs { display: flex; gap: 6px; }
.mem-tab {
  border: none; border-radius: 9px; padding: 5px 11px; font-size: 12.5px;
  background: rgba(255, 255, 255, 0.5); color: var(--text-2);
}
.mem-tab.on { background: var(--accent); color: #fff; }
.mem-dot { margin-left: 5px; font-size: 11px; opacity: 0.85; }
.mem-err { font-size: 12px; color: var(--danger); }
.mem-empty { font-size: 12.5px; color: var(--text-3); }
.mem-bulk { display: flex; align-items: center; gap: 10px; }
.mem-item {
  border: 1px solid rgba(0, 0, 0, 0.08); border-radius: 12px; padding: 10px 12px;
  background: var(--glass-bg-soft); display: flex; flex-direction: column; gap: 5px;
}
.mem-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.mem-title { font-weight: 600; font-size: 13.5px; color: var(--text); }
.mem-tag { font-size: 10.5px; color: var(--text-3); border: 1px solid rgba(127, 127, 127, 0.3); border-radius: 6px; padding: 0 5px; }
.mem-tag.priv { color: var(--accent); border-color: var(--accent); }
.mem-why { font-size: 12px; color: var(--text-2); }
.mem-unsure { font-size: 12px; color: var(--text-2); opacity: 0.9; }
.mem-body { font-size: 12.5px; line-height: 1.6; color: var(--text); white-space: pre-wrap; }
.mem-feeling { font-size: 12.5px; line-height: 1.6; color: var(--text-2); white-space: pre-wrap; }
.mem-meta { font-size: 11.5px; color: var(--text-3); }
.mem-row { display: flex; align-items: center; gap: 8px; }
.mem-spacer { flex: 1; }
.mem-link { border: none; background: none; padding: 0; font-size: 12px; color: var(--text-3); }
.mem-btn {
  border: none; border-radius: 9px; padding: 5px 10px; font-size: 12.5px;
  background: rgba(255, 255, 255, 0.6); color: var(--text);
}
.mem-btn.primary { background: var(--accent); color: #fff; }
.mem-btn.danger { color: var(--danger); }
.mem-btn:disabled { opacity: 0.5; }
.mem-flag { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-2); }
.mem-flag input, .mem-head input { accent-color: var(--accent); }
</style>
