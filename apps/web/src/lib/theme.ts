// Appearance: System / Light / Dark, and Text size. "System" removes the override so tokens.css follows prefers-color-scheme.
// Text size sets the root font size (a percentage, so the browser's own default still counts): tokens and Tailwind spacing
// are rem, so the whole app scales with it. Both are device settings, like light/dark: never sent anywhere (audit D53).
// The stock theme further down (talos | paper | hearth) is the exception: it is a setting of the owner's config.
import {
  DEFAULT_THEME,
  STOCK_THEME_IDS,
  STOCK_THEMES,
  type StockThemeId,
  THEME_COLOR_TOKENS,
  THEME_FONT_STACKS,
  THEME_FONT_TOKENS,
  THEME_RADIUS_TOKENS,
  THEME_TOKEN_NAMES,
  type Theme,
  type ThemeMode,
  validateTheme,
} from '@talos-app/protocol'
import { useSyncExternalStore } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = 'talos-theme'
const SIZE_KEY = 'talos-text-size'
const subs = new Set<() => void>()

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {}
  return 'system'
}

export type TextSize = 'default' | 'large' | 'larger' | 'largest'
/** Root font size as a percentage of the browser's default. Default is left unset, exactly as before this control. */
export const TEXT_SIZE_PERCENT: Record<TextSize, number> = { default: 100, large: 115, larger: 130, largest: 150 }

export function getTextSize(): TextSize {
  try {
    const v = localStorage.getItem(SIZE_KEY)
    if (v === 'large' || v === 'larger' || v === 'largest') return v
  } catch {}
  return 'default'
}

export function applyTheme(choice: ThemeChoice = getTheme(), size: TextSize = getTextSize()) {
  const root = document.documentElement
  if (size === 'default') root.style.removeProperty('font-size')
  else root.style.fontSize = `${TEXT_SIZE_PERCENT[size]}%`
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.dataset.theme = choice
  paintStockTheme(choice)
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim()
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#141110')
}

export function setTheme(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  } catch {}
  applyTheme(choice, getTextSize())
  for (const s of subs) s()
}

export function setTextSize(size: TextSize) {
  try {
    if (size === 'default') localStorage.removeItem(SIZE_KEY)
    else localStorage.setItem(SIZE_KEY, size)
  } catch {}
  applyTheme(getTheme(), size)
  for (const s of subs) s()
}

export function useTextSize(): TextSize {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
    getTextSize,
    () => 'default',
  )
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
    getTheme,
    () => 'system',
  )
}

/**
 * The CSS custom properties of a theme for one mode, as {name: value}. Only names on the protocol's allowlist appear, and
 * every value is rebuilt from the validated theme (a #rrggbb, a number of pixels, a font stack from the bundled list), never
 * copied. A theme that fails validation gives the default's values, and `problems` says why.
 */
export function themeDeclarations(
  theme: unknown,
  mode: ThemeMode,
): { vars: Record<string, string>; problems: string[] } {
  const checked = validateTheme(theme)
  const t = checked.ok ? checked.theme : DEFAULT_THEME
  const colours = t[mode] as Record<string, string>
  const vars: Record<string, string> = {}
  for (const name of THEME_COLOR_TOKENS) vars[name] = colours[name] as string
  for (const name of THEME_RADIUS_TOKENS) vars[name] = `${t.radius[name]}px`
  for (const name of THEME_FONT_TOKENS) vars[name] = THEME_FONT_STACKS[t.fonts[name]]
  return { vars, problems: checked.ok ? [] : [checked.error] }
}

/**
 * Sets a theme's tokens on the root element, for one mode (see `themeDeclarations`). The result says whether the theme
 * applied or was replaced by the default, so the caller can show the reason.
 * Mode changes need another call: the inline values beat the stylesheet's light and dark blocks.
 */
export function applyThemeTokens(
  theme: unknown,
  mode: ThemeMode,
): { applied: 'theme' | 'default'; problems: string[] } {
  const { vars, problems } = themeDeclarations(theme, mode)
  const style = document.documentElement.style
  for (const [name, value] of Object.entries(vars)) style.setProperty(name, value)
  return { applied: problems.length === 0 ? 'theme' : 'default', problems }
}

