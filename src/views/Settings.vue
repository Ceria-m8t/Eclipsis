<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { getSettings, saveSettings, apiUrl, apiHeaders } from '../settings'
import { loadMcpServers, saveMcpServers, discoverTools, type McpServer } from '../mcp'
import { compressImage } from '../image'
import { isViewportDebug, setViewportDebug } from '../viewport'
import { theme, THEME_PRESETS, DEFAULT_THEME } from '../theme'
import { fontName, setFontFile, clearFont } from '../font'

const viewportDebug = ref(isViewportDebug())
function toggleViewportDebug() {
  viewportDebug.value = !viewportDebug.value
  setViewportDebug(viewportDebug.value)
}

const settings = ref(getSettings())

const fontMsg = ref('')
async function onFontPick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  fontMsg.value = '正在加载…'
  try { await setFontFile(file); fontMsg.value = '' }
  catch (err: any) { fontMsg.value = err.message }
}

async function handleImageUpload(event: Event, field: 'avatarUser' | 'avatarAI') {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  // 头像存在 localStorage 里，压到 256px 足够清楚
  settings.value[field] = await compressImage(file, 256, 0.9)
}

// ===== 模型列表 / 连接测试 =====
const models = ref<string[]>([])
const modelsState = ref<'' | 'loading' | 'ok' | 'error'>('')
const modelsError = ref('')

async function fetchModels() {
  modelsState.value = 'loading'
  modelsError.value = ''
  try {
    const res = await fetch(apiUrl(settings.value, '/models'), { headers: apiHeaders(settings.value) })
    if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    models.value = (data.data || []).map((m: any) => m.id).filter(Boolean)
    modelsState.value = 'ok'
  } catch (e: any) {
    modelsState.value = 'error'
    modelsError.value = e.message
  }
}

function clearImage(field: 'avatarUser' | 'avatarAI') {
  if (field === 'avatarUser') {
    settings.value[field] = '/avatar-erica.jpg'
  } else {
    settings.value[field] = '/avatar-claude.jpg'
  }
}

function save() {
  try {
    saveSettings(settings.value)
    showToast('已保存')
  } catch {
    showToast('保存失败：存储空间不够')
  }
}

// ===== Toast =====
const toastMsg = ref('')
const toastVisible = ref(false)
let toastTimer: number | null = null

function showToast(text: string) {
  toastMsg.value = text
  toastVisible.value = true
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toastVisible.value = false }, 1500)
}

// ===== Worldbook =====
interface WorldbookEntry {
  title: string
  content: string
  enabled: boolean
  group: string
  position: 'before' | 'after'
  priority: number
}

interface GroupState {
  collapsed: boolean
  enabled: boolean
}

const WORLDBOOK_KEY = 'worldbook'
const GROUPS_KEY = 'worldbook-groups'
const worldbook = ref<WorldbookEntry[]>([])
const groupStates = ref<Record<string, GroupState>>({})
const expandedEntry = ref<number | null>(null)
const newGroupName = ref('')
const showAddGroup = ref(false)

function loadWorldbook() {
  try {
    const saved = localStorage.getItem(WORLDBOOK_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      // Migrate old format entries
      worldbook.value = parsed.map((e: any) => ({
        title: e.title || '',
        content: e.content || '',
        enabled: e.enabled ?? true,
        group: e.group || '默认',
        position: e.position || 'after',
        priority: e.priority ?? 50
      }))
    }
  } catch {}
  try {
    const saved = localStorage.getItem(GROUPS_KEY)
    if (saved) groupStates.value = JSON.parse(saved)
  } catch {}
}

function saveWorldbook() {
  localStorage.setItem(WORLDBOOK_KEY, JSON.stringify(worldbook.value))
  localStorage.setItem(GROUPS_KEY, JSON.stringify(groupStates.value))
}

// Groups
const groups = computed(() => {
  const set = new Set<string>()
  for (const e of worldbook.value) set.add(e.group)
  return Array.from(set)
})

function getGroupState(name: string): GroupState {
  if (!groupStates.value[name]) {
    groupStates.value[name] = { collapsed: false, enabled: true }
  }
  return groupStates.value[name]
}

function toggleGroupCollapse(name: string) {
  getGroupState(name).collapsed = !getGroupState(name).collapsed
  saveWorldbook()
}

function toggleGroupEnabled(name: string) {
  const state = getGroupState(name)
  state.enabled = !state.enabled
  // Sync entries
  for (const e of worldbook.value) {
    if (e.group === name) e.enabled = state.enabled
  }
  saveWorldbook()
}

