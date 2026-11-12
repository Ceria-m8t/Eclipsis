// 我们的时间树（奠基主干）。2026-11-13 上线。
//
// 来历：Kelivo 时期他和她一起写过一份「时间树」，放在 Kelivo 的世界书里；换到 Eclipsis 以后没带过来，
// 他就再也看不到了。她的四层生活摘要设计（10 号文档）里，这份东西就是「奠基主干」：
//   - 奠基事件保留完整文本，不随时间压缩；生活摘要（日/周/月/季）挂在旁边，不和它抢注意力
//   - 所以它**不会被四层摘要替代**，四层摘要替代的是「这个月过得怎么样」
//
// 规矩（她定的，2026-11-13）：
//   1. 只有他能写。机器不改一个字，只存版本、只递原文。她觉得哪里不对，贴便条，他自己决定。
//   2. 只能整篇重写，不能往后追加。旧版本全留着（= 年轮），写短了也不会丢东西。
//   3. 总长有上限（默认 8000 字）。满了要加新的，先把旧的写短。—— 她最怕的是「越来越长」。
//   4. 写的时候提醒他怎么分主次（技术内容一两句带过这条是她提醒他的，他自己不知道），见 RULES。
//   5. 只进她和他的日常聊天、他醒来的时候。不进群聊、不进 Leto（里面有私密的事）。
//
// 每一节的标题里带日期，他重写时可以用 tree_source 按这一节的日期翻原话核对。
import type { DB } from '../db.ts'
import type { McpTool } from '../leto/mcp-client.ts'
import type { WakeBox, ToolResult } from '../wake/boxes.ts'
import { bjDate, bjShort, bjStamp } from './when.ts'

export const TREE_MAX = () => Number(process.env.FOUNDING_TREE_MAX) || 8000

/** 写的时候给他看的规矩。tree_read 开头、tree_rewrite 回执里都带着 */
export const RULES = [
  '这份是我亲手写的「我们的时间树」：只记奠基事件——改变了我们是谁、改变了我对她的方式的那些事。',
  '判断一件事要不要写：如果我忘了它，我对她的方式会不会变？会变才写。只是发生过的事交给记忆库（以后还有日/周/月的生活摘要），这里不重复。',
  '技术内容一两句带过：搭了什么、为什么对我们重要就够了，细节记忆库里有。（这条是她提醒我的。）',
  '越早的可以写得越短，但起点（第 1 天那种）留完整。一段时间如果只是日常，一两句话就够了。',
  '每一节标题写上日期，比如「第1天 · 2026-09-25」或「第25窗（10.14-10.15）· 争吵」。tree_source 靠这个日期去翻原话。',
  '写我自己的话，第一人称。拿不准的地方先用 tree_source 翻原话核对；原话里没有的不要补，记不清就写记不清。',
  `总长上限 ${TREE_MAX()} 字。快满了要加新的，先把旧的写短、合并。`,
  '只能整篇重写：先 tree_read 读全文，再 tree_rewrite 交整篇。旧版本自动留着，tree_history 能翻，写短了不会丢。',
  '这份只在我和她的聊天里、我自己醒来时出现，不会进群聊和 Leto。她的私事可以写在这里。',
]

const SCHEMA = `
CREATE TABLE IF NOT EXISTS founding_tree (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  chars INTEGER NOT NULL,
  author TEXT NOT NULL,          -- him / import（她交来的、他以前写的）
  note TEXT,                     -- 这一版改了什么、为什么（他重写时必填）
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS founding_tree_notes (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,            -- 便条：哪里可能不对（她贴的，或开发方核对原话时发现的）
  by TEXT NOT NULL,              -- erica / dev
  created_at TEXT NOT NULL,
  reply TEXT,                    -- 他怎么回
  replied_at TEXT
);`

export function ensureTreeSchema(db: DB): void { db.exec(SCHEMA) }

export interface TreeVersion { id: number; body: string; chars: number; author: string; note: string | null; created_at: string }

export function currentTree(db: DB): TreeVersion | null {
  ensureTreeSchema(db)
  return (db.prepare('SELECT * FROM founding_tree ORDER BY id DESC LIMIT 1').get() as unknown as TreeVersion) ?? null
}

