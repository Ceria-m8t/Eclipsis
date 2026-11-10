<script setup lang="ts">
// 书翻开以后停下的那一页：在纸上直接编辑。
// 纸（书页图）固定铺满屏幕，只有字在滚；横线跟着行高画，跟着字一起滚。
import { ref, computed, nextTick, onMounted, watch } from 'vue'

const props = defineProps<{
  kind: 'main' | 'world'
  page: string               // 书页图地址
  title: string
  content: string
  enabled: boolean
  group: string
  position: 'before' | 'after'
  priority: number
  groups: string[]           // 已有的分组，给分组输入框做选项
  isNew: boolean
  titleFont: string
  titleWeight: number
  // 只有主 Prompt 有：「家里能做什么」（功能说明，开发方会跟着功能改），拼在主 Prompt 正文后面
  features?: string
  featuresEnabled?: boolean
}>()

const emit = defineEmits<{
  done: [v: { title: string; content: string; enabled: boolean; group: string; position: 'before' | 'after'; priority: number; features?: string; featuresEnabled?: boolean }]
  discard: []
  remove: []
  history: []
}>()

const title = ref(props.title)
const content = ref(props.content)
const enabled = ref(props.enabled)
const group = ref(props.group)
const position = ref(props.position)
const priority = ref(props.priority)
const features = ref(props.features ?? '')
const featuresOn = ref(props.featuresEnabled ?? true)
const showMarks = ref(false)
const confirmRemove = ref(false)

const dirty = computed(() =>
  title.value !== props.title || content.value !== props.content || enabled.value !== props.enabled ||
  group.value !== props.group || position.value !== props.position || priority.value !== props.priority ||
  (props.kind === 'main' && (features.value !== (props.features ?? '') || featuresOn.value !== (props.featuresEnabled ?? true))))

const area = ref<HTMLTextAreaElement | null>(null)
const titleEl = ref<HTMLTextAreaElement | null>(null)
const featArea = ref<HTMLTextAreaElement | null>(null)
function fit(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}
const grow = () => { fit(area.value); fit(titleEl.value); fit(featArea.value) }
watch([content, title, features], () => nextTick(grow))
onMounted(() => nextTick(grow))

// 纸的高度：打开这页时的整屏高（那时键盘还没弹）
const paperH = `${Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-h')) || innerHeight)}px`

function done() {
  emit('done', {
    title: title.value.trim() || (props.kind === 'main' ? props.title : '无题'),
    content: content.value, enabled: enabled.value, group: group.value.trim() || '默认',
    position: position.value, priority: Math.max(0, Math.min(100, Math.round(Number(priority.value) || 0))),
    ...(props.kind === 'main' ? { features: features.value, featuresEnabled: featuresOn.value } : {})
  })
}
function remove() {
  if (!confirmRemove.value) { confirmRemove.value = true; setTimeout(() => (confirmRemove.value = false), 3000); return }
  emit('remove')
}
</script>

<template>
  <div class="book-page" :class="kind">
    <!-- 纸单独一层，高度定在打开时的整屏高：键盘弹出来时页面变矮，纸不跟着缩放上移 -->
    <div class="paper" data-glass-backdrop :style="{ backgroundImage: `url(${page})`, height: paperH }"></div>
    <div class="scroll">
      <div class="sheet">
        <textarea
          v-if="kind === 'world'"
          ref="titleEl"
          v-model="title"
          class="title"
          rows="1"
          :style="{ fontFamily: titleFont, fontWeight: titleWeight }"
          maxlength="40"
          aria-label="书名"
          @keydown.enter.prevent
        ></textarea>
        <div v-else class="title" :style="{ fontFamily: titleFont, fontWeight: titleWeight }">{{ title }}</div>

        <div class="meta">
          <template v-if="kind === 'world'">
            <label class="toggle"><input v-model="enabled" type="checkbox" /> {{ enabled ? '启用中' : '没启用' }}</label>
            <span class="dot">·</span>
            <button class="link" @click="showMarks = !showMarks">{{ showMarks ? '收起书签' : '书签' }}</button>
          </template>
          <template v-else>
            <span>他是谁</span>
            <span class="dot">·</span>
            <button class="link" @click="emit('history')">历史版本</button>
          </template>
        </div>

        <div v-if="kind === 'world' && showMarks" class="marks">
          <label>分组
            <input v-model="group" list="book-groups" maxlength="20" />
            <datalist id="book-groups"><option v-for="g in groups" :key="g" :value="g" /></datalist>
          </label>
          <label>放在
            <select v-model="position">
              <option value="before">主 Prompt 前面</option>
              <option value="after">主 Prompt 后面</option>
            </select>
          </label>
          <label>优先级
            <input v-model.number="priority" type="number" min="0" max="100" step="10" inputmode="numeric" />
          </label>
        </div>

        <textarea
          ref="area"
          v-model="content"
          class="body"
          :placeholder="kind === 'main' ? '写下他是谁……' : '在这页写下这本书的内容……'"
          spellcheck="false"
        ></textarea>

        <!-- 主 Prompt 的第二部分：家里能做什么。拼的时候紧跟在上面那段后面 -->
        <template v-if="kind === 'main'">
          <div class="part-title" :style="{ fontFamily: titleFont, fontWeight: titleWeight }">家里能做什么</div>
          <div class="meta">
            <label class="toggle"><input v-model="featuresOn" type="checkbox" /> {{ featuresOn ? '拼在上面那段后面' : '没拼进去' }}</label>
          </div>
          <p class="part-hint">告诉他 Eclipsis 里有哪些功能、哪些还没有。加功能、改功能时，开发这边会顺手更新这里。</p>
          <textarea
            ref="featArea"
            v-model="features"
            class="body features"
            :class="{ off: !featuresOn }"
            placeholder="家里有哪些能做的……"
            spellcheck="false"
            aria-label="家里能做什么"
          ></textarea>
        </template>

        <button v-if="kind === 'world' && !isNew" class="remove" @click="remove">{{ confirmRemove ? '再点一次，抽走这本' : '抽走这本' }}</button>
      </div>
    </div>

    <!-- 合上/完成在右上角，不保存在左上角（液态玻璃，和书架页的返回按钮一样） -->
    <button v-if="dirty" class="glass corner left" @click="emit('discard')">不保存</button>
    <button class="glass corner right" :class="{ strong: dirty || isNew }" @click="done">{{ dirty || isNew ? '完成' : '合上' }}</button>
  </div>
