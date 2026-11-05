import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import { AgentConfig, STOCK_THEMES } from '../src/index.ts'

const parse = (extra: Record<string, unknown>) => AgentConfig.parse({ ...defaultConfig, ...extra })

describe('config theme', () => {
  it('is absent when the file does not say, which means talos', () => {
    expect(parse({}).theme).toBeUndefined()
  })
  it('keeps each stock theme id, and the ids are the stock theme names', () => {
    for (const t of STOCK_THEMES) expect(parse({ theme: t.name }).theme).toBe(t.name)
  })
  for (const junk of ['neon', '', 'PAPER', 7, null, {}, ['paper'], '../paper'])
    it(`reads ${JSON.stringify(junk)} as absent instead of failing the whole config`, () => {
      const c = parse({ theme: junk })
      expect(c.theme).toBeUndefined()
      expect(c.agent.name).toBe('Talos')
    })
  it('an older bridge schema (no theme key) still parses a file that has one', () => {
    const { theme: _drop, ...rest } = AgentConfig.shape
    expect(() => AgentConfig.omit({ theme: true }).parse({ ...defaultConfig, theme: 'hearth' })).not.toThrow()
    expect(Object.keys(rest)).not.toContain('theme')
  })
})

describe('config theme: a custom theme block (K9c)', () => {
  const dusk = { ...structuredClone(STOCK_THEMES[1]), name: 'dusk' }
  it('keeps a valid custom theme as a fresh copy and drops an invalid one', () => {
    const c = parse({ theme: dusk })
    expect(c.theme).toEqual(dusk)
    expect(c.theme).not.toBe(dusk)
    const bad = structuredClone(dusk) as any
    bad.light['--accent'] = 'url(https://x.example/a.png)'
    expect(parse({ theme: bad }).theme).toBeUndefined()
  })
  it('an older bridge schema (theme is a stock id only) ignores a custom theme block and keeps the rest', () => {
    const old = AgentConfig.extend({ theme: z.enum(['talos', 'paper', 'hearth']).optional().catch(undefined) })
    const c = old.parse({ ...defaultConfig, theme: dusk })
    expect(c.theme).toBeUndefined()
    expect(c.agent.name).toBe('Talos')
  })
})