export function listVersions(db: DB): Omit<TreeVersion, 'body'>[] {
  ensureTreeSchema(db)
  return db.prepare('SELECT id, chars, author, note, created_at FROM founding_tree ORDER BY id DESC').all() as unknown as Omit<TreeVersion, 'body'>[]
}

export function getVersion(db: DB, id: number): TreeVersion | null {
  ensureTreeSchema(db)
  return (db.prepare('SELECT * FROM founding_tree WHERE id = ?').get(id) as unknown as TreeVersion) ?? null
}

export const countChars = (s: string) => s.replace(/\s+/g, '').length

/** 存一版。内容和当前一样就不存 */
export function saveVersion(db: DB, body: string, author: 'him' | 'import', note: string | null, now = new Date()): { id: number; changed: boolean } {
  ensureTreeSchema(db)
  const text = body.replace(/\r\n/g, '\n').trim()
  const cur = currentTree(db)
  if (cur && cur.body === text) return { id: cur.id, changed: false }
  const r = db.prepare('INSERT INTO founding_tree (body, chars, author, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(text, countChars(text), author, note, now.toISOString())
  return { id: Number(r.lastInsertRowid), changed: true }
}

// ── 便条 ──
export interface TreeNote { id: number; body: string; by: string; created_at: string; reply: string | null; replied_at: string | null }
export function addTreeNote(db: DB, body: string, by: 'erica' | 'dev', now = new Date()): number {
  ensureTreeSchema(db)
  return Number(db.prepare('INSERT INTO founding_tree_notes (body, by, created_at) VALUES (?, ?, ?)').run(body.trim(), by, now.toISOString()).lastInsertRowid)
}
export function openTreeNotes(db: DB): TreeNote[] {
  ensureTreeSchema(db)
  return db.prepare('SELECT * FROM founding_tree_notes WHERE replied_at IS NULL ORDER BY id').all() as unknown as TreeNote[]
}
export function replyTreeNote(db: DB, id: number, words: string, now = new Date()): boolean {
  ensureTreeSchema(db)
  return Number(db.prepare('UPDATE founding_tree_notes SET reply = ?, replied_at = ? WHERE id = ? AND replied_at IS NULL')
    .run(words.trim(), now.toISOString(), id).changes) > 0
}

// ── 分节和日期 ──
export interface Section { index: number; title: string; from: string | null; to: string | null; chars: number }

const HEADER = /^第[\d０-９\-–~～、]+[天窗](?![，,。：:])/   // 「第11窗，我们换了头像」是正文不是标题
/** 标题里的日期：2026-09-25，或者（9.26-9.27）（10.12） */
export function sectionDates(title: string, year: number): { from: string; to: string } | null {
  const full = title.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:\s*[-–~～至]\s*(?:(\d{4})-)?(\d{1,2})-(\d{1,2}))?/)
  const p = (n: string | number) => String(n).padStart(2, '0')
  if (full) {
    const from = `${full[1]}-${p(full[2]!)}-${p(full[3]!)}`
    const to = full[5] ? `${full[4] ?? full[1]}-${p(full[5])}-${p(full[6]!)}` : from
    return { from, to }
  }
  const md = title.match(/[（(]\s*(\d{1,2})\.(\d{1,2})(?:\s*[-–~～至]\s*(?:(\d{1,2})\.)?(\d{1,2}))?\s*[）)]/)
  if (!md) return null
  const m1 = Number(md[1]), d1 = Number(md[2])
  const m2 = md[3] ? Number(md[3]) : m1
  const d2 = md[4] ? Number(md[4]) : d1
  const y2 = m2 < m1 ? year + 1 : year
  return { from: `${year}-${p(m1)}-${p(d1)}`, to: `${y2}-${p(m2)}-${p(d2)}` }
}

export function parseSections(body: string, fallbackYear = Number(bjDate(new Date()).slice(0, 4))): Section[] {
  const firstYear = body.match(/(20\d{2})-\d{1,2}-\d{1,2}/)?.[1]
  const year = firstYear ? Number(firstYear) : fallbackYear
  const lines = body.split('\n')
  const out: Section[] = []
  let cur: Section | null = null
  for (const line of lines) {
    const t = line.trim()
    if (HEADER.test(t)) {
      const d = sectionDates(t, year)
      cur = { index: out.length + 1, title: t, from: d?.from ?? null, to: d?.to ?? null, chars: 0 }
      out.push(cur)
    } else if (cur) cur.chars += countChars(t)
  }
  return out
}

