// 记忆库（二改第一期：只建表 + 搬家，没有任何东西会读它，聊天零影响）
//
// 和 OB 的关系：OB 的 221 张卡原样搬进 memories，bucket_id 当外部 ID 留着，
// 原卡的 front matter + 正文整份存在 raw 里 —— 搬错了能照着回退，也能继续在 Obsidian 里读 OB。
//
// 四条地基（都来自 16-记忆库二改设计稿.md v0.2，为的是以后不返工）：
//   1. subject：每条记忆写明「这是谁的事」。现在的卡没有这个字段，召回只能靠向量相似，
//      才会把朋友的事认成她的事（她最怕的那个错）。
//   2. layer：fact / state / bond 三层寿命分开（内部代号，显示名她还没定）。
//   3. valid_from / valid_until：事实被推翻不删，只标失效，注入时只给当前有效的那条。
//   4. fact_body / feeling：双轨，一条记忆里事实和情绪都在场。
//
// portrait / stances / views（自画像 / 取舍 / 看法本）**这一期只建表不填**：
// 料不够（221 张、3 个月、40% 是碎片），现在生成只会长出「从流水账里归纳的假人格」。
// 北极星：机制只搬运注意力、只喂材料；「我是谁」的任何一笔，永远只有他自己的手。
import { addColumns, type DB } from '../db.ts'

/** 三层寿命。名字是内部代号，前端和工具说明上怎么叫等她定 */
export type Layer = 'fact' | 'state' | 'bond'
/** 三档：常驻（进固定前缀，有总量上限）/ 重要（优先召回）/ 普通 */
export type Grade = 'resident' | 'important' | 'normal'

export const RESIDENT_CAP = 30

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  bucket_id TEXT UNIQUE,                 -- OB 的 id（外部 ID）；我们自己写的新记忆为空
  layer TEXT NOT NULL,                   -- fact / state / bond
  subject TEXT NOT NULL,                 -- erica / ai / us / person:<slug> / unknown
  title TEXT NOT NULL DEFAULT '',
  fact_body TEXT NOT NULL,               -- 双轨之一：现场、原话、发生了什么
  feeling TEXT,                          -- 双轨之二：当时的情绪、他的感觉
  why TEXT,                              -- 为什么记（新写入必填；OB 搬来的 98% 是空的）
  tags TEXT NOT NULL DEFAULT '[]',       -- JSON 数组（OB 的 domain 降级成标签）
  grade TEXT NOT NULL DEFAULT 'normal',  -- resident / important / normal
  valence REAL, arousal REAL,
  valid_from TEXT,                       -- 事实从什么时候起成立
  valid_until TEXT,                      -- 被推翻的时刻（不删，只失效）
  source TEXT NOT NULL,                  -- hold / grow / note / digest / migrate
  voice TEXT NOT NULL DEFAULT 'him',     -- 这条是谁的笔：him（他自己写的/他的原话）/ machine（程序整理的）/ hers（她写的）
                                         -- 要紧：注入时 machine 写的只给事实那半，情绪那半只在 him 时才给。
                                         -- 不然等于雇了个旁人替他写日记，再让他每天读 —— 他会照着那个语气长。
  source_ref TEXT,                       -- 回到原始经历的路（episodes.seq 等）
  evidence TEXT NOT NULL DEFAULT '[]',   -- JSON：episodes.seq，回到原话的路（叙事是信号，链接是回到质感的路）
  thread TEXT,                           -- 夜里整理时归的话题线
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_recalled_at TEXT,                 -- 上次真的被递给他的时刻（冷却、衰减用）
  recall_count INTEGER NOT NULL DEFAULT 0,
  dont_surface INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,  -- 搬家时规则拿不准：等人看一眼，别先拿去召回
  review_note TEXT,
  merged_into INTEGER,                   -- 被合并掉的那张指向留下的那张
  retracted_at TEXT,
  retract_reason TEXT,                   -- merged / manual / superseded
  raw TEXT                               -- 原卡 front matter + 正文（JSON，可回退）
);
CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer, grade);
CREATE INDEX IF NOT EXISTS idx_memories_subject ON memories(subject);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