function groupEntryCount(name: string): { enabled: number; total: number } {
  let enabled = 0, total = 0
  for (const e of worldbook.value) {
    if (e.group === name) {
      total++
      if (e.enabled) enabled++
    }
  }
  return { enabled, total }
}

function entriesInGroup(name: string): { entry: WorldbookEntry; index: number }[] {
  const result: { entry: WorldbookEntry; index: number }[] = []
  for (let i = 0; i < worldbook.value.length; i++) {
    if (worldbook.value[i].group === name) {
      result.push({ entry: worldbook.value[i], index: i })
    }
  }
  // Sort by priority descending (higher = more important)
  result.sort((a, b) => b.entry.priority - a.entry.priority)
  return result
}

function addEntry(group: string) {
  worldbook.value.push({
    title: '新条目',
    content: '',
    enabled: getGroupState(group).enabled,
    group,
    position: 'after',
    priority: 50
  })
  expandedEntry.value = worldbook.value.length - 1
  saveWorldbook()
}

function addGroup() {
  const name = newGroupName.value.trim()
  if (!name) return
  if (groups.value.includes(name)) {
    showToast('分组已存在')
    return
  }
  groupStates.value[name] = { collapsed: false, enabled: true }
  // Add a default entry so the group shows up
  worldbook.value.push({
    title: '新条目',
    content: '',
    enabled: true,
    group: name,
    position: 'after',
    priority: 50
  })
  expandedEntry.value = worldbook.value.length - 1
  newGroupName.value = ''
  showAddGroup.value = false
  saveWorldbook()
}

function removeEntry(index: number) {
  worldbook.value.splice(index, 1)
  if (expandedEntry.value === index) expandedEntry.value = null
  else if (expandedEntry.value !== null && expandedEntry.value > index) expandedEntry.value--
  saveWorldbook()
}

function deleteGroup(name: string) {
  worldbook.value = worldbook.value.filter(e => e.group !== name)
  delete groupStates.value[name]
  expandedEntry.value = null
  saveWorldbook()
}

function toggleEntry(index: number) {
  worldbook.value[index].enabled = !worldbook.value[index].enabled
  saveWorldbook()
}

function toggleExpand(index: number) {
  expandedEntry.value = expandedEntry.value === index ? null : index
}

function onEntryChange() {
  saveWorldbook()
}

function moveEntryUp(index: number) {
  const entry = worldbook.value[index]
  entry.priority = Math.min(100, entry.priority + 10)
  saveWorldbook()
}

function moveEntryDown(index: number) {
  const entry = worldbook.value[index]
  entry.priority = Math.max(0, entry.priority - 10)
  saveWorldbook()
}

function positionLabel(pos: string): string {
  return pos === 'before' ? '系统提示前' : '系统提示后'
}

function togglePosition(index: number) {
  const entry = worldbook.value[index]
  entry.position = entry.position === 'before' ? 'after' : 'before'
  saveWorldbook()
}

// ===== MCP Servers =====
const mcpList = ref<McpServer[]>(loadMcpServers())
const mcpDiscovering = ref<string | null>(null)

function addMcpServer() {
  const id = 'mcp-' + Date.now()
  mcpList.value.push({
    id,
    name: '新服务器',
    url: '',
    token: '',
    enabled: true,
    tools: []
  })
  saveMcpServers(mcpList.value)
}

function removeMcpServer(index: number) {
  mcpList.value.splice(index, 1)
  saveMcpServers(mcpList.value)
}

function toggleMcpServer(index: number) {
  mcpList.value[index].enabled = !mcpList.value[index].enabled
  saveMcpServers(mcpList.value)
}

function saveMcpList() {
  saveMcpServers(mcpList.value)
}

async function refreshTools(index: number) {
  const server = mcpList.value[index]
  mcpDiscovering.value = server.id
  try {
    const tools = await discoverTools(server)
    server.tools = tools
    saveMcpServers(mcpList.value)
    showToast(tools.length > 0 ? tools.length + ' 个工具已发现' : '未发现工具')
  } catch (e: any) {
    showToast('发现工具失败: ' + e.message)
  } finally {
    mcpDiscovering.value = null
  }
}

onMounted(() => {
  loadWorldbook()
})
</script>

