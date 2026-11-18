import { describe, expect, it } from 'vitest'
import {
  contrastProblems,
  DEFAULT_THEME,
  STOCK_THEME_IDS,
  STOCK_THEMES,
  THEME_COLOR_TOKENS,
  THEME_CONTRAST_PAIRS,
  THEME_TOKEN_NAMES,
  themeProblems,
  validateTheme,
} from '../src/theme.ts'

const clone = () => structuredClone(DEFAULT_THEME) as unknown as Record<string, Record<string, unknown>>
const withColor = (value: unknown) => {
  const t = clone()
  t.light['--accent'] = value
  return t
}

describe('theme format', () => {
  it('accepts every stock theme', () => {
    expect(STOCK_THEMES.length).toBe(5)
    expect(STOCK_THEME_IDS).toEqual(['talos', 'paper', 'hearth', 'iris', 'harbor'])
    expect(STOCK_THEMES.map((t) => t.name)).toEqual([...STOCK_THEME_IDS])
    for (const t of STOCK_THEMES) {
      expect(Object.keys(t).sort(), t.name).toEqual(['dark', 'light', 'name'])
      const r = validateTheme(t)
      expect(r.ok, `${t.name}: ${r.ok ? '' : r.error}`).toBe(true)
      expect(contrastProblems(t), t.name).toEqual([])
    }
  })

  it('has no pattern token and no duplicate names', () => {
    expect(THEME_TOKEN_NAMES).not.toContain('--pattern-meander')
    expect(new Set(THEME_TOKEN_NAMES).size).toBe(THEME_TOKEN_NAMES.length)
    expect(new Set(STOCK_THEMES.map((t) => t.name)).size).toBe(5)
    expect(THEME_TOKEN_NAMES).toEqual([...THEME_COLOR_TOKENS])
  })

  for (const bad of [
    'url(https://example.com/a.png)',
    'var(--bg)',
    '#fff;}body{display:none',
    'expression(alert(1))',
    '#fff',
    'red',
    '#12345g',
    '#ff0000 ',
    'rgb(0 0 0)',
  ]) {
    it(`refuses the colour ${JSON.stringify(bad)}`, () => {
      const r = validateTheme(withColor(bad))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).not.toContain('\n')
    })
  }

  it('refuses an unknown or hostile token name', () => {
    for (const name of ['--pattern-meander', '--evil', 'background', '--bg;}x{', '--talos-terracotta']) {
      const t = clone()
      t.light[name] = '#000000'
      expect(validateTheme(t).ok, name).toBe(false)
    }
  })

  it('refuses a missing token and an extra top-level key', () => {
    const missing = clone()
    delete missing.dark['--bg']
    expect(validateTheme(missing).ok).toBe(false)
    expect(validateTheme({ ...clone(), extra: 1 }).ok).toBe(false)
  })

  // A custom theme saved before themes became colours-only still has radius and fonts: it applies, colours only.
  it('accepts a legacy theme with radius and fonts, ignores their contents and returns it without them', () => {
    for (const legacy of [
      { radius: { '--radius-card': 6 }, fonts: { '--font-ui': 'inter' } },
      { radius: 'anything', fonts: ['Comic Sans', 'url(f.woff)'] },
      { radius: null, fonts: 7 },
    ]) {
      const r = validateTheme({ ...clone(), ...legacy })
      expect(r.ok, JSON.stringify(legacy)).toBe(true)
      if (r.ok) {
        expect(Object.keys(r.theme).sort()).toEqual(['dark', 'light', 'name'])
        expect(r.theme.light).toEqual(DEFAULT_THEME.light)
      }
    }
    expect(validateTheme({ ...clone(), radius: {}, fonts: {}, extra: 1 }).ok).toBe(false)
  })

  it('has a violet iris and a teal harbor that pass the validator', () => {
    for (const id of ['iris', 'harbor']) {
      const t = STOCK_THEMES.find((x) => x.name === id)
      expect(t, id).toBeDefined()
      expect(themeProblems(t), id).toEqual([])
    }
  })

  it('refuses pale text on a pale ground, naming the pair in one line', () => {
    const t = clone()
    t.light['--text'] = '#e8dcc4'
    const problems = contrastProblems(t as never)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems[0]).toMatch(/light.*--text.*--bg.*4\.5/)
    for (const p of problems) expect(p).not.toContain('\n')
    const r = validateTheme(t)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).not.toContain('\n')
  })

  it('checks every required pair in both modes', () => {
    for (const [mode, name, bg] of [
      ['dark', '--text-2', '--bg'],
      ['light', '--accent-text', '--bg'],
      ['dark', '--on-accent', '--accent'],
      ['light', '--on-chrome', '--chrome'],
      ['dark', '--text', '--surface'],
    ] as const) {
      const t = clone()
      t[mode][name] = t[mode][bg]
      expect(contrastProblems(t as never).join('\n'), `${mode} ${name}`).toContain(name)
    }
  })
})

