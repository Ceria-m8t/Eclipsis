<script setup lang="ts">
// 设置页「垫图和画风」（2026-11-11）：
// 垫图 = 几张固定参考图（她、小克、糯糯、家），他画图时按名字挑，画出来才是他们俩。
// 画风 = 几段提示词，设一个默认；她和他都不用每次写风格。以后加真人照片就再加一个画风、切默认。
import { ref, onMounted } from 'vue'
import Icon from './Icon.vue'
import { compressImage } from '../image'
import {
  drawInfo, uploadRef, editRef, deleteRef, deleteRefPhoto, saveStyle, setDefaultStyle, deleteStyle,
  type DrawInfo, type DrawRefInfo, type DrawStyleInfo,
} from '../draw'

const info = ref<DrawInfo | null>(null)
const err = ref('')
const busy = ref('')
const msg = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const pendingName = ref('')
const pendingNote = ref('')
// 往已有的名字下面再加一张时，记住是哪个
const addingTo = ref<DrawRefInfo | null>(null)
const styleDraft = ref<{ id?: string; name: string; prompt: string; isDefault: boolean } | null>(null)

async function reload() {
  try { info.value = await drawInfo(); err.value = '' } catch (e: any) { err.value = e.message }
}
onMounted(reload)

function pick() {
  if (!pendingName.value.trim()) { msg.value = '先给这张垫图起个名字（他按名字挑，比如「她」「小克」）'; return }
  addingTo.value = null
  msg.value = ''
  fileInput.value?.click()
}

/** 往这个名字下面再加一张（不同角度，画出来更像） */
function addPhoto(r: DrawRefInfo) {
  addingTo.value = r
  msg.value = ''
  fileInput.value?.click()
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  const target = addingTo.value
  busy.value = 'upload'
  try {
    // 垫图压到 1024 够模型看清，省上传时间
    const dataUrl = await compressImage(f, 1024, 0.92)
    const blob = await (await fetch(dataUrl)).blob()
    if (target) {
      await uploadRef(blob, target.name, target.note, target.byDefault)
      msg.value = `「${target.name}」又多了一张`
    } else {
      await uploadRef(blob, pendingName.value.trim(), pendingNote.value.trim(), true)
      pendingName.value = ''
      pendingNote.value = ''
      msg.value = '加好了。同一个人可以多放几张不同角度的，画出来更像'
    }
    await reload()
  } catch (e2: any) { msg.value = e2?.message || '没传上去' }
  addingTo.value = null
  busy.value = ''
}

async function flip(r: DrawRefInfo, key: 'enabled' | 'byDefault') {
  busy.value = r.id
  try { await editRef({ id: r.id, [key]: !r[key] }); await reload() } catch (e: any) { msg.value = e.message }
  busy.value = ''
}
async function rename(r: DrawRefInfo) {
  const name = window.prompt('这张垫图叫什么？（他按这个名字挑）', r.name)?.trim()
  if (!name) return
  const note = window.prompt('一句说明（给他看，比如「长头发，戴眼镜」）', r.note)?.trim() ?? r.note
  busy.value = r.id
  try { await editRef({ id: r.id, name, note }); await reload() } catch (e: any) { msg.value = e.message }
  busy.value = ''
}
async function remove(r: DrawRefInfo) {
  if (!confirm(`删掉垫图「${r.name}」和它下面的 ${r.photos.length} 张图？`)) return
  try { await deleteRef(r.id); await reload() } catch (e: any) { msg.value = e.message }
}
async function removePhoto(r: DrawRefInfo, id: string) {
  if (r.photos.length === 1 && !confirm(`这是「${r.name}」最后一张，删了这个垫图就没了。继续？`)) return
  try { await deleteRefPhoto(id); await reload() } catch (e: any) { msg.value = e.message }
}

async function useStyle(s: DrawStyleInfo) {
  busy.value = s.id
  try { await setDefaultStyle(s.id); await reload() } catch (e: any) { msg.value = e.message }
  busy.value = ''
}
async function saveStyleDraft() {
  const d = styleDraft.value
  if (!d) return
  busy.value = 'style'
  try { await saveStyle(d); styleDraft.value = null; await reload() } catch (e: any) { msg.value = e.message }
  busy.value = ''
}
async function removeStyle(s: DrawStyleInfo) {
  if (!confirm(`删掉画风「${s.name}」？`)) return
  try { await deleteStyle(s.id); await reload() } catch (e: any) { msg.value = e.message }
}
</script>

