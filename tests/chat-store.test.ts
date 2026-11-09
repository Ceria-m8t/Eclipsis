// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { fromServer, mergeServer, contextTail, splitHeart, looksNoReply, READ_SIGNAL, heartMarker, type SrvItem } from '../src/chat-store'
import { buildContext } from '../src/chat-engine'
import type { ChatMessage } from '../src/db'

const u = (seq: number, content: string, extra: Partial<SrvItem> = {}): SrvItem =>
  ({ id: 'e' + seq, seq, seqs: [seq], role: 'user', ts: new Date(Date.UTC(2026, 10, 10, 0, 0, seq)).toISOString(), turn: 'e' + seq, content, raw: '（2026-11-10 08:00）' + content, source: 'kelivo', ...extra })
const a = (seq: number, content: string, turn = 'e' + seq, versions?: string[]): SrvItem => ({
  id: 'e' + seq, seq, seqs: [seq], role: 'assistant', ts: new Date(Date.UTC(2026, 10, 10, 0, 0, seq)).toISOString(), turn, content, source: 'kelivo',
  versions: (versions || [content]).map((c, i) => ({ seq: seq + i, seqs: [seq + i], ts: '2026-11-10T00:00:00Z', content: c, thinking: '', tools: [] })),
})
const local = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: 'L' + content, seq: Date.now(), role: 'user', createdAt: Date.now(), content, ...extra })

describe('聊天记录在后端', () => {
  it('fromServer：他的回复多个版本，默认显示最新那个', () => {
    const m = fromServer(a(5, '二', 'T', ['一', '二']))
    expect(m.versions!.map(v => v.content)).toEqual(['一', '二'])
    expect(m.activeVersion).toBe(1)
    expect(m.srv!.turn).toBe('T')
  })

  it('mergeServer：新来的接在后面；本地还没发的排在最后', () => {
    const pending = local('还没发')
    const list = mergeServer([pending], [fromServer(u(1, '在吗')), fromServer(a(2, '在呢'))])
    expect(list.map(m => m.content)).toEqual(['在吗', '在呢', '还没发'])
  })

  it('mergeServer：重新生成出来的新版本接到原来那条后面，本地生成中的版本去掉', () => {
    const old = fromServer(a(2, '笑话一'))
    old.versions!.push({ content: '本地生成中', createdAt: 0 })
    const list = mergeServer([fromServer(u(1, '讲个笑话')), old], [fromServer(a(9, '笑话二', 'e2'))])
    expect(list.length).toBe(2)
    expect(list[1]!.versions!.map(v => v.content)).toEqual(['笑话一', '笑话二'])
    expect(list[1]!.activeVersion).toBe(1)
    expect(list[1]!.srv!.seqs).toEqual([2, 9])
  })

  it('contextTail：只发最后一条他的回复之后她说的那几句', () => {
    const list = [fromServer(u(1, '早')), fromServer(a(2, '早呀')), fromServer(u(3, '吃了吗')), local('在干嘛')]
    expect(contextTail(list).map(m => m.content)).toEqual(['吃了吗', '在干嘛'])
    // 重新生成一条前面紧挨着也是他的回复：往回找最近一句她的话
    expect(contextTail([fromServer(u(1, '早')), fromServer(a(2, '早呀'))]).map(m => m.content)).toEqual(['早'])
  })

  it('有图时去掉正文里的「[图片]」占位；没图（早先导入的）照样显示', () => {
    expect(fromServer(u(1, '大成功！\n\n[图片]', { images: ['/api/eclipsis/blob/' + 'a'.repeat(64)] })).content).toBe('大成功！')
    expect(fromServer(u(2, '[图片]', { images: ['/api/eclipsis/blob/' + 'a'.repeat(64)] })).content).toBe('')
    expect(fromServer(u(3, '')).content).toBe('[图片]')
    expect(fromServer(u(4, '（图片）', { images: ['/api/eclipsis/blob/' + 'a'.repeat(64)] })).content).toBe('', 'Eclipsis 自己发图时的占位')
  })

  it('发给他时用她的原文（带时间标记），后端来的图片地址不发', () => {
    const m = fromServer(u(1, '看图', { images: ['/api/eclipsis/blob/' + 'a'.repeat(64)] }))
    const ctx = buildContext([m, local('新的', { images: ['data:image/png;base64,AAA'] })], 100000)
    expect(ctx.messages[1]).toEqual({ role: 'user', content: '（2026-11-10 08:00）看图' })
    expect(ctx.messages[2].content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } })
  })

  it('心声：拆出来单独显示；只有心声时正文空；发给他时拼在末尾', () => {
    expect(splitHeart('哼\n\n' + heartMarker('快来哄我'))).toEqual({ text: '哼', thought: '快来哄我' })
    const m = fromServer(u(1, heartMarker('想他')))
    expect(m.content).toBe('')
    expect(m.thought).toBe('想他')
    const ctx = buildContext([local('嗯', { thought: '其实很想他' })], 100000)
    expect(ctx.messages[1].content).toMatch(/嗯\n\n〔她心里想的，没说出口：其实很想他〕$/)
  })

  it('已读不回：她的信号认成 signal；他的 [NO_REPLY] 流式时一出 "[NO" 就先藏起来', () => {
    expect(fromServer(u(1, READ_SIGNAL)).signal).toBe('read')
    expect(looksNoReply('[NO_REPLY]')).toBe(true)
    expect(looksNoReply('[NO')).toBe(true)
    expect(looksNoReply('[图片]')).toBe(false)
    expect(looksNoReply('好')).toBe(false)
  })

  it('醒来：消息和后到的念头拼回一项', () => {
    const w = (seq: number, content: string, wake: any): SrvItem => ({ ...a(seq, content, 'wake:W'), source: 'wake', wake })
    const list = mergeServer([fromServer(w(5, '花园浇了', { id: 'W', silent: false }))], [fromServer(w(6, '', { id: 'W', trace: '等她醒', silent: true }))])
    expect(list.length).toBe(1)
    expect(list[0]!.wake).toMatchObject({ id: 'W', trace: '等她醒', silent: false })
    expect(list[0]!.content).toBe('花园浇了')
  })

  it('后端来的图重新发时：用取回的 dataURL，原文里的「[图片]」占位去掉', () => {
    const m = fromServer(u(9, '', { images: ['/api/eclipsis/blob/' + 'b'.repeat(64)], raw: '[图片]\n（2026-11-10 07:08）（图片）' }))
    m.imageData = ['data:image/jpeg;base64,QQ==']
    const ctx = buildContext([m], 100000)
    expect(ctx.messages[1].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QQ==' } },
      { type: 'text', text: '（2026-11-10 07:08）（图片）' },
    ])
  })
})
