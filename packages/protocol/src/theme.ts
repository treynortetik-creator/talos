// Theme format: plain data that can only set a fixed list of colour tokens, in light and dark. A theme changes colours only:
// fonts, sizes and corner radii are always tokens.css's own. A theme can hold no url(), var(), calc() or free text, so
// applying one cannot run or fetch anything. Colours are #rrggbb.
import harbor from '../themes/harbor.json' with { type: 'json' }
import hearth from '../themes/hearth.json' with { type: 'json' }
import iris from '../themes/iris.json' with { type: 'json' }
import paper from '../themes/paper.json' with { type: 'json' }
import talos from '../themes/talos.json' with { type: 'json' }

export const THEME_COLOR_TOKENS = [
  '--bg',
  '--surface',
  '--surface-2',
  '--line',
  '--text',
  '--text-2',
  '--accent',
  '--on-accent',
  '--accent-text',
  '--glow',
  '--tint',
  '--ok',
  '--warn',
  '--danger',
  '--info',
  '--focus',
  '--meander-ink',
  '--wave',
  '--figure-bg',
  '--chrome',
  '--on-chrome',
  '--on-chrome-2',
  '--chrome-line',
  '--chrome-hover',
  '--chrome-active',
  '--chrome-accent-text',
  // the scoped parts: owner bubbles and the phone top band (.figure-ground, .top-band), and the warning inside .frieze
  '--figure-text',
  '--figure-text-2',
  '--figure-accent-text',
  '--frieze-warn',
  // what .figure-ground and .top-band swap in for the page's surfaces, lines, status colours, focus ring and wave
  '--figure-surface',
  '--figure-surface-2',
  '--figure-line',
  '--figure-ok',
  '--figure-danger',
  '--figure-info',
  '--figure-wave',
  '--figure-focus',
  '--figure-meander-ink',
] as const
/** The only names a theme may set. */
export const THEME_TOKEN_NAMES: readonly string[] = [...THEME_COLOR_TOKENS]

type Colours = Record<(typeof THEME_COLOR_TOKENS)[number], string>
export type Theme = {
  name: string
  light: Colours
  dark: Colours
}
export type ThemeMode = 'light' | 'dark'

/** A colour pair the app really draws. `fg` is a token name (or a fixed #rrggbb, for a colour no theme sets). */
export type ContrastPair = { fg: string; bg: string; min: number; label?: string }
const TEXT = 4.5
/**
 * Every pair a theme has to keep readable, in both modes. apps/web/test/tokens.test.ts runs this same list against
 * tokens.css, so the shipped palette and the validator cannot drift apart.
 */
export const THEME_CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: '--text', bg: '--bg', min: TEXT },
  { fg: '--text', bg: '--surface', min: TEXT },
  { fg: '--text-2', bg: '--bg', min: TEXT },
  { fg: '--text-2', bg: '--surface-2', min: TEXT },
  { fg: '--text-2', bg: '--surface', min: TEXT },
  { fg: '--accent-text', bg: '--bg', min: TEXT },
  { fg: '--on-accent', bg: '--accent', min: TEXT },
  { fg: '--text', bg: '--tint', min: TEXT },
  { fg: '--ok', bg: '--bg', min: TEXT },
  { fg: '--warn', bg: '--bg', min: TEXT },
  { fg: '--danger', bg: '--bg', min: TEXT },
  { fg: '--info', bg: '--bg', min: TEXT },
  // badges put these on surface-2
  { fg: '--ok', bg: '--surface-2', min: TEXT },
  { fg: '--warn', bg: '--surface-2', min: TEXT },
  { fg: '--danger', bg: '--surface-2', min: TEXT },
  // the black frieze (sidebar, bottom bar)
  { fg: '--on-chrome', bg: '--chrome', min: TEXT },
  { fg: '--on-chrome-2', bg: '--chrome', min: TEXT },
  { fg: '--on-chrome', bg: '--chrome-active', min: TEXT },
  { fg: '--on-chrome-2', bg: '--chrome-hover', min: TEXT },
  { fg: '--chrome-accent-text', bg: '--chrome', min: TEXT },
  { fg: '--chrome-accent-text', bg: '--chrome-active', min: TEXT },
  // .figure-ground (owner bubbles) and .top-band (the phone's top band) swap these in for --text, --text-2 and --accent-text
  { fg: '--figure-text', bg: '--figure-bg', min: TEXT },
  { fg: '--figure-text-2', bg: '--figure-bg', min: TEXT },
  { fg: '--figure-accent-text', bg: '--figure-bg', min: TEXT },
  { fg: '--figure-text', bg: '--chrome', min: TEXT },
  { fg: '--figure-text-2', bg: '--chrome', min: TEXT },
  { fg: '--figure-accent-text', bg: '--chrome', min: TEXT },
  // .frieze swaps --frieze-warn in for --warn; the needs-you dot sits on the chrome
  { fg: '--frieze-warn', bg: '--chrome', min: TEXT },
  { fg: '--frieze-warn', bg: '--chrome-active', min: TEXT },
  // status colours inside an owner bubble (.figure-ground) and on the phone top band
  ...['--figure-bg', '--chrome', '--figure-surface'].flatMap((bg) =>
    ['--figure-ok', '--figure-danger', '--figure-info'].map((fg) => ({ fg, bg, min: TEXT })),
  ),
  { fg: '--figure-text', bg: '--figure-surface', min: TEXT },
  { fg: '--figure-text-2', bg: '--figure-surface', min: TEXT },
  { fg: '--figure-text-2', bg: '--figure-surface-2', min: TEXT },
  // non-text parts need 3:1
  { fg: '--figure-focus', bg: '--figure-bg', min: 3 },
  { fg: '--figure-focus', bg: '--chrome', min: 3 },
  { fg: '--figure-meander-ink', bg: '--figure-bg', min: 3 },
  { fg: '--figure-meander-ink', bg: '--chrome', min: 3 },
  { fg: '--figure-wave', bg: '--figure-bg', min: 3 },
  { fg: '--figure-wave', bg: '--figure-surface', min: 3 },
  { fg: '--wave', bg: '--surface', min: 3 },
  { fg: '--focus', bg: '--bg', min: 3 },
]

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** A ratio for a message: cut to two decimals, never rounded up, so a failing 4.496 cannot read as 4.50. */
const floor2 = (n: number) => (Math.floor(n * 100) / 100).toFixed(2)

