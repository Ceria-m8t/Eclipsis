import { describe, it, expect } from 'vitest'
import { parsePixel, splitPixel } from '../src/pixel'

const art = (w: number, h: number) => JSON.stringify({ w, h, palette: ['#0000', '#C8909A'], grid: Array.from({ length: w * h }, (_, i) => i % 2) })

describe('像素小画（她这边）', () => {
  it('拆出来，正文里不留那段 JSON', () => {
    const r = splitPixel(`给你。\n\n[[PIXEL]]${art(2, 2)}[[/PIXEL]]\n\n小小的。`)
    expect(r.text).toBe('给你。\n\n小小的。')
    expect(r.arts).toHaveLength(1)
    expect(r.arts[0]).toEqual({ w: 2, h: 2, palette: ['#0000', '#C8909A'], grid: [0, 1, 0, 1] })
  })

  it('流式写到一半：半截 JSON 不显示', () => {
    const r = splitPixel('给你画\n[[PIXEL]]{"w":16,"h":16,"palette":["#0000"')
    expect(r.text).toBe('给你画')
    expect(r.arts).toHaveLength(0)
  })

  it('画坏了：显示一句话，不显示 JSON', () => {
    const r = splitPixel('[[PIXEL]]{"w":2,"h":2,"palette":["#0000"],"grid":[0,0,0]}[[/PIXEL]]')
    expect(r.text).toBe('〔像素小画没画成〕')
    expect(r.arts).toHaveLength(0)
  })

  it('没有像素块的回复原样返回', () => {
    expect(splitPixel('普通一句话')).toEqual({ text: '普通一句话', arts: [] })
  })

  it('parsePixel 挡掉不合规的', () => {
    expect(parsePixel('{"w":0,"h":1,"palette":["#0000"],"grid":[]}')).toBeNull()
    expect(parsePixel('{"w":65,"h":1,"palette":["#0000"],"grid":[0]}')).toBeNull()
    expect(parsePixel('{"w":1,"h":1,"palette":["#0000"],"grid":[3]}')).toBeNull()
    expect(parsePixel('坏的')).toBeNull()
  })
})