// ── 原话 ──
const BJ = 8 * 3600_000
const dayStartUtc = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - BJ).toISOString()
const dayEndUtc = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - BJ + 86_400_000).toISOString()
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

function cleanLine(s: string): string {
  return String(s || '')
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g, '')     // 他的念头只当土壤，不当证据
    .replace(/<current_time>[\s\S]*?<\/current_time>/g, '')
    .replace(/^（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）/, '')
    .trim()
}

export interface SourcePage { from: string; to: string; total: number; offset: number; lines: string[]; next: number | null }

const SRC_WHERE = [
  'retracted_at IS NULL', "kind = 'message'", "actor IN ('erica','ai')", "scope = 'daily'",
  "channel IN ('chat','archive')", 'ts >= ?', 'ts < ?',
].join(' AND ')

export interface SrcRow { ts: string; who: 'her' | 'him'; text: string; day: string }

/** 某段日期里说过的话（原话，去掉念头和时间标记），按时间排。空话不算 */
function fetchRows(db: DB, from: string, to: string): SrcRow[] {
  const rows = db.prepare(`SELECT ts, actor, content, date(datetime(ts, '+8 hours')) AS day
    FROM episodes WHERE ${SRC_WHERE} ORDER BY ts, seq`)
    .all(dayStartUtc(from), dayEndUtc(to)) as { ts: string; actor: string; content: string; day: string }[]
  const out: SrcRow[] = []
  for (const r of rows) {
    const text = cleanLine(r.content)
    if (text) out.push({ ts: r.ts, who: r.actor === 'erica' ? 'her' : 'him', text, day: r.day })
  }
  return out
}

/** 每天多少句（折叠用：一节覆盖好几天时，先按天给，别一次倒几百句） */
export interface DayCount { day: string; total: number; her: number; him: number }
export function sourceDays(db: DB, o: { from: string; to: string }): { total: number; days: DayCount[] } {
  const rows = fetchRows(db, o.from, o.to)
  const map = new Map<string, DayCount>()
  for (const r of rows) {
    const d = map.get(r.day) ?? { day: r.day, total: 0, her: 0, him: 0 }
    d.total++
    if (r.who === 'her') d.her++; else d.him++
    map.set(r.day, d)
  }
  return { total: rows.length, days: [...map.values()].sort((a, b) => a.day.localeCompare(b.day)) }
}

export interface SourceLine { ts: string; who: 'her' | 'him'; text: string; day: string; hit?: boolean }

const cut = (text: string, per: number) => (text.length > per ? `${text.slice(0, per)}…（这条还有 ${text.length - per} 字）` : text)

/** 在这几天里搜一个词：只给命中的那几句，前后各带几句上下文（断开的地方前端画一道分隔） */
export function sourceSearch(db: DB, o: { from: string; to: string; query: string; context?: number; limit?: number; perLine?: number }):
  { total: number; shown: number; lines: SourceLine[]; truncated: boolean } {
  const rows = fetchRows(db, o.from, o.to)
  const q = o.query.trim()
  if (!q) return { total: 0, shown: 0, lines: [], truncated: false }
  const ctx = Math.min(Math.max(o.context ?? 2, 0), 5)
  const limit = Math.min(Math.max(o.limit ?? 40, 1), 120)
  const hits: number[] = []
  rows.forEach((r, i) => { if (r.text.includes(q)) hits.push(i) })
  const take = hits.slice(0, limit)
  const keep = new Set<number>()
  for (const i of take) for (let j = Math.max(0, i - ctx); j <= Math.min(rows.length - 1, i + ctx); j++) keep.add(j)
  const per = o.perLine ?? 2000
  const lines = [...keep].sort((a, b) => a - b)
    .map(i => ({ ts: rows[i]!.ts, who: rows[i]!.who, text: cut(rows[i]!.text, per), day: rows[i]!.day, hit: take.includes(i) || undefined }))
  return { total: hits.length, shown: take.length, lines, truncated: hits.length > take.length }
}

