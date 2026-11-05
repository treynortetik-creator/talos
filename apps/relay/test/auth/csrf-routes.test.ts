// Every state-changing route that takes the browser cookie must demand the CSRF header on the real relay.
// The shared test auth turns the CSRF check into a no-op, so this file runs the real auth module.
import { ROUTE_LIST } from '@talos-app/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORIGIN } from '../core/harness.ts'
import { type RealRelay, startRealRelay } from '../review/real-relay.ts'

vi.setConfig({ testTimeout: 30_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

const fill = (p: string) => p.replace(/:[A-Za-z_]+/g, 'x0')
const writes = ROUTE_LIST.filter(
  (x) => x.auth === 'session' && x.method !== 'GET' && x.path !== '/ws' && x.path !== '/bridge',
)

describe('CSRF on every cookie-authenticated write route', () => {
  it('the sweep covers a meaningful number of routes', () => {
    expect(writes.length).toBeGreaterThan(10)
  })

  it('a signed-in cookie without the CSRF header is refused on each, and with it the same call gets past the guard', async () => {
    r = await startRealRelay()
    for (const route of writes) {
      // A fresh session per route: logout routes end the session they are called with.
      const owner = await r.owner()
      const url = `${r.httpBase}${fill(route.path)}`
      const base = { Cookie: owner.cookie, Origin: ORIGIN, 'content-type': 'application/json' }
      const without = await fetch(url, { method: route.method, headers: base, body: '{}' })
      const refusal = await without.json().catch(() => null)
      expect([without.status, refusal], `${route.method} ${route.path} without the header`).toEqual([
        403,
        { error: 'csrf_header' },
      ])
      // Control: the identical call with the header is not stopped by the CSRF guard (it may fail later for other reasons).
      const withHeader = await fetch(url, {
        method: route.method,
        headers: { ...base, 'X-Talos-CSRF': '1' },
        body: '{}',
      })
      const body = (await withHeader.json().catch(() => ({}))) as { error?: string }
      expect(body.error, `${route.method} ${route.path} with the header`).not.toBe('csrf_header')
    }
  })
})
