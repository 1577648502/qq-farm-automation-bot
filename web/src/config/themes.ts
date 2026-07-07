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
    name: '白色',
    isDark: false,
    bg: '#f9fafb',
    text: '#1f2937',
    primary: '#3b82f6',
    secondary: '#2563eb',
    gradient: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
    icon: 'i-carbon-sun',
  },
  'dark-blue': {
    name: '深色',
    isDark: true,
    bg: '#111827',
    text: '#f3f4f6',
    primary: '#3b82f6',
    secondary: '#2563eb',
    gradient: 'linear-gradient(135deg, #60a5fa 0%, #3b82f6 100%)',
    icon: 'i-carbon-moon',
  },
  'light-pink': {
    name: '樱花粉',
    isDark: false,
    bg: '#fff0f5',
    text: '#831843',
    primary: '#ec4899',
    secondary: '#be185d',
    gradient: 'linear-gradient(135deg, #f472b6 0%, #ec4899 100%)',
    icon: 'i-carbon-favorite',
  },
  'light-green': {
    name: '清新绿',
    isDark: false,
    bg: '#f0fdf4',
    text: '#14532d',
    primary: '#22c55e',
    secondary: '#16a34a',
    gradient: 'linear-gradient(135deg, #4ade80 0%, #22c55e 100%)',
    icon: 'i-carbon-sprout',
  },
  'dark-purple': {
    name: '紫罗兰',
    isDark: true,
    bg: '#1e1b4b',
    text: '#e9d5ff',
    primary: '#a855f7',
    secondary: '#9333ea',
    gradient: 'linear-gradient(135deg, #c084fc 0%, #a855f7 100%)',
    icon: 'i-carbon-badge',
  },
  'dark-orange': {
    name: '暖阳橙',
    isDark: true,
    bg: '#292524',
    text: '#fef3c7',
    primary: '#f59e0b',
    secondary: '#d97706',
    gradient: 'linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%)',
    icon: 'i-carbon-sun',
  },
  'dark-teal': {
    name: '青空夜',
    isDark: true,
    bg: '#134e4a',
    text: '#ccfbf1',
    primary: '#06b6d4',
    secondary: '#0891b2',
    gradient: 'linear-gradient(135deg, #22d3ee 0%, #06b6d4 100%)',
    icon: 'i-carbon-tree',
  },
  'dark-red': {
    name: '绯红夜',
    isDark: true,
    bg: '#18181b',
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
  root.classList.toggle('dark', config.isDark)
}
