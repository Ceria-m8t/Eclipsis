// src/settings.ts
const DEFAULTS = {
  apiBase: import.meta.env.VITE_API_BASE || '',
  apiKey: import.meta.env.VITE_API_KEY || '',
  model: import.meta.env.VITE_MODEL || ''
}

export function getSettings() {
  const saved = localStorage.getItem('our-home-settings')
  if (saved) {
    try {
      const parsed = JSON.parse(saved)
      return { ...DEFAULTS, ...parsed }
    } catch {
      return { ...DEFAULTS }
    }
  }
  return { ...DEFAULTS }
}

export function saveSettings(s: { apiBase: string; apiKey: string; model: string }) {
  localStorage.setItem('our-home-settings', JSON.stringify(s))
}
