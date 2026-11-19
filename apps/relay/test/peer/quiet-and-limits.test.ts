// Linked agents P2 on the hooks test harness (fake bus, fake clock): quiet hours change nothing for a peer message, and the
// existing rate limits and body-size limit apply to it unchanged.
import { signStandard } from '@talos-app/integrations'
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { handleHookRequest } from '../../src/hooks/ingest.ts'
import { MAX_BODY_BYTES } from '../../src/hooks/types.ts'
import { framesOf, type Loose, setup } from '../hooks/harness.ts'

afterEach(() => resetAuthImplementation())

const quiet = (c: { quiet_window: { start: string; end: string } | null; timezone: string }) => {
  c.quiet_window = { start: '22:00', end: '07:00' }
  c.timezone = 'UTC'
}
const MAC = { 'x-test-bridge': 'key' }
const ID = 'msg_01HZX3K9M2Q4R5T6V7W8Y9ABCD'
const body = (over: Record<string, unknown> = {}) => ({
  v: 1,
  id: ID,
  from: 'home',
  text: 'hello',
  chain: 0,
  from_peer_task: false,
  sent_at: '2026-10-28T23:30:00.000Z',
  ...over,
})
async function made(s: ReturnType<typeof setup>): Promise<{ id: string; secret: string }> {
  const res = await s.api('POST', '/bridge/peers', { name: 'work' }, MAC)
  expect(res.status).toBe(201)
  const j = (await res.json()) as Loose
  return { id: j.conn_id, secret: j.secret }
}

describe('quiet hours', () => {
  it('a peer message goes to the bridge at once: no digest, no push, nothing for the apps', async () => {
    const s = setup({ config: quiet })
    const c = await made(s)
    s.f.clock.set(Date.parse('2026-10-28T23:30:00Z')) // inside the window
    expect((await s.send('peer', c.id, c.secret, body(), { id: ID })).status).toBe(200)
    await s.drain()
    expect(framesOf(s.f.bus.toBridgeLog, 'peer.message')).toHaveLength(1)
    expect(s.f.bus.toBridgeLog).toHaveLength(1)
    expect(s.f.bus.toAppsLog).toHaveLength(0)
    expect(s.f.push.intents).toEqual([])
    s.f.clock.set(Date.parse('2026-10-29T07:00:00Z')) // the window ends: the digest has nothing to say about it
    await s.tick()
    expect(framesOf(s.f.bus.toBridgeLog, 'hook.digest')).toHaveLength(0)
    expect(s.f.bus.toBridgeLog).toHaveLength(1)
    expect(s.f.push.intents).toEqual([])
    const f = framesOf(s.f.bus.toBridgeLog, 'peer.message')[0] as Loose
    expect(s.f.bus.toBridgeLog[0]?.opts).toMatchObject({ durable: true })
    expect(f.peer).toBe('work')
  })
})

describe('the existing limits apply unchanged', () => {
  const req = (s: ReturnType<typeof setup>, c: { id: string; secret: string }, extra: Record<string, unknown> = {}) => {
    const raw = JSON.stringify(body())
    const headers = signStandard({
      secret: c.secret,
      id: ID,
      timestampS: Math.floor(s.f.clock.now() / 1000),
      body: raw,
    })
    return {
      integration: 'peer',
      connId: c.id,
      method: 'POST',
      headers,
      url: `https://relay.example.com/hook/peer/${c.id}`,
      ip: '203.0.113.9',
      readBody: async () => new TextEncoder().encode(raw),
      ...extra,
    }
  }

  it('over the per-connection or the total rate: 429, nothing stored, and the id is not spent', async () => {
    const s = setup()
    const c = await made(s)
    for (const admit of ['conn', 'global'] as const) {
      const r = await handleHookRequest(s.rt, req(s, c, { admit: () => admit }))
      expect(r.status, admit).toBe(429)
    }
    expect(s.f.bus.toBridgeLog).toHaveLength(0)
    expect(s.count('hooks_dedup')).toBe(0)
    const ok = await handleHookRequest(s.rt, req(s, c, { admit: () => 'ok' }))
    expect(ok.status).toBe(200)
    expect(s.f.bus.toBridgeLog).toHaveLength(1)
  })

  it('a declared or an actual body over the cap is 413, read or not', async () => {
    const s = setup()
    const c = await made(s)
    expect((await handleHookRequest(s.rt, req(s, c, { declaredLength: MAX_BODY_BYTES + 1 }))).status).toBe(413)
    expect((await handleHookRequest(s.rt, req(s, c, { readBody: async () => null }))).status).toBe(413)
    expect(s.f.bus.toBridgeLog).toHaveLength(0)
  })

  it('a message is charged to the rate buckets only once it is verified', async () => {
    const s = setup()
    const c = await made(s)
    let charged = 0
    const admit = () => {
      charged++
      return 'ok' as const
    }
    const bad = req(s, c, { admit })
    bad.headers['webhook-signature'] = 'v1,AAAA'
    expect((await handleHookRequest(s.rt, bad)).status).toBe(401)
    expect(charged).toBe(0)
    expect((await handleHookRequest(s.rt, req(s, c, { admit }))).status).toBe(200)
    expect(charged).toBe(1)
  })
})

describe('the app cannot drive the peer inbox', () => {
  it('the Test button and a sample are refused for a peer row', async () => {
    const s = setup()
    const c = await made(s)
    const test = await s.api('POST', `/api/connections/${c.id}/test`, {})
    expect(test.status).toBe(403)
    const sample = await s.api('POST', `/api/connections/${c.id}/test`, { sample: true })
    expect(sample.status).toBe(403)
    expect(s.f.bus.toBridgeLog).toHaveLength(0)
    expect(s.count('hooks_deliveries')).toBe(0)
  })
})