/** One line per colour pair under its minimum, in either mode. Empty when the theme is readable. */
export function contrastProblems(theme: Theme): string[] {
  const out: string[] = []
  for (const mode of ['light', 'dark'] as const) {
    const set = theme[mode] as Record<string, string>
    for (const { fg, bg, min, label } of THEME_CONTRAST_PAIRS) {
      const ratio = contrastRatio(fg.startsWith('#') ? fg : (set[fg] as string), set[bg] as string)
      if (ratio < min) out.push(`${mode}: ${label ?? fg} on ${bg} is ${floor2(ratio)}:1, needs ${min}:1`)
    }
  }
  return out
}

export type ThemeResult = { ok: true; theme: Theme } | { ok: false; error: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const COLOUR = /^#[0-9a-fA-F]{6}$/
const NAME = /^[a-z][a-z0-9-]{0,31}$/

/** Most lines a refusal carries; the rest are counted in one "...and N more" line, so a hostile theme cannot flood the reply. */
const MAX_PROBLEM_LINES = 20
const MAX_KEY_ECHO = 40
/** A key name as echoed back: control characters removed (they could forge a line or an escape) and long names cut. */
const safeKey = (k: string) => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const clean = k.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
  return clean.length > MAX_KEY_ECHO ? `${clean.slice(0, MAX_KEY_ECHO)}...` : clean
}

/** Every problem with the shape or values, one line each, naming the bad key; empty when there is none. Written by hand (no schema library). */
function shapeProblems(v: unknown): string[] {
  const all = shapeProblemsAll(v)
  if (all.length <= MAX_PROBLEM_LINES) return all
  return [...all.slice(0, MAX_PROBLEM_LINES), `...and ${all.length - MAX_PROBLEM_LINES} more`]
}

function shapeProblemsAll(v: unknown): string[] {
  if (!isRecord(v)) return ['theme: must be an object']
  const out: string[] = []
  const group = (key: string, names: readonly string[], check: (x: unknown) => string | null) => {
    const g = v[key]
    if (!isRecord(g)) return void out.push(`${key}: must be an object`)
    for (const k of Object.keys(g)) if (!names.includes(k)) out.push(`${key}.${safeKey(k)}: not an allowed token`)
    for (const n of names) {
      if (!(n in g)) out.push(`${key}.${n}: missing`)
      else {
        const bad = check(g[n])
        if (bad) out.push(`${key}.${n}: ${bad}`)
      }
    }
  }
  // `radius` and `fonts` are allowed and ignored: a custom theme saved before themes were colours-only still applies.
  for (const k of Object.keys(v))
    if (!['name', 'light', 'dark', 'radius', 'fonts'].includes(k)) out.push(`${safeKey(k)}: not an allowed key`)
  if (typeof v.name !== 'string' || !NAME.test(v.name)) out.push('name: lowercase letters, digits and dashes, up to 32')
  const colourCheck = (x: unknown) => (typeof x === 'string' && COLOUR.test(x) ? null : 'must be #rrggbb')
  group('light', THEME_COLOR_TOKENS, colourCheck)
  group('dark', THEME_COLOR_TOKENS, colourCheck)
  return out
}

/** Reads every property of the input once into plain objects, so a getter or a later edit cannot change what was checked. */
function snapshot(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(snapshot)
  if (!isRecord(v)) return v
  return Object.fromEntries(Object.keys(v).map((k) => [k, snapshot(v[k])]))
}

/** Every problem with a theme, shape and values first, then (only when the shape is sound) every low-contrast pair. */
export function themeProblems(input: unknown): string[] {
  const copy = snapshot(input)
  const bad = shapeProblems(copy)
  return bad.length > 0 ? bad : contrastProblems(copy as Theme)
}

/** Checks shape, values and contrast. The error is the first problem, one line. The theme returned is a fresh copy, never the input. */
export function validateTheme(input: unknown): ThemeResult {
  const copy = snapshot(input)
  const problems = themeProblems(copy)
  if (problems.length > 0) return { ok: false, error: problems[0] as string }
  const { radius: _r, fonts: _f, ...theme } = copy as Theme & { radius?: unknown; fonts?: unknown }
  return { ok: true, theme }
}

/** The ids of the stock themes: the values the `theme` setting in the owner's config may hold. */
export const STOCK_THEME_IDS = ['talos', 'paper', 'hearth', 'iris', 'harbor'] as const
/** A bridge that lists this accepts every id in STOCK_THEME_IDS in its config (an older one drops iris and harbor to talos). */
export const THEMES_V2_FEATURE = 'themes/2'
export type StockThemeId = (typeof STOCK_THEME_IDS)[number]

export const STOCK_THEMES: readonly Theme[] = [talos, paper, hearth, iris, harbor] as Theme[]
/** The theme that matches tokens.css as shipped. */
export const DEFAULT_THEME: Theme = talos as Theme
