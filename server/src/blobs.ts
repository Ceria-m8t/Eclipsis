// 去重存储。图片从消息里拆出来存成文件，消息里换成 {blob: 哈希}；
// 每轮请求都带着完整历史，按消息去重后，同一条只占一份空间。
import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from './db.ts'

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/s

export class BlobStore {
  db: DB
  dir: string

  constructor(db: DB, dir: string) {
    this.db = db
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  putText(kind: string, text: string): string {
    const hash = sha256(text)
    this.db.prepare(`INSERT OR IGNORE INTO blobs(hash, kind, mime, size, text, created_at) VALUES (?, ?, NULL, ?, ?, ?)`)
      .run(hash, kind, Buffer.byteLength(text), text, new Date().toISOString())
    return hash
  }

  putFile(mime: string, data: Buffer): string {
    const hash = sha256(data)
    const sub = join(this.dir, hash.slice(0, 2))
    const file = join(sub, hash)
    if (!existsSync(file)) {
      mkdirSync(sub, { recursive: true })
      writeFileSync(file, data)
    }
    this.db.prepare(`INSERT OR IGNORE INTO blobs(hash, kind, mime, size, text, created_at) VALUES (?, 'file', ?, ?, NULL, ?)`)
      .run(hash, mime, data.length, new Date().toISOString())
    return hash
  }

  getText(hash: string): string | undefined {
    const row = this.db.prepare('SELECT text FROM blobs WHERE hash = ?').get(hash) as { text: string | null } | undefined
    return row?.text ?? undefined
  }

  // 把 data:image/...;base64 换成 blob 引用。返回新对象，不改原消息。
  extractImages(message: any): { message: any; images: string[] } {
    const images: string[] = []
    const content = message?.content
    if (!Array.isArray(content)) return { message, images }
    const parts = content.map((p: any) => {
      const url = p?.image_url?.url ?? (typeof p?.image_url === 'string' ? p.image_url : undefined)
      if (typeof url === 'string') {
        const m = DATA_URL.exec(url)
        if (m) {
          const hash = this.putFile(m[1], Buffer.from(m[2], 'base64'))
          images.push(hash)
          return { type: 'image_ref', blob: hash, mime: m[1] }
        }
      }
      // Anthropic 原生格式的图片
      if (p?.type === 'image' && p?.source?.type === 'base64' && typeof p.source.data === 'string') {
        const hash = this.putFile(p.source.media_type || 'application/octet-stream', Buffer.from(p.source.data, 'base64'))
        images.push(hash)
        return { type: 'image_ref', blob: hash, mime: p.source.media_type }
      }
      return p
    })
    return { message: { ...message, content: parts }, images }
  }

  // 存一条消息（图片已拆出），返回哈希、替换后的消息、图片哈希
  putMessage(message: any): { hash: string; message: any; images: string[] } {
    const ex = this.extractImages(message)
    return { hash: this.putText('message', JSON.stringify(ex.message)), message: ex.message, images: ex.images }
  }
}
