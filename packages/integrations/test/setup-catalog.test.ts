import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSetupSpecs as fullList } from '../src/catalog.ts'
import { listSetupSpecs, setupCatalog } from '../src/setup-catalog.ts'

describe('browser-safe setup catalog', () => {
  it('matches the full catalog, spec for spec and in the same order', () => {
    expect(listSetupSpecs()).toEqual(fullList())
  })

  it('has one entry per id, each under its own key', () => {
    for (const [id, spec] of Object.entries(setupCatalog)) expect(spec.id).toBe(id)
  })

  it('imports nothing from node:* anywhere in its import graph', () => {
    const seen = new Set<string>()
    const walk = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const src = readFileSync(file, 'utf8')
      expect(src, file).not.toMatch(/from\s+['"]node:/)
      for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) walk(join(file, '..', m[1] as string))
    }
    walk(join(import.meta.dirname, '../src/setup-catalog.ts'))
    expect(seen.size).toBeGreaterThan(15)
  })
})
