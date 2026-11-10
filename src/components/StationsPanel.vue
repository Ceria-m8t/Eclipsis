<script setup lang="ts">
// 设置页「中转站」：聊天的站 + 画图的站。以前在 Leto 管理页里，切完还要回来再拉一次模型列表（11-11 搬过来）。
// 密钥只存在后端，这里只看到打码的；改的时候地址要重填（地址里可能带着密钥）。
import { ref, onMounted } from 'vue'
import {
  listChatStations, saveChatStation, switchChatStation, deleteChatStation, stationModels, testChatStation,
  listImageStations, saveImageStation, switchImageStation, deleteImageStation, imageStationModels, testImageStation,
  type ChatStationList, type ImageStationList, type DrawMode,
} from '../stations'
import { getSettings, saveSettings } from '../settings'

const chat = ref<ChatStationList | null>(null)
const img = ref<ImageStationList | null>(null)
const err = ref('')
const busy = ref('')
const msg = ref<Record<string, string>>({})
const models = ref<Record<string, string[]>>({})

interface ChatDraft { id?: string; name: string; url: string; key: string; defaultModel: string }
interface ImgDraft { id?: string; name: string; url: string; key: string; model: string; size: string; mode: DrawMode }
const chatDraft = ref<ChatDraft | null>(null)
const imgDraft = ref<ImgDraft | null>(null)

async function reload() {
  try {
    const [a, b] = await Promise.all([listChatStations(), listImageStations()])
    chat.value = a; img.value = b; err.value = ''
  } catch (e: any) { err.value = e.message }
}
onMounted(reload)

/** 切站：顺手把聊天用的模型也换成这个站的默认模型（省掉再拉一次列表） */
async function useChat(id: string, defaultModel: string) {
  busy.value = id
  try {
    await switchChatStation(id)
    if (defaultModel) {
      const s = getSettings()
      s.model = defaultModel
      saveSettings(s)
      msg.value[id] = `切过去了，聊天模型也换成了 ${defaultModel}`
    } else {
      msg.value[id] = '切过去了。这个站没填默认模型，记得挑一个'
    }
    await reload()
  } catch (e: any) { msg.value[id] = e.message }
  busy.value = ''
}

async function loadModels(id: string, kind: 'chat' | 'image') {
  busy.value = id + 'models'
  msg.value[id] = '正在问这个站…'
  try {
    const r = kind === 'chat' ? await stationModels(id) : await imageStationModels(id)
    models.value[id] = r.models
    msg.value[id] = r.error || `${r.models.length} 个模型，点一个就设成默认`
  } catch (e: any) { msg.value[id] = e.message }
  busy.value = ''
}

async function pickModel(id: string, kind: 'chat' | 'image', model: string) {
  const st = kind === 'chat' ? chat.value?.stations.find(s => s.id === id) : img.value?.stations.find(s => s.id === id)
  if (!st) return
  busy.value = id
  try {
    if (kind === 'chat') {
      await saveChatStation({ id, name: st.name, url: st.url, defaultModel: model })
      if (chat.value?.active === id) { const s = getSettings(); s.model = model; saveSettings(s) }
    } else {
      await saveImageStation({ id, name: st.name, url: st.url, model })
    }
    msg.value[id] = `默认模型设成了 ${model}`
    await reload()
  } catch (e: any) { msg.value[id] = e.message }
  busy.value = ''
}

async function test(id: string, kind: 'chat' | 'image') {
  busy.value = id + 'test'
  msg.value[id] = kind === 'image' ? '正在画一张小图…' : '正在发一条试试…'
  try {
    if (kind === 'chat') {
      const r = await testChatStation(id)
      msg.value[id] = r.ok ? `通的，${r.ms} 毫秒${r.reply ? `，他回了「${r.reply.slice(0, 20)}」` : ''}` : `不通：${r.error}`
    } else {
      const r = await testImageStation(id)
      msg.value[id] = r.ok
        ? `画出来了（${r.mode === 'images' ? '走 images 接口' : '走聊天接口'}，${Math.round((r.bytes || 0) / 1024)}KB，${((r.ms || 0) / 1000).toFixed(1)} 秒）`
        : `画不出来：${r.error}`
    }
  } catch (e: any) { msg.value[id] = e.message }
  busy.value = ''
}

async function saveChat() {
  const d = chatDraft.value
  if (!d) return
  if (d.id && !d.url) { msg.value.draft = '改的时候要重新填地址（地址里可能带着密钥，所以这里不显示原来的）'; return }
  busy.value = 'save'
  try { await saveChatStation(d); chatDraft.value = null; msg.value.draft = ''; await reload() }
  catch (e: any) { msg.value.draft = e.message }
  busy.value = ''
}
async function saveImg() {
  const d = imgDraft.value
  if (!d) return
  if (d.id && !d.url) { msg.value.draft = '改的时候要重新填地址'; return }
  busy.value = 'save'
  try { await saveImageStation(d); imgDraft.value = null; msg.value.draft = ''; await reload() }
  catch (e: any) { msg.value.draft = e.message }
  busy.value = ''
}

