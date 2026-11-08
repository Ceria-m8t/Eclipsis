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
// 按实际字体量字宽（英文字母比汉字窄得多，按字数估会提前截短，11-09「Safety觉察」就被截成了 SAFETY…）

export interface TitleFont { family: string; weight: number }

let ctx: CanvasRenderingContext2D | null = null
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/

/** 一段字有多宽（单位 em）。竖排时汉字占 1em、英文数字横躺着占它自己的宽 */
function em(text: string, font: TitleFont, vertical = false): number {
  ctx ??= document.createElement('canvas').getContext('2d')
  if (!ctx) return [...text].length
  ctx.font = `${font.weight} 100px ${font.family}`
  if (!vertical) return ctx.measureText(text).width / 100
  let sum = 0
  for (const ch of text) sum += CJK.test(ch) ? 1 : ctx.measureText(ch).width / 100
  return sum
}

/** 书脊上竖排的书名：字太多就截短，返回要显示的字和字号（单位：书脊高度的百分比，配合 cqh） */
export function spineTitle(title: string, img: Img, font: TitleFont, widen = 1): { text: string; size: number } {
  const label = img.label ?? { x: 0.3, y: 0.25, w: 0.4, h: 0.23 }
  const aspect = img.w / img.h * widen               // 书脊宽 / 高（书架上加粗过）
  const byWidth = label.w * aspect * 0.86             // 一个字的宽不超过皮签宽（换算成书脊高度的比例）
  const chars = [...(title.trim() || '无题')]
  const len = (n: number, ell: boolean) => em(chars.slice(0, n).join('') + (ell ? '…' : ''), font, true) + n * 0.04
  const fit = (n: number, ell: boolean) => label.h / (len(n, ell) * 1.04)
  let n = chars.length
  let ell = false
  // 字号小到皮签宽度的六成以下就截短，后面用省略号
  while (n > 2 && fit(n, ell) < byWidth * 0.6) { n--; ell = true }
  const text = ell ? chars.slice(0, n).join('') + '…' : chars.join('')
  return { text, size: Math.min(byWidth, fit(n, ell)) * 100 }
}

/** 封面标题框里横排的书名：一行放不下就分两行，还放不下才截短。字号单位：封面宽度的百分比（配合 cqw） */
export function coverTitle(title: string, img: Img, font: TitleFont): { text: string; size: number } {
  const label = img.label ?? { x: 0.25, y: 0.34, w: 0.54, h: 0.22 }
  const aspect = img.h / img.w
  const boxH = label.h * aspect                       // 标题框的高（换算成封面宽度的比例）
  const boxW = label.w * 0.94
  const width = (t: string) => em(t, font) + [...t].length * 0.06
  const raw = title.trim() || '无题'

  const one = Math.min(boxH * 0.42, boxW / width(raw))
  if (one >= boxH * 0.24) return { text: raw, size: one * 100 }

  // 分两行。能断开的地方：空格前后、中英文交界、两个汉字之间；英文单词中间不断
  const chars = [...raw]
  const latin = (c: string) => /[A-Za-z0-9]/.test(c)
  const canBreak = (i: number) => !(latin(chars[i - 1]) && latin(chars[i]))
  const minSize = boxH * 0.2
  const sizeOf = (ls: string[]) => Math.min(boxH * 0.34, boxW / Math.max(...ls.map(width)))
  const split = (i: number) => [chars.slice(0, i).join('').trim(), chars.slice(i).join('').trim()]

  // 先找两行差不多长、字号最大的断法
  let best: string[] | null = null
  for (let i = 1; i < chars.length; i++) {
    if (!canBreak(i)) continue
    const ls = split(i)
    if (!best || sizeOf(ls) > sizeOf(best)) best = ls
  }
  if (best && sizeOf(best) >= minSize) return { text: best.join('\n'), size: sizeOf(best) * 100 }
  if (!best) return { text: raw, size: Math.max(one, minSize * 0.8) * 100 }   // 一个长单词，只能一行

  // 还太小：第一行按最小字号尽量装满，第二行装不下的截掉
  const maxW = boxW / minSize
  let i = 1
  while (i < chars.length && width(chars.slice(0, i + 1).join('')) <= maxW) i++
  while (i > 1 && !canBreak(i)) i--
  const first = chars.slice(0, i).join('').trim()
  let rest = chars.slice(i)
  while (rest.length > 1 && width(rest.join('').trim() + '…') > maxW) rest = rest.slice(0, -1)
  const second = rest.join('').trim() + (rest.length < chars.length - i ? '…' : '')
  return { text: first + '\n' + second, size: sizeOf([first, second]) * 100 }
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
