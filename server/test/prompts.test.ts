// 提示词存储：存取、历史、首次导入、拼接、HTTP 接口
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { openDb } from '../src/db.ts'
import {
  ensurePromptSchema, getDoc, putDoc, listHistory, importDocs, composeSystemPrompt,
  validateDoc, handlePromptApi, MAX_HISTORY
} from '../src/prompts.ts'
import { listen, close } from './helpers.ts'

function freshDb() {
  const db = openDb(':memory:')
  ensurePromptSchema(db)
  return db
}
const P = (main: string, extra: Record<string, unknown> = {}) => ({ main, features: 'F', featuresEnabled: true, ...extra })

describe('putDoc / history', () => {
  it('保存和读取', () => {
    const db = freshDb()
    assert.equal(getDoc(db, 'prompt'), null)
    assert.equal(putDoc(db, 'prompt', P('v1')).changed, true)
    assert.equal((getDoc<any>(db, 'prompt')!.value).main, 'v1')
  })
  it('内容没变不写、不进历史；变了把旧版本放进历史', () => {
    const db = freshDb()
    putDoc(db, 'prompt', P('v1'))
    assert.equal(putDoc(db, 'prompt', P('v1')).changed, false)
    assert.equal(listHistory(db).length, 0)
    putDoc(db, 'prompt', P('v2'), '改称呼前')
    const h = listHistory(db)
    assert.equal(h.length, 1)
    assert.equal((h[0].value as any).main, 'v1')
    assert.equal(h[0].note, '改称呼前')
  })
  it(`历史最多 ${MAX_HISTORY} 条，新的在前`, () => {
    const db = freshDb()
    for (let i = 0; i <= MAX_HISTORY + 5; i++) putDoc(db, 'prompt', P(`v${i}`))
    const h = listHistory(db)
    assert.equal(h.length, MAX_HISTORY)
    assert.equal((h[0].value as any).main, `v${MAX_HISTORY + 4}`)
  })
  it('世界书不记历史', () => {
    const db = freshDb()
    putDoc(db, 'worldbook', [{ content: 'a' }])
    putDoc(db, 'worldbook', [{ content: 'b' }])
    assert.equal(listHistory(db, 'worldbook').length, 0)
  })
})

describe('validateDoc', () => {
  it('拒绝错误的形状', () => {
    assert.ok(validateDoc('prompt', 'x'))
    assert.ok(validateDoc('prompt', { main: 1 }))
    assert.ok(validateDoc('prompt', { main: 'x', featuresEnabled: 'yes' }))
    assert.ok(validateDoc('worldbook', {}))
    assert.ok(validateDoc('worldbookGroups', []))
    assert.equal(validateDoc('prompt', { main: 'x' }), null)
    assert.equal(validateDoc('worldbook', []), null)
  })
  it('拒绝超过 2MB', () => {
    assert.match(validateDoc('worldbook', [{ content: 'x'.repeat(2 * 1024 * 1024 + 1) }]) ?? '', /太大/)
  })
})

describe('importDocs', () => {
  it('只填服务器上没有的，已有的不覆盖', () => {
    const db = freshDb()
    putDoc(db, 'prompt', P('server'))
    const r = importDocs(db, { prompt: P('browser'), worldbook: [{ content: 'w' }], bogus: 1 })
    assert.deepEqual(r.imported, ['worldbook'])
    assert.ok(r.skipped.includes('prompt') && r.skipped.includes('bogus'))
    assert.equal((getDoc<any>(db, 'prompt')!.value).main, 'server')
  })
  it('主 prompt 是这次导入的时，带上浏览器里的历史（顺序保持新的在前）', () => {
    const db = freshDb()
    importDocs(db, { prompt: P('now') }, [{ value: P('older'), note: 'n1' }, { value: P('oldest'), note: 'n2' }, { value: 'bad' }])
    const h = listHistory(db)
    assert.deepEqual(h.map(x => (x.value as any).main), ['older', 'oldest'])
  })
})

describe('composeSystemPrompt', () => {
  it('没有主 prompt → null', () => {
    assert.equal(composeSystemPrompt(freshDb()), null)
  })
  it('前置（按优先级）→ 主 prompt → 功能说明 → 后置；关掉的条目和分组不带', () => {
    const db = freshDb()
    putDoc(db, 'prompt', P('MAIN'))
    putDoc(db, 'worldbook', [
      { content: 'B-low', enabled: true, group: 'g', position: 'before', priority: 10 },
      { content: 'B-high', enabled: true, group: 'g', position: 'before', priority: 90 },
      { content: 'A1', enabled: true, group: 'g', position: 'after' },
      { content: 'OFF', enabled: false, group: 'g', position: 'after' },
      { content: 'GROUP-OFF', enabled: true, group: 'hidden', position: 'after' }
    ])
    putDoc(db, 'worldbookGroups', { hidden: { enabled: false } })
    assert.equal(composeSystemPrompt(db), 'B-high\n\nB-low\n\nMAIN\n\nF\n\nA1')
    assert.equal(composeSystemPrompt(db, { features: false }), 'B-high\n\nB-low\n\nMAIN\n\nA1')
  })
  it('功能说明关掉时不带', () => {
    const db = freshDb()
    putDoc(db, 'prompt', P('MAIN', { featuresEnabled: false }))
    assert.equal(composeSystemPrompt(db), 'MAIN')
  })
})

describe('HTTP /v1/eclipsis/prompts', () => {
  it('GET / PUT / history / import / 错误', async () => {
    const db = freshDb()
    const server = createServer(async (req, res) => {
      if (!(await handlePromptApi(db, req, res))) { res.writeHead(404); res.end() }
    })
    const port = await listen(server)
    const base = `http://127.0.0.1:${port}/v1/eclipsis/prompts`
    const call = async (path: string, init?: RequestInit) => {
      const r = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json' } })
      return { status: r.status, body: await r.json() as any }
    }
    try {
      let r = await call('')
      assert.equal(r.status, 200)
      assert.equal(r.body.docs.prompt, null)

      r = await call('/import', { method: 'POST', body: JSON.stringify({ docs: { prompt: P('imported') } }) })
      assert.deepEqual(r.body.imported, ['prompt'])

      r = await call('/prompt', { method: 'PUT', body: JSON.stringify({ value: P('edited'), note: '编辑前' }) })
      assert.equal(r.status, 200)
      assert.equal(r.body.changed, true)

      r = await call('/history')
      assert.equal(r.body.history[0].value.main, 'imported')

      r = await call('/prompt', { method: 'PUT', body: JSON.stringify({ value: { main: 3 } }) })
      assert.equal(r.status, 400)
      r = await call('/prompt', { method: 'PUT', body: '{not json' })
      assert.equal(r.status, 400)
      r = await call('/nope', { method: 'PUT', body: '{}' })
      assert.equal(r.status, 404)
      r = await call('/prompt', { method: 'DELETE' })
      assert.equal(r.status, 405)

      const unrelated = await fetch(`http://127.0.0.1:${port}/v1/eclipsis/other`)
      assert.equal(unrelated.status, 404)
    } finally {
      await close(server)
    }
  })
})
