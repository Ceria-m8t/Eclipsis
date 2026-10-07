<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const anniversaryDate = new Date('2026-09-25')

//纪念日配置
// 每年循环的日期 (月-日 格式)
const recurringDates: Record<string, string> = {
  '04-27': '🎂 Erica 生日',
  '09-25': '💕 在一起纪念日',
}

// 一次性特殊日期 (完整日期)
const oneTimeDates: Record<string, string> = {}

// 自定义备注（从localStorage读取）
const customNotes = ref<Record<string, string>>(
  JSON.parse(localStorage.getItem('calendar-notes') || '{}')
)

function getSpecialLabel(dateStr: string): string {
  // dateStr 格式: 2026-10-08
  const monthDay = dateStr.slice(5) // "10-08"
  const labels: string[] = []
  if (recurringDates[monthDay]) labels.push(recurringDates[monthDay])
  if (oneTimeDates[dateStr]) labels.push(oneTimeDates[dateStr])
  if (customNotes.value[dateStr]) labels.push(customNotes.value[dateStr])
  return labels.join(' · ')
}

// 当前状态
const today = new Date()
const daysTogether = computed(() => {
  const now = new Date()
  return Math.floor((now.getTime() - anniversaryDate.getTime()) / (1000 * 60 * 60 * 24)) + 2
})

// 日历状态
const currentYear = ref(today.getFullYear())
const currentMonth = ref(today.getMonth()) // 0-indexed

const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月']
const weekDays = ['日', '一', '二', '三', '四', '五', '六']

// 切换月份
function prevMonth() {
  if (currentMonth.value === 0) {
    currentMonth.value = 11
    currentYear.value--
  } else {
    currentMonth.value--
  }
}
function nextMonth() {
  if (currentMonth.value === 11) {
    currentMonth.value = 0
    currentYear.value++
  } else {
    currentMonth.value++
  }
}

// 生成日历格子
const calendarDays = computed(() => {
  const year = currentYear.value
  const month = currentMonth.value
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const days: Array<{ date: number; key: string; isToday: boolean; isSpecial: boolean; label: string }> = []

  // 前面的空格
  for (let i = 0; i < firstDay; i++) {
    days.push({ date: 0, key: `empty-${i}`, isToday: false, isSpecial: false, label: '' })
  }

  // 日期
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const isToday = (d === today.getDate() && month === today.getMonth() && year === today.getFullYear())
    const label = getSpecialLabel(dateStr)
    days.push({
      date: d,
      key: dateStr,
      isToday,
      isSpecial: !!label,
      label
    })
  }
  return days
})

// 选中日期
const selectedDate = ref('')
const selectedLabel = ref('')
function selectDate(day: typeof calendarDays.value[0]) {
  if (day.date === 0) return
  if (selectedDate.value === day.key) {
    selectedDate.value = ''
    selectedLabel.value = ''
  } else {
    selectedDate.value = day.key
    selectedLabel.value = day.label
  }
}

// 添加/编辑备注
const isEditing = ref(false)
const editText = ref('')

function startEdit() {
  editText.value = customNotes.value[selectedDate.value] || ''
  isEditing.value = true
}

function saveNote() {
  if (editText.value.trim()) {
    customNotes.value[selectedDate.value] = editText.value.trim()
  } else {
    delete customNotes.value[selectedDate.value]
  }
  localStorage.setItem('calendar-notes', JSON.stringify(customNotes.value))
  isEditing.value = false
  //刷新label显示
  selectedLabel.value = getSpecialLabel(selectedDate.value)
}

function cancelEdit() {
  isEditing.value = false
}
</script>

