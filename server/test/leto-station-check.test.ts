// 站点自检：换站后验"当前站转不转工具"。假上游覆盖三种结果。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { probeStation } from '../src/leto/station-check.ts'
import { listen, close } from './helpers.ts'

function fake(handler: (body: any) => { status: number; json: any }) {
  return createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const { status, json } = handler(body)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(json))
    })
  })
}

describe('probeStation', () => {
  it('转工具 → ok', async () => {
    const svc = fake(() => ({ status: 200, json: { choices: [{ message: { tool_calls: [{ id: 't', type: 'function', function: { name: 'get_time', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] } }))
    const port = await listen(svc)
    try {
      const r = await probeStation(`http://127.0.0.1:${port}/v1`, 'k', 'm')
      assert.equal(r.ok, true)
      assert.equal(r.toolsOk, true)
    } finally { await close(svc) }
  })

  it('模型在但不转工具 → 不 ok，说明原因', async () => {
    const svc = fake(() => ({ status: 200, json: { choices: [{ message: { content: '现在大概十点吧' }, finish_reason: 'stop' }] } }))
    const port = await listen(svc)
    try {
      const r = await probeStation(`http://127.0.0.1:${port}/v1`, 'k', 'm')
      assert.equal(r.modelOk, true)
      assert.equal(r.toolsOk, false)
      assert.equal(r.ok, false)
      assert.match(r.detail, /不转工具|没返工具/)
    } finally { await close(svc) }
  })

  it('站点报错（model_not_found）→ 连得上但模型不在', async () => {
    const svc = fake(() => ({ status: 503, json: { error: { code: 'model_not_found', message: 'No available channel' } } }))
    const port = await listen(svc)
    try {
      const r = await probeStation(`http://127.0.0.1:${port}/v1`, 'k', 'm')
      assert.equal(r.reachable, true)
      assert.equal(r.modelOk, false)
      assert.equal(r.ok, false)
      assert.match(r.detail, /HTTP 503|model_not_found|No available/)
    } finally { await close(svc) }
  })
})
