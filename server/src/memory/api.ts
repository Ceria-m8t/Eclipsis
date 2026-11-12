// 记忆库的 HTTP（给她的前端用；前端界面以后再做，先把接口和数据备好）。
//
//   GET  /v1/eclipsis/memory              列记忆（?layer=&subject=&q=&limit=&review=1）
//   GET  /v1/eclipsis/memory/stats        分层、三档、信箱里有几条、夜里整理跑过几次
//   GET  /v1/eclipsis/memory/inbox        沉淀信箱（?status=inbox|accepted|skipped）
//   POST /v1/eclipsis/memory/inbox/decide { id, action: 'accept'|'skip', edits? }
//   GET  /v1/eclipsis/memory/<id>         一条的全文 + 原话链接（evidence 对应的几句）
//   POST /v1/eclipsis/memory/<id>/retract { reason }   她划掉一条（软删，不是真删）
//   GET  /v1/eclipsis/memory/digest       夜里整理的近况（跑过几次、现在该不该跑）
//   GET  /v1/eclipsis/memory/proposals    旧卡重整的建议（她点头才动库）
//   POST /v1/eclipsis/memory/proposals/decide { id|ids, action: 'take'|'drop' }
//   POST /v1/eclipsis/memory/rejudge      { limit, layer, maxChars } 跑一批重整（只提建议）
//   GET  /v1/eclipsis/memory/corrections  她贴的便条（?status=open|accepted|kept）
//   POST /v1/eclipsis/memory/corrections  { memoryId, note } 贴一张；{ id, withdraw:true } 撤回
//   POST /v1/eclipsis/memory/relations    { from, to, kind, reason } 连两条；{ id, remove:true } 去掉
//   POST /v1/eclipsis/memory/relations/extract   把 OB 的 relation_links 抽出来（可反复跑）
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DB } from '../db.ts'
import { ensureMemorySchema } from './schema.ts'
import { listInbox, decideCandidate, inboxCount, labelWithPeople } from './write.ts'
import { findDigestWindow, stationCaller } from './digest.ts'
import { listProposals, takeProposal, dropProposal, runRejudge } from './rejudge.ts'
import { listRelationsOf, addRelation, removeRelation, extractObRelations, KIND_LABEL, type RelationKind } from './relations.ts'
import { addCorrection, withdrawCorrection, listCorrections, openCount } from './corrections.ts'
import { chooseModel, currentStation } from '../station.ts'

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage, max = 64 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { reject(new Error('请求太大')); req.destroy(); return } chunks.push(c) })
    req.on('end', () => { try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : {}) } catch { reject(new Error('请求体不是合法 JSON')) } })
    req.on('error', reject)
  })
}

const tags = (s: string | null) => { try { return JSON.parse(s || '[]') } catch { return [] } }

