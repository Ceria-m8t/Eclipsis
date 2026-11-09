// 配置全部来自环境变量（systemd 从 server/.env 读进来），改完 restart 生效。
export interface Config {
  frontPort: number       // 前端出口：nginx /api/ → 这里 → Dylan
  tapPort: number         // 上游入口：xiaoke → 这里 → 中转站
  dylanUrl: string        // Dylan 网关地址，如 http://127.0.0.1:3457/v1
  upstreamUrl: string     // 中转站地址（换站改这个），如 https://example.com/v1
  upstreamKey: string     // 中转站密钥（换站改这个）
  tapKey: string          // xiaoke 调用上游入口时用的本地密钥（xiaoke 的 XIAOKE_UPSTREAM_KEY 填它）
  headerTimeoutMs: number // 等上游返回响应头的最长时间；开始流式输出后不再计时
  streamIdleMs: number    // 开始输出以后，连续多久一个字节都没有就断开（中转站卡住时别一直占着 xiaoke）
  retry429DelaysMs: number[] // 中转站回 429/502/503 时隔多久自动重试（逗号分隔的毫秒数，空 = 不重试）
  dbPath: string
  blobDir: string
  xiaokeUrl: string       // xiaoke 本体（聊天页删消息时同步删它的记录）
  xiaokeKey: string       // xiaoke 的 XIAOKE_API_KEY
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const v = Number(env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    frontPort: num(env, 'FRONT_PORT', 3480),
    tapPort: num(env, 'TAP_PORT', 3481),
    dylanUrl: (env.DYLAN_URL || 'http://127.0.0.1:3457/v1').trim(),
    upstreamUrl: (env.UPSTREAM_URL || '').trim(),
    upstreamKey: (env.UPSTREAM_KEY || '').trim(),
    tapKey: (env.TAP_KEY || '').trim(),
    headerTimeoutMs: num(env, 'HEADER_TIMEOUT_MS', 120_000),
    streamIdleMs: num(env, 'STREAM_IDLE_TIMEOUT_MS', 90_000),
    retry429DelaysMs: (env.RETRY_429_DELAYS_MS ?? '6000,12000').split(',').map(x => Number(x.trim())).filter(x => Number.isFinite(x) && x > 0),
    dbPath: (env.DB_PATH || '/var/lib/eclipsis/eclipsis.sqlite').trim(),
    blobDir: (env.BLOB_DIR || '/var/lib/eclipsis/blobs').trim(),
    xiaokeUrl: (env.XIAOKE_URL || 'http://127.0.0.1:3010').trim(),
    xiaokeKey: (env.XIAOKE_KEY || '').trim()
  }
}

// 把收到的 /v1/xxx 拼到目标地址上。目标写不写 /v1 结尾都行（和 xiaoke 的规则一致）。
export function joinV1(base: string, incomingPath: string): string {
  const b = base.replace(/\/+$/, '')
  const root = b.endsWith('/v1') ? b : `${b}/v1`
  const rest = incomingPath.replace(/^\/v1(?=\/|\?|$)/, '')
  if (rest === '' || rest.startsWith('/') || rest.startsWith('?')) return root + rest
  return `${root}/${rest}`
}