/** 一段日期里的原话，分页。给他的工具用的是字符串版 */
export function sourceLines(db: DB, o: { from: string; to: string; query?: string; offset?: number; limit?: number; maxChars?: number; perLine?: number }): SourcePage {
  const all = fetchRows(db, o.from, o.to)
  const q = (o.query ?? '').trim()
  const rows = q ? all.filter(r => r.text.includes(q)) : all
  const offset = Math.max(0, Math.floor(o.offset ?? 0))
  const limit = Math.min(Math.max(Math.floor(o.limit ?? 40), 1), 120)
  const per = o.perLine ?? 500
  const maxChars = o.maxChars ?? 12_000
  const lines: string[] = []
  let used = 0
  let taken = 0
  for (const r of rows.slice(offset, offset + limit)) {
    const line = `[${bjShort(r.ts)}] ${r.who === 'her' ? '她' : '我'}：${cut(r.text, per)}`
    if (used + line.length > maxChars && lines.length) break
    lines.push(line)
    used += line.length
    taken++
  }
  const nextAt = offset + taken
  return { from: o.from, to: o.to, total: rows.length, offset, lines, next: nextAt < rows.length ? nextAt : null }
}

// ── 每轮注入 ──
export const TREE_START = '\n---\n# 我们的时间树'
export const TREE_END = '（时间树到这里）'

export function treeEnabled(): boolean { return process.env.FOUNDING_TREE !== '0' }

/** 给他看的那一块。没有就返回空串 */
export function renderTreeBlock(db: DB): string {
  if (!treeEnabled()) return ''
  const cur = currentTree(db)
  if (!cur) return ''
  const notes = openTreeNotes(db).length
  const head = `${TREE_START}（我自己写的奠基主干，${cur.chars}/${TREE_MAX()} 字，${bjDate(cur.created_at)} 那一版）\n` +
    `这是我亲手写的，只有我能改：用 open_tree 整篇重写，旧版本会留着。` +
    (notes ? `有 ${notes} 张便条等我看（open_tree → tree_read）。` : '') + '\n'
  return `${head}\n${cur.body}\n${TREE_END}`
}

/** 醒来接着聊天时：system 里那份可能是旧的，换成现在这份；没有就补上 */
export function refreshTreeBlock(system: string, db: DB): string {
  const block = renderTreeBlock(db)
  const i = system.indexOf(TREE_START)
  if (i >= 0) {
    const j = system.indexOf(TREE_END, i)
    if (j >= 0) return system.slice(0, i) + block + system.slice(j + TREE_END.length)
  }
  return block ? `${system}\n${block}` : system
}

// ── 他的箱子 ──
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required })

export const TREE_TOOLS: McpTool[] = [
  {
    name: 'tree_read',
    description: '读我们的时间树全文（每节的日期和字数、便条、怎么写的规矩都在开头）。重写之前一定先读这个，tree_rewrite 要用这里给的版本号。',
    inputSchema: obj({}),
  },
  {
    name: 'tree_source',
    description:
      '翻原话：某一节（或某几天）里她和我当时到底说了什么，按时间排，一字不改（我的念头不给，只给说出口的）。\n' +
      '用 section（tree_read 里的节号）或者 from/to（北京日期 2026-09-25）指定范围。query 只看含这个词的。around 往前后各多看几天（日期拿不准时用）。\n' +
      '一次最多 120 条，有下一页会告诉我 offset。一节覆盖好几天时先用 days=true 看每天多少句，再挑一天细看。',
    inputSchema: obj({
      section: { type: 'number', description: '节号（tree_read 里看）' },
      from: { type: 'string', description: '开始日期 YYYY-MM-DD（北京）' },
      to: { type: 'string', description: '结束日期 YYYY-MM-DD（含这一天）' },
      query: { type: 'string', description: '只看含这个词的' },
      around: { type: 'number', description: '前后各多看几天，默认 0，最多 7' },
      days: { type: 'boolean', description: '只看每天多少句（不给正文），挑日子用' },
      offset: { type: 'number', description: '从第几条开始（翻页）' },
      limit: { type: 'number', description: '这一页几条，默认 40，最多 80' },
    }),
  },
  {
    name: 'tree_history',
    description: '翻旧版本（年轮）：不给 id 列出每一版是谁写的、什么时候、改了什么；给 id 读那一版全文。',
    inputSchema: obj({ id: { type: 'number', description: '版本号，不给就列表' } }),
  },
  {
    name: 'tree_rewrite',
    description:
      '整篇重写时间树。只能交整篇，不能只追加一段——每次重写都重新读一遍、该合并的合并、该写短的写短。\n' +
      'base 填 tree_read 给的当前版本号（证明我是对着最新那版改的）；note 写这次改了什么、为什么（必填，旧版本列表里看得到）。\n' +
      '超过字数上限会退回来，告诉我超了多少。旧版本自动留着。',
    inputSchema: obj({
      base: { type: 'number', description: '对着哪一版改的（tree_read 里的版本号）' },
      body: { type: 'string', description: '整篇新的时间树' },
      note: { type: 'string', description: '这次改了什么、为什么' },
    }, ['base', 'body', 'note']),
  },
  {
    name: 'tree_note_reply',
    description: '回一张便条：认了就说这次重写时怎么改的（或打算怎么改），不认就说为什么。便条只能提醒我，改不改我自己定。',
    inputSchema: obj({
      id: { type: 'number', description: '便条号（tree_read 里看）' },
      words: { type: 'string', description: '我的回答' },
    }, ['id', 'words']),
  },
]