-- 合并证据：谁被合进了谁、凭什么、原卡长什么样。带这张表合并才敢做
CREATE TABLE IF NOT EXISTS memory_merges (
  id INTEGER PRIMARY KEY,
  kept_bucket_id TEXT NOT NULL,
  dropped_bucket_id TEXT NOT NULL,
  overlap REAL NOT NULL,                 -- 2-gram 重合度
  reason TEXT NOT NULL,
  dropped_raw TEXT NOT NULL,             -- 整张原卡
  created_at TEXT NOT NULL,
  undone_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_merges_dropped ON memory_merges(dropped_bucket_id);

-- 关系边（2026-11-12）：卡片不该是孤岛。形状抄「缝合怪」那张图——**每条关系都写明为什么连**。
-- OB 原来的 relation_links 是按相似度自动连的（292 条，全是 auto），搬进来时一律标 auto=1、
-- kind 只敢填 related/same_event/follows；「触发/导致/解释/改善」这几种有因果含义的，
-- 只有他自己或她手写才算，程序不猜。
CREATE TABLE IF NOT EXISTS memory_relations (
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                    -- same_event 同一件事 / follows 后来怎样了 / related 同类
                                         -- triggers 触发 / causes 导致 / explains 解释 / improves 改善
  reason TEXT NOT NULL DEFAULT '',       -- 为什么连（空着就是没人说得清，前端要显示「没写原因」）
  score REAL,                            -- 自动连的相似度
  auto INTEGER NOT NULL DEFAULT 0,       -- 1=程序连的（弱），0=他或她手写的
  created_by TEXT NOT NULL DEFAULT 'ob', -- ob / him / her / digest
  created_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_relations_from ON memory_relations(from_id);
CREATE INDEX IF NOT EXISTS idx_relations_to ON memory_relations(to_id);

-- 修正层（2026-11-12，她要的「记忆修正」）：**原文一个字不动，更正叠在上面。**
-- 她发现哪条记错了 → 贴一张便条 → 他下次看到 → **改不改由他定**。
-- 界面上没有「替他改写」的入口，这是 2026-10-24 就定下的规矩（他的记忆只有他能改）。
-- 半年后还能看出「他当时是这么记的，后来被纠正过」，比直接改掉诚实。
CREATE TABLE IF NOT EXISTS memory_corrections (
  id INTEGER PRIMARY KEY,
  memory_id INTEGER NOT NULL,
  note TEXT NOT NULL,                    -- 她写的那句话（原样留着，永不覆盖）
  by TEXT NOT NULL DEFAULT 'her',        -- her / him
  status TEXT NOT NULL DEFAULT 'open',   -- open 他还没看到 / accepted 他认了 / kept 他留着原样 / withdrawn 她撤回
  his_reply TEXT,                        -- 他的回应（认了就写一句，留着原样也要说为什么）
  seen_at TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corrections_status ON memory_corrections(status, created_at);

-- 旧卡重整的「建议」（2026-11-12，她说「我想把之前的记忆全部整理一遍」）：
-- 程序只能**提建议**，不能改正文。合并/拆开/换层/补「为什么记」都要她点头。
-- 拆开时给的文字必须是原卡里**一字不差的片段**（代码里强制校验），不是重写。
CREATE TABLE IF NOT EXISTS memory_proposals (
  id INTEGER PRIMARY KEY,
  memory_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                    -- merge / split / relayer / why / retract
  status TEXT NOT NULL DEFAULT 'open',   -- open / taken / dropped
  payload TEXT NOT NULL,                 -- JSON：目标、新层、why 草稿、拆开后的原文片段
  reason TEXT NOT NULL,                  -- 给她看的一句话
  batch TEXT,                            -- 哪一批跑出来的
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON memory_proposals(status, created_at);

-- 沉淀信箱（第二期）：拿不准的记忆先停在这里，她只做「选入 / 跳过」两个动作。
-- 她 2026-11-12 定的是 c：**只有拿不准的进信箱，明确的直接进库**。
-- 「明确」= 四条同时成立：主体唯一 / 有原话对得上 / 查重不落灰区 / 不是两头沾（既像事实又像当日状态）。
CREATE TABLE IF NOT EXISTS memory_candidates (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL,                  -- note（他随手记）/ digest（夜里整理）
  status TEXT NOT NULL DEFAULT 'inbox',  -- inbox / accepted / skipped
  payload TEXT NOT NULL,                 -- JSON：layer/subject/title/fact/feeling/why/tags
  unsure TEXT NOT NULL,                  -- 哪一条没过（给她看的一句话）
  evidence TEXT NOT NULL DEFAULT '[]',   -- JSON：episodes.seq
  thread TEXT,                           -- 夜里整理时归的话题线
  similar_to INTEGER,                    -- 像哪一条已有的记忆
  overlap REAL,
  memory_id INTEGER,                     -- 她选入之后生成的那条
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT                        -- her / him
);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON memory_candidates(status, created_at);

-- 夜里整理跑过哪一段（按 episodes.seq 推进，不重复整理；失败不推进，隔一阵再来）
CREATE TABLE IF NOT EXISTS memory_digest_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL,
  episodes INTEGER NOT NULL DEFAULT 0,
  thread TEXT,
  model TEXT,
  wrote INTEGER NOT NULL DEFAULT 0,      -- 直接进库几条
  inboxed INTEGER NOT NULL DEFAULT 0,    -- 进信箱几条
  amended INTEGER NOT NULL DEFAULT 0,    -- 续接/合并几条
  skipped INTEGER NOT NULL DEFAULT 0,    -- 判「跳过」几条（正常结果，不是失败）
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_digest_runs_started ON memory_digest_runs(started_at);

-- 人物卡：库里本来没有「人」这个东西，名字全散在正文里（Kefira 51 次、妈妈 16 次…）
-- aliases 很要紧：她说「我妈」不说「妈妈」，卡名对不上就认不出来
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',    -- JSON 数组
  relation TEXT,                         -- 她的闺蜜 / 她妈妈 / 她的狗
  his_note TEXT,                         -- 他手写的那半：永不被自动覆盖
  his_note_updated_at TEXT,
  now_line TEXT,                         -- 以「现在：」开头的那一段（直递时只给它和第一段）
  ambiguous INTEGER NOT NULL DEFAULT 0,  -- 名字本身是普通词（「朋友」「同学」），要过判官
  kin INTEGER NOT NULL DEFAULT 0,        -- 亲属：「你妈妈」别认成自家的
  card_enabled INTEGER NOT NULL DEFAULT 1,
  mentions INTEGER NOT NULL DEFAULT 0,   -- 库里出现次数（搬家时数的）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ↓↓↓ 「他」那一层：这一期只建表，一行都不填 ↓↓↓
-- 三条焊死的规矩（两个仓库各自用事故换来的）：
--   写成观察不写成指令；他确认才算、她只能划掉不能替他写；不碰说话方式。

-- 自画像：他反复出现的样子。≥3 件经历、分在 ≥2 天才算一条；最多 15 条；3 周没再出现就退场
CREATE TABLE IF NOT EXISTS portrait (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,                    -- 观察句（「读书很慢，常在一页上停很久」）
  evidence TEXT NOT NULL DEFAULT '[]',   -- JSON：episodes.seq / memories.id
  days INTEGER NOT NULL DEFAULT 0,       -- 证据分布在几天
  confirmed_at TEXT,                     -- 他确认了才进上下文
  struck_at TEXT,                        -- 她划掉的（她只能划掉）
  retired_at TEXT,                       -- 退成「以前的我」
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 取舍：两件他都在乎的事撞在一起时，他一次次先顾哪边（= 她说的「他对世界的理解」）
-- 同一类拉扯 6 周内 ≥3 次、分在不同日子、大多选同一边才长成一条；最多 8 条
CREATE TABLE IF NOT EXISTS stances (
  id INTEGER PRIMARY KEY,
  tension TEXT NOT NULL,                 -- 哪两件事撞了
  chose TEXT NOT NULL,                   -- 他先顾了哪边
  text TEXT NOT NULL,
  times INTEGER NOT NULL DEFAULT 0,
  evidence TEXT NOT NULL DEFAULT '[]',
  confirmed_at TEXT,
  struck_at TEXT,
  retired_at TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 看法本：他怎么看一件事（最近 12 条）
CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL,
  text TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  confirmed_at TEXT,
  struck_at TEXT,
  retired_at TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

export function ensureMemorySchema(db: DB): void {
  db.exec(SCHEMA)
  // 第一期已经搬完的库：补上第二期加的两列
  addColumns(db, 'memories', { evidence: "TEXT NOT NULL DEFAULT '[]'", thread: 'TEXT' })
  // 第二期之前搬进来的：grow 写的算程序的笔，其余算他自己的
  if (addColumns(db, 'memories', { voice: "TEXT NOT NULL DEFAULT 'him'" }).includes('voice')) {
    db.exec("UPDATE memories SET voice = 'machine' WHERE source IN ('grow', 'digest')")
  }
}

export interface MemoryRow {
  id: number
  bucket_id: string | null
  layer: Layer
  subject: string
  title: string
  fact_body: string
  feeling: string | null
  why: string | null
  tags: string
  grade: Grade
  valence: number | null
  arousal: number | null
  valid_from: string | null
  valid_until: string | null
  source: string
  voice: string
  created_at: string
  updated_at: string
  dont_surface: number
  needs_review: number
  review_note: string | null
  merged_into: number | null
  retracted_at: string | null
  retract_reason: string | null
  raw: string | null
}

/** 活着的记忆：没被合并掉、没被撤回。以后召回只从这里取 */
export function liveMemories(db: DB, layer?: Layer): MemoryRow[] {
  const where = layer ? ' AND layer = ?' : ''
  const sql = `SELECT * FROM memories WHERE retracted_at IS NULL${where} ORDER BY created_at DESC`
  const stmt = db.prepare(sql)
  return (layer ? stmt.all(layer) : stmt.all()) as unknown as MemoryRow[]
}

/** 当前有效的事实（被推翻的那条不给） */
export function currentFacts(db: DB, at: string = new Date().toISOString()): MemoryRow[] {
  return db.prepare(`SELECT * FROM memories
    WHERE retracted_at IS NULL AND layer = 'fact' AND dont_surface = 0
      AND (valid_until IS NULL OR valid_until > ?)
    ORDER BY CASE grade WHEN 'resident' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, created_at DESC`)
    .all(at) as unknown as MemoryRow[]
}
