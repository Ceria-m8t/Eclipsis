export interface Settings {
  apiBase: string
  apiKey: string
  model: string
  chatBg: string
  avatarUser: string
  avatarAI: string
  bubbleTheme: string
}

const DEFAULT_SETTINGS: Settings = {
  apiBase: '',
  apiKey: 'erica-heartbeat-gateway-2026',
  model: 'claude-fable-5[次]',
  chatBg: '',
  avatarUser: '/avatar-erica.jpg',
  avatarAI: '/avatar-claude.jpg',
  bubbleTheme: 'glass-light'
}

const STORAGE_KEY = 'our-home-settings'

export function getSettings(): Settings {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) }
    } catch {
      return DEFAULT_SETTINGS
    }
  }
  return DEFAULT_SETTINGS
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}