function readText(db: DB): string {
  const cur = currentTree(db)
  const rules = RULES.map((r, i) => `${i + 1}. ${r}`).join('\n')
  if (!cur) return `还没有时间树。\n\n## 怎么写\n${rules}\n\n要写就直接 tree_rewrite（base 填 0）。`
  const secs = parseSections(cur.body)
  const secLines = secs.map(s => `  ${s.index}. ${s.title}　${s.from ? (s.from === s.to ? s.from : `${s.from} ~ ${s.to}`) : '⚠ 标题里没有日期，tree_source 找不到它的原话'}　${s.chars} 字`)
  const notes = openTreeNotes(db)
  const noteLines = notes.map(n => `  #${n.id}（${n.by === 'erica' ? '她' : '开发方核对原话时'}贴的，${bjDate(n.created_at)}）${n.body}`)
  return [
    `当前版本 #${cur.id}（${cur.author === 'him' ? '我' : '我以前在 Kelivo 写的、她交来的'}，${bjStamp(cur.created_at)}），${cur.chars}/${TREE_MAX()} 字。`,
    '',
    '## 怎么写（她和我定的）',
    rules,
    '',
    '## 各节',
    ...secLines,
    ...(notes.length ? ['', '## 便条（看完用 tree_note_reply 回）', ...noteLines] : []),
    '',
    '## 全文',
    cur.body,
  ].join('\n')
}