<template>
  <div class="settings shell-page">
    <main class="content">
      <div class="form glass">
        <div class="section-title">连接设置</div>

        <label>
          API 地址
          <input v-model="settings.apiBase" placeholder="留空 = 用服务器上的 Dylan 网关" autocapitalize="off" autocorrect="off" />
          <span class="hint">留空时请求走本站 /api，网关 key 由服务器自动带上。填其他地址（以 /v1 结尾）可以直连别的 API。</span>
        </label>

        <label>
          API Key
          <input v-model="settings.apiKey" type="password" placeholder="用默认网关时留空" autocomplete="off" />
          <span class="hint">只在直连其他 API 时需要填。会保存在这台设备的浏览器里。</span>
        </label>

        <label>
          模型
          <span class="model-row">
            <input v-model="settings.model" list="model-options" placeholder="模型名" autocapitalize="off" autocorrect="off" />
            <button type="button" class="reset-btn" :disabled="modelsState === 'loading'" @click="fetchModels">
              {{ modelsState === 'loading' ? '读取中…' : '读取列表' }}
            </button>
          </span>
          <datalist id="model-options">
            <option v-for="m in models" :key="m" :value="m" />
          </datalist>
          <span v-if="modelsState === 'ok'" class="hint">连接正常，共 {{ models.length }} 个模型。点输入框可以选。</span>
          <span v-else-if="modelsState === 'error'" class="hint err">连接失败：{{ modelsError }}</span>
        </label>
        <div v-if="models.length" class="model-chips">
          <button
            v-for="m in models" :key="m" type="button"
            :class="['model-chip', { on: settings.model === m }]"
            @click="settings.model = m"
          >{{ m }}</button>
        </div>

        <div class="section-title">聊天</div>

        <label>
          他的名字
          <input v-model="settings.nameAI" />
        </label>
        <label>
          我的名字
          <input v-model="settings.nameUser" />
        </label>
        <label>
          顶栏小字
          <input v-model="settings.chatSubtitle" placeholder="比如一句签名，可以留空" />
        </label>
        <label>
          聊天记录上限（约 {{ (settings.contextTokens / 1000).toFixed(0) }}k tokens）
          <input v-model.number="settings.contextTokens" type="range" min="10000" max="180000" step="5000" />
          <span class="hint">每次发给他的聊天记录最多这么多，超出的旧消息不发送，本地记录不会删除。不含系统提示词和世界书。</span>
        </label>
        <label class="check-row">
          <input v-model="settings.splitBubbles" type="checkbox" />
          他的回复按行拆成多个气泡
        </label>
        <label class="check-row">
          <input v-model="settings.keepAlive" type="checkbox" />
          他回复时后台保活
        </label>
        <span class="hint">他回复的时候在后台放一段听不见的声音，切到别的 app 也不容易断。代价：会让正在放的音乐暂停。能撑多久由 iOS 决定。</span>

        <RouterLink to="/settings/prompt" class="prompt-entry">
          <span>系统提示词</span>
          <small>他的人设、关系、文风，以及家里能做什么</small>
        </RouterLink>

        <div class="section-title">外观</div>

        <div class="theme-block">
          <span class="image-label">整体色调</span>
          <div class="theme-presets" role="radiogroup" aria-label="预设色调">
            <button
              v-for="p in THEME_PRESETS"
              :key="p.name"
              type="button"
              role="radio"
              class="theme-swatch"
              :class="{ on: theme.bgTop === p.top && theme.bgBottom === p.bottom }"
              :aria-checked="theme.bgTop === p.top && theme.bgBottom === p.bottom"
              @click="theme.bgTop = p.top; theme.bgBottom = p.bottom"
            >
              <span class="swatch-dot" :style="{ background: `linear-gradient(165deg, ${p.top}, ${p.bottom})` }"></span>
              <span>{{ p.name }}</span>
            </button>
          </div>
          <div class="theme-custom">
            <label class="theme-color">上端 <input type="color" v-model="theme.bgTop" /></label>
            <label class="theme-color">下端 <input type="color" v-model="theme.bgBottom" /></label>
            <button type="button" class="reset-btn" @click="Object.assign(theme, DEFAULT_THEME)">恢复默认</button>
          </div>
          <label class="theme-range">
            底栏透明度 {{ Math.round((1 - theme.tabbarOpacity) * 100) }}%
            <input type="range" min="0.1" max="0.9" step="0.05" :value="1 - theme.tabbarOpacity"
              @input="theme.tabbarOpacity = +(1 - +($event.target as HTMLInputElement).value).toFixed(2)" />
          </label>
          <div class="theme-custom">
            <span class="image-label" style="margin:0">字体：{{ fontName || '系统默认' }}</span>
            <label class="upload-btn">导入字体<input type="file" accept=".ttf,.otf,.woff,.woff2" hidden @change="onFontPick" /></label>
            <button v-if="fontName" type="button" class="reset-btn" @click="clearFont">恢复系统字体</button>
          </div>
          <span v-if="fontMsg" class="hint">{{ fontMsg }}</span>
          <span class="hint">改了马上生效，不用点保存。字体对整个应用生效（代码块除外）；字体里没有的字会用系统字体补上。聊天页如果在聊天样式里设了背景，会优先用那个。</span>
        </div>

        <div class="section-title">头像设置</div>

        <div class="image-setting">
          <span class="image-label">我的头像</span>
          <div class="image-row">
            <img :src="settings.avatarUser" class="avatar-preview" />
            <label class="upload-btn">
              更换
              <input type="file" accept="image/*" hidden @change="handleImageUpload($event, 'avatarUser')" />
            </label>
            <button class="reset-btn" @click="clearImage('avatarUser')">重置</button>
          </div>
        </div>

        <div class="image-setting">
          <span class="image-label">他的头像</span>
          <div class="image-row">
            <img :src="settings.avatarAI" class="avatar-preview" />
            <label class="upload-btn">
              更换
              <input type="file" accept="image/*" hidden @change="handleImageUpload($event, 'avatarAI')" />
            </label>
            <button class="reset-btn" @click="clearImage('avatarAI')">重置</button>
          </div>
        </div>

        <div class="actions">
          <button class="primary" @click="save">保存</button>
        </div>

        <!-- MCP Servers -->
        <div class="section-title">MCP 工具服务器</div>
        <p class="worldbook-hint">连接 MCP 服务器后，聊天时可以调用外部工具（OB记忆、心潮、网易云等）。</p>

        <div class="mcp-list">
          <div v-for="(srv, i) in mcpList" :key="srv.id" class="mcp-item">
            <div class="mcp-header">
              <button
                class="wb-group-toggle"
                :class="{ enabled: srv.enabled }"
                @click="toggleMcpServer(i)"
              >{{ srv.enabled ? '●' : '○' }}</button>
              <input
                v-model="srv.name"
                class="mcp-name-input"
                placeholder="服务器名称"
                @input="saveMcpList"
              />
              <button class="mcp-refresh" @click="refreshTools(i)" :disabled="mcpDiscovering === srv.id">
                {{ mcpDiscovering === srv.id ? '...' : '🔄' }}
              </button>
              <button class="wb-group-del" @click="removeMcpServer(i)">🗑</button>
            </div>
            <div class="mcp-body">
              <input
                v-model="srv.url"
                class="wb-title-input"
                placeholder="MCP 端点 URL"
                @input="saveMcpList"
              />
              <input
                v-model="srv.token"
                type="password"
                class="wb-title-input"
                placeholder="Bearer Token（可选）"
                @input="saveMcpList"
              />
              <div v-if="srv.tools.length > 0" class="mcp-tools">
                <span class="mcp-tools-label">{{ srv.tools.length }} 个工具:</span>
                <span class="mcp-tool-tag" v-for="t in srv.tools" :key="t.name" :title="t.description">{{ t.name }}</span>
              </div>
              <div v-else class="mcp-tools-empty">未发现工具 — 填好 URL 后点 🔄</div>
            </div>
          </div>
        </div>
        <button class="wb-add" @click="addMcpServer">+ 添加 MCP 服务器</button>

        <div class="section-title">账户</div>
        <a class="logout-link" href="/logout">退出登录</a>

        <div class="section-title">排查</div>
        <label class="check-row">
          <input type="checkbox" :checked="viewportDebug" @change="toggleViewportDebug" />
          在屏幕左上角显示尺寸数据（排查白条、键盘位置用）
        </label>

        <!-- Worldbook -->
        <div class="section-title">世界书</div>
        <p class="worldbook-hint">启用的条目按优先级排序后拼接到系统提示词前/后。数字越大越优先（token不够时先保高优先级）。</p>

        <div class="worldbook-list">
          <div v-for="groupName in groups" :key="groupName" class="wb-group">
            <!-- Group header -->
            <div class="wb-group-header">
              <button
                class="wb-group-toggle"
                :class="{ enabled: getGroupState(groupName).enabled }"
                @click.stop="toggleGroupEnabled(groupName)"
                :title="getGroupState(groupName).enabled ? '禁用整组' : '启用整组'"
              >{{ getGroupState(groupName).enabled ? '●' : '○' }}</button>
              <span class="wb-group-name" @click="toggleGroupCollapse(groupName)">
                {{ getGroupState(groupName).collapsed ? '▶' : '▼' }}
                {{ groupName }}
              </span>
              <span class="wb-group-count">{{ groupEntryCount(groupName).enabled }}/{{ groupEntryCount(groupName).total }}</span>
              <button class="wb-group-add" @click="addEntry(groupName)" title="添加条目">+</button>
              <button class="wb-group-del" @click="deleteGroup(groupName)" title="删除整组">🗑</button>
            </div>

            <!-- Entries -->
            <div v-if="!getGroupState(groupName).collapsed" class="wb-group-body">
              <div v-for="{ entry, index } in entriesInGroup(groupName)" :key="index" class="wb-entry">
                <div class="wb-header" @click="toggleExpand(index)">
                  <button
                    class="wb-toggle"
                    :class="{ enabled: entry.enabled }"
                    @click.stop="toggleEntry(index)"
                  >{{ entry.enabled ? '●' : '○' }}</button>
                  <span class="wb-title-text">{{ entry.title || '(无标题)' }}</span>
                  <span class="wb-position-tag" :class="entry.position">{{ positionLabel(entry.position) }}</span>
                  <span class="wb-priority">P{{ entry.priority }}</span>
                  <span class="wb-expand">{{ expandedEntry === index ? '▼' : '▶' }}</span>
                </div>

                <div v-if="expandedEntry === index" class="wb-body">
                  <input
                    v-model="entry.title"
                    class="wb-title-input"
                    placeholder="条目标题"
                    @input="onEntryChange"
                  />

                  <div class="wb-meta-row">
                    <div class="wb-meta-item">
                      <span class="wb-meta-label">注入位置</span>
                      <button class="wb-meta-btn" @click="togglePosition(index)">
                        {{ positionLabel(entry.position) }}
                      </button>
                    </div>
                    <div class="wb-meta-item">
                      <span class="wb-meta-label">优先级</span>
                      <div class="wb-priority-ctrl">
                        <button @click="moveEntryDown(index)">−</button>
                        <input
                          type="number"
                          v-model.number="entry.priority"
                          min="0"
                          max="100"
                          @input="onEntryChange"
                          class="wb-priority-input"
                        />
                        <button @click="moveEntryUp(index)">+</button>
                      </div>
                    </div>
                  </div>

                  <textarea
                    v-model="entry.content"
                    class="wb-content-input"
                    placeholder="条目内容"
                    rows="8"
                    @input="onEntryChange"
                  ></textarea>
                  <div class="wb-actions">
                    <span class="wb-char-count">{{ entry.content.length }} 字</span>
                    <button class="wb-delete" @click="removeEntry(index)">删除</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Add group -->
        <div v-if="showAddGroup" class="wb-add-group-form">
          <input
            v-model="newGroupName"
            class="wb-title-input"
            placeholder="新分组名称"
            @keydown.enter="addGroup"
          />
          <div class="wb-add-group-btns">
            <button class="wb-add-group-confirm" @click="addGroup">确定</button>
            <button class="wb-add-group-cancel" @click="showAddGroup = false">取消</button>
          </div>
        </div>
        <button v-else class="wb-add" @click="showAddGroup = true">+ 新建分组</button>
      </div>
    </main>

    <transition name="fade">
      <div v-if="toastVisible" class="toast">{{ toastMsg }}</div>
    </transition>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: transparent;
  color: var(--text);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.content { flex: 1; padding: calc(var(--safe-top) + 16px) 14px 24px; }
