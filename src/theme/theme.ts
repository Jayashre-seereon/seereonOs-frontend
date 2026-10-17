// Theme engine: tenant brand presets + custom colours → CSS variables for light and dark.
// Admins configure it in Settings → Appearance; each user can override light/dark only.
import type { ThemeConfig } from '@/types/entities'

export interface Preset {
  id: string
  name: string
  description: string
  primary: string
  accent: string
  sidebar: ThemeConfig['sidebar']
}

export const PRESETS: Preset[] = [
  { id: 'seereon', name: 'Seereon Emerald', description: 'Emerald with Seereon gold (house brand)', primary: '#0C6B4E', accent: '#DAB34F', sidebar: 'light' },
  { id: 'ocean', name: 'Ocean', description: 'Confident blue with a warm amber accent', primary: '#1D5FD1', accent: '#E0892B', sidebar: 'light' },
  { id: 'graphite', name: 'Graphite', description: 'Quiet charcoal, brass highlights', primary: '#2F3A45', accent: '#C08A2E', sidebar: 'dark' },
  { id: 'indigo', name: 'Indigo', description: 'Deep indigo with a teal accent', primary: '#4338CA', accent: '#0FA3A3', sidebar: 'tinted' },
  { id: 'teal', name: 'Lagoon', description: 'Teal with saffron', primary: '#0E7C86', accent: '#E9A23B', sidebar: 'light' },
  { id: 'aubergine', name: 'Aubergine', description: 'Plum with gold', primary: '#5B2A86', accent: '#C9A227', sidebar: 'dark' },
  { id: 'terracotta', name: 'Laterite', description: 'Odisha laterite red with slate green', primary: '#A8472A', accent: '#2F6F6B', sidebar: 'light' },
  { id: 'crimson', name: 'Crimson', description: 'Crimson with sand', primary: '#A4243B', accent: '#B99A5B', sidebar: 'tinted' },
]

