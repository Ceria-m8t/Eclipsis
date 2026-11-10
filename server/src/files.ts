// 她发文件给他（2026-11-11）：文字类、PDF、Word 取出文字给他看；原件存着，她在聊天页能下载。
//
// 怎么走：
//   1. 前端先把文件传到 POST /v1/eclipsis/chat/upload（原始字节 + x-file-name 头），后端存原件、抽文字、记进 files 表；
//   2. 前端发消息时在正文里带一个标记 [文件 报告.pdf #<12位哈希>]（她看到的是文件气泡，标记不显示）；
//   3. 发给他之前，attachFiles 把最近几份文件的正文塞在标记后面；更早的只留文件名，并写明这一轮没带内容
//      （和图片一样：不然每轮都把整份文档重发一遍，钱和上下文都撑不住）。
//
// 抽文字用系统现成的命令，不加依赖：PDF 用 pdftotext（poppler-utils），docx 用 unzip 取 word/document.xml 再剥标签。
// 扫描版 PDF 抽不出字，就明确告诉他「这份看不到内容」，别让他照着文件名编（和看不到的图片同一条规矩）。
import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DB } from './db.ts'
import type { BlobStore } from './blobs.ts'

export const MAX_BYTES = 10 * 1024 * 1024      // 单个文件 10MB
export const MAX_CHARS = 30_000                // 抽出来的文字最多给这么多（约 3 万字）
const KEEP_WITH_TEXT = 2                       // 历史里最近几条带文件的消息还带正文

