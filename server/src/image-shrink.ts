// 给模型看的小图（2026-11-11）：他画出来的是 1024 的 PNG，一张两三 MB，
// 每轮都塞进历史太重（11-11 就因为超过总量上限，画她那张被跳过了，他说「第二张没看到」）。
// 画完就另存一份 JPEG 小图，历史里给他看小的；她在聊天页看的还是原图。
//
// 用系统的 python3 + Pillow（apt 的 python3-pil），不加 node 依赖。没装就原样返回，不影响画图。
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 超过这个大小才缩（她手机上传的照片本来就压过，一般两三百 KB） */
export const SHRINK_OVER_BYTES = 600 * 1024
export const SHRINK_MAX_SIDE = 1280

const PY = `
import sys
from PIL import Image
src, dst, side = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src)
im = im.convert('RGB')
w, h = im.size
scale = min(1.0, side / float(max(w, h)))
if scale < 1.0:
    im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
im.save(dst, 'JPEG', quality=82, optimize=True)
`

function run(args: string[], timeoutMs = 25_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('python3', args, { timeout: timeoutMs }, err => (err ? reject(err) : resolve()))
  })
}

/**
 * 缩成给模型看的小图。缩不动（没装 Pillow、格式不认）就返回 null，调用方用原图。
 */
export async function shrinkForModel(data: Buffer, opts: { maxSide?: number } = {}): Promise<{ mime: string; data: Buffer } | null> {
  if (data.length < SHRINK_OVER_BYTES) return null
  const dir = mkdtempSync(join(tmpdir(), 'ecl-img-'))
  try {
    const src = join(dir, 'in.bin')
    const dst = join(dir, 'out.jpg')
    const py = join(dir, 'shrink.py')
    writeFileSync(src, data)
    writeFileSync(py, PY)
    await run([py, src, dst, String(opts.maxSide ?? SHRINK_MAX_SIDE)])
    const out = readFileSync(dst)
    if (!out.length || out.length >= data.length) return null
    return { mime: 'image/jpeg', data: out }
  } catch {
    return null
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}
