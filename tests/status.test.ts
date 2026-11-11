// @vitest-environment happy-dom
// 顶栏状态：后端是那一份，localStorage 只是缓存（2026-11-11）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { aiStatus, setStatus, fetchStatus, pushStatus } from '../src/status'

const KEY = 'eclipsis-ai-status'
const SETTINGS = 'our-home-settings'

function mockFetch(impl: (url: string, init?: RequestInit) => any) {
  const spy = vi.fn((url: any, init?: any) => Promise.resolve(impl(String(url), init)))
  vi.stubGlobal('fetch', spy)
  return spy
}
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

beforeEach(() => {
  localStorage.clear()
  setStatus(null)
})
afterEach(() => vi.unstubAllGlobals())

describe('本机缓存', () => {
  it('setStatus 写 ref 和 localStorage，清掉时两边都清', () => {
    setStatus({ emoji: '☕', text: '在厨房泡茶' })
    expect(aiStatus.value!.text).toBe('在厨房泡茶')
    expect(JSON.parse(localStorage.getItem(KEY)!).emoji).toBe('☕')
    setStatus(null)
    expect(aiStatus.value).toBe(null)
    expect(localStorage.getItem(KEY)).toBe(null)
  })
})

describe('fetchStatus', () => {
  it('后端有就用后端那份（他醒来时改的这样回到顶栏），带上原本的时间', async () => {
    setStatus({ emoji: '☕', text: '旧的' })
    mockFetch(() => ok({ status: { emoji: '🌙', text: '等她睡', updatedAt: '2026-11-11T02:00:00.000Z', source: 'wake' } }))
    await fetchStatus()
    expect(aiStatus.value).toEqual({
      emoji: '🌙', text: '等她睡', updatedAt: Date.parse('2026-11-11T02:00:00.000Z')
    })
  })

  it('后端说没有就清掉（他清过）', async () => {
    setStatus({ emoji: '☕', text: '在泡茶' })
    mockFetch(() => ok({ status: null }))
    await fetchStatus()
    expect(aiStatus.value).toBe(null)
  })

  it('后端连不上/报错时保持现在显示的，不闪空', async () => {
    setStatus({ emoji: '☕', text: '在泡茶' })
    mockFetch(() => { throw new Error('连不上') })
    await fetchStatus()
    expect(aiStatus.value!.text).toBe('在泡茶')
    mockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }))
    await fetchStatus()
    expect(aiStatus.value!.text).toBe('在泡茶')
  })

  it('直连别的 API（填了 apiBase）时不问后端', async () => {
    localStorage.setItem(SETTINGS, JSON.stringify({ apiBase: 'https://example.com/v1' }))
    const spy = mockFetch(() => ok({ status: null }))
    await fetchStatus()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('pushStatus', () => {
  it('顶栏先更新，再 POST 给后端', async () => {
    const spy = mockFetch(() => ok({ status: { emoji: '☕', text: '在厨房泡茶' } }))
    const err = await pushStatus({ emoji: '☕', text: '在厨房泡茶' })
    expect(err).toBe(null)
    expect(aiStatus.value!.text).toBe('在厨房泡茶')
    const [url, init] = spy.mock.calls[0] as any[]
    expect(url).toBe('/api/eclipsis/status')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ emoji: '☕', text: '在厨房泡茶', source: 'chat' })
  })

  it('清空发 clear', async () => {
    const spy = mockFetch(() => ok({ status: null }))
    await pushStatus(null)
    expect(JSON.parse((spy.mock.calls[0] as any[])[1].body)).toEqual({ clear: true })
    expect(aiStatus.value).toBe(null)
  })

  it('存不上时返回原因（顶栏还是改了，他会被告知）', async () => {
    mockFetch(() => ({ ok: false, status: 500, json: async () => ({ error: '数据库锁了' }) }))
    const err = await pushStatus({ emoji: '☕', text: '在泡茶' })
    expect(err).toBe('数据库锁了')
    expect(aiStatus.value!.text).toBe('在泡茶')
  })
})
