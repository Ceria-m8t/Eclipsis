// 站点自检：换站后随时跑，验"当前配置里这个 Agent 的站"能不能用 + 转不转工具。
// 用法：node server/src/leto/station-check.ts <agentId>
//   读 /etc/eclipsis/leto-agents.json（或 LETO_AGENTS_FILE）里该 Agent 的 upstream，
//   发一个最小工具调用探针，报告：连得上 / 模型在 / 转不转工具。
// 不碰 Leto、不发消息、不写库，纯探活。
import { loadAgents } from './agent.ts'
import { loadConfig } from '../config.ts'

interface ProbeResult {
  ok: boolean
  reachable: boolean
  modelOk: boolean
  toolsOk: boolean
  detail: string
}

export async function probeStation(url: string, key: string, model: string): Promise<ProbeResult> {
  const r: ProbeResult = { ok: false, reachable: false, modelOk: false, toolsOk: false, detail: '' }
  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, max_tokens: 150, stream: false,
        messages: [{ role: 'user', content: '现在北京几点？用 get_time 工具查，别自己编。' }],
        tools: [{ type: 'function', function: { name: 'get_time', description: '取当前时间', parameters: { type: 'object', properties: { tz: { type: 'string' } } } } }],
        tool_choice: 'auto'
      }),
      signal: AbortSignal.timeout(90_000)
    })
    r.reachable = true
    const text = await res.text()
    if (!res.ok) {
      r.detail = `HTTP ${res.status}: ${text.slice(0, 200)}`
      return r
    }
    let data: any
    try { data = JSON.parse(text) } catch { r.detail = `返回不是 JSON: ${text.slice(0, 200)}`; return r }
    if (data?.error) { r.detail = `站点报错: ${data.error.message || JSON.stringify(data.error).slice(0, 200)}`; return r }
    r.modelOk = true
    const msg = data?.choices?.[0]?.message
    const calls = msg?.tool_calls
    if (Array.isArray(calls) && calls.length > 0 && calls[0]?.function?.name) {
      r.toolsOk = true
      r.ok = true
      r.detail = `转工具 ✅ 调了 ${calls[0].function.name}`
    } else {
      r.detail = `模型在、但没返工具调用（finish=${data?.choices?.[0]?.finish_reason}）。这个站可能不转工具，Leto 用不了。`
    }
    return r
  } catch (e: any) {
    r.detail = e?.name === 'TimeoutError' ? '超时（90s）——站点太慢或不稳' : `连不上: ${String(e?.message || e)}`
    return r
  }
}

async function main() {
  const agentId = process.argv[2]
  if (!agentId) { console.error('用法: node station-check.ts <agentId>  (如 hajimi / ds / xiaoke)'); process.exit(2) }

  const cfg = loadConfig()
  const agent = loadAgents().find(a => a.id === agentId)
  if (!agent) {
    console.error(`配置里没有启用的 Agent "${agentId}"。检查 /etc/eclipsis/leto-agents.json 里它的 enabled 和 token。`)
    process.exit(2)
  }
  const url = agent.upstream?.url || cfg.upstreamUrl
  const key = agent.upstream?.key || cfg.upstreamKey
  const model = agent.upstream?.model || '(未配，会跟随最近 exchange)'
  if (!url || !key) { console.error(`${agent.name} 没配站点（upstream.url/key 空，且无 backend 默认）`); process.exit(2) }
  if (!agent.upstream?.model) { console.error(`${agent.name} 没配 model，自检需要明确 model`); process.exit(2) }

  console.log(`自检 ${agent.name} (${agentId})：站点 ${url}  模型 ${model}`)
  const res = await probeStation(url, key, agent.upstream.model)
  console.log(`  连得上: ${res.reachable ? '是' : '否'}`)
  console.log(`  模型在: ${res.modelOk ? '是' : '否'}`)
  console.log(`  转工具: ${res.toolsOk ? '是' : '否'}`)
  console.log(`  结论: ${res.detail}`)
  console.log(res.ok ? '✅ 这个站可以给 Leto 用' : '❌ 还不能用，见上面原因')
  process.exit(res.ok ? 0 : 1)
}

if (process.argv[1] && process.argv[1].endsWith('station-check.ts')) {
  main().catch(e => { console.error(e); process.exit(1) })
}
