// Review fix #13: module output is parsed against NormalizedEvent before it is stored or sent to the Mac.
import type { IntegrationModule } from '@talos-app/integrations'
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { fakeWork, setup } from '../hooks/harness.ts'

afterEach(() => resetAuthImplementation())

function moduleWithTs(ts: string): IntegrationModule {
  const base = fakeWork('generic')
  return {
    ...base,
    setup: { ...base.setup, category: 'personal', default_thread: 'inbox' },
    normalize: async (raw, conn) => {
      const [e] = await base.normalize(raw, conn)
      return [{ ...(e as object), ts, dedup_key: `bad:${raw.receivedAt}`, work: false } as never]
    },
  }
}

describe('events a module returns', () => {
  it('an event with an unparseable timestamp is dropped, not stored or sent', async () => {
    const s = setup({ modules: { generic: moduleWithTs('+033658-01-01T00:00:00.000Z') } })
    const c = await s.create('generic')
    expect((await s.send('generic', c.id, c.secret, { title: 'x' })).status).toBe(200)
    await s.drain()
    expect(s.events()).toHaveLength(0)
    expect(s.f.bus.toBridgeLog.filter((l) => l.frame.type === 'hook.event')).toHaveLength(0)
  })

  it('a good event still goes through', async () => {
    const s = setup({ modules: { generic: moduleWithTs('2026-10-28T12:00:00.000Z') } })
    const c = await s.create('generic')
    expect((await s.send('generic', c.id, c.secret, { title: 'x' })).status).toBe(200)
    await s.drain()
    expect(s.events()).toHaveLength(1)
  })
})
