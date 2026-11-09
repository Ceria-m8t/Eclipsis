<script setup lang="ts">
// 设置页「他的工具箱」：聊天和醒来共用的箱子（后端 server/src/toolbox.ts）。
// 内置的（记忆库、心潮、Leto、小镇、醒来设置）只能开关；她自己加的可以改、删。令牌只存在后端，这里只看到打码的。
import { ref, onMounted } from 'vue'
import { listToolbox, saveBox, setBoxFlags, deleteBox, testBox, type BoxInfo } from '../toolbox'
import type { McpServer } from '../mcp'

const props = defineProps<{ legacy: McpServer[] }>()
const emit = defineEmits<{ (e: 'moved', id: string): void }>()

const boxes = ref<BoxInfo[]>([])
const err = ref('')
const msg = ref<Record<string, string>>({})
const busy = ref('')
interface Draft { id?: string; title: string; entryName: string; description: string; url: string; token: string; chat: boolean; wake: boolean; fromLegacy?: string }
const draft = ref<Draft | null>(null)

async function reload() {
  try { boxes.value = await listToolbox(); err.value = '' } catch (e: any) { err.value = e.message }
}
onMounted(reload)

async function flip(b: BoxInfo, key: 'chat' | 'wake') {
  busy.value = b.id + key
  try { await setBoxFlags(b.id, { [key]: !b[key] }); b[key] = !b[key] } catch (e: any) { msg.value[b.id] = e.message }
  busy.value = ''
}
async function test(b: BoxInfo) {
  busy.value = b.id + 'test'
  msg.value[b.id] = '正在问…'
  const r: { ok: boolean; tools?: string[]; error?: string } = await testBox(b.id).catch((e: any) => ({ ok: false, error: String(e.message) }))
  msg.value[b.id] = r.ok ? `能连上，${r.tools!.length} 个工具：${r.tools!.join('、')}` : `连不上：${r.error}`
  busy.value = ''
}
function edit(b?: BoxInfo) {
  draft.value = b
    ? { id: b.id, title: b.title, entryName: b.entryName, description: b.description, url: '', token: '', chat: b.chat, wake: b.wake }
    : { title: '', entryName: 'open_', description: '', url: '', token: '', chat: true, wake: true }
}
function fromLegacy(s: McpServer) {
  const slug = (s.name || 'tools').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'tools'
  draft.value = {
    title: s.name || '新箱子', entryName: 'open_' + (/^[a-z]/.test(slug) ? slug : 'box_' + slug).slice(0, 24),
    description: s.tools.length ? `里面有：${s.tools.slice(0, 8).map(t => t.name).join('、')}${s.tools.length > 8 ? ' 等' : ''}` : '',
    url: s.url, token: s.token, chat: true, wake: true, fromLegacy: s.id,
  }
}
async function save() {
  const d = draft.value
  if (!d) return
  if (d.id && !d.url) { msg.value.draft = '改的时候要重新填一下地址（地址里可能带着令牌，所以这里不显示原来的）'; return }
  busy.value = 'save'
  try {
    await saveBox({ id: d.id, title: d.title, entryName: d.entryName, description: d.description, url: d.url, token: d.token, chat: d.chat, wake: d.wake })
    if (d.fromLegacy) emit('moved', d.fromLegacy)
    draft.value = null
    msg.value.draft = ''
    await reload()
  } catch (e: any) { msg.value.draft = e.message }
  busy.value = ''
}
async function remove(b: BoxInfo) {
  if (!confirm(`删掉「${b.title}」这个箱子？聊天和醒来都不会再有它。`)) return
  try { await deleteBox(b.id); await reload() } catch (e: any) { msg.value[b.id] = e.message }
}
</script>

