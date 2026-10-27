<script setup lang="ts">
// "这一轮发了什么"：读后端记下的这条回复每一轮（有工具调用时不止一轮）的耗时、发了多少、一路被补了什么
import { ref, onMounted } from 'vue'

const props = defineProps<{ turn: string; version: number }>()
const emit = defineEmits<{ close: [] }>()

interface Msg { role: string; chars: number; images: number; tool_calls: number; origin: 'frontend' | 'gateway'; preview: string }
interface Round {
  rid: string
  started_at: string
  model: string | null
  status: string
  error: string | null
  front: { ttfb_ms: number | null; first_token_ms: number | null; latency_ms: number | null; client_closed_ms: number | null } | null
  upstream: { ttfb_ms: number | null; first_token_ms: number | null; latency_ms: number | null; status: string; error: string | null } | null
  transforms: { strip_wake_history?: { stripped: number; saved_chars: number } } | null
  sent: { messages: number; chars: number; system_chars: number } | null
  delivered: { messages: number; chars: number; from_frontend: number; from_gateway: number; gateway_chars: number } | null
  messages: Msg[]
  reply: { chars: number; thinking_chars: number; tool_calls: string[]; finish_reason: string | null }
}

const state = ref<'loading' | 'ok' | 'error'>('loading')
const errorText = ref('')
const rounds = ref<Round[]>([])