async function removeChat(id: string, name: string) {
  if (!confirm(`删掉「${name}」？`)) return
  try { await deleteChatStation(id); await reload() } catch (e: any) { msg.value[id] = e.message }
}
async function removeImg(id: string, name: string) {
  if (!confirm(`删掉「${name}」？`)) return
  try { await deleteImageStation(id); await reload() } catch (e: any) { msg.value[id] = e.message }
}

const MODE_LABEL: Record<DrawMode, string> = { auto: '自动试', images: 'images 接口', chat: '聊天接口返图' }
</script>

<template>
  <div class="stations">
    <p class="st-hint">
      聊天、他自己醒来、心潮、小克的 Leto 用的是同一个站，点「切过去」立刻生效，不用重启。切站时会顺手把聊天模型换成这个站的默认模型。
    </p>
    <p v-if="err" class="st-err">{{ err }}</p>

    <div class="section-title">聊天的站</div>
    <div v-for="s in chat?.stations || []" :key="s.id" class="st-item">
      <div class="st-head">
        <span class="st-name">{{ s.name }}</span>
        <span v-if="chat?.active === s.id" class="st-badge on">正在用</span>
        <span class="st-spacer"></span>
        <button v-if="chat?.active !== s.id" class="st-btn primary" :disabled="!!busy" @click="useChat(s.id, s.defaultModel)">切过去</button>
      </div>
      <p class="st-meta">{{ s.url }} · 密钥 {{ s.key }}</p>
      <p class="st-meta">默认模型：{{ s.defaultModel || '（没填）' }}</p>
      <div class="st-row">
        <button class="st-btn" :disabled="!!busy" @click="loadModels(s.id, 'chat')">读模型</button>
        <button class="st-btn" :disabled="!!busy" @click="test(s.id, 'chat')">自检</button>
        <span class="st-spacer"></span>
        <button class="st-btn" @click="chatDraft = { id: s.id, name: s.name, url: '', key: '', defaultModel: s.defaultModel }">改</button>
        <button class="st-btn danger" :disabled="chat?.active === s.id" @click="removeChat(s.id, s.name)">删</button>
      </div>
      <div v-if="models[s.id]?.length" class="st-models">
        <button v-for="m in models[s.id]" :key="m" :class="['st-chip', { on: m === s.defaultModel }]" @click="pickModel(s.id, 'chat', m)">{{ m }}</button>
      </div>
      <p v-if="msg[s.id]" class="st-meta">{{ msg[s.id] }}</p>
    </div>

    <div v-if="chatDraft" class="st-item st-form">
      <input v-model="chatDraft.name" class="wb-title-input" placeholder="名字（比如：织云）" />
      <input v-model="chatDraft.url" class="wb-title-input" :placeholder="chatDraft.id ? '地址（改的时候要重填，以 /v1 结尾）' : '地址，以 /v1 结尾'" autocapitalize="off" />
      <input v-model="chatDraft.key" type="password" class="wb-title-input" :placeholder="chatDraft.id ? '密钥（留空 = 不改）' : '密钥'" />
      <input v-model="chatDraft.defaultModel" class="wb-title-input" placeholder="默认模型（可以先空着，存完点「读模型」挑）" autocapitalize="off" />
      <div class="st-row">
        <span class="st-spacer"></span>
        <button class="st-btn" @click="chatDraft = null">取消</button>
        <button class="st-btn primary" :disabled="busy === 'save'" @click="saveChat">存好</button>
      </div>
      <p v-if="msg.draft" class="st-err">{{ msg.draft }}</p>
    </div>
    <button v-else class="wb-add" @click="chatDraft = { name: '', url: '', key: '', defaultModel: '' }">+ 加一个聊天的站</button>

    <div class="section-title">画图的站</div>
    <p class="st-hint">他的画笔和你的「生图」都用这里正在用的那个。不确定接口怎么调就选「自动试」，点自检后会告诉你哪种通。</p>
    <div v-for="s in img?.stations || []" :key="s.id" class="st-item">
      <div class="st-head">
        <span class="st-name">{{ s.name }}</span>
        <span v-if="img?.active === s.id" class="st-badge on">正在用</span>
        <span class="st-spacer"></span>
        <button v-if="img?.active !== s.id" class="st-btn primary" :disabled="!!busy" @click="switchImageStation(s.id).then(reload)">切过去</button>
      </div>
      <p class="st-meta">{{ s.url }} · 密钥 {{ s.key }}</p>
      <p class="st-meta">模型：{{ s.model || '（没填）' }} · 尺寸：{{ s.size || '站的默认' }} · {{ MODE_LABEL[s.mode] }}</p>
      <div class="st-row">
        <button class="st-btn" :disabled="!!busy" @click="loadModels(s.id, 'image')">读模型</button>
        <button class="st-btn" :disabled="!!busy" @click="test(s.id, 'image')">自检（画一张）</button>
        <span class="st-spacer"></span>
        <button class="st-btn" @click="imgDraft = { id: s.id, name: s.name, url: '', key: '', model: s.model, size: s.size, mode: s.mode }">改</button>
        <button class="st-btn danger" @click="removeImg(s.id, s.name)">删</button>
      </div>
      <div v-if="models[s.id]?.length" class="st-models">
        <button v-for="m in models[s.id]" :key="m" :class="['st-chip', { on: m === s.model }]" @click="pickModel(s.id, 'image', m)">{{ m }}</button>
      </div>
      <p v-if="msg[s.id]" class="st-meta">{{ msg[s.id] }}</p>
    </div>

    <div v-if="imgDraft" class="st-item st-form">
      <input v-model="imgDraft.name" class="wb-title-input" placeholder="名字（比如：画图站）" />
      <input v-model="imgDraft.url" class="wb-title-input" :placeholder="imgDraft.id ? '地址（改的时候要重填）' : '地址，以 /v1 结尾'" autocapitalize="off" />
      <input v-model="imgDraft.key" type="password" class="wb-title-input" :placeholder="imgDraft.id ? '密钥（留空 = 不改）' : '密钥'" />
      <input v-model="imgDraft.model" class="wb-title-input" placeholder="模型名（走聊天接口返图的必须填）" autocapitalize="off" />
      <input v-model="imgDraft.size" class="wb-title-input" placeholder="尺寸，如 1024x1024（可留空）" autocapitalize="off" />
      <label class="st-mode">
        接口
        <select v-model="imgDraft.mode">
          <option value="auto">自动试</option>
          <option value="images">images 接口</option>
          <option value="chat">聊天接口返图</option>
        </select>
      </label>
      <div class="st-row">
        <span class="st-spacer"></span>
        <button class="st-btn" @click="imgDraft = null">取消</button>
        <button class="st-btn primary" :disabled="busy === 'save'" @click="saveImg">存好</button>
      </div>
      <p v-if="msg.draft" class="st-err">{{ msg.draft }}</p>
    </div>
    <button v-else class="wb-add" @click="imgDraft = { name: '', url: '', key: '', model: '', size: '', mode: 'auto' }">+ 加一个画图的站</button>
  </div>
