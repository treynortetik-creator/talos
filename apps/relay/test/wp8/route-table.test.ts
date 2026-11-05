// FOLLOWUPS PR2 "no default-deny on /api/*": a route that is not in the protocol's route table stops the relay from
// starting, so no endpoint can ship without a declared login rule.
import { ROUTE_LIST } from '@talos-app/protocol'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { assertRouteTable, unlistedRoutes } from '../../src/route-table.ts'
import { buildApp } from '../../src/routes.ts'
import type { AppEnv } from '../../src/services.ts'
import { startTestRelay } from '../core/harness.ts'
import { createFakeServices } from '../helpers/fake-services.ts'

describe('route table', () => {
  it('every route the real modules register is in the protocol table', () => {
    const app = buildApp(createFakeServices().services)
    expect(unlistedRoutes(app)).toEqual([])
  })

  it("every auth:'session' row answers an anonymous caller with exactly 401 (the declared guard is enforced)", async () => {
    const relay = await startTestRelay()
    try {
      const fill = (path: string) => path.replace(':id', 'x0').replace(/:[a-z_]+/g, 'x0')
      let checked = 0
      for (const r of ROUTE_LIST) {
        if (r.auth !== 'session' || r.path === '/ws' || r.path === '/bridge') continue
        const res = await fetch(`${relay.httpBase}${fill(r.path)}`, {
          method: r.method,
          headers: { Origin: 'https://relay.example.com', 'X-Talos-CSRF': '1', 'content-type': 'application/json' },
          ...(r.method === 'GET' ? {} : { body: '{}' }),
        })
        expect(res.status, `${r.method} ${r.path}`).toBe(401)
        checked++
      }
      expect(checked).toBeGreaterThan(20)
    } finally {
      await relay.stop()
    }
  })

  it('an unlisted route under a guarded prefix is caught, whatever its method', () => {
    const app = new Hono<AppEnv>()
    app.get('/api/secret', (c) => c.json({ oops: true }))
    app.post('/bridge/backdoor', (c) => c.json({}))
    app.all('/hook/x/y/z', (c) => c.json({}))
    app.get('/media/:id/extra', (c) => c.json({}))
    expect(unlistedRoutes(app)).toEqual([
      'ALL /hook/x/y/z',
      'GET /api/secret',
      'GET /media/:id/extra',
      'POST /bridge/backdoor',
    ])
    expect(() => assertRouteTable(app)).toThrow(/default-deny/)
  })

  it('a listed path with the wrong method is caught too', () => {
    const app = new Hono<AppEnv>()
    app.delete('/api/me', (c) => c.json({}))
    expect(unlistedRoutes(app)).toEqual(['DELETE /api/me'])
  })

  it('paths outside the guarded prefixes are not its business (the static app)', () => {
    const app = new Hono<AppEnv>()
    app.get('/anything', (c) => c.text('ok'))
    expect(unlistedRoutes(app)).toEqual([])
  })
})
