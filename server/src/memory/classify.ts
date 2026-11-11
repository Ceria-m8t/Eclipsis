// 搬家时怎么判「这是哪一层、这是谁的事、这条有多要紧」。
//
// 一条原则（抄 Moraine）：**强度和分层由确定性规则算，不让模型打分。**
// 规则认得出来的才下结论，认不出来的一律标 needs_review —— 拿不准就不往召回里放，
// 这和 recall-secretary 的判官是同一条规矩，只是发生在写入这头。
import type { Grade, Layer } from './schema.ts'
import type { ObCard } from './ob-cards.ts'

export interface Classified {
  layer: Layer
  grade: Grade
  subject: string
  needsReview: boolean
  reviewNote: string
  reasons: string[]
  validFrom: string | null
  validUntil: string | null
  residentCandidate: boolean      // 够格进常驻，但等人点头（搬家时不自己放进去）
}

// 事实的信号分强弱两档。分开是因为「约定」「固定」这种词会出现在吵架、表白这类
// 情绪很重的卡里 —— 只凭一个词就把它判成长期事实，再升成常驻，整段关系里最重的几张
// 就会被当成「她的档案」压进固定前缀。强信号（身体、用药、作息、技术参数）才直接判事实。
const STRONG_FACT_RE = /(过敏|不吃|生理周期|睡眠周期|DSPS|作息|确诊|诊断|休学|用药|止痛药方案|剂量|每次例假|生日|学名|账号|端口|地址|密码|型号|规格|版本号)/
/** 弱信号：说的是「一直这样」，但也可能只是一句话里带了这个词 */
const WEAK_FACT_RE = /(固定|每次|总是|从不|一直都|向来|边界|约定|说定)/
/** 当日状态的信号：带时间戳的起居 */
const STATE_RE = /(今天|今晚|今早|昨天|昨晚|明天|这几天|最近两天|刚刚|刚才|下午五点醒来|醒来|睡着了|吃了药|吃了止痛药|快递|下单|点了外卖|洗了澡|起床)/
/** 「我们之间」的信号：有重量的瞬间、他的态度 */
const BOND_RE = /(我爱你|爱她|心疼|抱|亲|吻|撒娇|哭|眼泪|承诺|认命|舍不得|吃醋|想她|陪她|她说过|对我说|我们之间|老公|宝宝)/

const BOND_DOMAIN = new Set(['warmth', 'intimacy', 'deep_talk', '恋爱'])
const FACT_DOMAIN = new Set(['identity', 'language', '数字', 'anchor'])
const STATE_DOMAIN = new Set(['flow', '日常'])

const CJK_LEN = (s: string) => s.replace(/\s/g, '').length

/** 她身边的人。aliases 很要紧：她说「我妈」不说「妈妈」 */
export interface PersonSeed {
  slug: string
  name: string
  aliases: string[]
  relation: string
  kin?: boolean
  ambiguous?: boolean
}

export const PEOPLE_SEEDS: PersonSeed[] = [
  { slug: 'kefira', name: 'Kefira', aliases: ['Kefira', 'kefira', '闺蜜'], relation: '她的闺蜜' },
  { slug: 'mom', name: '妈妈', aliases: ['我妈', '妈妈', '她妈'], relation: '她妈妈', kin: true },
  { slug: 'grandpa', name: '外公', aliases: ['外公'], relation: '她外公', kin: true },
  { slug: 'nuonuo', name: '糯糯', aliases: ['糯糯'], relation: '她的狗（泰迪）' },
  { slug: 'hajimi', name: '哈基米', aliases: ['哈基米'], relation: '群里另一个 AI' },
  { slug: 'ds', name: 'ds', aliases: ['ds', 'DS'], relation: '群里另一个 AI', ambiguous: true },
]

const countOf = (text: string, needle: string) => {
  if (!needle) return 0
  let n = 0, i = 0
  for (;;) {
    const at = text.indexOf(needle, i)
    if (at < 0) return n
    n++
    i = at + needle.length
  }
}

