// 把他摆的像素小画渲染成 PNG，挂到那条经历上（2026-11-11）。
// 和画笔画的图走同一条路：meta.images → 聊天页显示图片，历史里他也看得到自己画的。
import type { DB } from './db.ts'
import type { BlobStore } from './blobs.ts'
import { renderPixel, type PixelArt } from './pixel.ts'

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
  meta.images = hashes
  // 像素图本来就小，历史里直接用它，不用再缩
  db.prepare('UPDATE episodes SET meta = ? WHERE seq = ?').run(JSON.stringify(meta), seq)
}
