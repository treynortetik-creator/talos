// @vitest-environment jsdom
import { DEFAULT_THEME, STOCK_THEMES, THEME_COLOR_TOKENS } from '@talos-app/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyThemeTokens, setStockTheme, themeDeclarations } from '../src/lib/theme.ts'

const root = () => document.documentElement
beforeEach(() => root().removeAttribute('style'))

describe('applyThemeTokens', () => {
  it('sets the chosen mode colours on the root', () => {
    const t = STOCK_THEMES[1] as (typeof STOCK_THEMES)[number]
    applyThemeTokens(t, 'dark')
    expect(root().style.getPropertyValue('--bg')).toBe(t.dark['--bg'])
    expect(root().style.getPropertyValue('--accent')).toBe(t.dark['--accent'])
  })

  // A theme changes colours only: fonts, sizes and radii are always tokens.css's own.
  it('returns only colour tokens for every stock theme and for a legacy custom theme with radius and fonts', () => {
    const legacy = {
      ...structuredClone(STOCK_THEMES[1]),
      name: 'dusk',
      radius: { '--radius-card': 20, '--radius-bubble': 20, '--radius-button': 20 },
      fonts: { '--font-display': 'cinzel', '--font-ui': 'cinzel', '--font-mono': 'cinzel' },
    }
    for (const t of [...STOCK_THEMES, legacy])
      for (const mode of ['light', 'dark'] as const) {
        const { vars, problems } = themeDeclarations(t, mode)
        expect(problems, t.name).toEqual([])
        expect(Object.keys(vars), t.name).toEqual([...THEME_COLOR_TOKENS])
      }
    applyThemeTokens(legacy, 'light')
    expect(root().style.getPropertyValue('--font-ui')).toBe('')
    expect(root().style.getPropertyValue('--radius-card')).toBe('')
  })

  it('leaves no inline font or radius on <html> after paper then talos, even from an older build', () => {
    for (const n of [
      '--font-display',
      '--font-ui',
      '--font-mono',
      '--radius-card',
      '--radius-bubble',
      '--radius-button',
    ])
      root().style.setProperty(n, 'inherit')
    setStockTheme('paper')
    setStockTheme('talos')
    expect(root().getAttribute('style') ?? '').not.toMatch(/--font-|--radius-/)
    for (const n of ['--font-ui', '--radius-card']) root().style.setProperty(n, 'inherit')
    setStockTheme('paper')
    expect(root().getAttribute('style') ?? '').not.toMatch(/--font-|--radius-/)
    setStockTheme('talos')
  })

  it('never sets a name outside the allowlist, even from a hand-built object', () => {
    const t = structuredClone(DEFAULT_THEME) as unknown as Record<string, Record<string, unknown>>
    t.light['--pattern-meander'] = 'url(https://example.com/x.svg)'
    t.light['--evil'] = '#000000'
    applyThemeTokens(t, 'light')
    expect(root().style.getPropertyValue('--pattern-meander')).toBe('')
    expect(root().style.getPropertyValue('--evil')).toBe('')
    expect(root().style.getPropertyValue('--accent')).toBe(DEFAULT_THEME.light['--accent'])
  })

  it('falls back to the default theme when the theme is invalid', () => {
    const t = structuredClone(DEFAULT_THEME) as unknown as Record<string, Record<string, unknown>>
    t.light['--accent'] = 'url(https://example.com/x.png)'
    t.light['--bg'] = '#000000'
    applyThemeTokens(t, 'light')
    expect(root().style.getPropertyValue('--accent')).toBe(DEFAULT_THEME.light['--accent'])
    expect(root().style.getPropertyValue('--bg')).toBe(DEFAULT_THEME.light['--bg'])
    applyThemeTokens('not a theme', 'dark')
    expect(root().style.getPropertyValue('--bg')).toBe(DEFAULT_THEME.dark['--bg'])
  })

  it('reports which theme was applied and why a fallback happened', () => {
    expect(applyThemeTokens(DEFAULT_THEME, 'light')).toEqual({ applied: 'theme', problems: [] })
    const bad = structuredClone(DEFAULT_THEME) as unknown as Record<string, Record<string, unknown>>
    bad.light['--accent'] = 'url(https://example.com/x.png)'
    const r = applyThemeTokens(bad, 'light')
    expect(r.applied).toBe('default')
    expect(r.problems.length).toBe(1)
    expect(r.problems[0]).toContain('--accent')
    const low = structuredClone(DEFAULT_THEME) as unknown as Record<string, Record<string, unknown>>
    low.dark['--ok'] = low.dark['--bg']
    expect(applyThemeTokens(low, 'dark').problems[0]).toContain('--ok')
    expect(applyThemeTokens('nope', 'dark').applied).toBe('default')
  })

  it('writes the allowlist in its own order, whatever order the theme lists its keys in', () => {
    const t = structuredClone(STOCK_THEMES[1]) as unknown as Record<string, Record<string, unknown>>
    for (const group of ['light', 'dark']) t[group] = Object.fromEntries(Object.entries(t[group] as object).reverse())
    const spy = vi.spyOn(document.documentElement.style, 'setProperty')
    const r = applyThemeTokens(t, 'light')
    expect(r.applied).toBe('theme')
    expect(spy.mock.calls.map((c) => c[0])).toEqual([...THEME_COLOR_TOKENS])
    spy.mockRestore()
  })
})
