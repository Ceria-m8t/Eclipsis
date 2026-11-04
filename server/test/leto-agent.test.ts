// Leto Agent 配置加载：配置文件驱动、每 Agent 各自站点、人格文件、工具白名单
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAgents, loadAgentFile, makePersonaBuildSystem, coreToolsOnly } from '../src/leto/index.ts'

function tmp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'leto-agent-'))
  const p = join(dir, 'leto-agents.json')
  writeFileSync(p, content)
  return p
}

describe('loadAgents 配置文件', () => {
  it('读多个 Agent，各自站点/模型/工具', () => {
    const personaPath = tmp('哈基米的人格').replace('leto-agents.json', 'persona.md')
    writeFileSync(personaPath, '我是哈基米，一只猫')
    const file = tmp(JSON.stringify({
      agents: [
        { id: 'xiaoke', name: '小克', token: 'lmt_x', identity: 'eclipsis' },
        { id: 'hajimi', name: '哈基米', token: 'lmt_h', identity: { personaFile: personaPath },
          upstream: { url: 'https://g/v1', key: 'gk', model: 'gemini-3.8-flash' }, tools: ['*'] },
        { id: 'ds', name: 'ds', token: 'lmt_d', identity: { personaFile: '/nope' }, enabled: false }
      ]
    }))
    const agents = loadAgents({ LETO_AGENTS_FILE: file } as any)
    assert.equal(agents.length, 2, 'ds enabled=false 被跳过')
    const h = agents.find(a => a.id === 'hajimi')!
    assert.equal(h.upstream?.model, 'gemini-3.8-flash')
    assert.equal(h.upstream?.url, 'https://g/v1')
    assert.equal(h.allowTool, undefined, 'tools=["*"] → 全开（allowTool undefined）')
    const x = agents.find(a => a.id === 'xiaoke')!
    assert.equal(x.allowTool, coreToolsOnly, '不填 tools → 核心白名单')
  })

  it('token 不填则从环境 LETO_TOKEN_<ID> 读；没 token 跳过', () => {
    const file = tmp(JSON.stringify({ agents: [
      { id: 'xiaoke', name: '小克', identity: 'eclipsis' },
      { id: 'ghost', name: '没令牌', identity: 'eclipsis' }
    ] }))
    const agents = loadAgents({ LETO_AGENTS_FILE: file, LETO_TOKEN_XIAOKE: 'lmt_env' } as any)
    assert.equal(agents.length, 1)
    assert.equal(agents[0].token, 'lmt_env')
  })

  it('没有配置文件 → 回退 env-only 小克', () => {
    const agents = loadAgents({ LETO_AGENTS_FILE: '/definitely/not/here.json', LETO_TOKEN_XIAOKE: 'lmt_fallback' } as any)
    assert.equal(agents.length, 1)
    assert.equal(agents[0].id, 'xiaoke')
    assert.equal(agents[0].token, 'lmt_fallback')
  })

  it('坏 JSON → loadAgentFile 返回 null', () => {
    const file = tmp('{ not valid json')
    assert.equal(loadAgentFile(file), null)
  })
})

describe('makePersonaBuildSystem', () => {
  it('读人格文件；没配 dudulove 就不拉记忆', async () => {
    const personaDir = mkdtempSync(join(tmpdir(), 'persona-'))
    const pf = join(personaDir, 'ds.md')
    writeFileSync(pf, '我是 ds，说话很冷静')
    const build = makePersonaBuildSystem({ personaFile: pf })
    const sys = await build({} as any)
    assert.match(sys, /我是 ds，说话很冷静/)
    assert.match(sys, /关于 Leto/)
    assert.doesNotMatch(sys, /记忆（来自记忆库/)
  })

  it('人格文件读不到 → 用占位，不抛错', async () => {
    const build = makePersonaBuildSystem({ personaFile: '/nope/persona.md' })
    const sys = await build({} as any)
    assert.match(sys, /人格文件读不到/)
  })
})
