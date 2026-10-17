// 全局自定义字体：作用于整个应用（顶栏、底栏、气泡、设置页……）。
// 字体文件存在 IndexedDB（单独一个库），不占 localStorage 的 5MB 额度。
// 旧版本存在聊天样式（localStorage 'eclipsis-chat-style-v2'）里的字体会自动搬过来。
import { ref } from 'vue'

const DB = 'eclipsis-assets'
const STORE = 'kv'
const FONT_KEY = 'app-font'
// 中文字体常见 10~30MB；IndexedDB 放得下，太大只是启动时加载慢一点
export const MAX_FONT_BYTES = 40 * 1024 * 1024

interface StoredFont { family: string; name: string; data: Blob }

/** 当前字体的显示名（原文件名），空表示用系统字体 */
export const fontName = ref('')

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function kv<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const r = fn(t.objectStore(STORE))
    t.oncomplete = () => { db.close(); resolve(r ? (r.result as T) : undefined) }
    t.onerror = () => { db.close(); reject(t.error) }
  })
}

let currentFace: FontFace | null = null

async function apply(f: StoredFont | null) {
  const root = document.documentElement.style
  if (currentFace) { document.fonts.delete(currentFace); currentFace = null }
  if (!f) {
    root.removeProperty('--app-font')
    fontName.value = ''
    return
  }
  const face = new FontFace(f.family, await f.data.arrayBuffer())
  await face.load()
  document.fonts.add(face)
  currentFace = face
  // 自定义字体在前，缺字时回退到系统字体（中文字体不全的也能显示）
  root.setProperty('--app-font', `'${f.family}', var(--sans)`)
  fontName.value = f.name
}

async function migrateOld(): Promise<StoredFont | null> {
  try {
    const raw = localStorage.getItem('eclipsis-chat-style-v2')
    if (!raw) return null
    const o = JSON.parse(raw)
    if (!o.fontFamily || !o.fontData) return null
    const blob = await (await fetch(o.fontData)).blob()
    const f: StoredFont = { family: o.fontFamily, name: o.fontFamily.replace(/^custom-/, ''), data: blob }
    await kv('readwrite', s => s.put(f, FONT_KEY))
    // 存好之后再从聊天样式里删掉，腾出 localStorage
    const cur = JSON.parse(localStorage.getItem('eclipsis-chat-style-v2') || '{}')
    delete cur.fontFamily; delete cur.fontData
    localStorage.setItem('eclipsis-chat-style-v2', JSON.stringify(cur))
    return f
  } catch { return null }
}

export async function startFont() {
  try {
    const f = (await kv<StoredFont>('readonly', s => s.get(FONT_KEY))) || (await migrateOld())
    if (f) await apply(f)
  } catch (e) {
    console.warn('[font] 加载自定义字体失败', e)
  }
}

/** 上传新字体。失败时抛出带中文说明的错误 */
export async function setFontFile(file: File) {
  if (file.size > MAX_FONT_BYTES) throw new Error(`字体文件 ${(file.size / 1048576).toFixed(0)}MB，超过 ${MAX_FONT_BYTES / 1048576}MB 上限。可以找这个字体的 WOFF2 版本，通常只有原来的一半大`)
  const name = file.name.replace(/\.[^.]+$/, '')
  // 每次用新的 family 名，避免浏览器缓存旧字形
  const f: StoredFont = { family: 'eclipsis-font-' + Date.now(), name, data: file }
  try { await apply(f) } catch { throw new Error('这个文件读不出来，换一个 TTF/OTF/WOFF 试试') }
  try { await kv('readwrite', s => s.put(f, FONT_KEY)) }
  catch { throw new Error('字体能用，但手机存储空间不够存下来，下次打开会恢复原字体') }
}

export async function clearFont() {
  await kv('readwrite', s => s.delete(FONT_KEY))
  await apply(null)
}
