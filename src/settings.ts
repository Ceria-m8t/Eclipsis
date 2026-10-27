export interface Settings {
  apiBase: string        // 留空 = 走同源 /api（nginx 转发到 Dylan 网关，并由服务器注入 key）
  apiKey: string         // 只在直连其他 API 时需要填
  model: string
  chatBg: string
  avatarUser: string
  avatarAI: string
  bubbleTheme: string
  nameAI: string
  nameUser: string
  chatSubtitle: string   // 顶栏名字下面那行小字
  contextTokens: number  // 发给模型的聊天历史上限（估算值，不含系统提示词）
  splitBubbles: boolean  // 他的回复按段落拆成多个气泡
  keepAlive: boolean     // 他回复时后台静音保活（切到别的 app 不断）
}

const DEFAULT_SETTINGS: Settings = {
  apiBase: '',
  apiKey: '',
  model: '[K2-个人]claude-opus-4-6',
  chatBg: '',
  avatarUser: '/avatar-erica.jpg',
  avatarAI: '/avatar-claude.jpg',
  bubbleTheme: 'glass-light',
  nameAI: '小克',
  nameUser: 'Erica',
  chatSubtitle: '',
  contextTokens: 60000,
  splitBubbles: true,
  keepAlive: true
}

const STORAGE_KEY = 'our-home-settings'

export function getSettings(): Settings {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

// 同源 /api 时不发 Authorization（即使旧设置里存过 key），由 nginx 注入真实 key
export function apiUrl(s: Settings, path: string): string {
  return s.apiBase ? `${s.apiBase.replace(/\/$/, '')}${path}` : `/api${path}`
}

export function apiHeaders(s: Settings): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (s.apiBase && s.apiKey) h['Authorization'] = `Bearer ${s.apiKey}`
  return h
}