<template>
  <div class="draw">
    <p class="dw-hint">
      他的画笔和你的「生图」都用这里的设置。<strong>垫图</strong>是固定参考图，他画到你们俩时照着画，
      同一个人可以放好几张不同角度的（一次画图每人最多用 3 张、总共 6 张）；
      <strong>画风</strong>设一个默认就行，他和你都不用每次写风格。
    </p>
    <p v-if="err" class="dw-err">{{ err }}</p>
    <p v-else-if="info && !info.ready" class="dw-err">还没配画图的站（上面那块「画图的站」），画笔不会出现。</p>
    <p v-if="msg" class="dw-meta">{{ msg }}</p>

    <div class="section-title">垫图</div>
    <div v-if="!info?.refs.length" class="dw-meta">还没有。加几张：你、他的形象、糯糯、家里的样子。</div>
    <div v-for="r in info?.refs || []" :key="r.id" class="dw-ref">
      <div class="dw-head">
        <span class="dw-ref-name">{{ r.name }}</span>
        <span class="dw-badge plain">{{ r.photos.length }} 张</span>
        <span class="dw-spacer"></span>
        <button class="dw-btn" :disabled="!!busy" @click="addPhoto(r)">再加一张</button>
        <button class="dw-btn" @click="rename(r)">改</button>
        <button class="dw-btn danger" @click="remove(r)">删</button>
      </div>
      <p class="dw-ref-note">{{ r.note || '（没写说明）' }}</p>
      <div class="dw-photos">
        <div v-for="ph in r.photos" :key="ph.id" class="dw-thumb">
          <img :src="ph.url" :alt="r.name" />
          <button aria-label="删掉这一张" @click="removePhoto(r, ph.id)"><Icon name="close" :size="11" /></button>
        </div>
      </div>
      <div class="dw-row">
        <label class="dw-flag"><input type="checkbox" :checked="r.enabled" :disabled="!!busy" @change="flip(r, 'enabled')" />他能用</label>
        <label class="dw-flag"><input type="checkbox" :checked="r.byDefault" :disabled="!!busy" @change="flip(r, 'byDefault')" />我生图时默认带</label>
      </div>
    </div>

    <div class="dw-add">
      <input v-model="pendingName" class="wb-title-input" placeholder="名字（他按这个挑，比如「她」「小克」）" />
      <input v-model="pendingNote" class="wb-title-input" placeholder="一句说明（给他看，比如「长头发，戴眼镜」）" />
      <button class="dw-btn primary" :disabled="busy === 'upload'" @click="pick">
        {{ busy === 'upload' ? '正在传…' : '选一张图加进来' }}
      </button>
      <input ref="fileInput" type="file" accept="image/*" hidden @change="onFile" />
    </div>

    <div class="section-title">画风</div>
    <div v-for="s in info?.styles || []" :key="s.id" class="dw-style">
      <div class="dw-head">
        <span class="dw-ref-name">{{ s.name }}</span>
        <span v-if="s.isDefault" class="dw-badge">默认</span>
        <span class="dw-spacer"></span>
        <button v-if="!s.isDefault" class="dw-btn" :disabled="!!busy" @click="useStyle(s)">设为默认</button>
        <button class="dw-btn" @click="styleDraft = { id: s.id, name: s.name, prompt: s.prompt, isDefault: s.isDefault }">改</button>
        <button class="dw-btn danger" @click="removeStyle(s)">删</button>
      </div>
      <p class="dw-ref-note">{{ s.prompt }}</p>
    </div>

    <div v-if="styleDraft" class="dw-add">
      <input v-model="styleDraft.name" class="wb-title-input" placeholder="画风名字（比如：二次元 / 真人 / 水彩）" />
      <textarea v-model="styleDraft.prompt" class="wb-title-input" rows="3" placeholder="这个画风怎么画（会拼在提示词最前面）"></textarea>
      <label class="dw-flag"><input v-model="styleDraft.isDefault" type="checkbox" />设为默认</label>
      <div class="dw-row">
        <span class="dw-spacer"></span>
        <button class="dw-btn" @click="styleDraft = null">取消</button>
        <button class="dw-btn primary" :disabled="busy === 'style'" @click="saveStyleDraft">存好</button>
      </div>
    </div>
    <button v-else class="wb-add" @click="styleDraft = { name: '', prompt: '', isDefault: false }">+ 加一个画风</button>
  </div>
</template>

<style scoped>
.draw { display: flex; flex-direction: column; gap: 10px; }
.dw-hint { font-size: 12px; line-height: 1.6; color: var(--text-2); }
.dw-err { font-size: 12px; color: var(--danger); }
.dw-meta { font-size: 11.5px; color: var(--text-3); }
.dw-ref, .dw-style, .dw-add {
  border: 1px solid rgba(0, 0, 0, 0.08); border-radius: 12px; padding: 10px 12px;
  background: var(--glass-bg-soft);
}
.dw-ref { display: flex; flex-direction: column; gap: 6px; }
.dw-photos { display: flex; gap: 6px; flex-wrap: wrap; }
.dw-thumb { position: relative; }
.dw-thumb img { width: 56px; height: 56px; object-fit: cover; border-radius: 10px; display: block; }
.dw-thumb button {
  position: absolute; top: -5px; right: -5px; width: 19px; height: 19px;
  border-radius: 50%; border: none; background: rgba(40, 44, 60, 0.72); color: #fff;
  display: flex; align-items: center; justify-content: center;
}
.dw-badge.plain { border-color: rgba(127, 127, 127, 0.35); color: var(--text-3); }
.dw-ref-name { font-weight: 600; font-size: 14px; color: var(--text); }
.dw-ref-note { font-size: 11.5px; line-height: 1.55; color: var(--text-3); }
.dw-ref-act { display: flex; flex-direction: column; gap: 4px; }
.dw-style, .dw-add { display: flex; flex-direction: column; gap: 6px; }
.dw-head { display: flex; align-items: center; gap: 8px; }
.dw-row { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
.dw-spacer { flex: 1; }
.dw-flag { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; color: var(--text-2); }
.dw-flag input { accent-color: var(--accent); }
.dw-badge { font-size: 10.5px; border-radius: 6px; padding: 1px 6px; border: 1px solid var(--accent); color: var(--accent); }
.dw-btn { border: none; border-radius: 9px; padding: 5px 10px; font-size: 12.5px; background: rgba(255, 255, 255, 0.6); color: var(--text); }
.dw-btn.primary { background: var(--accent); color: #fff; }
.dw-btn.danger { color: var(--danger); }
.dw-btn:disabled { opacity: 0.5; }
textarea.wb-title-input { resize: vertical; font-family: inherit; }
</style>
