// @vitest-environment jsdom
import {
  DEFAULT_THEME,
  STOCK_THEMES,
  THEME_COLOR_TOKENS,
  THEME_FONT_TOKENS,
  THEME_RADIUS_TOKENS,
} from '@talos-app/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyThemeTokens } from '../src/lib/theme.ts'

const root = () => document.documentElement
beforeEach(() => root().removeAttribute('style'))

describe('applyThemeTokens', () => {
  it('sets the chosen mode colours, radii and font stacks on the root', () => {
    const t = STOCK_THEMES[1] as (typeof STOCK_THEMES)[number]
    applyThemeTokens(t, 'dark')
    expect(root().style.getPropertyValue('--bg')).toBe(t.dark['--bg'])
    expect(root().style.getPropertyValue('--accent')).toBe(t.dark['--accent'])
    expect(root().style.getPropertyValue('--radius-card')).toBe(`${t.radius['--radius-card']}px`)
    expect(root().style.getPropertyValue('--font-ui')).toContain(',')
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
    for (const group of ['light', 'dark', 'radius', 'fonts'])
      t[group] = Object.fromEntries(Object.entries(t[group] as object).reverse())
    const spy = vi.spyOn(document.documentElement.style, 'setProperty')
    const r = applyThemeTokens(t, 'light')
    expect(r.applied).toBe('theme')
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      ...THEME_COLOR_TOKENS,
      ...THEME_RADIUS_TOKENS,
      ...THEME_FONT_TOKENS,
    ])
    spy.mockRestore()
  })
})