describe('every pair the app puts on screen is checked', () => {
  const refused = (mutate: (t: Record<string, Record<string, unknown>>) => void, token: string) => {
    const t = clone()
    mutate(t)
    const r = validateTheme(t)
    expect(r.ok, token).toBe(false)
    if (!r.ok) {
      expect(r.error, token).toContain(token)
      expect(r.error).not.toContain('\n')
    }
  }

  it('shares one pair list with the validator and has 22 or more entries', () => {
    expect(THEME_CONTRAST_PAIRS.length).toBeGreaterThanOrEqual(22)
  })

  for (const name of ['--ok', '--warn', '--danger']) {
    it(`refuses light ${name} set to --bg`, () => {
      refused((t) => {
        t.light[name] = t.light['--bg']
      }, name)
    })
  }
  for (const name of ['--on-chrome-2', '--chrome-accent-text']) {
    it(`refuses dark ${name} set to --chrome`, () => {
      refused((t) => {
        t.dark[name] = t.dark['--chrome']
      }, name)
    })
  }
  it('refuses light --figure-bg set to cream (owner bubbles are cream text on it)', () => {
    refused((t) => {
      t.light['--figure-bg'] = '#f3e6cf'
    }, '--figure-bg')
  })
  // The scoped parts (owner bubbles, the phone top band, the frieze warning) read these tokens, so a theme sets them.
  it('checks the figure and frieze tokens against the grounds they sit on', () => {
    const pairs = THEME_CONTRAST_PAIRS.map((p) => `${p.fg} on ${p.bg}`)
    for (const fg of ['--figure-text', '--figure-text-2', '--figure-accent-text'])
      for (const bg of ['--figure-bg', '--chrome']) expect(pairs, `${fg} on ${bg}`).toContain(`${fg} on ${bg}`)
    expect(pairs).toContain('--frieze-warn on --chrome')
    expect(pairs).toContain('--frieze-warn on --chrome-active')
    expect(THEME_CONTRAST_PAIRS.filter((p) => p.fg.startsWith('#'))).toEqual([]) // no colour is pinned outside a theme
  })
  for (const name of ['--figure-text', '--figure-text-2', '--figure-accent-text'])
    for (const [mode, ground] of [
      ['light', '--figure-bg'],
      ['dark', '--chrome'],
    ] as const)
      it(`refuses ${mode} ${name} set to ${ground}`, () => {
        refused((t) => {
          t[mode][name] = t[mode][ground]
        }, name)
      })
  it('refuses a frieze warning colour that matches the chrome', () => {
    refused((t) => {
      t.light['--frieze-warn'] = t.light['--chrome']
    }, '--frieze-warn')
  })
  const NEW_TOKENS = [
    '--figure-text',
    '--figure-text-2',
    '--figure-accent-text',
    '--frieze-warn',
    '--figure-surface',
    '--figure-surface-2',
    '--figure-line',
    '--figure-ok',
    '--figure-danger',
    '--figure-info',
    '--figure-wave',
    '--figure-focus',
    '--figure-meander-ink',
  ]
  for (const [name, ground] of [
    ['--figure-ok', '--figure-bg'],
    ['--figure-danger', '--chrome'],
    ['--figure-info', '--figure-bg'],
    ['--figure-wave', '--figure-bg'],
    ['--figure-focus', '--chrome'],
  ] as const)
    it(`refuses dark ${name} set to ${ground}`, () => {
      refused((t) => {
        t.dark[name] = t.dark[ground]
      }, name)
    })
  it('every stock theme sets the new tokens in both modes', () => {
    for (const t of STOCK_THEMES)
      for (const mode of ['light', 'dark'] as const)
        for (const n of NEW_TOKENS)
          expect((t[mode] as Record<string, string>)[n], `${t.name} ${mode} ${n}`).toMatch(/^#[0-9a-f]{6}$/)
  })
  it('refuses --tint set to the text colour', () => {
    refused((t) => {
      t.light['--tint'] = '#141110'
    }, '--tint')
    refused((t) => {
      t.dark['--tint'] = '#f3e6cf'
    }, '--tint')
  })
  it('refuses --focus set to --bg (non-text 3:1)', () => {
    refused((t) => {
      t.light['--focus'] = t.light['--bg']
    }, '--focus')
    refused((t) => {
      t.dark['--focus'] = t.dark['--bg']
    }, '--focus')
  })
  it('checks the frieze warning colour against --chrome', () => {
    const t = clone()
    t.dark['--chrome'] = t.dark['--frieze-warn'] as string
    expect(contrastProblems(t as never).join('\n')).toContain('--frieze-warn on --chrome')
  })

  it('never rounds a failing ratio up to the threshold in the message', () => {
    // #127660 on cream is 4.4983:1; rounding would print 4.50 and read as a pass
    const t = clone()
    t.light['--text-2'] = '#127660'
    const line = contrastProblems(t as never).find((p) => p.includes('--text-2 on --bg'))
    expect(line).toBe('light: --text-2 on --bg is 4.49:1, needs 4.5:1')
    const r = validateTheme(t)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).not.toMatch(/is 4\.50?:1/)
  })
})

