// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, nextTick } from 'vue'
import TurnDebug from '../src/components/TurnDebug.vue'
import { startKeepAlive, stopKeepAlive, keepAliveActive } from '../src/keepalive'

const flush = async () => { for (let i = 0; i < 5; i++) { await Promise.resolve(); await nextTick() } }

function mount(props: { turn: string; version: number }) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(TurnDebug, props)
  app.mount(el)
  return { el, unmount: () => { app.unmount(); el.remove() } }
}

afterEach(() => { vi.unstubAllGlobals(); stopKeepAlive() })

describe('TurnDebug', () => {
  it('按 turn + version 请求，显示耗时、字数、补进来的条数', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ rounds: [{
      rid: 'r1', started_at: '2026-10-27T17:09:03Z', model: 'm', status: 'ok', error: null,
      front: { ttfb_ms: 7989, first_token_ms: 7989, latency_ms: 10530, client_closed_ms: null },
      upstream: { ttfb_ms: 6184, first_token_ms: 6184, latency_ms: 9443, status: 'ok', error: null },
      transforms: { strip_wake_history: { stripped: 30, saved_chars: 184595 } },
      sent: { messages: 25, chars: 40000, system_chars: 30000 },
      delivered: { messages: 183, chars: 120000, from_frontend: 25, from_gateway: 158, gateway_chars: 80000 },
      messages: [{ role: 'system', chars: 30000, images: 0, tool_calls: 0, origin: 'frontend', preview: '你是' },
                 { role: 'user', chars: 2, images: 0, tool_calls: 0, origin: 'gateway', preview: '旧的' }],
      reply: { chars: 120, thinking_chars: 300, tool_calls: [], finish_reason: 'stop' }
    }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { el, unmount } = mount({ turn: 'abc', version: 2 })
    await flush()
    expect(fetchMock).toHaveBeenCalledWith('/api/eclipsis/turn/abc?version=2')
    const text = el.textContent || ''
    expect(text).toContain('6.2 秒')           // 开始回复用上游入口的时间
    expect(text).toContain('10.5 秒')          // 回完用网页那边的
    expect(text).toContain('158 条')
    expect(text).toContain('剪掉旧唤醒')
    expect(text).toContain('正常')
    expect(el.querySelectorAll('li.gw').length).toBe(1)
    unmount()
  })

  it('网页提前断开时直接说出来', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ rounds: [{
      rid: 'r2', started_at: '2026-10-27T17:09:03Z', model: 'm', status: 'aborted', error: null,
      front: { ttfb_ms: null, first_token_ms: null, latency_ms: 40000, client_closed_ms: 40000 },
      upstream: null, transforms: null, sent: { messages: 3, chars: 10, system_chars: 0 }, delivered: null,
      messages: [], reply: { chars: 0, thinking_chars: 0, tool_calls: [], finish_reason: null }
    }] }))))
    const { el, unmount } = mount({ turn: 'x', version: 0 })
    await flush()
    expect(el.textContent).toContain('网页在第 40.0 秒 断开了')
    unmount()
  })

  it('没有记录、读取失败都有说明', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"rounds":[]}')))
    let m = mount({ turn: 'x', version: 0 }); await flush()
    expect(m.el.textContent).toContain('后端没有这条回复的记录')
    m.unmount()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 502 })))
    m = mount({ turn: 'x', version: 0 }); await flush()
    expect(m.el.querySelector('[role="alert"]')?.textContent).toContain('HTTP 502')
    m.unmount()
  })
})

describe('keepalive', () => {
  it('开始时循环播放，结束时暂停；重复开不会重复播', () => {
    const play = vi.fn(() => Promise.resolve())
    const pause = vi.fn()
    class FakeAudio { loop = false; preload = ''; currentTime = 0; src: string; constructor(src: string) { this.src = src } play = play; pause = pause; setAttribute() {} }
    vi.stubGlobal('Audio', FakeAudio)
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x' }))
    startKeepAlive()
    startKeepAlive()
    expect(play).toHaveBeenCalledTimes(1)
    expect(keepAliveActive()).toBe(true)
    stopKeepAlive()
    expect(pause).toHaveBeenCalledTimes(1)
    expect(keepAliveActive()).toBe(false)
  })

  it('播放被系统拒绝时不报错，状态回到未开启', async () => {
    // 模块里缓存了 Audio 对象，换一份全新的模块再测
    vi.resetModules()
    vi.stubGlobal('Audio', class { loop = false; preload = ''; currentTime = 0; play() { return Promise.reject(new Error('NotAllowed')) } pause() {} setAttribute() {} })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:y' }))
    const k = await import('../src/keepalive')
    expect(() => k.startKeepAlive()).not.toThrow()
    await Promise.resolve(); await Promise.resolve()
    expect(k.keepAliveActive()).toBe(false)
  })
})
