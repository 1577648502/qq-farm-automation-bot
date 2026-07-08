export const THEME_STORAGE_KEY = 'ui_theme'
export const DEFAULT_THEME = 'light-blue'

export interface ThemeConfig {
  name: string
  isDark: boolean
  bg: string
  text: string
  primary: string
  secondary: string
  gradient: string
  icon: string
}

export const themes = {
  'light-blue': {
    name: '晴空蓝',
    isDark: false,
    bg: '#f8fafc',
    text: '#1e293b',
    primary: '#3b82f6',
    secondary: '#2563eb',
    gradient: 'linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%)',
    icon: 'i-carbon-sun',
  },
  'dark-blue': {
    name: '深空蓝',
    isDark: true,
    bg: '#0f172a',
    text: '#e2e8f0',
    primary: '#60a5fa',
    secondary: '#3b82f6',
    gradient: 'linear-gradient(135deg, #93c5fd 0%, #60a5fa 100%)',
    icon: 'i-carbon-moon',
  },
  'light-pink': {
    name: '樱花粉',
    isDark: false,
    bg: '#fff5f7',
    text: '#831843',
    primary: '#ec4899',
    secondary: '#db2777',
    gradient: 'linear-gradient(135deg, #f472b6 0%, #ec4899 100%)',
    icon: 'i-carbon-star',
  },
  'light-green': {
    name: '萌芽绿',
    isDark: false,
    bg: '#f0fdf4',
    text: '#166534',
    primary: '#22c55e',
    secondary: '#16a34a',
    gradient: 'linear-gradient(135deg, #4ade80 0%, #22c55e 100%)',
    icon: 'i-carbon-sprout',
  },
  'forest': {
    name: '森林',
    isDark: false,
    bg: '#f5faf0',
    text: '#1a3a2a',
    primary: '#4ade80',
    secondary: '#22c55e',
    gradient: 'linear-gradient(135deg, #6ee7b7 0%, #34d399 100%)',
    icon: 'i-carbon-tree',
  },
  'lavender': {
    name: '薰衣草',
    isDark: false,
    bg: '#f8f5ff',
    text: '#3b1f6e',
    primary: '#a78bfa',
    secondary: '#8b5cf6',
    gradient: 'linear-gradient(135deg, #c4b5fd 0%, #a78bfa 100%)',
    icon: 'i-carbon-star',
  },
  'dark-purple': {
    name: '紫罗兰',
    isDark: true,
    bg: '#1c1535',
    text: '#e9d5ff',
    primary: '#a855f7',
    secondary: '#9333ea',
    gradient: 'linear-gradient(135deg, #c084fc 0%, #a855f7 100%)',
    icon: 'i-carbon-star',
  },
  'dark-teal': {
    name: '青空夜',
    isDark: true,
    bg: '#0f2a2a',
    text: '#ccfbf1',
    primary: '#2dd4bf',
    secondary: '#14b8a6',
    gradient: 'linear-gradient(135deg, #5eead4 0%, #2dd4bf 100%)',
    icon: 'i-carbon-tree',
  },
  'dark-orange': {
    name: '暖阳橙',
    isDark: true,
    bg: '#1c1917',
    text: '#fef3c7',
    primary: '#f59e0b',
    secondary: '#d97706',
    gradient: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
    icon: 'i-carbon-sun',
  },
  'dark-red': {
    name: '绯红夜',
    isDark: true,
    bg: '#1a1215',
    text: '#fda4af',
    primary: '#f43f5e',
    secondary: '#e11d48',
    gradient: 'linear-gradient(135deg, #fb7185 0%, #f43f5e 100%)',
    icon: 'i-carbon-close-filled',
  },
} as const satisfies Record<string, ThemeConfig>

export type Theme = keyof typeof themes

export function normalizeTheme(theme: string | null | undefined): Theme {
  return theme && theme in themes ? theme as Theme : DEFAULT_THEME
}

export function getStoredTheme(): Theme {
  if (typeof localStorage === 'undefined')
    return DEFAULT_THEME
  return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY))
}

export function applyThemeToDocument(theme: Theme) {
  if (typeof document === 'undefined' || !document.documentElement)
    return

  const config = themes[theme]
  const root = document.documentElement
  root.style.setProperty('--theme-bg', config.bg)
  root.style.setProperty('--theme-text', config.text)
  root.style.setProperty('--theme-primary', config.primary)
  root.style.setProperty('--theme-secondary', config.secondary)
  root.style.setProperty('--theme-gradient', config.gradient)

  if (config.isDark) {
    root.style.setProperty('--card-bg', '#1e293b')
    root.style.setProperty('--card-border', 'rgba(255,255,255,0.06)')
    root.style.setProperty('--surface-bg', 'rgba(255,255,255,0.04)')
  }
  else {
    root.style.setProperty('--card-bg', '#ffffff')
    root.style.setProperty('--card-border', 'rgba(0,0,0,0.06)')
    root.style.setProperty('--surface-bg', 'rgba(0,0,0,0.02)')
  }

  root.classList.toggle('dark', config.isDark)
}



