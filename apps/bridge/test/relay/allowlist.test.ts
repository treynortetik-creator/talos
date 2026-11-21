// The bridge talks to Railway through one module, with a closed list of exact operations: one mutation, the rest read-only.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { RAILWAY_ENDPOINT, RAILWAY_OPERATIONS } from '../../src/relay/railway.ts'

const src = join(import.meta.dir, '..', '..', 'src')
const sources = (dir = src): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : []
  })

describe('the Railway allowlist', () => {
  test('the list is frozen, names the one endpoint, and holds exactly one mutation', () => {
    expect(RAILWAY_ENDPOINT).toBe('https://backboard.railway.com/graphql/v2')
    expect(Object.isFrozen(RAILWAY_OPERATIONS)).toBe(true)
    const all = Object.entries(RAILWAY_OPERATIONS)
    expect(all.map(([k]) => k).sort()).toEqual([
      'domains',
      'me',
      'project',
      'projectToken',
      'service',
      'serviceInstanceRedeploy',
    ])
    const mutations = all.filter(([, q]) => /^\s*mutation\b/.test(q))
    expect(mutations.map(([k]) => k)).toEqual(['serviceInstanceRedeploy'])
    for (const [k, q] of all) if (k !== 'serviceInstanceRedeploy') expect(q, k).toMatch(/^\s*query\b/)
  })
  test("the mutation is Railway's redeploy of one service instance, and nothing else is in the text", () => {
    expect(RAILWAY_OPERATIONS.serviceInstanceRedeploy).toBe(
      'mutation Redeploy($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }',
    )
  })
  test('the module holds no other GraphQL operation than the listed ones', () => {
    const text = readFileSync(join(src, 'relay', 'railway.ts'), 'utf8')
    const ops = [...text.matchAll(/(?:^|[`'"])\s*(query|mutation|subscription)\s+\w+/g)].map((m) => m[0].trim())
    expect(ops).toHaveLength(Object.keys(RAILWAY_OPERATIONS).length)
  })
  test("no other file in the bridge names Railway's endpoint, or any of the operations", () => {
    for (const f of sources()) {
      if (f.endsWith(join('relay', 'railway.ts'))) continue
      const text = readFileSync(f, 'utf8')
      const name = relative(src, f)
      expect(text, name).not.toMatch(/backboard\.railway/)
      expect(text, name).not.toMatch(/serviceInstanceRedeploy|projectToken\s*\{|Project-Access-Token/)
    }
  })
  test('only the Railway module sends a token header', () => {
    for (const f of sources()) {
      if (f.endsWith(join('relay', 'railway.ts'))) continue
      expect(readFileSync(f, 'utf8'), relative(src, f)).not.toMatch(/Bearer \$\{[^}]*railway/i)
    }
  })
})
