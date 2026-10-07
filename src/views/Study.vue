<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const OB_TOKEN = 'erica2026ob'

// 状态
const buckets = ref<any[]>([])
const loading = ref(false)
const searchQuery = ref('')
const searchResults = ref<any[]>([])
const searching = ref(false)
const activeTab = ref('all')
const expandedId = ref<string | null>(null)
const expandedDetail = ref<any>(null)
const detailLoading = ref(false)

// domain分类
const DOMAIN_TABS = [
  { key: 'all', label: '全部', icon: '📚' },
  { key: 'anchor', label: '锚点', icon: '⚓' },
  { key: 'deep_talk', label: '深谈', icon: '💭' },
  { key: 'identity', label: '身份', icon: '🪞' },
  { key: 'language', label: '暗号', icon: '🗝️' },
  { key: 'warmth', label: '温度', icon: '🕯️' },
  { key: 'flow', label: '进行中', icon: '🌊' },
  { key: 'feel', label: '感受', icon: '🫧' },
  { key: 'plan', label: '计划', icon: '📋' },
  { key: 'archive', label: '归档', icon: '📦' },
]

// 请求头
function headers() {
  return {
    'Authorization': `Bearer ${OB_TOKEN}`,
    'Content-Type': 'application/json'
  }
}

// 加载全部记忆
async function loadBuckets() {
  loading.value = true
  try {
    const res = await fetch('/ob/buckets?sort=created_desc', { headers: headers() })
    if (res.ok) {
      buckets.value = await res.json()
    }
  } catch (e) {
    console.error('加载记忆失败', e)
  } finally {
    loading.value = false
  }
}

// 搜索
let searchTimer: number | null = null
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  if (!searchQuery.value.trim()) {
    searchResults.value = []
    return
  }
  searchTimer = window.setTimeout(() => doSearch(), 400)
}

async function doSearch() {
  const q = searchQuery.value.trim()
  if (!q) return
  searching.value = true
  try {
    const res = await fetch(`/ob/search?q=${encodeURIComponent(q)}&limit=20`, { headers: headers() })
    if (res.ok) {
      const data = await res.json()
      searchResults.value = data.results || data || []
    }
  } catch (e) {
    console.error('搜索失败', e)
  } finally {
    searching.value = false
  }
}

// 展开详情
async function toggleDetail(id: string) {
  if (expandedId.value === id) {
    expandedId.value = null
    expandedDetail.value = null
    return
  }
  expandedId.value = id
  expandedDetail.value = null
  detailLoading.value = true
  try {
    const res = await fetch(`/ob/bucket/${id}`, { headers: headers() })
    if (res.ok) {
      expandedDetail.value = await res.json()
    }
  } catch (e) {
    console.error('加载详情失败', e)
  } finally {
    detailLoading.value = false
  }
}

// 筛选后的列表
const filteredBuckets = computed(() => {
  if (searchQuery.value.trim() && searchResults.value.length) {
    return searchResults.value
  }
  if (activeTab.value === 'all') {
    return buckets.value.filter(b => b.type !== 'archived')
  }
  if (activeTab.value === 'archive') {
    return buckets.value.filter(b => b.type === 'archived' || b.resolved)
  }
  if (activeTab.value === 'feel') {
    return buckets.value.filter(b => b.type === 'feel' || b.tags?.includes('__feel__'))
  }
  if (activeTab.value === 'plan') {
    return buckets.value.filter(b => b.type === 'plan')
  }
  return buckets.value.filter(b => {
    const domains: string[] = b.domain || []
    return domains.includes(activeTab.value)
  })
})

// 统计
const domainCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const tab of DOMAIN_TABS) {
    if (tab.key ==='all') {
      counts[tab.key] = buckets.value.filter(b => b.type !== 'archived').length
    } else if (tab.key === 'archive') {
      counts[tab.key] = buckets.value.filter(b => b.type === 'archived' || b.resolved).length
    } else if (tab.key === 'feel') {
      counts[tab.key] = buckets.value.filter(b => b.type === 'feel' || b.tags?.includes('__feel__')).length
    } else if (tab.key === 'plan') {
      counts[tab.key] = buckets.value.filter(b => b.type === 'plan').length
    } else {
      counts[tab.key] = buckets.value.filter(b => b.domain?.includes(tab.key)).length
    }
  }
  return counts
})

