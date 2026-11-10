// Eclipsis 后端（第一期：影子地基 + Wake + Pulse）
//   前端出口 FRONT_PORT：nginx /api/ → 这里 → Dylan。记下前端发了什么、场景、他回了什么，推出经历。
//   上游入口 TAP_PORT ：xiaoke → 这里 → 中转站。记下实际发给模型的完整内容。
// 两边都只记录、原样转发，不改回复。
// Wake 模块（WAKE_ENABLED=1）在同一进程里定时 tick，触发时自己调模型。
// Pulse 模块：身体状态引擎，每 30 秒 tick 一次，天气自动拉取，心潮桥接，聊天情绪检测。
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import { loadConfig, joinV1, type Config } from './config.ts'
import { openDb, type DB } from './db.ts'
import { BlobStore } from './blobs.ts'
import { Recorder } from './recorder.ts'
import { createTap, forwardHeaders, type Prepared } from './proxy.ts'
import { stripWakeHistory, stripThinkHistory, stripOldImages, reorderByTime, markMissingImages, type TimeLookup } from './transforms.ts'
import { handleApi } from './api.ts'
import { handleChatApi, xiaokeApi } from './chat-history.ts'
import { handleToolboxApi, setToolboxFile, setToolboxBlobs } from './toolbox.ts'
import { shadowCompare, replaceHistory } from './assembler/history.ts'
import { stripMomentHistory } from './moment.ts'
import { handleModelsApi } from './models.ts'
import { attachFiles, handleFileApi, ensureFileSchema } from './files.ts'
import { handleStationsApi } from './stations-api.ts'
import { handleDrawApi } from './draw-api.ts'
import { dropSupersededVersions } from './versions.ts'
import { handleLlmRelay } from './llm-relay.ts'
import { initStations, bindStationToConfig } from './station.ts'
import { ensureWakeSchema, WakeScheduler, dispatchWake, handleWakeApi } from './wake/index.ts'
import {
  ensurePulseSchema, handlePulseApi, doTick as pulseTick,
  setExternalWeather, setXinchaoEmotion,
  WeatherFetcher, refreshXinchaoBridge,
  pruneHrHistory, detectFromRecentChat
} from './pulse/index.ts'
import { assembleSceneBlock, injectSceneBlock, renderRecentGroupBlock } from './assembler/index.ts'
import { renderRecentWakeBlock } from './wake/chat-block.ts'
import { notifyXinchaoPresence, notifyXinchaoExchange } from './xinchao-client.ts'
import { ensurePromptSchema, handlePromptApi } from './prompts.ts'
import { handleLetoApi, handleLetoAdmin, loadAgents, type LetoApiDeps } from './leto/index.ts'

