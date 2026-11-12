// 时间显示（2026-11-12 她问「我怎么觉得我们的记忆系统时间不太对呢」—— 对，差 8 小时）。
//
// 库里存的是 UTC（new Date().toISOString()），这是对的：只有一种时间、不会错。
// 错的是**显示**：之前到处都在 created_at.slice(0, 16).replace('T', ' ')，
// 等于把 UTC 原样念成北京时间。
//
// 实例：夜里整理北京时间 13:25 写的那条，她和他看到的都是「05:25」。
// 更糟的是**夜里整理喂给模型的材料也是 UTC**，模型读到 05:25 就写「凌晨崩溃」——
// 时间错了，连带把那件事的定性也写错了。
//
// 所以：**存 UTC、显示一律过这里**。这个文件是记忆库里唯一把时间变成字符串的地方。
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 偏移到北京时间（+08:00）之后的 Date，后面一律用 getUTC* 读 */
function shifted(iso: string | Date): Date | null {
  const t = iso instanceof Date ? iso.getTime() : new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return new Date(t + 8 * 3600_000)
}

const p2 = (n: number) => String(n).padStart(2, '0')

/** 2026-11-12（北京） */
export function bjDate(iso: string | Date): string {
  const d = shifted(iso)
  if (!d) return String(iso).slice(0, 10)
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
}

/** 11-12 13:25（北京） */
export function bjShort(iso: string | Date): string {
  const d = shifted(iso)
  if (!d) return String(iso).slice(5, 16).replace('T', ' ')
  return `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
}

/** 2026-11-12 13:25（北京） */
export function bjStamp(iso: string | Date): string {
  const d = shifted(iso)
  if (!d) return String(iso).slice(0, 16).replace('T', ' ')
  return `${bjDate(iso)} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
}

/** 11月12日 周四 13:25（北京）——和「这一刻」箱子一致的写法 */
export function bjFull(iso: string | Date): string {
  const d = shifted(iso)
  if (!d) return String(iso)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${WEEK[d.getUTCDay()]} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
}

/** 「3 小时前」「昨天」这种相对说法 */
export function bjAgo(iso: string | Date, now: Date = new Date()): string {
  const t = iso instanceof Date ? iso.getTime() : new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const min = Math.floor((now.getTime() - t) / 60_000)
  if (min < 2) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const days = Math.floor(h / 24)
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  return bjDate(iso)
}
