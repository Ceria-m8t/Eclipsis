// 读 OB 的桶文件（Markdown + YAML front matter）。只读，不改 OB 的任何东西。
//
// 为什么自己写 YAML 解析：仓库零运行时依赖，而 OB 的 front matter 只用到三种结构
// （标量、标量数组、relation_links 那种「数组里装一层键值」）。够用就行，遇到没见过的结构
// 原样留在 raw 里，不猜。
// 注意 PyYAML 的默认写法：数组的 `- xxx` 和它的键**同一层缩进**，不是缩进在下面。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const OB_BUCKETS = '/root/ombre-brain/buckets'
/** 卡片所在的几个顶层目录；_app/_media/_sources/_ledger 是 OB 自己的东西，不是记忆 */
export const CARD_DIRS = ['dynamic', 'archive', 'permanent', 'feel', 'plans']

export interface ObCard {
  file: string                      // 相对 buckets/ 的路径
  bucketId: string                  // front matter 的 id（外部 ID，迁移后留着）
  name: string
  title: string
  type: string                      // dynamic / archived / permanent / feel / plan
  sourceTool: string                // hold / grow / …
  created: string
  lastActive: string
  importance: number
  valence: number
  arousal: number
  domain: string[]
  tags: string[]
  why: string                       // why_remembered，98% 是空的
  growBatchId: string
  dontSurface: boolean
  status: string                    // plans 才有：active / resolved / abandoned
  body: string
  raw: Record<string, unknown>      // 整份 front matter，原样留着（可回退）
}

type Yaml = Record<string, unknown>

/** 拆出 front matter 和正文 */
export function splitFrontMatter(text: string): { yaml: string; body: string } {
  const t = text.replace(/^\uFEFF/, '')
  if (!t.startsWith('---')) return { yaml: '', body: t.trim() }
  const m = /\n---[ \t]*(?:\r?\n|$)/.exec(t)
  if (!m) return { yaml: '', body: t.trim() }
  return { yaml: t.slice(t.indexOf('\n') + 1, m.index + 1), body: t.slice(m.index + m[0].length).trim() }
}

function scalar(s: string): unknown {
  const v = s.trim()
  if (!v || v === '~' || v === 'null') return null
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1)
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

const indentOf = (line: string) => line.length - line.replace(/^ +/, '').length
const KV = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/

/** OB 用到的那一小块 YAML：标量 / 标量数组 / 数组里装一层键值 */
export function parseYaml(src: string): Yaml {
  const lines = src.split(/\r?\n/).filter(l => l.trim() && !/^\s*#/.test(l))
  const out: Yaml = {}
  let i = 0
  while (i < lines.length) {
    const kv = KV.exec(lines[i].trim())
    if (!kv) { i++; continue }
    const [, key, rest] = kv
    const base = indentOf(lines[i])
    i++
    if (rest !== '') { out[key] = scalar(rest); continue }

    // 下面跟着的数组：`- xxx` 和键同层（PyYAML 默认），也允许缩进
    const items: unknown[] = []
    while (i < lines.length) {
      const indent = indentOf(lines[i])
      const t = lines[i].trim()
      const isItem = t.startsWith('- ') && indent >= base
      if (!isItem && indent <= base) break      // 回到同层的下一个键
      if (!isItem) { i++; continue }            // 数组项下面没认出来的行：跳过（raw 原文仍在）
      const first = t.slice(2)
      const inner = KV.exec(first)
      i++
      if (inner) {
        // 数组里装一层键值（relation_links）：后面缩进更深的行都属于这一项
        const map: Yaml = { [inner[1]]: scalar(inner[2]) }
        while (i < lines.length && indentOf(lines[i]) > indent && !lines[i].trim().startsWith('- ')) {
          const m2 = KV.exec(lines[i].trim())
          if (m2) map[m2[1]] = scalar(m2[2])
          i++
        }
        items.push(map)
      } else items.push(scalar(first))
    }
    out[key] = items
  }
  return out
}

const str = (v: unknown) => (v == null ? '' : String(v))
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter(x => typeof x === 'string' || typeof x === 'number').map(String)
  : v == null ? [] : [String(v)]

export function parseCard(file: string, text: string): ObCard {
  const { yaml, body } = splitFrontMatter(text)
  const raw = parseYaml(yaml)
  return {
    file,
    bucketId: str(raw.id),
    name: str(raw.name),
    title: str(raw.title || raw.name),
    type: str(raw.type),
    sourceTool: str(raw.source_tool),
    created: str(raw.created),
    lastActive: str(raw.last_active || raw.created),
    importance: num(raw.importance),
    valence: num(raw.valence),
    arousal: num(raw.arousal),
    domain: list(raw.domain),
    tags: list(raw.tags),
    why: str(raw.why_remembered),
    growBatchId: str(raw.grow_batch_id),
    dontSurface: raw.dont_surface === true,
    status: str(raw.status),
    body,
    raw,
  }
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (e.endsWith('.md')) out.push(p)
  }
  return out
}

/** 读全部卡片。OB 的文件名里有空格，所以一律走 fs 不走 shell */
export function readObCards(root = OB_BUCKETS, dirs = CARD_DIRS): ObCard[] {
  const files = dirs.flatMap(d => walk(join(root, d)))
  return files
    .map(f => parseCard(f.startsWith(root + '/') ? f.slice(root.length + 1) : f, readFileSync(f, 'utf8')))
    .filter(c => c.bucketId)
    .sort((a, b) => a.created.localeCompare(b.created) || a.bucketId.localeCompare(b.bucketId))
}

/** 建了从来没用过的空目录（13 号文档里那 12 个） */
export function emptyDirs(root = OB_BUCKETS, dirs = CARD_DIRS): string[] {
  const out: string[] = []
  for (const d of dirs) {
    let entries: string[]
    try { entries = readdirSync(join(root, d)) } catch { continue }
    for (const e of entries) {
      const p = join(root, d, e)
      if (statSync(p).isDirectory() && walk(p).length === 0) out.push(`${d}/${e}`)
    }
  }
  return out.sort()
}
