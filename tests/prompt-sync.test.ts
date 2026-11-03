// @vitest-environment happy-dom
// 提示词/世界书和后端同步：首次导入、离线补推、以后端为准
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { savePrompt, syncPromptsFromServer, loadPrompt, loadHistory } from '../src/prompt-store'

type Docs = Record<string, { value: unknown } | null>

// 一个最小的假后端，记下收到的请求
function fakeServer(initial: Docs = { prompt: null, worldbook: null, worldbookGroups: null }, opts: { down?: boolean } = {}) {
  const docs: Docs = { ...initial }
  const calls: { method: string; url: string; body?: any }[] = []
  const history: { value: unknown; note: string }[] = []
  const fetchFn = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    if (opts.down) throw new TypeError('network down')
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
    if (url === '/api/eclipsis/prompts' && method === 'GET') return ok({ docs })
    if (url === '/api/eclipsis/prompts/history') return ok({ history })
    if (url === '/api/eclipsis/prompts/import') {
      const imported: string[] = []
      for (const [k, v] of Object.entries(body.docs)) if (!docs[k]) { docs[k] = { value: v }; imported.push(k) }
      return ok({ imported, skipped: [] })
    }
    const m = /^\/api\/eclipsis\/prompts\/(\w+)$/.exec(url)
    if (m && method === 'PUT') { docs[m[1]] = { value: body.value }; return ok({ changed: true }) }
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchFn)
  return { docs, calls }
}

beforeEach(() => localStorage.clear())

describe('syncPromptsFromServer', () => {
  it('后端是空的：把浏览器里改过的主 prompt 和世界书传上去', async () => {
    localStorage.setItem('eclipsis-system-prompt', JSON.stringify({ main: '我的人设', features: 'F', featuresEnabled: true, updatedAt: 1 }))
    localStorage.setItem('worldbook', JSON.stringify([{ title: 't', content: 'c', enabled: true, group: '默认', position: 'after', priority: 50 }]))
    const s = fakeServer()
    expect(await syncPromptsFromServer()).toBe('imported')
    const imp = s.calls.find(c => c.url.endsWith('/import'))!
    expect(Object.keys(imp.body.docs).sort()).toEqual(['prompt', 'worldbook'])
    expect((s.docs.prompt!.value as any).main).toBe('我的人设')
  })

  it('没改过的出厂默认不上传', async () => {
    const s = fakeServer()
    await syncPromptsFromServer()
    expect(s.calls.some(c => c.url.endsWith('/import'))).toBe(false)
  })

  it('后端已有：以后端为准写回缓存', async () => {
    localStorage.setItem('eclipsis-system-prompt', JSON.stringify({ main: '旧的', features: '', featuresEnabled: true, updatedAt: 1 }))
    fakeServer({ prompt: { value: { main: '服务器上的', features: '', featuresEnabled: true, updatedAt: 2 } }, worldbook: { value: [] }, worldbookGroups: null })
    expect(await syncPromptsFromServer()).toBe('synced')
    expect(loadPrompt().main).toBe('服务器上的')
  })

  it('离线时保存只存本机，下次启动先补推再拉', async () => {
    fakeServer({ prompt: null, worldbook: null, worldbookGroups: null }, { down: true })
    expect(await savePrompt({ main: '离线改的', features: '', featuresEnabled: true })).toBe(false)
    expect(loadPrompt().main).toBe('离线改的')

    const s = fakeServer({ prompt: { value: { main: '服务器上的旧版', features: '', featuresEnabled: true, updatedAt: 1 } }, worldbook: null, worldbookGroups: null })
    await syncPromptsFromServer()
    expect(s.calls.some(c => c.method === 'PUT' && c.url.endsWith('/prompt'))).toBe(true)
    expect((s.docs.prompt!.value as any).main).toBe('离线改的')
    expect(loadPrompt().main).toBe('离线改的')
  })

  it('后端连不上时不动缓存', async () => {
    localStorage.setItem('eclipsis-system-prompt', JSON.stringify({ main: '本机的', features: '', featuresEnabled: true, updatedAt: 1 }))
    fakeServer(undefined, { down: true })
    expect(await syncPromptsFromServer()).toBe('offline')
    expect(loadPrompt().main).toBe('本机的')
    expect(loadHistory()).toEqual([])
  })
})