onMounted(async () => {
  try {
    const res = await fetch(`/api/eclipsis/turn/${encodeURIComponent(props.turn)}?version=${props.version}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    rounds.value = (await res.json()).rounds || []
    state.value = 'ok'
  } catch (e: any) {
    errorText.value = e?.message || String(e)
    state.value = 'error'
  }
})

const sec = (ms: number | null | undefined) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} 秒`)
const num = (n: number | null | undefined) => (n == null ? '—' : n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n))
const time = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const STATUS: Record<string, string> = {
  ok: '正常', pending: '进行中', http_error: '出错', network_error: '连接断了', aborted: '中途停了'
}
const ROLE: Record<string, string> = { system: '提示词', user: '她', assistant: '他', tool: '工具' }

// 一句话结论：哪里慢、谁断的
function verdict(r: Round): string {
  if (r.status === 'pending') return '还在进行中'
  if (r.front?.client_closed_ms != null) return `网页在第 ${sec(r.front.client_closed_ms)} 断开了（停止生成、切走或网络断了）`
  if (r.upstream?.status === 'http_error' || r.status === 'http_error') return '中转站返回了错误'
  if (r.status === 'network_error') return '连不上（看下面的错误）'
  const first = r.upstream?.first_token_ms
  if (first != null && first > 60_000) return '中转站很慢才开始回'
  return '正常'
}
</script>

<template>
  <div class="td">
    <div class="sheet-title">这一轮发了什么</div>

    <p v-if="state === 'loading'" class="td-note" aria-live="polite">读取中…</p>
    <p v-else-if="state === 'error'" class="td-note err" role="alert">读不到记录：{{ errorText }}</p>
    <p v-else-if="!rounds.length" class="td-note">后端没有这条回复的记录。10 月 28 日之前的消息、或者不是从这里发的，都没有。</p>

    <section v-for="(r, i) in rounds" :key="r.rid" class="td-round" :aria-label="`第 ${i + 1} 轮`">
      <h3 class="td-h">
        <span>{{ rounds.length > 1 ? `第 ${i + 1} 轮` : '这一轮' }} · {{ time(r.started_at) }}</span>
        <span class="td-badge" :class="r.status">{{ STATUS[r.status] || r.status }}</span>
      </h3>
      <p class="td-verdict">{{ verdict(r) }}</p>

      <dl class="td-grid">
        <dt>开始回复</dt><dd>{{ sec(r.upstream?.ttfb_ms ?? r.front?.ttfb_ms) }}</dd>
        <dt>第一个字</dt><dd>{{ sec(r.upstream?.first_token_ms ?? r.front?.first_token_ms) }}</dd>
        <dt>回完</dt><dd>{{ sec(r.front?.latency_ms) }}</dd>
        <dt>模型</dt><dd class="td-model">{{ r.model || '—' }}</dd>
      </dl>

      <dl class="td-grid">
        <template v-if="r.sent">
          <dt>网页发出</dt><dd>{{ r.sent.messages }} 条 · {{ num(r.sent.chars) }} 字</dd>
          <dt>其中提示词</dt><dd>{{ num(r.sent.system_chars) }} 字</dd>
        </template>
        <template v-if="r.delivered">
          <dt>实际给他</dt><dd>{{ r.delivered.messages }} 条 · {{ num(r.delivered.chars) }} 字</dd>
          <dt>一路补进来</dt><dd>{{ r.delivered.from_gateway }} 条 · {{ num(r.delivered.gateway_chars) }} 字</dd>
        </template>
        <template v-if="r.transforms?.strip_wake_history">
          <dt>剪掉旧唤醒</dt><dd>{{ r.transforms.strip_wake_history.stripped }} 条 · 省 {{ num(r.transforms.strip_wake_history.saved_chars) }} 字</dd>
        </template>
        <dt>他回了</dt>
        <dd>
          {{ num(r.reply.chars) }} 字<template v-if="r.reply.thinking_chars"> · 思考 {{ num(r.reply.thinking_chars) }} 字</template>
          <template v-if="r.reply.tool_calls.length"> · 调用 {{ r.reply.tool_calls.join('、') }}</template>
        </dd>
      </dl>

      <p v-if="r.error || r.upstream?.error" class="td-note err">{{ r.error || r.upstream?.error }}</p>

      <details v-if="r.messages.length" class="td-list">
        <summary>逐条看（{{ r.messages.length }} 条，灰色是一路补进来的）</summary>
        <ol>
          <li v-for="(m, j) in r.messages" :key="j" :class="{ gw: m.origin === 'gateway' }">
            <span class="td-role">{{ ROLE[m.role] || m.role }}</span>
            <span class="td-chars">{{ num(m.chars) }}<template v-if="m.images"> · 图{{ m.images }}</template><template v-if="m.tool_calls"> · 调用{{ m.tool_calls }}</template></span>
            <span class="td-prev">{{ m.preview || '（空）' }}</span>
          </li>
        </ol>
      </details>
    </section>

    <button class="sheet-btn" @click="emit('close')">完成</button>
  </div>
</template>

<style scoped>
.td { display: flex; flex-direction: column; }
.td-note { font-size: 13px; color: var(--text-2); padding: 6px 10px; line-height: 1.5; }
.td-note.err { color: var(--danger); word-break: break-all; }
.td-round {
  margin: 4px 4px 10px;
  padding: 10px 12px;
  border-radius: 18px;
  background: var(--glass-bg-soft);
}
.td-h {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 14px; font-weight: 600; margin-bottom: 2px;
}
.td-badge {
  font-size: 11px; font-weight: 500;
  padding: 2px 8px; border-radius: 10px;
  background: rgba(111, 134, 184, 0.16); color: var(--accent);
}
.td-badge.http_error, .td-badge.network_error { background: rgba(208, 86, 106, 0.14); color: var(--danger); }
.td-badge.aborted, .td-badge.pending { background: rgba(0, 0, 0, 0.06); color: var(--text-2); }
.td-verdict { font-size: 12px; color: var(--text-2); margin-bottom: 6px; }
.td-grid {
  display: grid; grid-template-columns: auto 1fr; gap: 4px 12px;
  font-size: 13px; padding: 6px 0;
  border-top: 1px solid rgba(0, 0, 0, 0.05);
}
.td-grid dt { color: var(--text-2); }
.td-grid dd { text-align: right; font-variant-numeric: tabular-nums; }
.td-model { word-break: break-all; font-size: 12px; }
.td-list { font-size: 12px; border-top: 1px solid rgba(0, 0, 0, 0.05); padding-top: 6px; }
.td-list summary { color: var(--accent); padding: 4px 0; cursor: pointer; }
.td-list ol { list-style: none; max-height: 40vh; overflow-y: auto; }
.td-list li {
  display: grid; grid-template-columns: 3em 5.5em 1fr; gap: 6px;
  padding: 3px 0; border-bottom: 1px solid rgba(0, 0, 0, 0.03);
}
.td-list li.gw { color: var(--text-3); }
.td-role { font-weight: 500; }
.td-chars { font-variant-numeric: tabular-nums; text-align: right; }
.td-prev { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
