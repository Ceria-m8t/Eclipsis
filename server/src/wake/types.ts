// Wake 模块类型定义
// 参考：Kli Wake Veil λ/H/Θ 模型 + Wake 2.0 Control Layer + Wake Trace 实践

// ── 来源 ──

/** 连续影响来源的标识符 */
export type SourceId =
  | 'silence'          // 沉默时长：最基本的"够久了"信号
  | 'user_state'       // 用户状态推断：现在适不适合打扰
  | 'threads'          // 生活线头：他自己留下的"想回去"锚点
  | 'xinchao'          // 心潮驱力：心理倾向（渴望、好奇、分享欲……）
  | 'emotion'          // emotion-system：思念时钟、观察到的情绪（以后）
  | 'body'             // 身体状态：脉扩展做好后接入（以后）

/** 一条来源在某一刻的输出 */
export interface SourceReading {
  sourceId: SourceId
  /** 本源值 [0, 1]，由来源自己计算。0 = 完全不推动醒来，1 = 最强推动 */
  value: number
  /** 这个值是否过时（来源数据太旧或不可用） */
  stale: boolean
  /** 可选的人类可读说明（调试/审计用） */
  label?: string
}

// ── 频率模式（非精确 Wake 节律）──

export type FrequencyMode = 'normal' | 'low_frequency' | 'silent' | 'custom'

/** 频率参数：custom 模式或 normal 的默认值 */
export interface FrequencyParams {
  /** 基础 λ（每小时期望醒来次数），默认 1.0 */
  lambdaBase: number
  /** Run 后短期安静时间（分钟），默认 20 */
  cooldownMinutes: number
  /** 非精确 Wake 下限（每小时），默认 0.1 */
  lambdaMin: number
  /** 非精确 Wake 上限（每小时），默认 6.0 */
  lambdaMax: number
}

// ── 控制状态 ──

/** 来源因子控制（0 = 不参与，1 = 默认，2 = 最大增强） */
export interface SourceFactorControl {
  sourceId: SourceId
  factor: number            // [0, 2]
  reason?: string
  expiresAt?: string        // UTC ISO，为空 = 直到手动解除
  setAt: string             // UTC ISO
}

/** 外部精确来源开关 */
export interface PreciseSourceControl {
  sourceId: string          // 如 'calendar', 'reminder'
  enabled: boolean
  reason?: string
  expiresAt?: string
  setAt: string
}

// ── 精确 Wake ──

export type PreciseWakeStatus = 'pending' | 'triggered' | 'consumed' | 'cancelled' | 'missed'

/** 他自己设的精确 Wake（Self Precise Wake）或外部精确事件 */
export interface PreciseWake {
  id: string
  source: 'self' | 'calendar' | 'reminder' | 'device' | 'external'
  wakeAt: string            // UTC ISO，绝对时间
  note?: string             // 他设的时候留的备注
  status: PreciseWakeStatus
  createdAt: string
  triggeredAt?: string
  consumedAt?: string
}

// ── 生活线头 ──

export type ThreadStatus = 'active' | 'completed' | 'expired'

/** 一根生活线头：他留下的"想回去"的锚点 */
export interface LifeThread {
  id: string
  text: string              // 他留下的简短描述
  createdAt: string         // UTC ISO
  expiresAt?: string        // 过期时间（不设就由系统根据年龄淘汰）
  status: ThreadStatus
  surfacedCount: number     // 已经浮现过几次
  lastSurfacedAt?: string
}

// ── Wake 机会与结局 ──

// error：调模型失败、超时、空回复、被截断——不是他选的，不算进每日次数，也不当成他的笔记
export type WakeOutcome = 'silent' | 'trace' | 'message' | 'error'
export type WakeOrigin = 'spontaneous' | 'precise_self' | 'precise_external'

/** 一次 Wake 机会 */
export interface WakeOpportunity {
  id: string
  origin: WakeOrigin
  /** 触发时的来源快照 */
  sources: SourceReading[]
  /** 触发原因的人类可读描述 */
  reason: string
  /** 精确 Wake 的关联 ID */
  preciseWakeId?: string
  createdAt: string
  /** 醒来后的结局 */
  outcome?: WakeOutcome
  /** fact 通道：给下次醒来看的极简事实 */
  fact?: string
  /** content 通道：给人读的完整经历 */
  content?: string
  /** 醒来时浮现的线头 ID */
  surfacedThreadIds?: string[]
  finishedAt?: string
  /** 调模型的 exchange rid（如果有） */
  exchangeRid?: string
}

// ── 引擎状态（持久化）──

/** 非精确 Wake 的累积状态 */
export interface SpontaneousState {
  /** 当前累积危险 H(t) */
  H: number
  /** 当前周期的阈值 Θ（每次触发后重新抽） */
  theta: number
  /** 上次 tick 的时间 */
  lastTickAt: string
  /** 上次成功 Wake 的时间 */
  lastWakeAt?: string
  /** 当前频率模式 */
  frequencyMode: FrequencyMode
  /** custom 参数（持久保存） */
  customParams?: FrequencyParams
  /** 频率模式临时覆盖的过期时间 */
  frequencyExpiresAt?: string
}
