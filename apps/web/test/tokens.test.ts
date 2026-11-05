import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { THEME_CONTRAST_PAIRS } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'theme', 'tokens.css'), 'utf8')

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`no block ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  const out: Record<string, string> = {}
  for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
    out[m[1] as string] = (m[2] as string).trim().replace(/\s*\/\*.*$/, '')
  return out
}

const primitives = block(':root[data-brand="talos"] {')
const light = block(':root[data-brand="talos"],\n:root[data-brand="talos"][data-theme="light"] {')
const darkMedia = block(':root[data-brand="talos"]:not([data-theme="light"]) {')
const darkForced = block(':root[data-brand="talos"][data-theme="dark"] {')
const frieze = block(':root[data-brand="talos"] .frieze {')
const figure = block(':root[data-brand="talos"] .figure-ground {')
const topBand = block(':root[data-brand="talos"] .top-band {')

const resolve = (v: string, set: Record<string, string>): string => {
  const m = /^var\((--[\w-]+)\)$/.exec(v)
  return m ? resolve((set[m[1] as string] ?? primitives[m[1] as string]) as string, set) : v
}
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}
const color = (set: Record<string, string>, name: string) => resolve(set[name] ?? (primitives[name] as string), set)

describe('Talos tokens', () => {
  it('locks the four brand primitives', () => {
    expect(primitives['--talos-terracotta']).toBe('#d9692b')
    expect(primitives['--talos-black']).toBe('#141110')
    expect(primitives['--talos-cream']).toBe('#f3e6cf')
    expect(primitives['--talos-ichor']).toBe('#ffb15c')
  })

  it('the forced-dark block is identical to the system-dark block', () => {
    expect(darkForced).toEqual(darkMedia)
  })

  it('both themes define the same token names', () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(darkMedia).sort())
  })

  // The scoped parts read theme tokens, never a colour of their own. Each token's value lives in the light and dark
  // blocks (checked against talos.json below) and the pair list names the same tokens, so editing either side is red.
  it('.figure-ground and .top-band take their text colours from the figure tokens', () => {
    for (const scope of [figure, topBand]) {
      expect(scope['--text']).toBe('var(--figure-text)')
      expect(scope['--text-2']).toBe('var(--figure-text-2)')
      expect(scope['--accent-text']).toBe('var(--figure-accent-text)')
    }
  })
  // The tokens the scoped parts read, and what each resolved to on origin/main (when they were hard-coded). Under talos the
  // computed values must not move by a byte; the other stock themes set their own through the same names.
  const SCOPED = {
    '--surface': ['--figure-surface', '#1c1815'],
    '--surface-2': ['--figure-surface-2', '#272119'],
    '--line': ['--figure-line', '#4a3f33'],
    '--focus': ['--figure-focus', '#f3e6cf'],
    '--meander-ink': ['--figure-meander-ink', '#d9692b'],
    '--text': ['--figure-text', '#f3e6cf'],
    '--text-2': ['--figure-text-2', '#c2b199'],
    '--accent-text': ['--figure-accent-text', '#ec8a52'],
  } as const
  const FIGURE_ONLY = {
    '--ok': ['--figure-ok', '#6cc08e'],
    '--warn': ['--frieze-warn', '#e9b44c'],
    '--danger': ['--figure-danger', '#ff6b5e'],
    '--info': ['--figure-info', '#7fb0f0'],
    '--wave': ['--figure-wave', '#8f7b64'],
  } as const
  for (const [scopeName, scope, own] of [
    ['.figure-ground', figure, { ...SCOPED, ...FIGURE_ONLY }],
    ['.top-band', topBand, SCOPED],
  ] as const)
    for (const [modeName, set] of [
      ['light', light],
      ['dark', darkMedia],
    ] as const) {
      it(`${scopeName} (${modeName}): every colour is a theme token, and under talos it resolves to the colour origin/main hard-coded`, () => {
        const inside = { ...set, ...scope }
        for (const [name, [token, was]] of Object.entries(own)) {
          expect(scope[name], `${scopeName} ${name}`).toBe(`var(${token})`)
          expect(color(inside, name), `${scopeName} ${name}`).toBe(was)
        }
      })
    }
  it('no scoped block carries a colour of its own', () => {
    for (const scope of [figure, topBand])
      for (const [name, v] of Object.entries(scope)) if (name !== '--keyline') expect(v, name).toMatch(/^var\(--/)
  })
  it('the pair list names the new text tokens on every ground they sit on, and the non-text ones at 3:1', () => {
    const find = (fg: string, bg: string) => THEME_CONTRAST_PAIRS.find((p) => p.fg === fg && p.bg === bg)
    for (const fg of ['--figure-ok', '--figure-danger', '--figure-info'])
      for (const bg of ['--figure-bg', '--chrome', '--figure-surface'])
        expect(find(fg, bg)?.min, `${fg} on ${bg}`).toBe(4.5)
    for (const fg of ['--figure-focus', '--figure-meander-ink'])
      for (const bg of ['--figure-bg', '--chrome']) expect(find(fg, bg)?.min, `${fg} on ${bg}`).toBe(3)
    for (const bg of ['--figure-bg', '--figure-surface']) expect(find('--figure-wave', bg)?.min).toBe(3)
  })
  it('.frieze takes its warning colour from --frieze-warn', () => {
    expect(frieze['--warn']).toBe('var(--frieze-warn)')
  })
  it('the pair list checks every token the scoped blocks use, on the ground each one sits on', () => {
    const has = (fg: string, bg: string) => THEME_CONTRAST_PAIRS.some((p) => p.fg === fg && p.bg === bg)
    for (const fg of ['--figure-text', '--figure-text-2', '--figure-accent-text'])
      for (const bg of ['--figure-bg', '--chrome']) expect(has(fg, bg), `${fg} on ${bg}`).toBe(true)
    expect(has('--frieze-warn', '--chrome')).toBe(true)
    expect(has('--frieze-warn', '--chrome-active')).toBe(true)
    // .figure-ground paints --figure-bg, .top-band paints --chrome
    expect(css).toMatch(/\.figure-ground \{[^}]*background-color: var\(--figure-bg\)/)
    expect(css).toMatch(/\.top-band \{[^}]*background-color: var\(--chrome\)/)
    expect(THEME_CONTRAST_PAIRS.filter((p) => p.fg.startsWith('#'))).toEqual([])
  })

  // Inside .frieze the scoped --warn replaces the theme's (light's darker one is 2.6:1 on the black chrome).
  for (const [name, set] of [
    ['light', light],
    ['dark', darkMedia],
  ] as const) {
    it(`${name}: --warn inside .frieze is at least 4.5:1 on --chrome and --chrome-active`, () => {
      expect(frieze['--warn']).toBeDefined()
      const inside = { ...set, ...frieze }
      expect(ratio(color(inside, '--warn'), color(inside, '--chrome'))).toBeGreaterThanOrEqual(4.5)
      expect(ratio(color(inside, '--warn'), color(inside, '--chrome-active'))).toBeGreaterThanOrEqual(4.5)
    })
  }

  for (const [name, set] of [
    ['light', light],
    ['dark', darkMedia],
  ] as const) {
    for (const { fg, bg, min } of THEME_CONTRAST_PAIRS) {
      it(`${name}: ${fg} on ${bg} is at least ${min}:1`, () => {
        const ink = fg.startsWith('#') ? fg : color(set, fg)
        expect(ratio(ink, color(set, bg))).toBeGreaterThanOrEqual(min)
      })
    }
  }

  for (const [name, set] of [
    ['light', light],
    ['dark', darkMedia],
  ] as const) {
    it(`${name}: unplayed waveform bars are at least 3:1 on --surface (UI part)`, () => {
      expect(ratio(color(set, '--wave'), color(set, '--surface'))).toBeGreaterThanOrEqual(3)
    })
  }

  it('the primary button (black ink on terracotta) is 5.37:1 in both modes', () => {
    expect(ratio(color(light, '--on-accent'), color(light, '--accent'))).toBeCloseTo(5.37, 1)
    expect(color(light, '--accent')).toBe(color(darkMedia, '--accent'))
  })

  it('ichor glow is 10.5:1 on black', () => {
    expect(ratio(primitives['--talos-ichor'] as string, primitives['--talos-black'] as string)).toBeCloseTo(10.5, 0)
  })

  it('the terracotta is never used as text on cream (2.8:1)', () => {
    expect(ratio(primitives['--talos-terracotta'] as string, primitives['--talos-cream'] as string)).toBeLessThan(3)
    expect(light['--accent-text']).not.toBe('var(--talos-terracotta)')
  })
})

describe('default theme file', () => {
  it('matches tokens.css in both modes, radii and fonts', async () => {
    const { DEFAULT_THEME, THEME_COLOR_TOKENS, THEME_FONT_STACKS } = await import('@talos-app/protocol')
    for (const [mode, set] of [
      ['light', light],
      ['dark', darkMedia],
    ] as const)
      for (const name of THEME_COLOR_TOKENS) expect(DEFAULT_THEME[mode][name], `${mode} ${name}`).toBe(color(set, name))
    for (const [name, px] of Object.entries(DEFAULT_THEME.radius)) expect(`${px}px`).toBe(primitives[name])
    for (const [name, id] of Object.entries(DEFAULT_THEME.fonts)) expect(THEME_FONT_STACKS[id]).toBe(primitives[name])
  })
})
