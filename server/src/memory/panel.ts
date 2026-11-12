// 记忆面板（地下室第一个柜子）。2026-11-13。
//
// 她说「现在还是感觉很散」，拿别人的面板（Remember Me）对比之后定的分区：
//   聊天里来的 / 他自己写的 / 他认得的 / 收着的 —— **按谁写的分，不按机制分**。
// 我第一版列的是「召回的毕业条件」「错题本」「关系边」这种开发时的说法，她一眼就觉得散。
// 所以：机制状态**不占格子**，压成底下一行；关系挪进卡片里面。
//
// 空的格子照样摆出来，写明「还没做」—— 0 本身是信息（她那张截图里也有「今天还没有」）。
// 这一层只读：不写库、不调模型。
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DB } from '../db.ts'
import { ensureMemorySchema } from './schema.ts'
import { inboxCount } from './write.ts'
import { openCount } from './corrections.ts'
import { BUILTIN_ALIASES, ensureAliasSchema } from './aliases.ts'
import { currentTree, parseSections, openTreeNotes, listVersions, countChars, TREE_MAX, ensureTreeSchema } from './tree.ts'
import { galaxySnapshot } from './galaxy.ts'
import { fulltextStats, ensureFulltextSchema } from './fulltext.ts'
import { recallMode } from './inject.ts'
import { bjDate, bjStamp, bjAgo } from './when.ts'

export interface Cell {
  key: string
  name: string
  en: string
  n: number
  unit?: string
  note?: string
  /** 还没做的：照样摆出来 */
  todo?: boolean
  /** 点了去哪（前端路由或面板 id），没有就是只能看 */
  to?: string
}
export interface Section { title: string; en: string; cells: Cell[] }
export interface PanelData {
  head: { quotes: number; cards: number; relations: number; sentence: string }
  daily: { day: string; n: number }[]
  sections: Section[]
  health: { label: string; value: string; ok: boolean }[]
}

/** 数一个数。某张表还没建出来时算 0——一个柜子不该因为旁边的抽屉空着就打不开 */
const one = (db: DB, sql: string, ...args: (string | number)[]) => {
  try { return Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0) }
  catch { return 0 }
}

const LIVE = 'retracted_at IS NULL AND merged_into IS NULL'
const EP = `retracted_at IS NULL AND kind = 'message' AND actor IN ('erica','ai') AND scope = 'daily' AND channel IN ('chat','archive')`

