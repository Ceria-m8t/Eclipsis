import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function listen(server: Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}
export function close(server: Server): Promise<void> {
  return new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) })
}

export interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }

// 假上游：记下收到的请求，用 handler 决定怎么回
export function fakeUpstream(handler: (req: Seen, res: ServerResponse) => void) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const s = { method: req.method || '', url: req.url || '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(s)
      handler(s, res)
    })
  })
  return { server, seen }
}

export const sseChunk = (d: any, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'eclipsis-test-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