export const FONT_CHOICES = ['plex', 'inter', 'source', 'system'] as const
export const FONTS: Record<ThemeConfig['font'], { label: string; stack: string }> = {
  plex: { label: 'IBM Plex Sans', stack: '"IBM Plex Sans", "Segoe UI", system-ui, -apple-system, sans-serif' },
  inter: { label: 'Inter', stack: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif' },
  source: { label: 'Source Sans 3', stack: '"Source Sans 3", "Segoe UI", system-ui, -apple-system, sans-serif' },
  system: { label: 'System (Segoe / SF)', stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  geist: { label: 'IBM Plex Sans', stack: '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif' },
  manrope: { label: 'IBM Plex Sans', stack: '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif' },
}

/* ---------------- colour math ---------------- */
type RGB = [number, number, number]
export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}
export function rgbToHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')
}
function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h *= 60
  }
  return [h, s, l]
}
function hslToRgb(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}
export function hsl(h: number, s: number, l: number): string {
  return rgbToHex(hslToRgb(((h % 360) + 360) % 360, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, l))))
}
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a)
  const y = hexToRgb(b)
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}
function lum(hex: string) {
  const c = hexToRgb(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
export function contrast(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
export function onColor(bg: string) {
  return contrast(bg, '#FFFFFF') >= 3.2 ? '#FFFFFF' : '#10150F'
}
/** Adjust lightness until text contrast against `against` reaches `target`. */
function readable(color: string, against: string, target = 4.5): string {
  let [h, s, l] = rgbToHsl(hexToRgb(color))
  const darkBg = lum(against) < 0.2
  for (let i = 0; i < 40 && contrast(hsl(h, s, l), against) < target; i++) l += darkBg ? 0.02 : -0.02
  return hsl(h, s, l)
}

/* ---------------- token generation ---------------- */
const CAT_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
const CAT_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']

export type Tokens = Record<string, string>

export function buildTokens(t: ThemeConfig, dark: boolean): Tokens {
  const [ph, ps] = rgbToHsl(hexToRgb(t.primary))
  const [ah] = rgbToHsl(hexToRgb(t.accent))
  const nh = ph // neutrals lean toward the brand hue
  const ns = Math.min(0.06, ps * 0.07)
  const N = (l: number, s = ns) => hsl(nh, s, l)

  const bg = dark ? N(0.08, ns * 1.2) : N(0.965, ns)
  const surface = dark ? N(0.105, ns * 1.1) : '#FFFFFF'
  const surface2 = dark ? N(0.135) : N(0.948)
  const elevated = dark ? N(0.14) : '#FFFFFF'
  const line = dark ? N(0.2) : N(0.895)
  const lineStrong = dark ? N(0.28) : N(0.82)
  const ink = dark ? N(0.94, ns * 0.5) : N(0.11, ns * 1.2)
  const ink2 = dark ? N(0.76, ns * 0.6) : N(0.32)
  const ink3 = dark ? N(0.58, ns * 0.6) : N(0.48)

  const brandBase = dark ? hsl(ph, Math.min(0.75, ps * 0.95), Math.max(0.46, rgbToHsl(hexToRgb(t.primary))[2] + 0.16)) : t.primary
  const brand = brandBase
  const brandInk = onColor(brand)
  const brandSoft = dark ? mix(surface, brand, 0.2) : mix('#FFFFFF', t.primary, 0.09)
  const brandSoft2 = dark ? mix(surface, brand, 0.32) : mix('#FFFFFF', t.primary, 0.16)
  const brandText = readable(dark ? brand : t.primary, surface, 4.6)
  const accent = dark ? hsl(ah, 0.62, 0.6) : t.accent
  const accentSoft = dark ? mix(surface, accent, 0.18) : mix('#FFFFFF', t.accent, 0.13)
  const accentText = readable(accent, surface, 4.5)

  const sem = (h: number, s: number) => {
    const solid = dark ? hsl(h, s * 0.85, 0.58) : hsl(h, s, 0.4)
    return { solid, soft: dark ? mix(surface, solid, 0.17) : mix('#FFFFFF', solid, 0.1), text: readable(solid, surface, 4.6) }
  }
  const success = sem(152, 0.62)
  const warning = sem(34, 0.88)
  const danger = sem(4, 0.7)
  const info = sem(212, 0.7)

  let sidebarBg: string, sidebarInk: string, sidebarMuted: string, sidebarActive: string, sidebarActiveInk: string, sidebarLine: string
  if (dark || t.sidebar === 'dark') {
    sidebarBg = dark ? N(0.06, ns * 1.4) : hsl(ph, Math.min(0.35, ps * 0.5), 0.12)
    sidebarInk = hsl(ph, 0.1, 0.93)
    sidebarMuted = hsl(ph, 0.1, 0.66)
    sidebarActive = dark ? mix(sidebarBg, brand, 0.28) : mix(sidebarBg, '#FFFFFF', 0.1)
    sidebarActiveInk = '#FFFFFF'
    sidebarLine = mix(sidebarBg, '#FFFFFF', 0.08)
  } else if (t.sidebar === 'tinted') {
    sidebarBg = hsl(ph, Math.min(0.55, ps * 0.8), 0.17)
    sidebarInk = hsl(ph, 0.2, 0.95)
    sidebarMuted = hsl(ph, 0.18, 0.72)
    sidebarActive = mix(sidebarBg, '#FFFFFF', 0.12)
    sidebarActiveInk = '#FFFFFF'
    sidebarLine = mix(sidebarBg, '#FFFFFF', 0.1)
  } else {
    sidebarBg = surface
    sidebarInk = ink
    sidebarMuted = ink3
    sidebarActive = brandSoft
    sidebarActiveInk = brandText
    sidebarLine = line
  }

  const r = { sharp: [2, 3, 4, 6], soft: [4, 6, 8, 10], round: [6, 10, 12, 16] }[t.radius]
  const dens = t.density === 'compact' ? { row: '36px', ctl: '32px', pad: '12px' } : { row: '44px', ctl: '36px', pad: '16px' }

  return {
    '--bg': bg,
    '--surface': surface,
    '--surface-2': surface2,
    '--elevated': elevated,
    '--line': line,
    '--line-strong': lineStrong,
    '--ink': ink,
    '--ink-2': ink2,
    '--ink-3': ink3,
    '--brand': brand,
    '--brand-ink': brandInk,
    '--brand-soft': brandSoft,
    '--brand-soft-2': brandSoft2,
    '--brand-text': brandText,
    '--accent': accent,
    '--accent-ink': onColor(accent),
    '--accent-soft': accentSoft,
    '--accent-text': accentText,
    '--success': success.solid,
    '--success-soft': success.soft,
    '--success-text': success.text,
    '--warning': warning.solid,
    '--warning-soft': warning.soft,
    '--warning-text': warning.text,
    '--danger': danger.solid,
    '--danger-soft': danger.soft,
    '--danger-text': danger.text,
    '--info': info.solid,
    '--info-soft': info.soft,
    '--info-text': info.text,
    '--sidebar-bg': sidebarBg,
    '--sidebar-ink': sidebarInk,
    '--sidebar-muted': sidebarMuted,
    '--sidebar-active': sidebarActive,
    '--sidebar-active-ink': sidebarActiveInk,
    '--sidebar-line': sidebarLine,
    '--ring': mix(brand, dark ? '#000000' : '#FFFFFF', 0.35),
    '--r-sm': r[0] + 'px',
    '--r-md': r[1] + 'px',
    '--r-lg': r[2] + 'px',
    '--r-xl': r[3] + 'px',
    '--row-h': dens.row,
    '--ctl-h': dens.ctl,
    '--pad': dens.pad,
    '--font-sans': FONTS[t.font].stack,
    '--shadow-sm': dark ? '0 0 0 transparent' : '0 1px 1px rgba(16,24,40,.03)',
    '--shadow-md': dark ? '0 4px 14px rgba(0,0,0,.45)' : '0 1px 2px rgba(16,24,40,.05), 0 4px 12px rgba(16,24,40,.06)',
    '--shadow-lg': dark ? '0 16px 40px rgba(0,0,0,.6)' : '0 2px 4px rgba(16,24,40,.06), 0 16px 36px rgba(16,24,40,.12)',
    // Categorical chart palette: validated 8-hue set (fixed order, light/dark stepped separately).
    // Single-series charts use the brand colour instead (see ui/charts.tsx).
    ...Object.fromEntries((dark ? CAT_DARK : CAT_LIGHT).map((c, i) => [`--c${i + 1}`, c])),
    'color-scheme': dark ? 'dark' : 'light',
  }
}

function css(tokens: Tokens) {
  return Object.entries(tokens)
    .map(([k, v]) => `${k}:${v}`)
    .join(';')
}

let media: MediaQueryList | null = null
let current: { theme: ThemeConfig; mode: ThemeConfig['mode'] } | null = null

export function resolveDark(mode: ThemeConfig['mode']): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  const host = document.documentElement.getAttribute('data-theme') // set by embedding viewers
  if (host === 'dark') return true
  if (host === 'light') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

export function applyTheme(theme: ThemeConfig, userMode?: ThemeConfig['mode']) {
  const mode = userMode && userMode !== 'system' ? userMode : theme.mode
  current = { theme, mode }
  const dark = resolveDark(mode)
  let el = document.getElementById('tenant-theme') as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = 'tenant-theme'
    document.head.appendChild(el)
  }
  el.textContent = `:root{${css(buildTokens(theme, dark))}}`
  document.documentElement.dataset.mode = dark ? 'dark' : 'light'
  const meta = document.querySelector('meta[name=theme-color]')
  if (meta) meta.setAttribute('content', dark ? buildTokens(theme, true)['--bg'] : theme.primary)
  if (!media && window.matchMedia) {
    media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener?.('change', () => current && applyTheme(current.theme, current.mode))
  }
}
