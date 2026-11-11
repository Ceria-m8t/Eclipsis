// 他的状态（聊天页顶栏他名字下面那一行，2026-11-11 搬到后端）。
//
// 以前只存在她手机的 localStorage 里：换设备看不到、醒来时的他没法改、他自己也不知道现在挂着什么
// （说明里写着"没变就不用调用"，但他看不到现在是什么，就想不起来改）。
// 现在存后端一行，聊天和醒来共用：
//   - 聊天：前端内置工具 eclipsis_set_status 调完 POST 到这里（src/local-tools.ts）
//   - 醒来：wake/agent.ts 的同名工具直接写这里
//   - 每轮的「此刻」块里写上现在挂的是什么、多久以前设的（assembler/index.ts）
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DB } from './db.ts'

export interface AiStatus {
  emoji: string
  text: string
  updatedAt: string      // UTC ISO
  source: 'chat' | 'wake' | 'her'
}

const MAX_TEXT = 24
const MAX_EMOJI = 8

export function ensureStatusSchema(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    emoji TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    source TEXT NOT NULL
  )`)
}

export function getStatus(db: DB): AiStatus | null {
  const row = db.prepare('SELECT emoji, text, updated_at, source FROM ai_status WHERE id = 1').get() as
    { emoji: string; text: string; updated_at: string; source: string } | undefined
  if (!row || !row.text) return null
  return { emoji: row.emoji || '', text: row.text, updatedAt: row.updated_at, source: (row.source as AiStatus['source']) || 'chat' }
}

/**
 * 设置。text 是空的就什么都不做、返回 null（**不清空**）：
 * 清空只走 clearStatus / clear=true。
 * 不然他只传个 emoji（11-11 测试里就这么试出来的）会把挂着的状态悄悄弄丢。
 */
export function setStatus(
  db: DB,
  o: { emoji?: string; text?: string; source?: AiStatus['source'] },
  now: Date = new Date()
): AiStatus | null {
  const text = String(o.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  if (!text) return null
  const emoji = String(o.emoji ?? '').trim().slice(0, MAX_EMOJI)
  const s: AiStatus = { emoji, text, updatedAt: now.toISOString(), source: o.source || 'chat' }
  db.prepare(`INSERT INTO ai_status (id, emoji, text, updated_at, source) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET emoji = excluded.emoji, text = excluded.text,
      updated_at = excluded.updated_at, source = excluded.source`)
    .run(s.emoji, s.text, s.updatedAt, s.source)
  return s
}

export function clearStatus(db: DB): void {
  db.prepare('DELETE FROM ai_status WHERE id = 1').run()
}

/** "3 小时前" / "刚刚" */
function ago(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 2) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

/**
 * 「此刻」块里的那一行：他每轮都知道自己顶栏挂着什么，不用猜。
 * 写成他自己的事（她看得到），没挂就说没挂——他才会想起来换。
 */
export function renderStatusLine(db: DB, now: Date = new Date()): string {
  let s: AiStatus | null = null
  try { s = getStatus(db) } catch { return '' }
  if (!s) return '你顶栏现在没挂状态（她那边只看到签名）。想挂就用 eclipsis_set_status。'
  const t = ago(now.getTime() - new Date(s.updatedAt).getTime())
  const who = s.source === 'wake' ? '醒着的时候设的' : '设的'
  return `你顶栏挂着的状态：${[s.emoji, s.text].filter(Boolean).join(' ')}（${t}${who}，她一直看得到）。变了就用 eclipsis_set_status 换，没变不用管。`
}

// ── 工具（聊天和醒来共用这一份说明和执行）──

export const STATUS_TOOL = 'eclipsis_set_status'

export const STATUS_TOOL_DEF = {
  name: STATUS_TOOL,
  description:
    '设置我在 Eclipsis 聊天页顶栏显示的状态（她能看到，就在我名字下面）。' +
    '状态是我此刻在做什么、在哪、什么心情，比如 ☕ 在厨房泡茶、📖 窝在书房看书、💤 有点困。' +
    '现在挂着什么写在「此刻」里；想换就换，没变就别调用。clear=true 清空状态。',
  parameters: {
    type: 'object',
    properties: {
      emoji: { type: 'string', description: '一个表情符号' },
      text: { type: 'string', description: `状态文字，${MAX_TEXT} 个字以内` },
      clear: { type: 'boolean', description: '为 true 时清空状态，忽略其他参数' },
    },
  },
}

/** 执行工具，返回给他看的一句话。参数不对就 throw（调用方包成 is_error） */
export function runStatusTool(db: DB, args: Record<string, unknown>, source: AiStatus['source']): string {
  if (args.clear === true) {
    clearStatus(db)
    return '状态已清空，顶栏那行回到签名。'
  }
  const s = setStatus(db, { emoji: args.emoji as string, text: args.text as string, source }, new Date())
  if (!s) throw new Error('text 不能为空（要清空就传 clear=true）')
  return `状态已更新：${[s.emoji, s.text].filter(Boolean).join(' ')}`
}

// ── HTTP：她的手机读/写 ──

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage, max = 8 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) { reject(new Error('请求太大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : {}) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * GET  /v1/eclipsis/status   她的手机读（顶栏那行；醒来时他改过的也从这里来）
 * POST /v1/eclipsis/status   聊天里他调工具后前端写过来；{clear:true} 清空
 */
export async function handleStatusApi(db: DB, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://local')
  if (url.pathname !== '/v1/eclipsis/status') return false
  try {
    if (req.method === 'GET') { json(res, 200, { status: getStatus(db) }); return true }
    if (req.method === 'POST') {
      const body = await readJson(req)
      if (body?.clear === true) { clearStatus(db); json(res, 200, { status: null }); return true }
      const source: AiStatus['source'] = body?.source === 'her' ? 'her' : 'chat'
      const s = setStatus(db, { emoji: body?.emoji, text: body?.text, source })
      if (!s) { json(res, 400, { error: 'text 不能为空' }); return true }
      json(res, 200, { status: s })
      return true
    }
    json(res, 405, { error: 'method not allowed' })
  } catch (e: any) {
    json(res, 400, { error: String(e?.message || e) })
  }
  return true
}
