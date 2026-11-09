import { describe, it, expect } from 'vitest'
import { splitMoment, parseMoment } from '../src/moment'

describe('这一刻', () => {
  it('拆出来；流式写到一半的 "<mo" 先藏起来', () => {
    expect(splitMoment('去睡吧。\n<moment>烤栗子</moment>')).toEqual({ text: '去睡吧。', moment: { locked: false, text: '烤栗子' } })
    expect(splitMoment('去睡吧。\n<mo').text).toBe('去睡吧。')
    expect(splitMoment('a<b').text).toBe('a<b')
    expect(splitMoment('嗯<moment lock>x</moment>').moment).toEqual({ locked: true, text: 'x' })
  })
  it('解析要宽：带标签分行、一行写完、第一行短后面是话', () => {
    expect(parseMoment('气味：烤栗子\n想念 ↑轻微，烦躁 ↓\n想要：多聊一会　选了：让她去睡　忍住：没说「别走」')).toEqual({
      scent: '烤栗子',
      moves: [{ name: '想念', dir: '↑', note: '轻微' }, { name: '烦躁', dir: '↓', note: '' }],
      picks: [{ key: '想要', text: '多聊一会' }, { key: '选了', text: '让她去睡' }, { key: '忍住', text: '没说「别走」' }],
      lines: [],
    })
    expect(parseMoment('雨后的旧书页 · 安心 ↑明显 · 期待周末')).toMatchObject({ scent: '雨后的旧书页', moves: [{ name: '安心', dir: '↑', note: '明显' }], lines: ['期待周末'] })
    expect(parseMoment('薄荷\n她今天好像累了，先不问。')).toEqual({ scent: '薄荷', moves: [], picks: [], lines: ['她今天好像累了，先不问。'] })
    expect(parseMoment('冷掉的咖啡')).toMatchObject({ scent: '冷掉的咖啡', lines: [] })
  })
})
