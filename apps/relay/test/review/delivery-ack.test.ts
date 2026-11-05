// Review fix #22: an event counts as delivered when the Mac acks it, not when the relay wrote it to a socket. A send the
// Mac never received must not cost the raw payload that /bridge/raw serves.
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { fakeWork, framesOf, setup } from '../hooks/harness.ts'

afterEach(() => resetAuthImplementation())

function withWork() {
  return setup({
    modules: { slack: fakeWork('slack') },
    config: (c) => {
      c.threads.push({
        id: 'work',
        name: 'Work',
        icon: 'briefcase',
        kind: 'fixed',
        order: 5,
        notify: 'all',
        voice_context: 'recent',
        archived: false,
        created_at: '2026-10-28T00:00:00.000Z',
      })
      c.work.thread = 'work'
      c.work.enabled = ['slack']
      c.work.retention = 'passthrough'
    },
  })
}

describe('passthrough work events', () => {
  it('written to a live socket but not acked: the raw payload is still there', async () => {
    const s = withWork()
    s.f.bus.setBridgeOnline(true) // the relay believes the socket is up and "sends"
    const c = await s.create('slack')
    await s.send('slack', c.id, c.secret, { title: 'in flight', id: 'p9' })
    await s.drain()
    const sent = framesOf(s.f.bus.toBridgeLog, 'hook.event')[0] as { id: string; event: { id: string } }
    expect((s.events()[0] as { delivered_at: number | null }).delivered_at).toBeNull()
    const raw = await s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}/bridge/raw/${sent.event.id}`, {
      headers: { 'x-test-bridge': 'k' },
    })
    expect(raw.status).toBe(200)
  })

  it('once the Mac acks, the event row and the raw payload are purged', async () => {
    const s = withWork()
    s.f.bus.setBridgeOnline(true)
    const c = await s.create('slack')
    await s.send('slack', c.id, c.secret, { title: 'acked', id: 'p10' })
    await s.drain()
    const sent = framesOf(s.f.bus.toBridgeLog, 'hook.event')[0] as { id: string; event: { id: string } }
    await s.f.bus.injectBridgeFrame({
      v: 1,
      type: 'ack',
      id: '01JBF3WA0H1J2K3M4N5P6Q7R8T',
      ts: new Date().toISOString(),
      ref: sent.id,
      stage: 'delivered',
    })
    expect(s.events()).toHaveLength(0)
    const raw = await s.app.request(`${s.f.services.env.PUBLIC_ORIGIN}/bridge/raw/${sent.event.id}`, {
      headers: { 'x-test-bridge': 'k' },
    })
    expect(raw.status).toBe(404)
  })
})
