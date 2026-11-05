// Review #32 (putCard keeps created_at) and #33 (a bodyTimeout 408 means the late upload is discarded).
import { fakeClock } from '@talos-app/testkit'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { bodyTimeout, lateRequest } from '../../src/core/body-guard.ts'
import type { AppEnv } from '../../src/services.ts'
import { startTestRelay, type TestRelay } from './harness.ts'

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

describe('late upload after the body timeout (#33)', () => {
  it('a handler that wakes after the 408 sees the request abandoned and saves nothing', async () => {
    const saved: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const app = new Hono<AppEnv>()
    app.post('/up', bodyTimeout(30), async (c) => {
      await gate // the upload is still arriving
      if (lateRequest(c)) return c.json({ error: 'request_timeout' }, 408)
      saved.push('bytes')
      return c.json({ ok: true })
    })
    const res = await app.request('/up', { method: 'POST', body: 'x' })
    expect(res.status).toBe(408)
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(saved).toEqual([])
  })

  it('a handler inside the window is untouched', async () => {
    const app = new Hono<AppEnv>()
    app.post('/up', bodyTimeout(500), (c) => c.json({ late: lateRequest(c) }))
    const res = await app.request('/up', { method: 'POST', body: 'x' })
    expect(await res.json()).toEqual({ late: false })
  })
})

describe('putCard (#32)', () => {
  it('keeps the original created_at across state changes', async () => {
    const clock = fakeClock()
    relay = await startTestRelay({ clock })
    const { store } = relay.runtime
    const card = {
      id: 'cd_01JBF3V7Q8K2M4N6P8R0S2T4V6',
      thread_id: 'general',
      state: 'open',
      risk: 'low',
      payload_hash: 'h',
      expires_at: new Date(clock.now() + 3600_000).toISOString(),
    } as never
    store.putCard(card)
    const db = relay.relay.services.db
    const at = () => (db.prepare('select created_at from core_cards').get() as { created_at: number }).created_at
    const first = at()
    clock.advance(60_000)
    store.setCardState((card as { id: string }).id, { state: 'resolved' } as never)
    expect(at()).toBe(first)
  })
})
