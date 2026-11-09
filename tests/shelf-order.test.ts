// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { shelfOrder, applyShelfOrder, lastPriority, type WorldbookEntry } from '../src/views/rooms/shelf/books'
import { buildSystemPrompt } from '../src/chat-engine'

const e = (title: string, position: 'before' | 'after', priority: number): WorldbookEntry =>
  ({ title, content: title, enabled: true, group: '默认', position, priority, id: title })

describe('书架顺序 = 拼接顺序', () => {
  it('shelfOrder：前面那组按优先级、主 Prompt、后面那组按优先级；一样的按数组先后', () => {
    const list = [e('A', 'after', 50), e('B', 'before', 10), e('C', 'after', 80), e('D', 'before', 90), e('E', 'after', 50)]
    expect(shelfOrder(list).map(i => (i < 0 ? '主' : list[i]!.title))).toEqual(['D', 'B', '主', 'C', 'A', 'E'])
  })

  it('applyShelfOrder：拖完的顺序写回去，拼出来的提示词顺序和书架一样', () => {
    const list = [e('A', 'after', 50), e('B', 'after', 50), e('C', 'after', 50)]
    // 书架上拖成：C | 主 | B A
    const order = [2, -1, 1, 0]
    const out = applyShelfOrder(list, order)
    expect(shelfOrder(out).map(i => (i < 0 ? '主' : out[i]!.title))).toEqual(['C', '主', 'B', 'A'])
    expect(out.find(x => x.title === 'C')!.position).toBe('before')
    localStorage.setItem('worldbook', JSON.stringify(out))
    const sys = buildSystemPrompt()
    const pos = (s: string) => sys.indexOf(s)
    expect(pos('C')).toBeLessThan(pos('B'))
    expect(pos('B')).toBeLessThan(pos('A'))
  })

  it('新添的一本排在最后', () => {
    const list = [e('A', 'after', 100), e('B', 'after', 0)]
    const added = [...list, e('N', 'after', lastPriority(list))]
    expect(shelfOrder(added).map(i => (i < 0 ? '主' : added[i]!.title))).toEqual(['主', 'A', 'B', 'N'])
  })
})