export const FILE_MARK = /\[文件 ([^\]#]{1,120}) #([0-9a-f]{12})\]/g

export interface FileInfo {
  hash: string
  name: string
  mime: string
  size: number
  kind: 'text' | 'pdf' | 'docx' | 'other'
  chars: number            // 抽出来多少字（0 = 抽不出）
  truncated: boolean
  note: string | null      // 抽不出字时写原因，给他看
}

export function ensureFileSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      hash TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      kind TEXT NOT NULL,
      chars INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      -- 抽出来的文字直接存这里：和原件内容一样时（纯文本文件）放 blobs 会因为哈希相同被当成同一条而丢掉
      text TEXT,
      created_at TEXT NOT NULL
    );
  `)
}

const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ya?ml|toml|ini|conf|env|sql|html?|css|xml|svg|ts|tsx|js|jsx|mjs|cjs|vue|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|sh|bash|zsh|php|lua|swift|dart|r|m)$/i
const PDF_EXT = /\.pdf$/i
const DOCX_EXT = /\.docx$/i

export function kindOf(name: string, mime: string): FileInfo['kind'] {
  if (PDF_EXT.test(name) || mime === 'application/pdf') return 'pdf'
  if (DOCX_EXT.test(name) || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
  if (TEXT_EXT.test(name) || mime.startsWith('text/') || mime === 'application/json') return 'text'
  return 'other'
}

function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err && !stdout) reject(err)
      else resolve(stdout || '')
    })
  })
}

/** docx 的 word/document.xml 剥成文字：段落换行、制表符保留，其余标签去掉 */
export function docxXmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 二进制当文字读会是一堆乱码：有 NUL 或替换字符太多就算读不出 */
function looksBinary(s: string): boolean {
  if (s.includes('\0')) return true
  const bad = (s.match(/\uFFFD/g) || []).length
  return bad > 0 && bad / Math.max(1, s.length) > 0.01
}

export async function extractText(data: Buffer, name: string, mime: string): Promise<{ text: string; note: string | null }> {
  const kind = kindOf(name, mime)
  if (kind === 'text') {
    const text = data.toString('utf8')
    if (looksBinary(text)) return { text: '', note: '这个文件不是纯文本，看不到里面的内容' }
    return { text, note: null }
  }
  if (kind === 'pdf' || kind === 'docx') {
    const dir = mkdtempSync(join(tmpdir(), 'ecl-file-'))
    const path = join(dir, kind === 'pdf' ? 'in.pdf' : 'in.docx')
    try {
      writeFileSync(path, data)
      if (kind === 'pdf') {
        const out = await run('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'])
        const text = out.replace(/\f/g, '\n\n').trim()
        return text
          ? { text, note: null }
          : { text: '', note: '这份 PDF 里抽不出文字（大概是扫描件或者整页都是图），内容你看不到，别猜' }
      }
      const xml = await run('unzip', ['-p', path, 'word/document.xml'])
      const text = docxXmlToText(xml)
      return text ? { text, note: null } : { text: '', note: '这份 Word 里抽不出文字（可能整篇都是图片或表格对象），内容你看不到，别猜' }
    } catch (e: any) {
      return { text: '', note: `这个文件没能打开（${String(e?.message || e).slice(0, 80)}），内容你看不到` }
    } finally {
      try { unlinkSync(path) } catch {}
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }
  return { text: '', note: '这种格式后端还不会读，内容你看不到，别猜（可以让她把里面的字贴过来）' }
}

/** 存一份文件：原件进 blobs，抽出来的文字也进 blobs，索引进 files 表 */
export async function saveFile(db: DB, blobs: BlobStore, data: Buffer, name: string, mime: string): Promise<FileInfo> {
  ensureFileSchema(db)
  const hash = blobs.putFile(mime || 'application/octet-stream', data)
  const kind = kindOf(name, mime)
  const got = await extractText(data, name, mime)
  const truncated = got.text.length > MAX_CHARS
  const text = truncated ? got.text.slice(0, MAX_CHARS) : got.text

  const info: FileInfo = {
    hash, name: name.slice(0, 200), mime: mime || 'application/octet-stream', size: data.length, kind,
    chars: text.length, truncated, note: got.note,
  }
  db.prepare(`INSERT INTO files(hash, name, mime, size, kind, chars, truncated, note, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET name = excluded.name, chars = excluded.chars, truncated = excluded.truncated,
      note = excluded.note, text = excluded.text`)
    .run(info.hash, info.name, info.mime, info.size, info.kind, info.chars, truncated ? 1 : 0, info.note, text || null, new Date().toISOString())
  return info
}

export interface FileRow extends FileInfo { text: string | null }

/** 按 12 位哈希前缀找文件（消息里的标记只带前 12 位） */
export function findFiles(db: DB, prefixes: string[]): Map<string, FileRow> {
  const out = new Map<string, FileRow>()
  if (!prefixes.length) return out
  try {
    ensureFileSchema(db)
    for (const p of new Set(prefixes)) {
      const r = db.prepare('SELECT * FROM files WHERE hash LIKE ? LIMIT 1').get(p + '%') as any
      if (r) out.set(p, {
        hash: r.hash, name: r.name, mime: r.mime, size: r.size, kind: r.kind,
        chars: r.chars, truncated: !!r.truncated, note: r.note, text: r.text,
      })
    }
  } catch { /* 老库没有这张表 */ }
  return out
}

const human = (n: number) => (n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`)
const KIND_NAME: Record<FileInfo['kind'], string> = { text: '文本', pdf: 'PDF', docx: 'Word', other: '文件' }

function fileBlock(f: FileRow, text: string): string {
  const head = `〔文件内容：${f.name}（${KIND_NAME[f.kind]}，${human(f.size)}${f.chars ? `，约 ${f.chars} 字` : ''}${f.truncated ? '，太长了只给前面这些' : ''}）〕`
  return `${head}\n${text}\n〔文件内容结束〕`
}

/**
 * 把消息里的文件标记换成他能看的东西：最近 keep 条带文件的消息给正文，更早的只留文件名。
 * 她那边看到的是文件气泡，这些字她看不到。
 */
export function attachFiles(messages: any[], db: DB, keep = KEEP_WITH_TEXT): { messages: any[]; attached: number; trimmed: number } {
  if (!Array.isArray(messages)) return { messages, attached: 0, trimmed: 0 }
  const hits: number[] = []
  messages.forEach((m, i) => {
    if (typeof m?.content === 'string' && FILE_MARK.test(m.content)) hits.push(i)
    FILE_MARK.lastIndex = 0
  })
  if (!hits.length) return { messages, attached: 0, trimmed: 0 }
  const withText = new Set(hits.slice(-keep))
  const all: string[] = []
  for (const i of hits) {
    const c = messages[i].content as string
    for (const m of c.matchAll(FILE_MARK)) all.push(m[2]!)
  }
  const found = findFiles(db, all)
  let attached = 0, trimmed = 0
  const out = messages.map((m, i) => {
    if (!hits.includes(i)) return m
    const content = (m.content as string).replace(FILE_MARK, (_whole, name: string, prefix: string) => {
      const f = found.get(prefix)
      if (!f) return `〔文件：${name}（找不到了）〕`
      if (!withText.has(i)) { trimmed++; return `〔文件：${name}（这一轮没带内容；她要是问里面的细节，让她再发一次）〕` }
      if (f.note || !f.text) { attached++; return `〔文件：${f.name}（${KIND_NAME[f.kind]}，${human(f.size)}）——${f.note || '内容是空的'}〕` }
      attached++
      return fileBlock(f, f.text)
    })
    return { ...m, content }
  })
  return { messages: out, attached, trimmed }
}

// ---------------- HTTP ----------------

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) { reject(Object.assign(new Error(`文件太大了（最多 ${human(max)}）`), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 *   POST /v1/eclipsis/chat/upload   原始字节 + x-file-name（URL 编码）→ { hash, name, size, kind, chars, note, mark }
 *   GET  /v1/eclipsis/file/<hash>        下载原件（她在聊天页长按/点「下载原件」）
 *   GET  /v1/eclipsis/file/<hash>/text   抽出来的文字（她在聊天页点文件，直接在前端里看）
 */
export async function handleFileApi(
  db: DB, blobs: BlobStore, req: IncomingMessage, res: ServerResponse
): Promise<boolean> {
  const p = new URL(req.url || '/', 'http://local').pathname
  if (p === '/v1/eclipsis/chat/upload' && req.method === 'POST') {
    try {
      const raw = String(req.headers['x-file-name'] || '')
      let name = ''
      try { name = decodeURIComponent(raw) } catch { name = raw }
      name = name.replace(/[\r\n\t]/g, ' ').trim()
      if (!name) { json(res, 400, { error: '缺 x-file-name' }); return true }
      const data = await readBody(req, MAX_BYTES)
      if (!data.length) { json(res, 400, { error: '文件是空的' }); return true }
      const info = await saveFile(db, blobs, data, name, String(req.headers['content-type'] || ''))
      json(res, 200, { ...info, mark: `[文件 ${info.name.replace(/[\][#]/g, '_')} #${info.hash.slice(0, 12)}]` })
    } catch (e: any) {
      json(res, e?.status || 500, { error: String(e?.message || e) })
    }
    return true
  }
  // 抽出来的文字：她点文件时在前端里直接看（不用交给 WPS）
  const mt = /^\/v1\/eclipsis\/file\/([0-9a-f]{12,64})\/text$/.exec(p)
  if (mt && req.method === 'GET') {
    const f = findFiles(db, [mt[1]!.slice(0, 12)]).get(mt[1]!.slice(0, 12))
    if (!f) { json(res, 404, { error: 'not found' }); return true }
    json(res, 200, {
      hash: f.hash.slice(0, 12), name: f.name, mime: f.mime, size: f.size, kind: f.kind,
      chars: f.chars, truncated: f.truncated, note: f.note, text: f.text || '',
    })
    return true
  }
  const m = /^\/v1\/eclipsis\/file\/([0-9a-f]{12,64})$/.exec(p)
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    const f = findFiles(db, [m[1]!.slice(0, 12)]).get(m[1]!.slice(0, 12))
    if (!f) { json(res, 404, { error: 'not found' }); return true }
    const data = blobs.readFile(f.hash)
    if (!data) { json(res, 404, { error: 'not found' }); return true }
    res.writeHead(200, {
      'content-type': f.mime,
      'content-length': String(data.length),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : data)
    return true
  }
  return false
}
