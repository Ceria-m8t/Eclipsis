// 把他摆的像素小画渲染成 PNG，挂到那条经历上（2026-11-11）。
// 和画笔画的图走同一条路：meta.images → 聊天页显示图片，历史里他也看得到自己画的。
//
// 聊天（recorder.finishEpisodes）和醒来（wake/dispatch.ts）共用这里：
// 他醒着画的以前不渲染，她看到的是一屏字符（2026-11-11 Erica 报的）。
import type { DB } from './db.ts'
import type { BlobStore } from './blobs.ts'
import { renderPixel, splitPixel, type PixelArt } from './pixel.ts'

/** 他写的像素块：从正文里拆出去（她看到的是图）。没画画就原样返回 */
export function takePixel(content: string): { text: string; arts: PixelArt[]; errors: string[] } {
  const p = splitPixel(content)
  if (!p.arts.length && !p.errors.length) return { text: content, arts: [], errors: [] }
  return { text: p.text, arts: p.arts, errors: p.errors }
}

/** 整条就是一幅画时正文会空掉：留个占位，不然这条经历会被当成空的丢掉（显示时会换成图） */
export const IMAGE_ONLY = '[图片]'

export async function attachPixelArt(db: DB, blobs: BlobStore, seq: number, arts: PixelArt[]): Promise<void> {
  const hashes: string[] = []
  for (const art of arts.slice(0, 4)) {
    const png = await renderPixel(art)
    hashes.push(blobs.putFile('image/png', png))
  }
  if (!hashes.length) return
  const row = db.prepare('SELECT meta FROM episodes WHERE seq = ?').get(seq) as { meta: string | null } | undefined
  if (!row) return
  let meta: Record<string, unknown> = {}
  try { meta = row.meta ? JSON.parse(row.meta) : {} } catch {}
  const had = Array.isArray(meta.images) ? (meta.images as unknown[]).filter(h => typeof h === 'string') as string[] : []
  meta.images = [...had, ...hashes]
  // 像素图本来就小，历史里直接用它，不用再缩
  db.prepare('UPDATE episodes SET meta = ? WHERE seq = ?').run(JSON.stringify(meta), seq)
}

/** 按 source_ref 找那条经历再挂（醒来那边写完经历没有 seq 在手上） */
export async function attachPixelBySourceRef(db: DB, blobs: BlobStore, sourceRef: string, arts: PixelArt[]): Promise<void> {
  const row = db.prepare('SELECT seq FROM episodes WHERE source_ref = ?').get(sourceRef) as { seq: number } | undefined
  if (row) await attachPixelArt(db, blobs, row.seq, arts)
}