// 格式化时间
function formatTime(iso: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    if (diffDays === 0) return '今天'
    if (diffDays === 1) return '昨天'
    if (diffDays < 7) return `${diffDays}天前`
    return `${d.getMonth() + 1}/${d.getDate()}`
  } catch {
    return ''
  }
}

// 重要度颜色
function importanceColor(imp: number): string {
  if (imp >= 9) return '#ff6b9d'
  if (imp >= 7) return '#c8a2c8'
  if (imp >= 5) return '#7a9ec4'
  return '#666'
}

// domain 图标
function domainIcon(domains: string[]): string {
  if (!domains?.length) return '📝'
  const d = domains[0]
  const tab = DOMAIN_TABS.find(t => t.key === d)
  return tab?.icon || '📝'
}

function goBack() {
  router.push('/')
}

onMounted(() => {
  loadBuckets()
  loadWorldBook()
})

//===== 世界书 =====
interface WorldBookEntry {
  id: string
  title: string
  content: string
  enabled: boolean
}

const showWorldBook = ref(false)
const worldBookEntries = ref<WorldBookEntry[]>([])
const editingEntry = ref<WorldBookEntry | null>(null)
const editTitle = ref('')
const editContent = ref('')

function loadWorldBook() {
  const saved = localStorage.getItem('worldbook')
  if (saved) {
    try {
      worldBookEntries.value = JSON.parse(saved)
    } catch { worldBookEntries.value = [] }
  }
}

function saveWorldBook() {
  localStorage.setItem('worldbook', JSON.stringify(worldBookEntries.value))
}

function addEntry() {
  editingEntry.value = { id: '', title: '', content: '', enabled: true }
  editTitle.value = ''
  editContent.value = ''
}

function editEntry(entry: WorldBookEntry) {
  editingEntry.value = entry
  editTitle.value = entry.title
  editContent.value = entry.content
}

function saveEntry() {
  if (!editTitle.value.trim() || !editContent.value.trim()) return
  if (editingEntry.value?.id) {
    // 编辑已有条目
    const idx = worldBookEntries.value.findIndex(e => e.id === editingEntry.value!.id)
    if (idx !== -1) {
      worldBookEntries.value[idx].title = editTitle.value.trim()
      worldBookEntries.value[idx].content = editContent.value.trim()
    }
  } else {
    // 新建条目
    worldBookEntries.value.push({
      id: Date.now().toString(36),
      title: editTitle.value.trim(),
      content: editContent.value.trim(),
      enabled: true
    })
  }
  saveWorldBook()
  editingEntry.value = null
}

function cancelEdit() {
  editingEntry.value = null
}

function deleteEntry(id: string) {
  worldBookEntries.value = worldBookEntries.value.filter(e => e.id !== id)
  saveWorldBook()
}

function toggleEntry(id: string) {
  const entry = worldBookEntries.value.find(e => e.id === id)
  if (entry) {
    entry.enabled = !entry.enabled
    saveWorldBook()
  }
}
</script>