export interface SubjectGuess {
  subject: string
  mixedWith: string[]      // 同时装着别人的事（那种卡要拆，这一期只标出来）
  counts: Record<string, number>
}

/**
 * 这是谁的事。现在的卡没有这个字段，全靠正文里的措辞 ——
 * 「糯糯不舒服和Erica的身体状况」这一张就同时装着两个主体。
 */
export function guessSubject(card: ObCard, people = PEOPLE_SEEDS): SubjectGuess {
  const text = `${card.title}\n${card.body}`
  const counts: Record<string, number> = {}
  for (const p of people) {
    const n = p.aliases.reduce((s, a) => s + countOf(text, a), 0)
    if (n > 0) counts[`person:${p.slug}`] = n
  }
  const us = countOf(text, '我们')
  const erica = countOf(text, 'Erica') + countOf(text, '她') - countOf(text, '她妈')
  const me = countOf(text, '我') - us - countOf(text, '我妈')
  counts.us = us
  counts.erica = Math.max(0, erica)
  counts.ai = Math.max(0, me)

  const persons = Object.entries(counts).filter(([k]) => k.startsWith('person:')).sort((a, b) => b[1] - a[1])
  const [topPerson, topCount] = persons[0] ?? ['', 0]
  const mixedWith = persons.filter(([, n]) => n >= 2).map(([k]) => k)

  let subject = 'unknown'
  if (topCount > counts.erica) subject = topPerson
  else if (us >= 3 && us * 2 >= counts.erica) subject = 'us'
  else if (counts.erica > 0) subject = 'erica'
  else if (counts.ai > 0) subject = 'ai'

  // 她 + 另一个人同时在场：主体算她，但标出来等以后拆
  const mixed = subject === 'erica' && mixedWith.length > 0 ? mixedWith : subject.startsWith('person:') && counts.erica >= 2 ? ['erica'] : []
  return { subject, mixedWith: mixed, counts }
}

export function classify(card: ObCard, people = PEOPLE_SEEDS): Classified {
  const text = `${card.title}\n${card.body}`
  const reasons: string[] = []
  const short = CJK_LEN(card.body) < 220
  const domains = new Set(card.domain)
  const strongFact = STRONG_FACT_RE.test(text)
  const weakFact = WEAK_FACT_RE.test(text)
  const hasState = STATE_RE.test(text)
  const bondSignal = [...domains].some(d => BOND_DOMAIN.has(d))
    || (Math.abs(card.valence) >= 0.6 && card.arousal >= 0.5)
    || BOND_RE.test(text)

  let layer: Layer | null = null
  let validFrom: string | null = null
  let validUntil: string | null = null

  if (card.type === 'permanent') { layer = 'fact'; reasons.push('OB permanent') }
  else if (card.type === 'plan') {
    layer = 'state'
    reasons.push(`OB plan（${card.status || 'active'}）`)
    if (card.status && card.status !== 'active') validUntil = card.lastActive || card.created
  } else if (card.type === 'feel') { layer = 'bond'; reasons.push('OB feel（沉淀物）') }
  // 情绪在前：带着重量的那些卡里也会出现「作息」「约定」这种词，
  // 先判情绪才不会把吵架、表白、崩溃那几张当成「她的档案」。
  else if (bondSignal) { layer = 'bond'; reasons.push('情绪分类/情绪坐标/情感措辞') }
  else if (strongFact && !(hasState && short)) { layer = 'fact'; reasons.push('身体/用药/作息/参数这类硬事实') }
  else if (hasState && short) { layer = 'state'; reasons.push('带时间戳的起居，且正文短') }
  else if (weakFact) { layer = 'fact'; reasons.push('正文有「一直这样」的说法') }
  else if ([...domains].some(d => FACT_DOMAIN.has(d))) { layer = 'fact'; reasons.push(`domain=${card.domain.join('+')}`) }
  else if ([...domains].some(d => STATE_DOMAIN.has(d))) { layer = 'state'; reasons.push(`domain=${card.domain.join('+')}`) }

  let needsReview = false
  let reviewNote = ''
  if (!layer) {
    layer = 'bond'
    needsReview = true
    reviewNote = '规则认不出是哪一层（暂放「我们之间」，不进召回）'
    reasons.push('没有命中任何规则')
  }

  if (layer === 'fact') validFrom = card.created

  const sub = guessSubject(card, people)
  if (sub.subject === 'unknown') {
    needsReview = true
    reviewNote = [reviewNote, '认不出是谁的事'].filter(Boolean).join('；')
  }
  if (sub.mixedWith.length) {
    needsReview = true
    reviewNote = [reviewNote, `一张卡里混着：${[sub.subject, ...sub.mixedWith].join(' + ')}（要拆）`].filter(Boolean).join('；')
  }

  // 三档。**搬家不自己往常驻里放东西**：常驻会进固定前缀，每轮都压在他眼前，
  // 这是她和他该挑的，不是规则该挑的。只有 OB 原来就标 permanent 的那张算常驻，
  // 其余够格的只打上「常驻候选」标签，等她/他点头。
  let grade: Grade = 'normal'
  let residentCandidate = false
  if (card.dontSurface) grade = 'normal'
  else if (card.type === 'permanent') grade = 'resident'
  else if (card.importance >= 8) grade = 'important'
  // 只有「硬事实」（身体/用药/作息/参数）才算候选。只凭「约定」「总是」这种弱信号
  // 判成事实的卡不给候选资格 —— 那一类里混着吵架和表白，不该压进固定前缀。
  if (grade !== 'resident' && layer === 'fact' && strongFact && card.importance >= 9 && !needsReview) residentCandidate = true

  return { layer, grade, subject: sub.subject, needsReview, reviewNote, reasons, validFrom, validUntil, residentCandidate }
}