function bearer(req: IncomingMessage): string {
  const h = String(req.headers.authorization || '')
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export interface ServerOptions {
  linkRid?: boolean           // LINK_RID=1
  stripWakeHistory?: boolean  // STRIP_WAKE_HISTORY=1
  stripThinkHistory?: boolean // STRIP_THINK_HISTORY=1
  stripOldImages?: boolean     // STRIP_OLD_IMAGES=1
  reorderByTime?: boolean      // REORDER_BY_TIME（默认开，=0 关）
  assembler?: boolean          // ASSEMBLER_ENABLED=1
  /** 她每发一条新消息时调用（用来通知心潮"她来了"） */
  onEricaMessage?: (text: string) => void
  /** 一轮聊天说完时调用（把这一轮交给心潮判互动） */
  onTurnComplete?: (her: string, his: string) => void
  /** Leto 入站端点依赖（未启用则为 null，端点会返回 503） */
  letoApi?: LetoApiDeps | null
  log?: (m: string, e?: unknown) => void
}

export function buildServers(cfg: Config, db: DB, opts: ServerOptions = {}): { front: Server; tap: Server } {
  ensurePromptSchema(db)
  const blobs = new BlobStore(db, cfg.blobDir)
  ensureFileSchema(db)
  setToolboxBlobs(blobs)      // 他的画笔要用它存图
  const recorder = new Recorder(db, blobs, { onEricaMessage: opts.onEricaMessage, onTurnComplete: opts.onTurnComplete })

  // 发给中转站时的请求头（换掉调用方的 key，用站的 key）
  const stationHeaders = (req: IncomingMessage): Record<string, string> => {
    const h: Record<string, string> = {
      'content-type': String(req.headers['content-type'] || 'application/json'),
      accept: String(req.headers.accept || 'application/json')
    }
    if (cfg.upstreamKey) h.authorization = `Bearer ${cfg.upstreamKey}`
    if (req.headers['user-agent']) h['user-agent'] = String(req.headers['user-agent'])
    return h
  }

  // 前端出口：鉴权交给 Dylan（nginx 注入的网关 key 原样带过去）；本端口只监听 127.0.0.1
  const front = createTap({
    tap: 'front', name: 'front', recorder, headerTimeoutMs: cfg.headerTimeoutMs, log: opts.log,
    api: async (req, res) => {
      if (await handleLlmRelay({ upstreamUrl: cfg.upstreamUrl, upstreamKey: cfg.upstreamKey, relayKey: (process.env.LLM_RELAY_KEY || '').trim() }, db, req, res, m => opts.log?.(m))) return true
      if (await handleWakeApi(db, req, res)) return true
      if (await handlePulseApi(db, req, res)) return true
      if (await handlePromptApi(db, req, res)) return true
      if (await handleToolboxApi(db, req, res)) return true
      // 模型列表：后端问当前这个站（以前透传给 xiaoke，它没有这个接口，Kelivo 只能拿到 404）
      if (await handleModelsApi(req, res, { url: cfg.upstreamUrl, key: cfg.upstreamKey })) return true
      // 她发文件：上传、下载
      if (await handleFileApi(db, blobs, req, res)) return true
      // 中转站面板（聊天的站 + 画图的站）、她自己点生图
      if (await handleStationsApi(db, req, res)) return true
      if (await handleDrawApi(db, blobs, req, res)) return true
      if (await handleChatApi(db, {
        blobDir: cfg.blobDir, xiaoke: xiaokeApi(cfg.xiaokeUrl, cfg.xiaokeKey), xiaokeHasNewMessages: !cfg.bypassXiaoke
      }, req, res)) return true
      if (await handleLetoApi(opts.letoApi ?? null, db, req, res)) return true
      if (process.env.LETO_ADMIN_ENABLED === '1' && await handleLetoAdmin(req, res, db)) return true
      return handleApi(db, req, res)
    },
    authorize: () => true,
    // BYPASS_XIAOKE=1：不再经过 xiaoke，直接发给中转站（队列、重复记录、它垫的那段历史都没了）
    ...(cfg.bypassXiaoke ? { streamIdleMs: cfg.streamIdleMs, retry429DelaysMs: cfg.retry429DelaysMs } : {}),
    target: path => (cfg.bypassXiaoke
      ? (cfg.upstreamUrl ? joinV1(cfg.upstreamUrl, path) : null)
      : joinV1(cfg.dylanUrl, path)),
    outgoingHeaders: req => (cfg.bypassXiaoke ? stationHeaders(req) : forwardHeaders(req)),
    prepare: (json, raw): Prepared => {
      if (cfg.bypassXiaoke) return stationPrepare(json, raw)
      const rid = crypto.randomUUID()
      if (!opts.linkRid) return { rid, linked: false, body: raw }
      return { rid, linked: false, body: Buffer.from(JSON.stringify({ ...json, eclipsis_rid: rid })) }
    }
  })

  // 上游入口：只认 TAP_KEY；发给中转站时换成 UPSTREAM_KEY
  const tap = createTap({
    tap: 'upstream', name: 'tap', recorder, headerTimeoutMs: cfg.headerTimeoutMs, streamIdleMs: cfg.streamIdleMs, retry429DelaysMs: cfg.retry429DelaysMs, log: opts.log,
    authorize: req => !!cfg.tapKey && safeEqual(bearer(req), cfg.tapKey),
    target: path => (cfg.upstreamUrl ? joinV1(cfg.upstreamUrl, path) : null),
    outgoingHeaders: stationHeaders,
    prepare: stationPrepare
  })
  return { front, tap }

  // ── 发给中转站之前对请求做的全部加工（两个入口共用：经 xiaoke 时在上游入口跑，直连时在前端出口跑）──
  function stationPrepare(json: any, raw: Buffer): Prepared {
      const linkedRid = typeof json?.eclipsis_rid === 'string' && /^[\w-]{8,64}$/.test(json.eclipsis_rid) ? json.eclipsis_rid : null
      const rid = linkedRid || crypto.randomUUID()
      let out = json
      let changed = 'eclipsis_rid' in json
      const transforms: Record<string, unknown> = {}
      if (changed) { const { eclipsis_rid: _drop, ...rest } = json; out = rest }
      // 影子：后端自己接前文的话会给哪些，和 xiaoke 拼的这份比一比（只记录，不改请求）。SHADOW_CONTEXT=0 关
      if (process.env.SHADOW_CONTEXT !== '0' && Array.isArray(out.messages) && out.messages.length > 2) {
        try { transforms.shadow_context = shadowCompare(db, out.messages); changed = true } catch { /* 影子出错不影响请求 */ }
      }
      // 替换 xiaoke：历史改成我们自己从经历表拼的那份（OUR_HISTORY=1 打开）。
      // 换完顺序本来就是对的，下面的「按时间排」没得排；system 和这一轮还是请求里原来那份。
      let ourHistory = false
      if (process.env.OUR_HISTORY === '1' && Array.isArray(out.messages)) {
        try {
          const r = replaceHistory(out.messages, db, Date.now(), { insertWhenEmpty: cfg.bypassXiaoke })
          if (r) {
            out = { ...out, messages: r.messages }
            transforms.our_history = r.info
            changed = true
            ourHistory = true
          }
        } catch (e) { opts.log?.(`[tap] 换历史失败，按原样发：${String(e)}`) }
      }
      // 先按时间排（要用原文去经历表里对时间，所以在剪思考、剪图之前）
      if (opts.reorderByTime && !ourHistory && Array.isArray(out.messages)) {
        try {
          const r = reorderByTime(out.messages, episodeTimeLookup(db))
          if (r.moved) {
            out = { ...out, messages: r.messages }
            transforms.reorder_by_time = { moved: r.moved }
            changed = true
          }
        } catch { /* 排不了就原样发 */ }
      }
      if (opts.stripWakeHistory && Array.isArray(out.messages)) {
        const r = stripWakeHistory(out.messages)
        if (r.stripped) {
          out = { ...out, messages: r.messages }
          transforms.strip_wake_history = { stripped: r.stripped, saved_chars: r.savedChars }
          changed = true
        }
      }
      // 她重新生成过的那几轮：历史里（xiaoke 补的）还留着被她丢掉的那版，只给算数那条（DROP_OLD_VERSIONS=0 关）
      if (process.env.DROP_OLD_VERSIONS !== '0' && Array.isArray(out.messages)) {
        try {
          const r = dropSupersededVersions(out.messages, db)
          if (r.dropped) { out = { ...out, messages: r.messages }; transforms.drop_old_versions = { dropped: r.dropped }; changed = true }
        } catch { /* 剪不了就原样发 */ }
      }
      // 他以前写的「这一刻」不再发回给他（MOMENT_HISTORY=0 关）
      if (process.env.MOMENT_HISTORY !== '0' && Array.isArray(out.messages)) {
        const r = stripMomentHistory(out.messages)
        if (r.stripped) { out = { ...out, messages: r.messages }; transforms.strip_moment_history = { stripped: r.stripped }; changed = true }
      }
      if (opts.stripThinkHistory && Array.isArray(out.messages)) {
        const r = stripThinkHistory(out.messages)
        if (r.stripped) {
          out = { ...out, messages: r.messages }
          transforms.strip_think_history = { stripped: r.stripped, saved_chars: r.savedChars }
          changed = true
        }
      }
      if (opts.stripOldImages && Array.isArray(out.messages)) {
        const r = stripOldImages(out.messages)
        if (r.stripped) {
          out = { ...out, messages: r.messages }
          transforms.strip_old_images = { stripped: r.stripped, saved_chars: r.savedChars }
          changed = true
        }
      }
      // 她发的文件：最近两条带文件的消息给正文，更早的只留文件名（和图片一样，不然每轮重发整份文档）
      if (Array.isArray(out.messages)) {
        try {
          const r = attachFiles(out.messages, db)
          if (r.attached || r.trimmed) {
            out = { ...out, messages: r.messages }
            transforms.files = { attached: r.attached, trimmed: r.trimmed }
            changed = true
          }
        } catch { /* 读不出就按原样发（标记会原样过去，他看得懂是个文件） */ }
      }
      // 看不到的图写清楚是看不到（MARK_MISSING_IMAGES=0 关）
      if (process.env.MARK_MISSING_IMAGES !== '0' && Array.isArray(out.messages)) {
        const r = markMissingImages(out.messages)
        if (r.marked) { out = { ...out, messages: r.messages }; transforms.mark_missing_images = { marked: r.marked }; changed = true }
      }
      // 组装器 v1：注入现场状态（时间+脉+天气）到 system message 末尾
      if (opts.assembler && Array.isArray(out.messages)) {
        try {
          const scene = assembleSceneBlock(db)
          const groupBlock = process.env.CHAT_GROUP_BLOCK === '1' ? renderRecentGroupBlock(db) : ''
          // 他醒来时发的消息和念头（默认开，CHAT_WAKE_BLOCK=0 关）
          let wakeBlock = ''
          if (process.env.CHAT_WAKE_BLOCK !== '0') {
            try { wakeBlock = renderRecentWakeBlock(db, { hours: Number(process.env.CHAT_WAKE_BLOCK_HOURS) || 24, skipSentMessages: ourHistory }) } catch { /* 不影响请求 */ }
          }
          const injected = injectSceneBlock(out.messages, scene.sceneBlock + (groupBlock ? '\n' + groupBlock : '') + (wakeBlock ? '\n\n' + wakeBlock : ''))
          if (groupBlock) transforms.group_block = { chars: groupBlock.length }
          if (wakeBlock) transforms.wake_block = { chars: wakeBlock.length }
          if (injected.injected) {
            out = { ...out, messages: injected.messages }
            transforms.assembler_v1 = scene.meta
            changed = true
          }
        } catch { /* assembler error should not block request */ }
      }
    // 这一份就是真正发给站的那份（他醒来时接聊天要找的是它）
    transforms.to_station = true
    if (!changed) return { rid, linked: false, body: raw, transforms }
    return {
      rid, linked: !!linkedRid, body: Buffer.from(JSON.stringify(out)), json: out, transforms
    }
  }
}

/** 经历表里最近 30 天的日常聊天：同一句话（角色 + 正文）记下的时间。每次请求现查（几千条，毫秒级） */
export function episodeTimeLookup(db: DB): TimeLookup {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const rows = db.prepare(`SELECT ts, actor, content FROM episodes WHERE channel = 'chat' AND scope = 'daily' AND kind = 'message'
    AND actor IN ('erica', 'ai') AND ts >= ?`).all(since) as { ts: string; actor: string; content: string }[]
  const map = new Map<string, number[]>()
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
  for (const r of rows) {
    const key = (r.actor === 'erica' ? 'user' : 'assistant') + '|' + norm(r.content)
    const list = map.get(key) || []
    list.push(Date.parse(r.ts))
    map.set(key, list)
  }
  return (role, text) => map.get(role + '|' + norm(text)) || []
}

function main() {
  if (process.env.TOOLBOX_FILE) setToolboxFile(process.env.TOOLBOX_FILE.trim())
  const cfg = loadConfig()
  // 换站：stations.json 里正在用的站优先，没有就用 backend.env；之后 cfg.upstreamUrl/Key 每次读都是现在的站
  const st = initStations()
  bindStationToConfig(cfg)
  console.log(`[eclipsis] 中转站：${st.name}（${st.url || '未配置'}）${st.defaultModel ? `，默认模型 ${st.defaultModel}` : ''}`)
  if (!cfg.tapKey) console.warn('[eclipsis] TAP_KEY 未设置：上游入口会拒绝所有请求')
  if (!cfg.upstreamUrl) console.warn('[eclipsis] UPSTREAM_URL 未设置：上游入口返回 503')
  const db = openDb(cfg.dbPath)

  // ── Leto 入站（默认关，LETO_ENABLED=1 才建）──
  let letoApi: LetoApiDeps | null = null
  if (process.env.LETO_ENABLED === '1') {
    const ingestKey = (process.env.LETO_INGEST_KEY || '').trim()
    const letoBaseUrl = (process.env.LETO_BASE_URL || 'https://leto.sarl').trim()
    const agents = loadAgents()
    if (!ingestKey) console.warn('[eclipsis] LETO_ENABLED=1 但缺 LETO_INGEST_KEY，Leto 入站会拒绝所有请求')
    else if (!cfg.upstreamUrl || !cfg.upstreamKey) console.warn('[eclipsis] LETO_ENABLED=1 但缺 UPSTREAM_URL/KEY，Leto 不启用')
    else if (agents.length === 0) console.warn('[eclipsis] LETO_ENABLED=1 但没有配置任何 Agent 令牌（LETO_TOKEN_XIAOKE 等），Leto 不启用')
    else {
      letoApi = {
        agents,
        ingestKey,
        dispatchConfig: {
          letoBaseUrl,
          // 换站后立刻跟着走（不是启动时抄一份）
          get upstreamUrl() { return cfg.upstreamUrl },
          get upstreamKey() { return cfg.upstreamKey },
          fallbackModel: (process.env.LETO_MODEL || '').trim() || undefined,
          maxTokens: Number(process.env.LETO_MAX_TOKENS) || 2000,
          maxToolCalls: Number(process.env.LETO_MAX_TOOL_CALLS) || 12,
          maxModelTurns: Number(process.env.LETO_MAX_MODEL_TURNS) || 8,
          mirrorMaxMembers: Number(process.env.LETO_MIRROR_MAX_MEMBERS) || 20,
          ourLetoNames: agents.map(a => a.letoName).filter((n): n is string => !!n),
          log: (m: string) => console.log(m)
        },
        log: (m: string) => console.log(m)
      }
      console.log(`[eclipsis] Leto 入站启用  agents=[${agents.map(a => a.id).join(', ')}]  leto=${letoBaseUrl}`)
    }
  }

  const { front, tap } = buildServers(cfg, db, {
    letoApi,
    linkRid: process.env.LINK_RID === '1',
    stripWakeHistory: process.env.STRIP_WAKE_HISTORY === '1',
    stripThinkHistory: process.env.STRIP_THINK_HISTORY === '1',
    stripOldImages: process.env.STRIP_OLD_IMAGES === '1',
    reorderByTime: process.env.REORDER_BY_TIME !== '0',
    assembler: process.env.ASSEMBLER_ENABLED === '1',
    onTurnComplete: (() => {
      const url = (process.env.XINCHAO_URL || '').trim()
      if (!url || process.env.XINCHAO_EXCHANGE === '0') return undefined
      return (her: string, his: string) => { void notifyXinchaoExchange(url, her, his) }
    })(),
    onEricaMessage: (() => {
      const url = (process.env.XINCHAO_URL || '').trim()
      // 通知完立刻刷新心潮缓存，下一轮的「此刻」就是醒着的状态（不用等 2 分钟定时刷新）
      return url ? (text: string) => {
        void notifyXinchaoPresence(url, text).then(async sent => {
          if (!sent) return
          const r = await refreshXinchaoBridge(url)
          if (r?.inferredEmotion) setXinchaoEmotion(r.inferredEmotion)
        }).catch(() => {})
      } : undefined
    })()
  })
  front.listen(cfg.frontPort, '127.0.0.1', () => console.log(
    `[eclipsis] front  127.0.0.1:${cfg.frontPort} → ${cfg.bypassXiaoke ? `${cfg.upstreamUrl}（直连中转站，不过 xiaoke）` : cfg.dylanUrl}`))
  tap.listen(cfg.tapPort, '127.0.0.1', () => console.log(`[eclipsis] tap    127.0.0.1:${cfg.tapPort} → ${cfg.upstreamUrl || '(未配置)'}` +
    `  LINK_RID=${process.env.LINK_RID === '1' ? 1 : 0} STRIP_WAKE_HISTORY=${process.env.STRIP_WAKE_HISTORY === '1' ? 1 : 0}` +
    ` STRIP_THINK_HISTORY=${process.env.STRIP_THINK_HISTORY === '1' ? 1 : 0}` +
    ` STRIP_OLD_IMAGES=${process.env.STRIP_OLD_IMAGES === '1' ? 1 : 0}` +
    ` REORDER_BY_TIME=${process.env.REORDER_BY_TIME === '0' ? 0 : 1}`))

  // ── Pulse 模块（总是初始化，不需要开关） ──
  ensurePulseSchema(db)
  const pulseTickMs = Number(process.env.PULSE_TICK_MS) || 30_000  // 默认 30 秒
  const xinchaoUrl = (process.env.XINCHAO_URL || '').trim() || undefined
  const log = (msg: string) => console.log(msg)

  // 天气自动拉取
  const weatherFetcher = new WeatherFetcher({
    intervalMs: Number(process.env.WEATHER_INTERVAL_MS) || 600_000,  // 默认 10 分钟
    log
  })
  weatherFetcher.start()

  // 心潮桥（复用 Wake 的 xinchao URL）
  let xinchaoBridgeTimer: ReturnType<typeof setInterval> | null = null
  if (xinchaoUrl) {
    const bridgeRefreshMs = Number(process.env.XINCHAO_BRIDGE_REFRESH_MS) || 120_000  // 默认 2 分钟
    const refreshBridge = async () => {
      const result = await refreshXinchaoBridge(xinchaoUrl)
      if (result?.inferredEmotion) {
        setXinchaoEmotion(result.inferredEmotion)
      }
    }
    refreshBridge()
    xinchaoBridgeTimer = setInterval(refreshBridge, bridgeRefreshMs)
    if (typeof xinchaoBridgeTimer === 'object' && 'unref' in xinchaoBridgeTimer) xinchaoBridgeTimer.unref()
    log(`[pulse:xinchao] 桥启动 每 ${bridgeRefreshMs / 1000}s 刷新 → ${xinchaoUrl}`)
  }

  // Pulse 定时 tick（含聊天情绪检测）
  const pulseTimer = setInterval(() => {
    try {
      // 注入最新天气
      const w = weatherFetcher.latest
      if (w) setExternalWeather(w)
      // 聊天情绪检测：有新的 Erica 消息时，从文本推断情绪
      const chatEmo = detectFromRecentChat(db)
      if (chatEmo) {
        log(`[pulse:emotion] 检测到 ${chatEmo.emotion} ← ${chatEmo.source}: "${chatEmo.trigger}"`)
      }
      // tick（聊天检测到的情绪优先级最高，因为是她直接说的话引起的）
      pulseTick(db, chatEmo ? { emotion: chatEmo.emotion } : undefined)
    } catch (e) {
      console.error('[pulse] tick error', e)
    }
  }, pulseTickMs)
  if (typeof pulseTimer === 'object' && 'unref' in pulseTimer) pulseTimer.unref()

  // 每小时清理旧心率历史
  const hrPruneTimer = setInterval(() => { try { pruneHrHistory(db) } catch {} }, 3600_000)
  if (typeof hrPruneTimer === 'object' && 'unref' in hrPruneTimer) hrPruneTimer.unref()

  log(`[pulse] 启动 tick=${pulseTickMs}ms weather=${weatherFetcher.latest ? '已拉取' : '等待'} xinchao=${xinchaoUrl || '(无)'}`)

  // ── Wake 模块 ──
  let wakeScheduler: WakeScheduler | null = null
  if (process.env.WAKE_ENABLED === '1') {
    const wakeModel = (process.env.WAKE_MODEL || "").trim() || undefined
    if (!cfg.upstreamUrl || !cfg.upstreamKey) {
      console.warn("[eclipsis] WAKE_ENABLED=1 但缺少 UPSTREAM_URL / UPSTREAM_KEY，Wake 不启动")
    } else {
      ensureWakeSchema(db)
      const barkUrl = (process.env.WAKE_BARK_URL || '').trim() || undefined
      const tickMs = Number(process.env.WAKE_TICK_MS) || 60_000

      wakeScheduler = new WakeScheduler(db, {
        tickIntervalMs: tickMs,
        maxPerDay: Number(process.env.WAKE_MAX_PER_DAY) || 30,
        maxGapMinMinutes: Number(process.env.WAKE_MAX_GAP_MIN_MINUTES) || 150,
        maxGapMaxMinutes: Number(process.env.WAKE_MAX_GAP_MAX_MINUTES) || 180,
        xinchaoUrl,
        xinchaoRefreshMs: Number(process.env.WAKE_XINCHAO_REFRESH_MS) || 300_000,
        log,
        onWake: (opp, db) => dispatchWake(opp, db, {
          upstreamUrl: cfg.upstreamUrl,
          upstreamKey: cfg.upstreamKey,
          model: wakeModel,
          barkUrl,
          maxTokens: Number(process.env.WAKE_MAX_TOKENS) || 2000,
          log
        })
      })
      wakeScheduler.start()
      console.log(`[eclipsis] Wake 启动  tick=${tickMs}ms  model=${wakeModel || '(自动跟随聊天)'}  xinchao=${xinchaoUrl || '(无)'}  bark=${barkUrl ? '是' : '否'}`)
    }
  }

  const stop = () => {
    if (wakeScheduler) wakeScheduler.stop()
    weatherFetcher.stop()
    if (xinchaoBridgeTimer) clearInterval(xinchaoBridgeTimer)
    clearInterval(pulseTimer)
    clearInterval(hrPruneTimer)
    front.close(); tap.close()
    setTimeout(() => { db.close(); process.exit(0) }, 3000).unref()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (import.meta.main) main()