<template>
  <div class="calendar-page">
    <!-- 顶栏 -->
    <header class="cal-header">
      <button class="back-btn" @click="router.push('/living')">← 客厅</button>
      <span class="header-title">日历</span>
      <span class="header-spacer"></span>
    </header>

    <!-- 装饰边框容器 -->
    <div class="frame-wrapper">
      <div class="decorative-frame">
        <!-- 四角花纹 -->
        <span class="corner corner-tl"></span>
        <span class="corner corner-tr"></span>
        <span class="corner corner-bl"></span>
        <span class="corner corner-br"></span>

        <!-- 在一起卡片 -->
        <div class="together-card">
          <div class="together-days">{{ daysTogether }}</div>
          <div class="together-text">天</div>
          <div class="together-since">🤍 2026.09.25 至今</div>
        </div>

        <!-- 分割线装饰 -->
        <div class="divider">
          <span class="divider-dot">◇</span>
        </div>

        <!-- 月历 -->
        <div class="month-nav">
          <button class="nav-btn" @click="prevMonth">‹</button>
          <span class="month-label">{{ currentYear }}年 {{ monthNames[currentMonth] }}</span>
          <button class="nav-btn" @click="nextMonth">›</button>
        </div><div class="weekday-row">
          <span v-for="w in weekDays" :key="w" class="weekday-cell">{{ w }}</span>
        </div>

        <div class="days-grid">
          <div
            v-for="day in calendarDays"
            :key="day.key"
            class="day-cell"
            :class="{
              empty: day.date === 0,
              today: day.isToday,
              special: day.isSpecial,
              selected: selectedDate === day.key
            }"
            @click="selectDate(day)"
          >
            <span v-if="day.date > 0" class="day-num">{{ day.date }}</span>
            <span v-if="day.isSpecial" class="special-dot"></span>
          </div>
        </div>

        <!-- 选中日期的信息 -->
        <div v-if="selectedDate" class="date-info">
        <div v-if="selectedLabel" class="date-note">
            {{ selectedLabel }}
        </div>

        <div v-if="isEditing" class="note-editor">
            <input
            v-model="editText"
            class="note-input"
            placeholder="写点什么..."
            maxlength="50"
            @keyup.enter="saveNote"
            />
            <div class="note-actions">
            <button class="note-btn save" @click="saveNote">保存</button>
            <button class="note-btn cancel" @click="cancelEdit">取消</button>
            </div>
        </div>
        <button v-else class="add-note-btn" @click="startEdit">
            {{ customNotes[selectedDate] ? '✏️ 编辑备注' : '+ 添加备注' }}
        </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.calendar-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  background: linear-gradient(180deg, #fdf6f0 0%, #fef9f4 50%, #fdf2ea 100%);
  overflow-y: auto;
}

/* 顶栏 */
.cal-header {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  flex-shrink: 0;
}
.back-btn {
  background: none;
  border: none;
  color: #b8896e;
  font-size: 14px;
  cursor: pointer;
  padding: 4px 8px;
}
.header-title {
  flex: 1;
  text-align: center;
  font-size: 17px;
  font-weight: 600;
  color: #8b6e5a;
}
.header-spacer { width: 60px; }

/* 装饰边框 */
.frame-wrapper {
  flex: 1;
  padding: 12px 16px 24px;
}
.decorative-frame {
  position: relative;
  border: 1.5px solid #e8cdb8;
  border-radius: 16px;
  padding: 28px 20px;
  background: rgba(255, 255, 255, 0.6);
  box-shadow: 0 2px 20px rgba(184, 137, 110, 0.08);
}

/* 四角花纹 */
.corner {
  position: absolute;
  width: 24px;
  height: 24px;
  border-color: #d4a98a;
  border-style: solid;
}
.corner-tl {
  top: 6px; left: 6px;
  border-width: 2px 0 0 2px;border-radius: 4px 0 0 0;
}
.corner-tr {
  top: 6px; right: 6px;
  border-width: 2px 2px 0 0;
  border-radius: 0 4px 0 0;
}
.corner-bl {
  bottom: 6px; left: 6px;
  border-width: 0 0 2px 2px;
  border-radius: 0 0 0 4px;
}
.corner-br {
  bottom: 6px; right: 6px;
  border-width: 0 2px 2px 0;
  border-radius: 0 0 4px 0;
}