</template>

<style scoped>
.book-page {
  position: fixed;
  left: 0; right: 0;
  top: var(--app-top, 0px);
  height: var(--app-h, 100dvh);
  z-index: 230;
  display: flex;
  flex-direction: column;
}
.paper {
  position: absolute;
  left: 0; right: 0; top: 0;
  background-color: #efe6d6;
  background-size: cover;
  background-position: center;
  pointer-events: none;
}
.main .paper { background-color: #dfe3ee; }
.scroll { position: relative; }
.scroll {
  flex: 1;
  overflow-y: auto; overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}
/* 字写在花框里面：左右各让出约 12%，上下让出花饰 */
.sheet {
  padding: calc(var(--safe-top, 0px) + 11vh) 13vw 60px;
  min-height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}
.main .sheet { padding-left: 10vw; padding-right: 10vw; }

.title {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
  text-align: center;
  font-size: 26px;
  line-height: 1.3;
  color: #2a1a0c;
  letter-spacing: 2px;
  padding: 0;
  outline: none;
  resize: none;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
  text-shadow: 0 1px 0 rgba(255, 250, 235, 0.6);
}
.main .title { color: #1d2140; }
.meta {
  margin-top: 6px;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: rgba(40, 28, 16, 0.62);
}
.main .meta { color: rgba(29, 33, 64, 0.62); }
.dot { opacity: 0.6; }
.toggle { display: inline-flex; align-items: center; gap: 4px; }
.toggle input { width: 15px; height: 15px; accent-color: #8a6a2a; }
.link {
  border: none; background: none; padding: 0;
  color: inherit; text-decoration: underline; text-underline-offset: 3px;
  font-size: 13px;
}
.marks {
  margin: 12px auto 0;
  display: flex; flex-wrap: wrap; gap: 8px 14px; justify-content: center;
  font-size: 13px; color: rgba(40, 28, 16, 0.75);
}
.marks label { display: inline-flex; align-items: center; gap: 6px; }
.marks input, .marks select {
  border: 1px solid rgba(90, 65, 30, 0.3);
  background: rgba(255, 252, 244, 0.55);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 16px;
  color: #000;
}
.marks input[type='number'] { width: 64px; }
.marks input[list] { width: 110px; }

/* 正文：纯黑字，横线和行高对齐 */
.body {
  --lh: 31px;
  margin-top: 18px;
  width: 100%;
  min-height: 55vh;
  border: none;
  outline: none;
  resize: none;
  overflow: hidden;
  padding: 0;
  font-family: var(--app-font, var(--sans));
  font-size: 16px;
  line-height: var(--lh);
  color: #000;
  background-color: transparent;
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent calc(var(--lh) - 1px),
    rgba(95, 70, 40, 0.24) calc(var(--lh) - 1px),
    rgba(95, 70, 40, 0.24) var(--lh)
  );
  background-attachment: local;
}
.main .body {
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent calc(var(--lh) - 1px),
    rgba(50, 60, 110, 0.2) calc(var(--lh) - 1px),
    rgba(50, 60, 110, 0.2) var(--lh)
  );
}
.body.features { min-height: 30vh; }
.body.features.off { opacity: 0.45; }
.part-title {
  margin-top: 40px;
  text-align: center;
  font-size: 21px;
  letter-spacing: 2px;
  color: #1d2140;
  text-shadow: 0 1px 0 rgba(255, 250, 235, 0.6);
}
.part-hint {
  margin: 8px 0 0;
  text-align: center;
  font-size: 12px;
  line-height: 1.5;
  color: rgba(29, 33, 64, 0.55);
}
.body::placeholder { color: rgba(40, 28, 16, 0.38); }

.remove {
  align-self: center;
  margin-top: 28px;
  border: none; background: none;
  font-size: 13px;
  color: rgba(120, 40, 25, 0.7);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.corner {
  position: absolute;
  top: calc(var(--safe-top, 0px) + 12px);
  border-radius: 18px;
  padding: 7px 16px;
  font-size: 14px;
  letter-spacing: 1px;
  white-space: nowrap;
  color: var(--text);
  transition: transform 0.25s var(--spring);
}
.corner:active { transform: scale(var(--press-scale)); }
.corner.left { left: 14px; }
.corner.right { right: 14px; }
.corner.strong { font-weight: 600; }
</style>
