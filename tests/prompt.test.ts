// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { loadPrompt, savePrompt, loadHistory, composePrompt, isCustomized, defaultPrompt } from '../src/prompt-store'
import { buildSystemPrompt } from '../src/chat-engine'
import { SYSTEM_PROMPT } from '../src/system-prompt'

beforeEach(() => localStorage.clear())

describe('prompt-store', () => {
  it('没改过时用代码里的默认提示词，并带上功能说明', () => {
    expect(isCustomized()).toBe(false)
    const p = composePrompt()
    expect(p.startsWith(SYSTEM_PROMPT.trim())).toBe(true)
    expect(p).toContain('# 我们的家（Eclipsis）')
  })

  it('保存后生效，原版本进历史', () => {
    savePrompt({ main: '新人设', features: '新功能', featuresEnabled: true })
    expect(loadPrompt().main).toBe('新人设')
    expect(composePrompt()).toBe('新人设\n\n新功能')
    const h = loadHistory()
    expect(h).toHaveLength(1)
    expect(h[0].note).toBe('出厂默认')
    expect(h[0].main).toBe(SYSTEM_PROMPT.trim())
  })

  it('内容没变时不产生历史', () => {
    const d = defaultPrompt()
    savePrompt({ main: d.main, features: d.features, featuresEnabled: true })
    expect(loadHistory()).toHaveLength(0)
  })

  it('关掉功能说明后不发', () => {
    savePrompt({ main: 'A', features: 'B', featuresEnabled: false })
    expect(composePrompt()).toBe('A')
  })

  it('历史最多 15 份，最新的在前', () => {
    for (let i = 0; i < 20; i++) savePrompt({ main: 'v' + i, features: '', featuresEnabled: true })
    const h = loadHistory()
    expect(h).toHaveLength(15)
    expect(h[0].main).toBe('v18')
  })

  it('世界书条目仍然拼在前后', () => {
    savePrompt({ main: '主体', features: '', featuresEnabled: true })
    localStorage.setItem('worldbook', JSON.stringify([
      { content: '前面', enabled: true, group: 'g', position: 'before', priority: 50 },
      { content: '后面', enabled: true, group: 'g', position: 'after', priority: 50 }
    ]))
    expect(buildSystemPrompt()).toBe('前面\n\n主体\n\n后面')
  })
})