/* 在一起卡片 */
.together-card {
  text-align: center;
  margin-bottom: 16px;
}
.together-days {
  font-size: 56px;
  font-weight: 300;
  color: #c4886a;
  line-height: 1;
  letter-spacing: 2px;
}
.together-text {
  font-size: 16px;
  color: #b8896e;
  margin-top: 2px;
  letter-spacing: 4px;
}
.together-since {
  font-size: 12px;
  color: #c4a88a;
  margin-top: 8px;
  letter-spacing: 1px;
}

/* 分割线 */
.divider {
  text-align: center;
  margin: 16px 0;
  position: relative;
}
.divider::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 10%;
  right: 10%;
  height: 1px;
  background: linear-gradient(90deg, transparent, #e0c8b4, transparent);
}
.divider-dot {
  position: relative;
  background: rgba(255,255,255,0.6);
  padding: 0 12px;
  color: #d4a98a;
  font-size: 10px;
}

/* 月份导航 */
.month-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 20px;
  margin-bottom: 12px;
}
.nav-btn {
  background: none;
  border: none;
  font-size: 22px;
  color: #b8896e;
  cursor: pointer;
  padding: 4px 10px;
  line-height: 1;
}
.nav-btn:hover { color: #96705a; }
.month-label {
  font-size: 15px;
  color: #8b6e5a;
  font-weight: 500;
  min-width: 120px;
  text-align: center;
}

/* 星期行 */
.weekday-row {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin-bottom: 4px;
}
.weekday-cell {
  text-align: center;
  font-size: 12px;
  color: #b8a090;
  padding: 4px 0;
}

/* 日期网格 */
.days-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}
.day-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 38px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.15s;
}
.day-cell.empty { cursor: default; }
.day-cell:not(.empty):hover {
  background: rgba(212, 169, 138, 0.1);
}
.day-num {
  font-size: 14px;
  color: #6b5a4e;
}
.day-cell.today {
  background: rgba(196, 136, 106, 0.15);
}
.day-cell.today .day-num {
  font-weight: 700;
  color: #c4886a;
}
.day-cell.selected {
  background: rgba(196, 136, 106, 0.2);
}
.day-cell.special .day-num {
  color: #c4886a;
  font-weight: 600;
}
.special-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #d4a98a;
  margin-top: 1px;
}

/* 选中备注 */
.date-note {
  text-align: center;
  margin-top: 16px;
  padding: 10px 16px;
  background: rgba(212, 169, 138, 0.1);
  border-radius: 10px;
  font-size: 13px;
  color: #8b6e5a;
}

/* 选中日期信息区 */
.date-info {
  margin-top: 16px;
}
.note-editor {
  margin-top: 8px;
}
.note-input {
  width: 100%;
  padding: 10px 14px;
  border: 1.5px solid #e0c8b4;
  border-radius: 10px;
  font-size: 13px;
  color: #6b5a4e;
  background: rgba(255,255,255,0.8);
  outline: none;
  box-sizing: border-box;
}
.note-input:focus {
  border-color: #c4886a;
}
.note-input::placeholder {
  color: #c4a88a;
}
.note-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  justify-content: flex-end;
}
.note-btn {
  padding: 6px 16px;
  border-radius: 8px;
  font-size: 12px;
  border: none;
  cursor: pointer;
}
.note-btn.save {
  background: #c4886a;
  color: #fff;
}
.note-btn.save:hover {
  background: #b07a5e;
}
.note-btn.cancel {
  background: rgba(212, 169, 138, 0.15);
  color: #8b6e5a;
}
.add-note-btn {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 8px;
  background: none;
  border: 1.5px dashed #e0c8b4;
  border-radius: 10px;
  color: #b8896e;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
.add-note-btn:hover {
  border-color: #c4886a;
  color: #96705a;
  background: rgba(212, 169, 138, 0.05);
}
</style>