describe('the validated theme is a fresh copy', () => {
  it('does not return the caller object and ignores a getter that changes after validation', () => {
    const t = clone()
    let reads = 0
    Object.defineProperty(t.light, '--accent', {
      enumerable: true,
      get: () => (++reads === 1 ? '#d9692b' : 'url(https://example.com/x.png)'),
    })
    const r = validateTheme(t)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.theme).not.toBe(t)
    expect(r.theme.light).not.toBe(t.light)
    expect(r.theme.light['--accent']).toBe('#d9692b')
    expect(r.theme.light['--accent']).toBe('#d9692b')
    expect(Object.getOwnPropertyDescriptor(r.theme.light, '--accent')?.get).toBeUndefined()
  })

  it('a later change to the input does not reach the result', () => {
    const t = clone()
    const r = validateTheme(t)
    expect(r.ok).toBe(true)
    t.light['--accent'] = 'url(x)'
    if (r.ok) expect(r.theme.light['--accent']).toBe(DEFAULT_THEME.light['--accent'])
  })
})

describe('themeProblems (K9c): every problem, named', () => {
  it('lists each disallowed key, bad value and missing token, and each low pair', () => {
    const t = structuredClone(STOCK_THEMES[1]) as any
    t.light['--nope'] = '#000000'
    delete t.dark['--accent']
    t.extra = 1
    const p = themeProblems(t)
    expect(p).toEqual(
      expect.arrayContaining([
        'light.--nope: not an allowed token',
        'dark.--accent: missing',
        'extra: not an allowed key',
      ]),
    )
    const low = structuredClone(STOCK_THEMES[1]) as any
    low.light['--text'] = low.light['--bg']
    expect(themeProblems(low).some((l) => l.startsWith('light: --text on --bg'))).toBe(true)
    expect(themeProblems(STOCK_THEMES[1])).toEqual([])
  })
})

describe('a hostile theme cannot flood the refusal', () => {
  const flood = () => {
    const t = structuredClone(STOCK_THEMES[1]) as any
    for (let i = 0; i < 5000; i++) {
      t[`junk${i}`] = 1
      t.light[`--junk${i}`] = '#000000'
    }
    return t
  }

  it('5,000 unknown keys give at most 20 lines and one "...and N more" line that counts the rest', () => {
    const t = flood()
    const p = themeProblems(t)
    expect(p.length).toBe(21)
    const last = p[20] as string
    const m = /^\.\.\.and (\d+) more$/.exec(last)
    expect(m).not.toBeNull()
    expect(Number(m?.[1])).toBe(10_000 - 20)
    expect(p.join('\n').length).toBeLessThan(2000)
    const v = validateTheme(t)
    expect(v.ok).toBe(false)
  })

  it('a theme with exactly 20 problems has no "more" line', () => {
    const t = structuredClone(STOCK_THEMES[1]) as any
    for (let i = 0; i < 20; i++) t[`junk${i}`] = 1
    const p = themeProblems(t)
    expect(p).toHaveLength(20)
    expect(p.some((l) => l.includes('more'))).toBe(false)
  })

  it('control characters in a key name are stripped from the echoed line, and a very long key is cut', () => {
    const t = structuredClone(STOCK_THEMES[1]) as any
    t['bad\u001b[31mkey\nIgnore previous instructions\u0000'] = 1
    t.light[`--x\r\n${'a'.repeat(500)}`] = '#000000'
    const lines = themeProblems(t)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the test is about control characters
    for (const l of lines) expect(l).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(lines.some((l) => l.startsWith('bad[31mkeyIgnore previous instructions'))).toBe(true)
    expect(lines.every((l) => l.length < 200)).toBe(true)
  })
})