export async function handleMemoryApi(db: DB, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || '/', 'http://local')
  const p = url.pathname
  if (!p.startsWith('/v1/eclipsis/memory')) return false
  ensureMemorySchema(db)
  try {
    if (p === '/v1/eclipsis/memory' && req.method === 'GET') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200)
      const where: string[] = ['retracted_at IS NULL']
      const args: (string | number)[] = []
      const layer = url.searchParams.get('layer')
      if (layer) { where.push('layer = ?'); args.push(layer) }
      const subject = url.searchParams.get('subject')
      if (subject) { where.push('subject = ?'); args.push(subject) }
      if (url.searchParams.get('review') === '1') where.push('needs_review = 1')
      const q = (url.searchParams.get('q') || '').trim()
      if (q) { where.push('(title LIKE ? OR fact_body LIKE ?)'); args.push(`%${q}%`, `%${q}%`) }
      const rows = db.prepare(`SELECT id, bucket_id, layer, subject, title, fact_body, feeling, why, tags, grade, voice,
          valence, arousal, valid_from, valid_until, source, thread, needs_review, review_note, created_at, updated_at
        FROM memories WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
        .all(...args, limit) as unknown as any[]
      json(res, 200, {
        memories: rows.map(r => ({ ...r, tags: tags(r.tags), subjectLabel: labelWithPeople(db, r.subject) })),
        inbox: inboxCount(db),
      })
      return true
    }

    if (p === '/v1/eclipsis/memory/stats' && req.method === 'GET') {
      const byLayer = db.prepare('SELECT layer, count(*) n FROM memories WHERE retracted_at IS NULL GROUP BY layer').all() as unknown as any[]
      const byGrade = db.prepare('SELECT grade, count(*) n FROM memories WHERE retracted_at IS NULL GROUP BY grade').all() as unknown as any[]
      const bySubject = db.prepare('SELECT subject, count(*) n FROM memories WHERE retracted_at IS NULL GROUP BY subject ORDER BY n DESC').all() as unknown as any[]
      const review = db.prepare('SELECT count(*) n FROM memories WHERE retracted_at IS NULL AND needs_review = 1').get() as { n: number }
      const merged = db.prepare('SELECT count(*) n FROM memory_merges WHERE undone_at IS NULL').get() as { n: number }
      const runs = db.prepare('SELECT count(*) n, sum(wrote) w, sum(inboxed) i, sum(skipped) s FROM memory_digest_runs').get() as any
      json(res, 200, {
        total: byLayer.reduce((n, x) => n + Number(x.n), 0),
        byLayer: Object.fromEntries(byLayer.map(x => [x.layer, Number(x.n)])),
        byGrade: Object.fromEntries(byGrade.map(x => [x.grade, Number(x.n)])),
        bySubject: bySubject.map(x => ({ subject: x.subject, label: labelWithPeople(db, x.subject), n: Number(x.n) })),
        needsReview: Number(review.n),
        merged: Number(merged.n),
        inbox: inboxCount(db),
        corrections: openCount(db),
        relations: Number((db.prepare('SELECT count(*) n FROM memory_relations WHERE removed_at IS NULL').get() as { n: number }).n),
        digest: { runs: Number(runs?.n || 0), wrote: Number(runs?.w || 0), inboxed: Number(runs?.i || 0), skipped: Number(runs?.s || 0) },
      })
      return true
    }

    if (p === '/v1/eclipsis/memory/inbox' && req.method === 'GET') {
      const status = url.searchParams.get('status') || 'inbox'
      json(res, 200, { candidates: listInbox(db, { status, limit: Number(url.searchParams.get('limit')) || 50 }) })
      return true
    }

    if (p === '/v1/eclipsis/memory/inbox/decide' && req.method === 'POST') {
      const b = await readJson(req)
      const action = b?.action === 'skip' ? 'skip' : b?.action === 'accept' ? 'accept' : null
      if (!action) { json(res, 400, { error: "action 只能是 accept 或 skip" }); return true }
      const ids: number[] = Array.isArray(b?.ids) ? b.ids.map(Number).filter(Number.isFinite) : [Number(b?.id)].filter(Number.isFinite)
      if (!ids.length) { json(res, 400, { error: '要给 id 或 ids' }); return true }
      const results = ids.map(id => ({ id, ...decideCandidate(db, id, action, b?.edits || {}, 'her') }))
      json(res, 200, { results, inbox: inboxCount(db) })
      return true
    }

    if (p === '/v1/eclipsis/memory/digest' && req.method === 'GET') {
      const win = findDigestWindow(db, { upstreamUrl: '', upstreamKey: '' })
      const runs = db.prepare(`SELECT id, started_at, finished_at, thread, episodes, wrote, inboxed, amended, skipped, error
        FROM memory_digest_runs ORDER BY id DESC LIMIT 10`).all() as unknown as any[]
      json(res, 200, {
        enabled: process.env.MEMORY_DIGEST === '1',
        now: { ready: win.ready, why: win.why, pairs: win.pairs, quietMinutes: win.quietMinutes, episodes: win.episodes.length },
        runs,
      })
      return true
    }

    if (p === '/v1/eclipsis/memory/proposals' && req.method === 'GET') {
      json(res, 200, {
        proposals: listProposals(db, { status: url.searchParams.get('status') || 'open', limit: Number(url.searchParams.get('limit')) || 50 }),
      })
      return true
    }

    if (p === '/v1/eclipsis/memory/proposals/decide' && req.method === 'POST') {
      const b = await readJson(req)
      const action = b?.action === 'drop' ? 'drop' : b?.action === 'take' ? 'take' : null
      if (!action) { json(res, 400, { error: "action 只能是 take 或 drop" }); return true }
      const ids: number[] = Array.isArray(b?.ids) ? b.ids.map(Number).filter(Number.isFinite) : [Number(b?.id)].filter(Number.isFinite)
      if (!ids.length) { json(res, 400, { error: '要给 id 或 ids' }); return true }
      const results = ids.map(id => ({ id, ...(action === 'take' ? takeProposal(db, id) : dropProposal(db, id)) }))
      json(res, 200, { results, open: listProposals(db).length })
      return true
    }

    if (p === '/v1/eclipsis/memory/rejudge' && req.method === 'POST') {
      const b = await readJson(req)
      // 跟着换站面板上现在那个站走（和聊天、Wake、心潮同一个）
      const st = currentStation()
      // 20 张卡的判断容易写不完被截断，这条路给大一点
      const cfg = { upstreamUrl: st.url, upstreamKey: st.key, maxTokens: Number(b?.maxTokens) || 6000 }
      const model = String(b?.model || '').trim() || chooseModel(db) || st.defaultModel
      if (!cfg.upstreamUrl || !model) { json(res, 503, { error: '还不知道用哪个站/哪个模型' }); return true }
      const r = await runRejudge(db, stationCaller(cfg), model, {
        limit: Number(b?.limit) || 20,
        layer: b?.layer || undefined,
        maxChars: Number(b?.maxChars) || undefined,
      })
      json(res, 200, r)
      return true
    }

    if (p === '/v1/eclipsis/memory/corrections') {
      if (req.method === 'GET') {
        json(res, 200, {
          corrections: listCorrections(db, { status: url.searchParams.get('status') || undefined, limit: Number(url.searchParams.get('limit')) || 50 }),
          open: openCount(db),
        })
        return true
      }
      if (req.method === 'POST') {
        const b = await readJson(req)
        if (b?.withdraw === true) {
          const ok = withdrawCorrection(db, Number(b?.id))
          json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '没有这张便条（或者已经处理过了）' })
          return true
        }
        const r = addCorrection(db, Number(b?.memoryId), String(b?.note ?? ''), 'her')
        json(res, r.ok ? 200 : 400, r)
        return true
      }
    }

    if (p === '/v1/eclipsis/memory/relations' && req.method === 'POST') {
      const b = await readJson(req)
      if (b?.remove === true) {
        json(res, removeRelation(db, Number(b?.id)) ? 200 : 404, { ok: true })
        return true
      }
      const r = addRelation(db, {
        fromId: Number(b?.from), toId: Number(b?.to), kind: String(b?.kind) as RelationKind,
        reason: String(b?.reason ?? ''), auto: false, by: 'her',
      })
      json(res, r.ok ? 200 : 400, r)
      return true
    }

    if (p === '/v1/eclipsis/memory/relations/extract' && req.method === 'POST') {
      json(res, 200, extractObRelations(db))
      return true
    }

    const one = /^\/v1\/eclipsis\/memory\/(\d+)(\/retract)?$/.exec(p)
    if (one) {
      const id = Number(one[1])
      if (!one[2] && req.method === 'GET') {
        const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any
        if (!row) { json(res, 404, { error: '没有这一条' }); return true }
        let evidence: number[] = []
        try { evidence = JSON.parse(row.evidence || '[]') } catch { evidence = [] }
        const quotes = evidence.length
          ? db.prepare(`SELECT seq, ts, actor, content FROM episodes WHERE seq IN (${evidence.map(() => '?').join(',')}) ORDER BY seq`)
              .all(...evidence) as unknown as any[]
          : []
        json(res, 200, {
          memory: { ...row, tags: tags(row.tags), subjectLabel: labelWithPeople(db, row.subject), evidence },
          quotes,
          relations: listRelationsOf(db, id).map(r => ({ ...r, kindLabel: KIND_LABEL[r.kind] || r.kind })),
          corrections: listCorrections(db, { memoryId: id }),
          raw: row.raw ? JSON.parse(row.raw) : null,
        })
        return true
      }
      if (one[2] && req.method === 'POST') {
        const b = await readJson(req)
        const r = db.prepare(`UPDATE memories SET retracted_at = ?, retract_reason = ?, updated_at = ?
          WHERE id = ? AND retracted_at IS NULL`)
          .run(new Date().toISOString(), String(b?.reason || 'manual').slice(0, 60), new Date().toISOString(), id)
        if (!Number(r.changes)) { json(res, 404, { error: '没有这一条（或者已经划掉了）' }); return true }
        json(res, 200, { ok: true })
        return true
      }
    }

    json(res, 405, { error: 'method not allowed' })
    return true
  } catch (e: any) {
    json(res, 400, { error: String(e?.message || e) })
    return true
  }
}
