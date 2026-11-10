// 她发文件给他（2026-11-11）：先传到后端（后端抽文字、存原件），再把标记放进消息正文。
// 气泡里显示文件名和大小，点一下下载；标记本身不显示。
const BASE = '/api/eclipsis'

export interface UploadedFile {
  hash: string
  name: string
  mime: string
  size: number
  kind: 'text' | 'pdf' | 'docx' | 'other'
  chars: number
  truncated: boolean
  note: string | null
  mark: string          // 放进正文的标记，如 [文件 报告.pdf #f3a9c1d2e4b5]
}

/** 聊天里能发的：文字类、PDF、Word。Excel 这些后端还读不出，不放进来 */
export const FILE_ACCEPT = [
  '.txt', '.md', '.markdown', '.pdf', '.docx', '.json', '.csv', '.tsv', '.log',
  '.yml', '.yaml', '.toml', '.ini', '.conf', '.env', '.sql', '.html', '.htm', '.css', '.xml',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.py', '.rb', '.go', '.rs', '.java',
  '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.sh', '.bash', '.php', '.lua', '.swift', '.dart',
].join(',')

export const MAX_FILE_BYTES = 10 * 1024 * 1024

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export async function uploadFile(file: File): Promise<UploadedFile> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`文件太大了（最多 ${humanSize(MAX_FILE_BYTES)}）`)
  const r = await fetch(`${BASE}/chat/upload`, {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(file.name),
    },
    body: file,
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.error || `上传失败（HTTP ${r.status}）`)
  return d as UploadedFile
}

export interface MsgFile { name: string; hash: string; size?: number; kind?: string; chars?: number; note?: string | null }

const MARK = /\[文件 ([^\]#]{1,120}) #([0-9a-f]{12})\]/g

/** 从正文里拆出文件标记：气泡上单独显示，正文里不留 */
export function splitFiles(text: string): { text: string; files: MsgFile[] } {
  if (!text.includes('[文件 ')) return { text, files: [] }
  const files: MsgFile[] = []
  const left = text.replace(MARK, (_w, name: string, hash: string) => {
    files.push({ name, hash })
    return ''
  }).replace(/\n{3,}/g, '\n\n').trim()
  return { text: left, files }
}

export const fileUrl = (hash: string) => `${BASE}/file/${hash}`

export interface FileText {
  hash: string; name: string; mime: string; size: number
  kind: UploadedFile['kind']; chars: number; truncated: boolean; note: string | null; text: string
}

/** 点开文件：拿后端抽出来的文字，在前端里直接看 */
export async function loadFileText(hash: string): Promise<FileText> {
  const r = await fetch(`${BASE}/file/${hash}/text`, { cache: 'no-store' })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((d as any).error || `打不开（HTTP ${r.status}）`)
  return d as FileText
}

/** 文件图标按类型分：只用来挑一个字，前端没有多余素材 */
export function fileBadge(nameOrKind: string): string {
  const s = nameOrKind.toLowerCase()
  if (s.endsWith('.pdf') || s === 'pdf') return 'PDF'
  if (s.endsWith('.docx') || s === 'docx') return 'DOC'
  if (/\.(csv|tsv)$/.test(s)) return 'CSV'
  if (/\.(md|markdown|txt|log)$/.test(s)) return 'TXT'
  const ext = s.split('.').pop() || ''
  return ext && ext.length <= 4 ? ext.toUpperCase() : '文件'
}
