// 书房书架：书的样子（用哪张书脊/封面/衬页/书页）和世界书的读写。
//
// 世界书的数据和设置页里那个面板是同一份（localStorage 'worldbook' + queueWorldbookPush 推到后端），
// 两边改哪边都行。每存一次先在本机留一份快照（最近 5 份），万一书架这边出了错还能找回。
import meta from './book-assets.json'
import { queueWorldbookPush } from '../../../prompt-store'

export const ASSET = '/assets/rooms/study/shelf/'

export interface WorldbookEntry {
  title: string
  content: string
  enabled: boolean
  group: string
  position: 'before' | 'after'
  priority: number
}

interface Box { x: number; y: number; w: number; h: number }
interface Img { file: string; w: number; h: number; label?: Box | null }

export interface BookLook {
  kind: 'main' | 'world'
  spine: Img
  cover: Img
  endpaper: Img
  page: Img
  /** 书在书架上的高度，相对最高那本普通书 */
  heightScale: number
}

const SPINE_MAX_H = 520   // books.py 把最高那本书脊缩到 520

/** 第 i 本世界书的样子：8 种书脊轮着用，封面/衬页跟书脊同色（书脊每两本一个颜色） */
export function worldLook(i: number): BookLook {
  const s = meta.spines[((i % 8) + 8) % 8]
  const color = Math.floor((((i % 8) + 8) % 8) / 2)
  return {
    kind: 'world',
    spine: s,
    cover: meta.covers[color],
    endpaper: meta.endpapers[color],
    page: meta.page_rococo,
    heightScale: s.h / SPINE_MAX_H
  }
}

export const MAIN_LOOK: BookLook = {
  kind: 'main',
  spine: meta.main.spine,
  cover: meta.main.cover,
  endpaper: meta.mainEndpaper,
  page: meta.page_main,
  heightScale: 1.14
}

export const SHELF_IMG = meta.shelf

// ── 世界书读写（格式和 Settings.vue 一样）──

const WB_KEY = 'worldbook'
const BACKUP_KEY = 'worldbook-shelf-backups'

export function loadWorldbook(): WorldbookEntry[] {
  try {
    const raw = localStorage.getItem(WB_KEY)
    if (!raw) return []
    return (JSON.parse(raw) as any[]).map(e => ({
      title: e.title || '',
      content: e.content || '',
      enabled: e.enabled ?? true,
      group: e.group || '默认',
      position: e.position === 'before' ? 'before' : 'after',
      priority: e.priority ?? 50
    }))
  } catch {
    return []
  }
}

export function saveWorldbook(list: WorldbookEntry[]) {
  try {
    const prev = localStorage.getItem(WB_KEY)
    if (prev) {
      const backups: { at: number; value: string }[] = JSON.parse(localStorage.getItem(BACKUP_KEY) || '[]')
      backups.unshift({ at: Date.now(), value: prev })
      localStorage.setItem(BACKUP_KEY, JSON.stringify(backups.slice(0, 5)))
    }
  } catch { /* 快照存不下就算了，不挡正常保存 */ }
  localStorage.setItem(WB_KEY, JSON.stringify(list))
  queueWorldbookPush()
}

// ── 书名排版 ──

/** 书脊上竖排的书名：字太多就截短，返回要显示的字和字号（单位：书脊高度的百分比，配合 cqh） */
export function spineTitle(title: string, img: Img, widen = 1): { text: string; size: number } {
  const label = img.label ?? { x: 0.3, y: 0.25, w: 0.4, h: 0.23 }
  const aspect = img.w / img.h * widen               // 书脊宽 / 高（书架上加粗过）
  const byWidth = label.w * aspect * 0.86             // 一个字的宽不超过皮签宽（换算成书脊高度的比例）
  const chars = [...(title.trim() || '无题')]
  const fit = (n: number) => label.h / (n * 1.12)
  let n = chars.length
  // 字号小到皮签宽度的六成以下就截短，后面用省略号
  while (n > 2 && fit(n) < byWidth * 0.6) n--
  const text = n < chars.length ? chars.slice(0, n - 1).join('') + '…' : chars.join('')
  return { text, size: Math.min(byWidth, fit(n)) * 100 }
}

/** 封面标题框里横排的书名，字号单位：封面宽度的百分比（配合 cqw） */
export function coverTitle(title: string, img: Img): { text: string; size: number } {
  const label = img.label ?? { x: 0.25, y: 0.34, w: 0.54, h: 0.22 }
  const aspect = img.h / img.w
  const chars = [...(title.trim() || '无题')]
  const maxByHeight = label.h * aspect * 0.42
  let n = chars.length
  while (n > 4 && label.w / (n * 1.04) < maxByHeight * 0.45) n--
  const text = n < chars.length ? chars.slice(0, n - 1).join('') + '…' : chars.join('')
  return { text, size: Math.min(maxByHeight, label.w / (n * 1.04)) * 100 }
}

// ── 书名字体（测试时三套轮着看，选定后留一套）──

export const BOOK_FONTS = [
  { id: 'ornate', name: '华丽', family: "'Cinzel Decorative', 'ZCOOL XiaoWei', serif", weight: 700 },
  { id: 'classic', name: '庄重', family: "'Cinzel Decorative', 'Noto Serif SC', serif", weight: 900 },
  { id: 'brush', name: '毛笔', family: "'Cinzel Decorative', 'Ma Shan Zheng', serif", weight: 400 }
] as const
const FONT_KEY = 'eclipsis-book-font'
export function loadBookFont(): (typeof BOOK_FONTS)[number] {
  const id = localStorage.getItem(FONT_KEY)
  return BOOK_FONTS.find(f => f.id === id) ?? BOOK_FONTS[0]
}
export function saveBookFont(id: string) { localStorage.setItem(FONT_KEY, id) }