<template>
  <div class="toolbox">
    <p class="tb-hint">他聊天时和自己醒来时用的是同一套箱子：手边先只有每个箱子的入口，打开了才拿到里面的工具（省 token）。以后加新工具就在这里加一个箱子，「聊天」「醒来」各一个开关。</p>
    <p v-if="err" class="tb-err">{{ err }}</p>

    <div v-for="b in boxes" :key="b.id" class="tb-item">
      <div class="tb-head">
        <span class="tb-title">{{ b.title }}</span>
        <code class="tb-entry">{{ b.entryName }}</code>
        <span v-if="b.builtin" class="tb-badge">内置</span>
      </div>
      <p class="tb-desc">{{ b.description }}</p>
      <div class="tb-row">
        <label class="tb-flag"><input type="checkbox" :checked="b.chat" :disabled="!!busy" @change="flip(b, 'chat')" />聊天</label>
        <label class="tb-flag"><input type="checkbox" :checked="b.wake" :disabled="!!busy" @change="flip(b, 'wake')" />醒来</label>
        <span class="tb-spacer"></span>
        <button class="tb-btn" :disabled="!!busy" @click="test(b)">测试</button>
        <template v-if="!b.builtin">
          <button class="tb-btn" @click="edit(b)">改</button>
          <button class="tb-btn danger" @click="remove(b)">删</button>
        </template>
      </div>
      <p v-if="!b.builtin" class="tb-meta">{{ b.url }}{{ b.token ? ' · 令牌 ' + b.token : '' }}</p>
      <p v-if="msg[b.id]" class="tb-meta">{{ msg[b.id] }}</p>
    </div>

    <div v-if="draft" class="tb-item tb-form">
      <input v-model="draft.title" class="wb-title-input" placeholder="名字（比如：网易云音乐）" />
      <input v-model="draft.entryName" class="wb-title-input" placeholder="入口名：open_ 开头，小写英文（比如 open_music）" autocapitalize="off" />
      <textarea v-model="draft.description" class="wb-title-input" rows="2" placeholder="一句话说明：箱子里有什么、什么时候用（他看这句决定要不要打开）"></textarea>
      <input v-model="draft.url" class="wb-title-input" :placeholder="draft.id ? 'MCP 地址（改的时候要重新填）' : 'MCP 地址（http:// 或 https://）'" autocapitalize="off" />
      <input v-model="draft.token" type="password" class="wb-title-input" :placeholder="draft.id ? 'Bearer 令牌（留空 = 不改）' : 'Bearer 令牌（没有就空着）'" />
      <div class="tb-row">
        <label class="tb-flag"><input v-model="draft.chat" type="checkbox" />聊天</label>
        <label class="tb-flag"><input v-model="draft.wake" type="checkbox" />醒来</label>
        <span class="tb-spacer"></span>
        <button class="tb-btn" @click="draft = null">取消</button>
        <button class="tb-btn primary" :disabled="busy === 'save'" @click="save">存好</button>
      </div>
      <p v-if="msg.draft" class="tb-err">{{ msg.draft }}</p>
    </div>
    <button v-else class="wb-add" @click="edit()">+ 加一个箱子</button>

    <template v-if="props.legacy.length">
      <p class="tb-hint">下面这些是以前在这台手机上直接连的 MCP：只有 Eclipsis 聊天里能用，他醒来时用不了。点「搬进工具箱」就会变成上面的一个箱子，搬完这里那条会关掉。</p>
      <div v-for="s in props.legacy" :key="s.id" class="tb-legacy">
        <span>{{ s.name || s.url }}{{ s.enabled ? '' : '（关着）' }} · {{ s.tools.length }} 个工具</span>
        <button class="tb-btn" @click="fromLegacy(s)">搬进工具箱</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.toolbox { display: flex; flex-direction: column; gap: 10px; margin-bottom: 8px; }
.tb-hint { font-size: 12px; line-height: 1.6; color: var(--text-2); }
.tb-err { font-size: 12px; color: var(--danger); }
.tb-item {
  border: 1px solid rgba(0, 0, 0, 0.08); border-radius: 12px; padding: 10px 12px;
  background: var(--glass-bg-soft); display: flex; flex-direction: column; gap: 6px;
}
.tb-form { gap: 8px; }
.tb-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tb-title { font-weight: 600; font-size: 14px; color: var(--text); }
.tb-entry { font-size: 11.5px; color: var(--text-3); }
.tb-badge { font-size: 10.5px; color: var(--text-3); border: 1px solid rgba(127, 127, 127, 0.3); border-radius: 6px; padding: 0 5px; }
.tb-desc { font-size: 12.5px; line-height: 1.55; color: var(--text-2); }
.tb-row { display: flex; align-items: center; gap: 10px; }
.tb-spacer { flex: 1; }
.tb-flag { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-2); }
.tb-flag input { accent-color: var(--accent); }
.tb-btn {
  border: none; border-radius: 9px; padding: 5px 10px; font-size: 12.5px;
  background: rgba(255, 255, 255, 0.6); color: var(--text);
}
.tb-btn.primary { background: var(--accent); color: #fff; }
.tb-btn.danger { color: var(--danger); }
.tb-btn:disabled { opacity: 0.5; }
.tb-meta { font-size: 11.5px; color: var(--text-3); word-break: break-all; }
.tb-legacy { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--text-2); }
textarea.wb-title-input { resize: vertical; font-family: inherit; }
</style>