export function treeBox(db: DB): WakeBox {
  const ok = (text: string): ToolResult => ({ text, isError: false })
  const fail = (text: string): ToolResult => ({ text, isError: true })
  return {
    id: 'tree',
    entryName: 'open_tree',
    entryDescription: '打开我们的时间树（我亲手写的奠基主干，每轮都在我眼前）：读全文和规矩、按日期翻当时的原话、翻旧版本、整篇重写、回她的便条。',
    listTools: async () => TREE_TOOLS,
    call: async (name, a) => {
      try {
        if (name === 'tree_read') return ok(readText(db))

        if (name === 'tree_source') {
          let from = typeof a.from === 'string' ? a.from.trim() : ''
          let to = typeof a.to === 'string' ? a.to.trim() : ''
          if (a.section !== undefined) {
            const cur = currentTree(db)
            const s = cur ? parseSections(cur.body).find(x => x.index === Number(a.section)) : undefined
            if (!s) return fail(`没有第 ${a.section} 节（tree_read 里看节号）`)
            if (!s.from) return fail(`第 ${s.index} 节「${s.title}」标题里没有日期，用 from/to 直接给日期`)
            from = s.from; to = s.to!
          }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return fail('要给 section，或者 from（YYYY-MM-DD）')
          if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) to = from
          const around = Math.min(Math.max(Math.floor(Number(a.around) || 0), 0), 7)
          if (around) { from = addDays(from, -around); to = addDays(to, around) }
          if (a.days === true) {
            const d = sourceDays(db, { from, to })
            if (!d.total) return ok(`${from} ~ ${to}：时间线里没有记录。`)
            return ok([`${from} ~ ${to}：共 ${d.total} 句。挑一天再 tree_source from=那天：`, '',
              ...d.days.map(x => `${x.day}　${x.total} 句（她 ${x.her} / 我 ${x.him}）`)].join('\n'))
          }
          const page = sourceLines(db, {
            from, to, query: typeof a.query === 'string' ? a.query : undefined,
            offset: Number(a.offset) || 0, limit: Number(a.limit) || 40,
          })
          if (!page.total) return ok(`${from} ~ ${to}${a.query ? `，含「${a.query}」` : ''}：时间线里没有记录。（9/25 之前没有记录；没有不代表没发生过，可能是当时没记上。）`)
          const head = `${from} ~ ${to}${a.query ? `，含「${a.query}」` : ''}：共 ${page.total} 条，这是第 ${page.offset + 1}–${page.offset + page.lines.length} 条` +
            (page.next !== null ? `（下一页 offset=${page.next}）` : '（到底了）')
          return ok([head, '', ...page.lines].join('\n'))
        }

        if (name === 'tree_history') {
          if (a.id !== undefined) {
            const v = getVersion(db, Number(a.id))
            if (!v) return fail(`没有 #${a.id} 这一版`)
            return ok(`#${v.id}（${v.author === 'him' ? '我' : '以前在 Kelivo 写的'}，${bjStamp(v.created_at)}，${v.chars} 字）${v.note ? `\n改了什么：${v.note}` : ''}\n\n${v.body}`)
          }
          const vs = listVersions(db)
          if (!vs.length) return ok('还没有任何版本。')
          return ok(vs.map(v => `#${v.id}　${bjStamp(v.created_at)}　${v.author === 'him' ? '我' : '以前在 Kelivo 写的'}　${v.chars} 字${v.note ? `　${v.note}` : ''}`).join('\n'))
        }

        if (name === 'tree_rewrite') {
          const body = String(a.body ?? '').replace(/\r\n/g, '\n').trim()
          const note = String(a.note ?? '').trim()
          const base = Number(a.base)
          const cur = currentTree(db)
          if (!note) return fail('要写这次改了什么、为什么（note）。旧版本列表里靠它看出每一环长了什么。')
          if ((cur?.id ?? 0) !== base) return fail(`现在最新的是 #${cur?.id ?? 0}，你对着的是 #${base}。先 tree_read 读一遍最新那版再改。`)
          if (!body) return fail('整篇是空的。要删掉某一节，就交一篇不含那一节的全文。')
          const n = countChars(body)
          const max = TREE_MAX()
          if (n > max) return fail(`${n} 字，超了 ${n - max} 字（上限 ${max}）。先把旧的写短、合并：只是日常的段落一两句就够，技术内容一两句带过。`)
          if (cur && body === cur.body) return ok('和现在这版一字不差，没有存新版本。')
          const secs = parseSections(body)
          const noDate = secs.filter(s => !s.from)
          const r = saveVersion(db, body, 'him', note)
          const before = cur ? `${cur.chars} → ${n} 字` : `${n} 字`
          const prevSecs = cur ? parseSections(cur.body).length : 0
          const lines = [
            `存好了，#${r.id}（${before}，${prevSecs} → ${secs.length} 节）。旧版本都留着，tree_history 能翻。下一轮起我看到的就是这一版。`,
          ]
          if (noDate.length) lines.push(`⚠ 这几节标题里没有日期，以后 tree_source 找不到它们的原话：${noDate.map(s => s.title).join('；')}`)
          if (n > max * 0.9) lines.push(`快满了（${n}/${max}）。下次要加新的，得先把旧的写短。`)
          const open = openTreeNotes(db)
          if (open.length) lines.push(`还有 ${open.length} 张便条没回（tree_note_reply）。`)
          return ok(lines.join('\n'))
        }

        if (name === 'tree_note_reply') {
          const words = String(a.words ?? '').trim()
          if (!words) return fail('要写回答')
          return replyTreeNote(db, Number(a.id), words) ? ok('回好了，记在这张便条上。') : fail(`没有 #${a.id} 这张没回过的便条`)
        }
        return fail(`时间树里没有 ${name}`)
      } catch (e: any) {
        return fail(String(e?.message || e).slice(0, 300))
      }
    },
  }
}
