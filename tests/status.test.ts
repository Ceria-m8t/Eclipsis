// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { localToolDefinitions, isLocalTool, runLocalTool } from '../src/local-tools'
import { aiStatus, setStatus } from '../src/status'
import { loadPrompt, savePrompt, loadHistory, upgradeFeatures, defaultPrompt, STATUS_SECTION } from '../src/prompt-store'

beforeEach(() => { localStorage.clear(); setStatus(null) })

describe('eclipsis_set_status', () => {
  it('作为 function 工具暴露给模型', () => {
    const defs = localToolDefinitions()
    expect(defs[0].type).toBe('function')
    expect(defs[0].function.name).toBe('eclipsis_set_status')
    expect(isLocalTool('eclipsis_set_status')).toBe(true)
    expect(isLocalTool('search')).toBe(false)
  })

  it('设置状态并存到本机', () => {
    const r = runLocalTool({ id: 'c1', name: 'eclipsis_set_status', arguments: '{"emoji":"☕","text":"在厨房泡茶"}' })
    expect(r.is_error).toBeFalsy()
    expect(aiStatus.value?.text).toBe('在厨房泡茶')
    expect(JSON.parse(localStorage.getItem('eclipsis-ai-status')!).emoji).toBe('☕')
  })

  it('clear 清空；空文字和坏 JSON 报错', () => {
    runLocalTool({ id: 'c1', name: 'eclipsis_set_status', arguments: '{"text":"在"}' })
    runLocalTool({ id: 'c2', name: 'eclipsis_set_status', arguments: '{"clear":true}' })
    expect(aiStatus.value).toBeNull()
    expect(runLocalTool({ id: 'c3', name: 'eclipsis_set_status', arguments: '{"text":"  "}' }).is_error).toBe(true)
    expect(runLocalTool({ id: 'c4', name: 'eclipsis_set_status', arguments: '{bad' }).is_error).toBe(true)
  })
})

describe('提示词补上状态说明', () => {
  it('出厂默认已包含', () => {
    expect(defaultPrompt().features).toContain('eclipsis_set_status')
  })

  it('改过的提示词：插在"还没有的"前面，旧版进历史，只补一次', () => {
    const d = defaultPrompt()
    const old = d.features.replace(STATUS_SECTION + '\n\n', '')
    savePrompt({ main: '我的人设', features: old, featuresEnabled: true })
    upgradeFeatures()
    const p = loadPrompt()
    expect(p.main).toBe('我的人设')
    expect(p.features.indexOf('eclipsis_set_status')).toBeLessThan(p.features.indexOf('## 还没有的'))
    expect(loadHistory()[0]!.features).toBe(old)
    upgradeFeatures()
    expect(p.features.split('eclipsis_set_status').length).toBe(loadPrompt().features.split('eclipsis_set_status').length)
  })
})