</template>

<style scoped>
.stations { display: flex; flex-direction: column; gap: 10px; }
.st-hint { font-size: 12px; line-height: 1.6; color: var(--text-2); }
.st-err { font-size: 12px; color: var(--danger); }
.st-item {
  border: 1px solid rgba(0, 0, 0, 0.08); border-radius: 12px; padding: 10px 12px;
  background: var(--glass-bg-soft); display: flex; flex-direction: column; gap: 6px;
}
.st-form { gap: 8px; }
.st-head { display: flex; align-items: center; gap: 8px; }
.st-name { font-weight: 600; font-size: 14px; color: var(--text); }
.st-badge { font-size: 10.5px; border-radius: 6px; padding: 1px 6px; border: 1px solid rgba(127, 127, 127, 0.3); color: var(--text-3); }
.st-badge.on { border-color: var(--accent); color: var(--accent); }
.st-spacer { flex: 1; }
.st-meta { font-size: 11.5px; line-height: 1.5; color: var(--text-3); word-break: break-all; }
.st-row { display: flex; align-items: center; gap: 8px; }
.st-btn { border: none; border-radius: 9px; padding: 5px 10px; font-size: 12.5px; background: rgba(255, 255, 255, 0.6); color: var(--text); }
.st-btn.primary { background: var(--accent); color: #fff; }
.st-btn.danger { color: var(--danger); }
.st-btn:disabled { opacity: 0.5; }
.st-models { display: flex; flex-wrap: wrap; gap: 6px; max-height: 148px; overflow-y: auto; }
.st-chip {
  border: 1px solid rgba(127, 127, 127, 0.28); border-radius: 8px; padding: 3px 8px;
  font-size: 11.5px; background: transparent; color: var(--text-2);
}
.st-chip.on { border-color: var(--accent); color: var(--accent); }
.st-mode { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-2); }
.st-mode select { flex: 1; padding: 6px; border-radius: 8px; border: 1px solid rgba(127, 127, 127, 0.3); background: rgba(255, 255, 255, 0.6); color: var(--text); }
</style>