// ---- Applied theme (talos | paper | hearth | a custom theme) -------------------------------------------------------------
// The theme the owner applied is a setting of the owner's config (`theme`), so every device follows it: a stock id, or a whole
// custom theme the agent drafted and the owner approved on a card. This device keeps a copy so a launch paints the right
// colours before the config has arrived. Light/dark/system above stays per device, and a theme has both modes. Talos is the
// stylesheet itself: choosing it removes the inline tokens. A custom theme is validated every time it is read.
const STOCK_KEY = 'talos-stock-theme'
export type AppliedTheme = StockThemeId | Theme
let memoryStock: AppliedTheme = 'talos'
let parsed: { raw: string; value: AppliedTheme } | null = null

const isStockId = (v: unknown): v is StockThemeId => STOCK_THEME_IDS.some((id) => id === v)

/** Any value from the config or storage: a stock id, a custom theme that passes the validator, or else talos. */
export function stockThemeFromConfig(v: unknown): AppliedTheme {
  if (isStockId(v)) return v
  const r = validateTheme(v)
  return r.ok ? r.theme : 'talos'
}

/** 'talos' | 'paper' | 'hearth' | 'custom': the part of an applied theme that is a stable string. */
export const themeKey = (t: AppliedTheme): StockThemeId | 'custom' => (typeof t === 'string' ? t : 'custom')
const same = (a: AppliedTheme, b: AppliedTheme) => JSON.stringify(a) === JSON.stringify(b)

export function getStockTheme(): AppliedTheme {
  try {
    const raw = localStorage.getItem(STOCK_KEY)
    if (raw === null) return memoryStock
    if (isStockId(raw)) return raw
    if (parsed?.raw !== raw) parsed = { raw, value: stockThemeFromConfig(JSON.parse(raw)) } // same object while unchanged
    return parsed.value
  } catch {}
  return memoryStock
}

function currentMode(choice: ThemeChoice): ThemeMode {
  if (choice !== 'system') return choice
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Puts the applied theme's tokens on the root for the mode in force, or takes them all off for talos. */
function paintStockTheme(choice: ThemeChoice) {
  const applied = getStockTheme()
  const theme = typeof applied === 'string' ? STOCK_THEMES.find((t) => t.name === applied) : applied
  if (applied === 'talos' || !theme) {
    for (const name of THEME_TOKEN_NAMES) document.documentElement.style.removeProperty(name)
    return
  }
  applyThemeTokens(theme, currentMode(choice))
}

/** The owner's pick (or the config's, from another device): applied now and kept for the next launch. */
export function setStockTheme(t: AppliedTheme) {
  memoryStock = t
  try {
    if (t === 'talos') localStorage.removeItem(STOCK_KEY)
    else localStorage.setItem(STOCK_KEY, typeof t === 'string' ? t : JSON.stringify(t))
  } catch {}
  applyTheme()
  for (const s of subs) s()
}

export function useStockTheme(): StockThemeId | 'custom' {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
    () => themeKey(getStockTheme()),
    () => 'talos',
  )
}
/** True when the config's theme is already what this device shows. */
export const isStockThemeApplied = (t: AppliedTheme) => same(t, getStockTheme())

let deviceReset = false

/**
 * The way back from a theme the owner cannot read, reachable without signing in (`?theme=default`, and the "Reset theme"
 * link on the sign-in screen). Talos on THIS device for as long as the page lives, or until the owner picks a theme.
 * It writes nothing: no config patch, no stored marker. Whatever the config says is left alone.
 */
export function resetStockTheme() {
  deviceReset = true
  setStockTheme('talos')
}
/** True while a reset on this device is in force: the config's theme is not applied here. */
export function stockThemeResetActive(): boolean {
  return deviceReset
}
/** The owner's own pick (Settings): an ordinary choice, and it ends any reset on this device. */
export function pickStockTheme(id: AppliedTheme) {
  deviceReset = false
  setStockTheme(id)
}

/** `?theme=default` in the address: reset, then take the parameter out of the address. Call before the first paint. */
export function resetThemeFromUrl(loc: Location = location, hist: History = history) {
  const q = new URLSearchParams(loc.search)
  if (q.get('theme') !== 'default') return
  resetStockTheme()
  q.delete('theme')
  const rest = q.toString()
  try {
    hist.replaceState(hist.state, '', `${loc.pathname}${rest ? `?${rest}` : ''}${loc.hash}`)
  } catch {}
}