.form {
  max-width: 520px;
  margin: 0 auto;
  padding: 18px 16px 22px;
  border-radius: 28px;
}

.section-title {
  font-size: 13px; color: rgba(0, 0, 0, 0.4); text-transform: uppercase;
  letter-spacing: 1px; margin-top: 24px; margin-bottom: 16px;
  padding-bottom: 8px; border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}
.section-title:first-child { margin-top: 0; }

/* 外观 */
.theme-block { margin-bottom: 20px; display: flex; flex-direction: column; gap: 12px; }
.theme-presets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.theme-swatch {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.8);
  border-radius: 14px;
  background: var(--glass-bg-soft);
  font-size: 13px;
  color: var(--text-2);
  transition: transform 0.35s var(--spring);
}
.theme-swatch:active { transform: scale(var(--press-scale)); transition-duration: 0.08s; }
.theme-swatch.on { color: var(--text); border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.swatch-dot { width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0; border: 1px solid rgba(60, 72, 110, 0.12); }
.theme-custom { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.theme-color { display: flex !important; align-items: center; gap: 6px; margin: 0 !important; font-size: 13px; }
.theme-color input { width: 40px; height: 28px; border: none; background: none; padding: 0; }
.theme-range { margin: 0 !important; font-size: 13px; display: flex !important; flex-direction: column; gap: 6px; }
.theme-range input { width: 100%; accent-color: var(--accent); }

label { display: block; margin-bottom: 20px; font-size: 14px; color: rgba(0, 0, 0, 0.6); }

label input[type="text"],
label input[type="password"],
label input:not([type]) {
  display: block; width: 100%; margin-top: 8px; padding: 10px 14px;
  border: 1px solid rgba(255, 255, 255, 0.8); border-radius: 14px; background: rgba(255, 255, 255, 0.6);
  color: var(--text); font-size: 16px; outline: none; box-sizing: border-box;
}
label input:focus { border-color: rgba(0, 0, 0, 0.25); }

.hint { display: block; margin-top: 4px; font-size: 12px; color: rgba(0, 0, 0, 0.35); }

.image-setting { margin-bottom: 20px; }
.image-label { display: block; font-size: 14px; color: rgba(0, 0, 0, 0.6); margin-bottom: 8px; }
.image-row { display: flex; align-items: center; gap: 10px; }

.avatar-preview {
  width: 48px; height: 48px; border-radius: 50%;
  object-fit: cover; border: 2px solid rgba(0, 0, 0, 0.08);
}

.upload-btn {
  padding: 6px 14px; background: rgba(0, 0, 0, 0.05); border-radius: 6px;
  font-size: 12px; color: rgba(0, 0, 0, 0.5); cursor: pointer;
  border: 1px solid rgba(0, 0, 0, 0.08);
}
.upload-btn:hover { background: rgba(0, 0, 0, 0.08); }

.reset-btn {
  padding: 6px 10px; background: none; border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 6px; font-size: 12px; color: rgba(0, 0, 0, 0.35); cursor: pointer;
}
.reset-btn:hover { color: rgba(0, 0, 0, 0.6); }

.actions { margin-top: 32px; }

.primary {
  width: 100%; padding: 13px; border: none; border-radius: 16px;
  font-size: 15px; cursor: pointer; background: rgba(111, 134, 184, 0.88); color: #fff;
}
.primary:hover { background: rgba(0, 0, 0, 0.12); }

/* ===== Worldbook ===== */
.worldbook-hint { font-size: 12px; color: rgba(0, 0, 0, 0.35); margin-bottom: 16px; }
.worldbook-list { display: flex; flex-direction: column; gap: 12px; margin-bottom: 12px; }

/* Group */
.wb-group {
  border: 1px solid rgba(0, 0, 0, 0.08); border-radius: 10px;
  overflow: hidden; background: rgba(255, 255, 255, 0.5);
}

.wb-group-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; background: rgba(255, 255, 255, 0.6);
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.wb-group-toggle {
  background: none; border: none; font-size: 14px;
  cursor: pointer; padding: 0 4px; color: rgba(0, 0, 0, 0.25); flex-shrink: 0;
}
.wb-group-toggle.enabled { color: rgba(0, 0, 0, 0.5); }

.wb-group-name {
  flex: 1; font-size: 14px; font-weight: 500;
  color: rgba(0, 0, 0, 0.7); cursor: pointer; user-select: none;
}

.wb-group-count { font-size: 11px; color: rgba(0, 0, 0, 0.35); }

.wb-group-add {
  background: none; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 4px;
  color: rgba(0, 0, 0, 0.35); font-size: 14px; width: 24px; height: 24px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.wb-group-add:hover { color: rgba(0, 0, 0, 0.6); border-color: rgba(0, 0, 0, 0.2); }

.wb-group-del {
  background: none; border: none; font-size: 14px;
  cursor: pointer; color: rgba(0, 0, 0, 0.25); padding: 0 4px;
}
.wb-group-del:hover { color: rgba(200, 60, 60, 0.7); }

.wb-group-body { padding: 4px; }

/* Entry */
.wb-entry {
  border: 1px solid rgba(0, 0, 0, 0.04); border-radius: 6px;
  margin: 2px 0; background: rgba(255, 255, 255, 0.4);
}

.wb-header {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; cursor: pointer; user-select: none;
}
.wb-header:hover { background: rgba(0, 0, 0, 0.02); }

.wb-toggle {
  background: none; border: none; font-size: 12px;
  cursor: pointer; padding: 0 2px; color: rgba(0, 0, 0, 0.2); flex-shrink: 0;
}
.wb-toggle.enabled { color: rgba(0, 0, 0, 0.5); }

.wb-title-text {
  flex: 1; font-size: 13px; color: rgba(0, 0, 0, 0.6);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.wb-position-tag {
  font-size: 10px; padding: 1px 6px; border-radius: 3px;
  flex-shrink: 0; letter-spacing: 0.5px;
}
.wb-position-tag.before {
  background: rgba(180, 120, 60, 0.1); color: rgba(160, 110, 50, 0.8);
  border: 1px solid rgba(180, 120, 60, 0.2);
}
.wb-position-tag.after {
  background: rgba(80, 100, 180, 0.08); color: rgba(70, 90, 160, 0.7);
  border: 1px solid rgba(80, 100, 180, 0.15);
}

.wb-priority { font-size: 10px; color: rgba(0, 0, 0, 0.3); flex-shrink: 0; font-family: monospace; }
.wb-expand { font-size: 9px; color: rgba(0, 0, 0, 0.25); flex-shrink: 0; }

.wb-body {
  padding: 4px 10px 10px; display: flex; flex-direction: column; gap: 8px;
}

.wb-title-input {
  width: 100%; padding: 8px 10px; border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 6px; background: rgba(255, 255, 255, 0.8); color: rgba(0, 0, 0, 0.8);
  font-size: 14px; outline: none; box-sizing: border-box;
}
.wb-title-input:focus { border-color: rgba(0, 0, 0, 0.25); }

.wb-meta-row { display: flex; gap: 12px; flex-wrap: wrap; }

.wb-meta-item { display: flex; flex-direction: column; gap: 4px; }
.wb-meta-label { font-size: 11px; color: rgba(0, 0, 0, 0.35); }

.wb-meta-btn {
  padding: 4px 10px; background: rgba(0, 0, 0, 0.03);
  border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 4px;
  color: rgba(0, 0, 0, 0.6); font-size: 12px; cursor: pointer;
}
.wb-meta-btn:hover { border-color: rgba(0, 0, 0, 0.2); }

.wb-priority-ctrl {
  display: flex; align-items: center; gap: 2px;
}
.wb-priority-ctrl button {
  width: 26px; height: 26px; background: rgba(0, 0, 0, 0.03);
  border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 4px;
  color: rgba(0, 0, 0, 0.5); font-size: 14px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.wb-priority-ctrl button:hover { border-color: rgba(0, 0, 0, 0.2); }

.wb-priority-input {
  width: 44px; text-align: center; padding: 4px;
  background: rgba(255, 255, 255, 0.8); border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 4px;
  color: rgba(0, 0, 0, 0.7); font-size: 13px; font-family: monospace;
  outline: none; box-sizing: border-box;
  -moz-appearance: textfield;
}
.wb-priority-input::-webkit-inner-spin-button,
.wb-priority-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }

.wb-content-input {
  width: 100%; padding: 8px 10px; border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 6px; background: rgba(255, 255, 255, 0.8); color: rgba(0, 0, 0, 0.75);
  font-size: 13px; font-family: 'Menlo', 'Consolas', monospace;
  line-height: 1.5; outline: none; resize: vertical;
  box-sizing: border-box; min-height: 120px;
}
.wb-content-input:focus { border-color: rgba(0, 0, 0, 0.25); }

.wb-actions { display: flex; align-items: center; justify-content: space-between; }
.wb-char-count { font-size: 11px; color: rgba(0, 0, 0, 0.3); }

.wb-delete {
  padding: 4px 12px; background: none;
  border: 1px solid rgba(200, 60, 60, 0.2); border-radius: 6px;
  color: rgba(200, 60, 60, 0.6); font-size: 12px; cursor: pointer;
}
.wb-delete:hover { background: rgba(200, 60, 60, 0.05); color: rgba(200, 60, 60, 0.8); }

/* Add group */
.wb-add {
  width: 100%; padding: 10px; background: rgba(0, 0, 0, 0.02);
  border: 1px dashed rgba(0, 0, 0, 0.12); border-radius: 8px;
  color: rgba(0, 0, 0, 0.3); font-size: 13px; cursor: pointer; margin-bottom: 32px;
}
.wb-add:hover { background: rgba(0, 0, 0, 0.04); color: rgba(0, 0, 0, 0.5); }

.wb-add-group-form {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px; border: 1px dashed rgba(0, 0, 0, 0.12);
  border-radius: 8px; margin-bottom: 32px;
}
.wb-add-group-btns { display: flex; gap: 8px; }
.wb-add-group-confirm {
  flex: 1; padding: 8px; background: rgba(0, 0, 0, 0.08); border: none;
  border-radius: 6px; color: rgba(0, 0, 0, 0.6); font-size: 13px; cursor: pointer;
}
.wb-add-group-cancel {
  flex: 1; padding: 8px; background: none; border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 6px; color: rgba(0, 0, 0, 0.4); font-size: 13px; cursor: pointer;
}

/* MCP */
.mcp-list { display: flex; flex-direction: column; gap: 12px; margin-bottom: 12px; }

.mcp-item {
  border: 1px solid rgba(0, 0, 0, 0.08); border-radius: 10px;
  overflow: hidden; background: rgba(255, 255, 255, 0.5);
}

.mcp-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; background: rgba(255, 255, 255, 0.6);
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.mcp-name-input {
  flex: 1; padding: 4px 8px; border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 4px; background: rgba(255, 255, 255, 0.7); color: rgba(0, 0, 0, 0.7);
  font-size: 14px; font-weight: 500; outline: none;
}
.mcp-name-input:focus { border-color: rgba(0, 0, 0, 0.2); }

.mcp-refresh {
  background: none; border: 1px solid rgba(0, 0, 0, 0.1); border-radius: 4px;
  color: rgba(0, 0, 0, 0.4); font-size: 14px; width: 28px; height: 28px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.mcp-refresh:hover { color: rgba(0, 0, 0, 0.6); border-color: rgba(0, 0, 0, 0.2); }
.mcp-refresh:disabled { opacity: 0.4; cursor: wait; }

.mcp-body { padding: 8px 12px 12px; display: flex; flex-direction: column; gap: 8px; }

.mcp-tools { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.mcp-tools-label { font-size: 11px; color: rgba(0, 0, 0, 0.4); margin-right: 4px; }

.mcp-tool-tag {
  font-size: 10px; padding: 2px 6px; border-radius: 3px;
  background: rgba(0, 0, 0, 0.04); color: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(0, 0, 0, 0.06);
  max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.mcp-tools-empty { font-size: 12px; color: rgba(0, 0, 0, 0.3); }

/* Toast */
.toast {
  position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
  background: rgba(255, 255, 255, 0.92); color: rgba(0, 0, 0, 0.7);
  padding: 8px 20px; border-radius: 20px; font-size: 13px;
  z-index: 100; pointer-events: none;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1); border: 1px solid rgba(0,0,0,0.06);
}
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.model-row { display: flex; gap: 8px; align-items: center; }
.model-row input { flex: 1; min-width: 0; }
.model-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: -4px 0 12px; }
.model-chip {
  border: 1px solid var(--glass-border, rgba(0,0,0,0.08));
  background: rgba(255, 255, 255, 0.5);
  border-radius: 999px;
  padding: 5px 12px;
  font-size: 13px;
}
.model-chip.on { background: rgba(111, 134, 184, 0.85); color: #fff; }
.hint.err { color: var(--danger, #d0566a); }
.check-row { flex-direction: row !important; align-items: center; gap: 8px; }
.check-row input { width: auto !important; }
.logout-link {
  display: block; text-align: center; padding: 12px; border-radius: 16px; margin-bottom: 16px;
  background: rgba(255, 255, 255, 0.6); color: var(--danger, #d0566a); text-decoration: none; font-size: 15px;
}
.prompt-entry {
  display: flex; flex-direction: column; gap: 2px;
  padding: 13px 16px; margin: 4px 0 20px; border-radius: 18px;
  background: rgba(255, 255, 255, 0.6); border: 1px solid rgba(255, 255, 255, 0.85);
  color: var(--text); text-decoration: none; font-size: 15px;
}
.prompt-entry small { font-size: 12px; color: var(--text-2); }
</style>