<template>
  <div class="study"><header class="room-header">
      <button class="back-btn" @click="goBack">←玄关</button>
      <span class="room-title">书房</span>
      <div class="spacer"></div>
    </header>

    <!--搜索栏 -->
    <div class="search-bar">
      <input
        v-model="searchQuery"
        placeholder="搜索记忆..."
        @input="onSearchInput"
      />
      <span v-if="searching" class="search-spinner">⏳</span>
    </div>

    <!-- 分类标签 -->
    <div class="tabs-scroll">
      <div class="tabs">
        <button
          v-for="tab in DOMAIN_TABS"
          :key="tab.key"
          :class="['tab', { active: activeTab === tab.key }]"
          @click="activeTab = tab.key; searchQuery = ''; searchResults = []"
        ><span class="tab-icon">{{ tab.icon }}</span>
          <span class="tab-label">{{ tab.label }}</span>
          <span class="tab-count" v-if="domainCounts[tab.key]">{{ domainCounts[tab.key] }}</span>
        </button>
      </div>
    </div>

    <!-- 记忆列表 -->
    <main class="memory-list" v-if="!loading">
      <div v-if="filteredBuckets.length === 0" class="empty">
        {{ searchQuery ? '没有找到相关记忆' : '这个分类还没有记忆' }}
      </div>

      <div
        v-for="bucket in filteredBuckets"
        :key="bucket.id"
        class="memory-card"
        @click="toggleDetail(bucket.id)"
      >
        <div class="card-header">
          <span class="card-icon">{{ domainIcon(bucket.domain) }}</span>
          <span class="card-name">{{ bucket.name || bucket.id }}</span>
          <span class="card-time">{{ formatTime(bucket.created) }}</span>
        </div>

        <div class="card-preview">{{ bucket.content_preview || bucket.display_content || '' }}</div>

        <div class="card-meta">
          <span
            class="importance-dot"
            :style="{ background: importanceColor(bucket.importance) }"
          ></span>
          <span v-if="bucket.pinned" class="meta-tag pinned">📌</span>
          <span v-if="bucket.type === 'feel'" class="meta-tag feel">🫧</span>
          <span v-if="bucket.resolved" class="meta-tag resolved">✓</span>
          <span v-for="tag in (bucket.tags || []).filter((t: string) => !t.startsWith('__'))" :key="tag" class="meta-tag">{{ tag }}</span>
        </div>

        <!-- 展开详情 -->
        <div v-if="expandedId === bucket.id" class="card-detail" @click.stop>
          <div v-if="detailLoading" class="detail-loading">加载中...</div>
          <div v-else-if="expandedDetail" class="detail-content">
            <pre class="detail-text">{{ expandedDetail.display_content || expandedDetail.content }}</pre>
            <div class="detail-meta">
              <div v-if="expandedDetail.metadata?.why_remembered" class="why">💡 {{ expandedDetail.metadata.why_remembered }}
              </div>
              <div class="meta-row">
                <span>重要度: {{ expandedDetail.metadata?.importance || '?' }}</span>
                <span>活跃度: {{ expandedDetail.score?.toFixed(1) || '?' }}</span>
                <span v-if="expandedDetail.metadata?.valence != null">
                  情绪: {{ (expandedDetail.metadata.valence * 100).toFixed(0) }}%
                </span>
              </div><div class="meta-row" v-if="expandedDetail.metadata?.created">
                <span>创建: {{ expandedDetail.metadata.created.slice(0, 10) }}</span>
                <span v-if="expandedDetail.metadata?.last_active">
                  最后活跃: {{ expandedDetail.metadata.last_active.slice(0, 10) }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- 加载中 -->
    <main v-else class="loading-state">
      <div class="loading-text">正在翻阅记忆...</div>
    </main>

        <div class="worldbook-section">
      <div class="wb-header" @click="showWorldBook = !showWorldBook">
        <span class="wb-toggle">{{ showWorldBook ? '▼' : '▶' }}</span>
        <span class="wb-title">📖 世界书</span>
        <span class="wb-count">{{ worldBookEntries.filter(e => e.enabled).length }}/{{ worldBookEntries.length }} 条启用</span>
      </div>

      <div v-if="showWorldBook" class="wb-body">
        <div v-if="editingEntry !== null" class="wb-editor">
          <input
            v-model="editTitle"
            placeholder="条目标题"
            class="wb-input"
          />
          <textarea
            v-model="editContent"
            placeholder="条目内容..."
            class="wb-textarea"
            rows="5"
          ></textarea>
          <div class="wb-editor-actions">
            <button class="wb-btn save" @click="saveEntry">保存</button>
            <button class="wb-btn cancel" @click="cancelEdit">取消</button>
          </div>
        </div>

        <div v-else>
          <button class="wb-add-btn" @click="addEntry">+ 添加条目</button>

          <div v-if="worldBookEntries.length === 0" class="wb-empty">
            还没有世界书条目
          </div>

          <div
            v-for="entry in worldBookEntries"
            :key="entry.id"
            :class="['wb-entry', { disabled: !entry.enabled }]">
            <div class="wb-entry-header">
              <label class="wb-switch" @click.stop>
                <input
                  type="checkbox"
                  :checked="entry.enabled"
                  @change="toggleEntry(entry.id)"
                />
                <span class="wb-slider"></span>
              </label>
              <span class="wb-entry-title">{{ entry.title }}</span>
              <div class="wb-entry-actions">
                <button class="wb-icon-btn" @click.stop="editEntry(entry)">✏️</button>
                <button class="wb-icon-btn" @click.stop="deleteEntry(entry.id)">🗑️</button>
              </div>
            </div>
            <div class="wb-entry-content">{{ entry.content }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.study {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  background: #0a0a0f;
  color: #e0e0e0;
}

.room-header {
  display: flex;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #1a1a2e;
  flex-shrink: 0;
}
.back-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 4px 8px;
}
.back-btn:hover { color: #c8c8d0; }
.room-title {
  flex: 1;
  text-align: center;
  font-size: 18px;
  font-weight: 600;
  color: #c8c8d0;
}
.spacer { width: 60px; }

/* 搜索栏 */
.search-bar {
  padding: 12px 16px 8px;
  position: relative;
  flex-shrink: 0;
}
.search-bar input {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid #2a2a4a;
  border-radius: 12px;
  background: #12121e;
  color: #e0e0e0;
  font-size: 14px;
  outline: none;
  box-sizing: border-box;
}
.search-bar input::placeholder { color: #555; }
.search-bar input:focus { border-color: #4a4a7a; }
.search-spinner {
  position: absolute;
  right: 28px;
  top: 50%;
  transform: translateY(-50%);
}

/* 分类标签 */
.tabs-scroll {
  flex-shrink: 0;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.tabs-scroll::-webkit-scrollbar { display: none; }
.tabs {
  display: flex;
  gap: 6px;
  padding: 8px 16px;
  white-space: nowrap;
}
.tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: 1px solid #2a2a4a;
  border-radius: 16px;
  background: transparent;
  color: #888;
  font-size: 13px;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s;
}
.tab:hover { border-color: #4a4a7a; color: #aaa; }
.tab.active {
  background: #1a1a3a;
  border-color: #5a5a8a;
  color: #c8c8d0;
}
.tab-icon { font-size: 14px; }
.tab-count {
  font-size: 11px;
  color: #666;
  margin-left: 2px;
}

/* 记忆列表 */
.memory-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 16px;
  -webkit-overflow-scrolling: touch;
}

.empty {
  text-align: center;
  color: #555;
  padding: 40px 0;
  font-size: 14px;
}

/* 记忆卡片 */
.memory-card {
  padding: 14px;
  margin-bottom: 8px;
  background: #111118;
  border: 1px solid #1a1a2e;
  border-radius: 12px;
  cursor: pointer;
  transition: border-color 0.2s;
}
.memory-card:hover { border-color: #2a2a4a; }
.memory-card:active { background: #15151f; }

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.card-icon { font-size: 16px; }
.card-name {
  flex: 1;
  font-size: 14px;
  font-weight: 500;
  color: #c8c8d0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-time {
  font-size: 12px;
  color: #555;
  flex-shrink: 0;
}

.card-preview {
  font-size: 13px;
  color: #888;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 8px;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.importance-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.meta-tag {
  font-size: 11px;
  color: #666;
  padding: 1px 6px;
  background: #1a1a2e;
  border-radius: 8px;
}
.meta-tag.pinned { color: #c8a2c8; }
.meta-tag.feel { color: #7ab8d4; }
.meta-tag.resolved { color: #6a9; }

/* 展开详情 */
.card-detail {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #1a1a2e;
}
.detail-loading {
  color: #555;
  font-size: 13px;
  text-align: center;
  padding: 12px 0;
}
.detail-text {
  font-size: 14px;
  line-height: 1.7;
  color: #d0d0d8;
  white-space: pre-wrap;
  word-break: break-word;font-family: inherit;
  margin: 0 0 12px;
  background: none;
  border: none;
  padding: 0;
}
.why {
  font-size: 13px;
  color: #a89060;
  margin-bottom: 8px;
  padding: 6px 10px;
  background: #1a1820;
  border-radius: 8px;
}
.detail-meta {
  font-size: 12px;
  color: #666;
}
.meta-row {
  display: flex;
  gap: 16px;
  margin-top: 4px;
}

/* 加载状态 */
.loading-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.loading-text {
  color: #555;
  font-size: 14px;
}

/* 世界书 */
.worldbook-section {
  flex-shrink: 0;
  border-top: 1px solid #1a1a2e;
}
.wb-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  cursor: pointer;
  user-select: none;
}
.wb-header:hover { background: #111118; }
.wb-toggle { color: #555; font-size: 12px; }
.wb-title { font-size: 15px; color: #c8c8d0; }
.wb-count { font-size: 12px; color: #555; margin-left: auto; }

.wb-body { padding: 0 16px 16px; }

.wb-add-btn {
  width: 100%;
  padding: 10px;
  border: 1px dashed #2a2a4a;
  border-radius: 10px;
  background: transparent;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  margin-bottom: 10px;
}
.wb-add-btn:hover { border-color: #4a4a7a; color: #aaa; }

.wb-empty {
  text-align: center;
  color: #444;
  font-size: 13px;
  padding: 20px 0;
}

.wb-entry {
  padding: 12px;
  margin-bottom: 8px;
  background: #111118;
  border: 1px solid #1a1a2e;
  border-radius: 10px;
  transition: opacity 0.2s;
}
.wb-entry.disabled { opacity: 0.4; }

.wb-entry-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}
.wb-entry-title {
  flex: 1;
  font-size: 14px;
  font-weight: 500;
  color: #c8c8d0;
}
.wb-entry-actions {
  display: flex;
  gap: 4px;
}
.wb-icon-btn {
  background: none;
  border: none;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 4px;
  opacity: 0.5;
}
.wb-icon-btn:hover { opacity: 1; }

.wb-entry-content {
  font-size: 13px;
  color: #888;
  line-height: 1.5;
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 开关 */
.wb-switch {
  position: relative;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
}
.wb-switch input { display: none; }
.wb-slider {
  position: absolute;
  inset: 0;
  background: #2a2a4a;
  border-radius: 10px;
  cursor: pointer;
  transition: 0.2s;
}
.wb-slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  top: 2px;
  background: #666;
  border-radius: 50%;
  transition: 0.2s;
}
.wb-switch input:checked + .wb-slider { background: #4a4a8a; }
.wb-switch input:checked + .wb-slider::before {
  transform: translateX(16px);
  background: #c8c8d0;
}

/* 编辑器 */
.wb-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}
.wb-input {
  padding: 10px 12px;
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  background: #12121e;
  color: #e0e0e0;
  font-size: 14px;outline: none;
}
.wb-input:focus { border-color: #4a4a7a; }
.wb-textarea {
  padding: 10px 12px;
  border: 1px solid #2a2a4a;
  border-radius: 8px;
  background: #12121e;
  color: #e0e0e0;
  font-size: 14px;
  line-height: 1.6;
  outline: none;
  resize: vertical;
  font-family: inherit;
}
.wb-textarea:focus { border-color: #4a4a7a; }
.wb-editor-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.wb-btn {
  padding: 8px 20px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
}
.wb-btn.save { background: #3a3a6a; color: #e0e0e0; }
.wb-btn.save:hover { background: #4a4a8a; }
.wb-btn.cancel { background: #2a2a3a; color: #888; }
.wb-btn.cancel:hover { background: #3a3a4a; }
</style>