export function panelData(db: DB): PanelData {
  ensureMemorySchema(db)
  ensureTreeSchema(db)
  ensureAliasSchema(db)
  ensureFulltextSchema(db)
  const cards = one(db, `SELECT count(*) n FROM memories WHERE ${LIVE}`)
  const quotes = one(db, `SELECT count(*) n FROM episodes WHERE ${EP}`)
  const relations = one(db, 'SELECT count(*) n FROM memory_relations WHERE removed_at IS NULL')
  const byLayer = Object.fromEntries((db.prepare(`SELECT layer, count(*) n FROM memories WHERE ${LIVE} GROUP BY layer`).all() as any[])
    .map(r => [r.layer, Number(r.n)])) as Record<string, number>
  const threads = one(db, `SELECT count(DISTINCT thread) n FROM memories WHERE ${LIVE} AND thread IS NOT NULL AND thread <> ''`)

  const tree = currentTree(db)
  const sections = tree ? parseSections(tree.body).length : 0
  const moments = one(db, `SELECT count(*) n FROM episodes WHERE actor = 'ai' AND retracted_at IS NULL AND content LIKE '%<moment%'`)
  const wakes = one(db, `SELECT count(DISTINCT json_extract(meta, '$.wake_id')) n FROM episodes WHERE channel = 'wake' AND retracted_at IS NULL`)
  const notes = one(db, `SELECT count(*) n FROM memories WHERE ${LIVE} AND source = 'note'`)
  const digestWrote = one(db, `SELECT count(*) n FROM memories WHERE ${LIVE} AND source = 'digest'`)

  const people = one(db, 'SELECT count(*) n FROM people')
  const peopleOn = one(db, 'SELECT count(*) n FROM people WHERE card_enabled = 1')
  const aliasesMine = one(db, 'SELECT count(*) n FROM memory_aliases')

  const review = one(db, `SELECT count(*) n FROM memories WHERE ${LIVE} AND needs_review = 1`)
  const belt = galaxySnapshot(db).asteroids.length
  const dropped = one(db, 'SELECT count(*) n FROM memories WHERE retracted_at IS NOT NULL')
  const privateN = one(db, `SELECT count(*) n FROM memories WHERE ${LIVE} AND privacy = 'private'`)
  const fts = fulltextStats(db)

  // 最近 30 天每天记了几张（她那张截图上的小柱子）
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const rows = db.prepare(`SELECT date(datetime(COALESCE(valid_from, created_at), '+8 hours')) d, count(*) n
    FROM memories WHERE ${LIVE} AND COALESCE(valid_from, created_at) >= ? GROUP BY d ORDER BY d`).all(since) as any[]
  const got = new Map(rows.map(r => [String(r.d), Number(r.n)]))
  const daily: { day: string; n: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const day = bjDate(new Date(Date.now() - i * 86_400_000))
    daily.push({ day, n: got.get(day) ?? 0 })
  }

  const lastDigest = db.prepare('SELECT started_at, wrote, error FROM memory_digest_runs ORDER BY id DESC LIMIT 1')
    .get() as { started_at: string; wrote: number | null; error: string | null } | undefined
  const todayN = daily[daily.length - 1]?.n ?? 0

  return {
    head: {
      quotes, cards, relations,
      sentence: `${quotes} 句原话，写成 ${cards} 张卡，串起 ${relations} 条关系`,
    },
    daily,
    sections: [
      {
        title: '聊天里来的', en: 'From our chats',
        cells: [
          { key: 'cards', name: '记忆卡', en: 'Cards', n: cards, to: 'cards',
            note: `事实 ${byLayer.fact ?? 0} · 近况 ${byLayer.state ?? 0} · 我们之间 ${byLayer.bond ?? 0}` },
          { key: 'threads', name: '线', en: 'Threads', n: threads, note: threads < 10 ? '几乎还没串起来' : undefined },
          { key: 'daylog', name: '流水账', en: 'Day Log', n: 0, todo: true, note: '四层摘要的「日」那层，还没做' },
          { key: 'weekly', name: '周总结', en: 'Weekly', n: 0, todo: true, note: '还没做' },
          { key: 'private', name: '私密', en: 'Private', n: privateN, note: privateN ? undefined : '标了私密的卡会收在这里' },
        ],
      },
      {
        title: '他自己写的', en: 'In his own hand',
        cells: [
          { key: 'tree', name: '时间树', en: 'Our Tree', n: sections, unit: '节', to: 'galaxy',
            note: tree ? `${countChars(tree.body)} / ${TREE_MAX()} 字 · 第 ${listVersions(db).length} 版` : '他还没写' },
          { key: 'moments', name: '他写的', en: 'His Writing', n: moments, note: '回复末尾的「这一刻」' },
          { key: 'wakes', name: '他做的', en: 'What He Did', n: wakes, unit: '次', note: '他自己醒来' },
          { key: 'memo', name: '柜子', en: 'Keepsakes', n: notes, note: notes ? undefined : '随手记的箱子给了他，还没用过' },
          { key: 'diary', name: '日记', en: 'Diary', n: 0, todo: true, note: '共享日记，还没做' },
          { key: 'dreams', name: '梦', en: 'Dreams', n: 0, todo: true, note: '心潮在写梦，还没接进来' },
        ],
      },
      {
        title: '他认得的', en: 'What he knows by name',
        cells: [
          { key: 'people', name: '信息卡', en: 'Little Lexicon', n: people,
            note: `启用 ${peopleOn} 个${peopleOn < people ? `，${people - peopleOn} 个壳还没启用` : ''}` },
          { key: 'aliases', name: '别名', en: 'Aliases', n: BUILTIN_ALIASES.length + aliasesMine, unit: '组',
            note: `出厂 ${BUILTIN_ALIASES.length} 组 · 你加了 ${aliasesMine} 组` },
          { key: 'lexicon', name: '细节卡', en: 'Chapters', n: 0, todo: true, note: '术语和设定，还没做' },
        ],
      },
      {
        title: '收着的', en: 'Kept',
        cells: [
          { key: 'quotes', name: '原话', en: 'Every Word', n: quotes, to: 'find',
            note: fts.behind ? `还有 ${fts.behind} 句在建索引` : '全部都能搜' },
          { key: 'review', name: '等你看一眼', en: 'Waiting on you', n: review + belt, to: 'review',
            note: `${review} 张等确认 · ${belt} 张还没认出是谁的事` },
          { key: 'inbox', name: '沉淀信箱', en: 'Inbox', n: inboxCount(db), to: 'inbox', note: '他拿不准的，等你选入或跳过' },
          { key: 'dropped', name: '归档', en: 'Archive', n: dropped, note: '划掉的和合并掉的，都还留着' },
          { key: 'digest', name: '夜里整理写的', en: 'Nightly', n: digestWrote },
        ],
      },
    ],
    health: [
      { label: '今天', value: todayN ? `记了 ${todayN} 张` : '还没有记', ok: true },
      {
        label: '夜里整理',
        value: lastDigest ? `${bjAgo(lastDigest.started_at)}${lastDigest.error ? ' 失败了' : `，写了 ${lastDigest.wrote ?? 0} 张`}` : '还没跑过',
        ok: !!lastDigest && !lastDigest.error,
      },
      { label: '召回', value: recallMode() === 'live' ? '已经给他了' : recallMode() === 'shadow' ? '影子运行（算出来不给他）' : '关着', ok: recallMode() !== 'off' },
      { label: '原话索引', value: fts.behind ? `还差 ${fts.behind} 句` : '齐了', ok: !fts.behind },
      { label: '他的便条', value: openTreeNotes(db).length || openCount(db) ? `${openTreeNotes(db).length + openCount(db)} 张等他回` : '都回了', ok: true },
      { label: '最近一张卡', value: (() => {
        const r = db.prepare(`SELECT COALESCE(valid_from, created_at) t FROM memories WHERE ${LIVE} ORDER BY t DESC LIMIT 1`).get() as { t: string } | undefined
        return r ? bjStamp(r.t) : '还没有'
      })(), ok: true },
    ],
  }
}

export function handlePanelApi(db: DB, req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || '/', 'http://local')
  if (url.pathname !== '/v1/eclipsis/memory/panel' || req.method !== 'GET') return false
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(panelData(db)))
  return true
}