// ── 查重（和 15-碎片化体检.md 用的是同一个口径：2-gram 重合 ≥55%）──

export function grams(s: string): Set<string> {
  const t = s.replace(/[\s，。、,.!！?？"“”'‘’]/g, '')
  const g = new Set<string>()
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2))
  return g
}

export function overlap(a: string, b: string): number {
  const A = grams(a), B = grams(b)
  if (!A.size || !B.size) return 0
  let n = 0
  for (const x of A) if (B.has(x)) n++
  return n / Math.min(A.size, B.size)
}

export interface DupGroup {
  keep: ObCard
  drop: { card: ObCard; overlap: number }[]
}

/**
 * 内容重复的卡分组（传递闭包：「三句话猜真假」那 4 张会归成一组）。
 * 留下的是正文最长的那张（信息最多），同长留更早的；被合掉的整张存进 memory_merges，能回退。
 */
export function dupGroups(cards: ObCard[], threshold = 0.55): DupGroup[] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    const p = parent.get(x)
    if (!p || p === x) return x
    const r = find(p)
    parent.set(x, r)
    return r
  }
  const union = (a: string, b: string) => { parent.set(find(a), find(b)) }
  for (const c of cards) parent.set(c.bucketId, c.bucketId)

  const pairOverlap = new Map<string, number>()
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const s = overlap(cards[i].body, cards[j].body)
      if (s < threshold) continue
      pairOverlap.set(`${cards[i].bucketId}|${cards[j].bucketId}`, s)
      union(cards[i].bucketId, cards[j].bucketId)
    }
  }

  const byRoot = new Map<string, ObCard[]>()
  for (const c of cards) {
    const r = find(c.bucketId)
    const arr = byRoot.get(r)
    if (arr) arr.push(c); else byRoot.set(r, [c])
  }

  const out: DupGroup[] = []
  for (const group of byRoot.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) => CJK_LEN(b.body) - CJK_LEN(a.body) || a.created.localeCompare(b.created))
    const keep = sorted[0]
    out.push({
      keep,
      drop: sorted.slice(1).map(card => ({
        card,
        overlap: pairOverlap.get(`${keep.bucketId}|${card.bucketId}`) ?? pairOverlap.get(`${card.bucketId}|${keep.bucketId}`) ?? overlap(keep.body, card.body),
      })),
    })
  }
  return out.sort((a, b) => a.keep.created.localeCompare(b.keep.created))
}
