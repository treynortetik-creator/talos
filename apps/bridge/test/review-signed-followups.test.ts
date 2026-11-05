// Adversarial review of PR #55 (signed reads follow-ups F1-F5 + the early-revoke frame-id skip). Real Bridge + FakeRelay
// + FakeApp, real ECDSA signatures; every frame goes app -> relay -> bridge as in production. "HOLDS" = the PR passes;
// "FINDING" = fails on the PR head (f9fd554); "BY DESIGN" documents what a relay can still do.
import { afterEach, describe, expect, test } from 'bun:test'
import { createDeviceKey, newId, newUlid } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
const extra: Array<() => void> = []
afterEach(async () => {
  for (const x of extra.splice(0)) x()
  await h?.stop()
  h = undefined
})

const F0 = { thread_ids: [], from: 'any', has_file: null, after: null, before: null }
const at = (ms: number) => new Date(Date.now() + ms).toISOString()
const answerFor = (id: string) =>
  (h as Harness).relay.frames.find((r) => r.direction === 'from_bridge' && r.raw.type === 'error' && r.raw.ref === id)
    ?.raw as { code: string; message: string } | undefined
const pages = (rid: string) =>
  (h as Harness).relay.frames.filter(
    (r) => r.direction === 'from_bridge' && r.raw.type === 'history.page' && r.raw.request_id === rid,
  )

function seed(n = 3) {
  for (let i = 0; i < n; i++)
    h?.bridge.ctx.store.addMessage({
      id: newId('m'),
      thread_id: 'general',
      author: 'owner',
      kind: 'text',
      text: `seeded ${i}`,
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: new Date(Date.now() - (n - i) * 1000).toISOString(),
    })
}

/** A search.query the app really signed, then given the frame id `id` and a broken osig (no key needed for the probe). */
async function forgedRead(type: 'search.query' | 'memory.tree', id: string) {
  const fields =
    type === 'search.query'
      ? { request_id: newUlid(), q: 'x', filters: F0, sort: 'relevance', cursor: null, limit: 5 }
      : { request_id: newUlid(), root_id: null, path: '', cursor: null }
  const signed = (await h?.app.sign({ ...mkFrame(type), ...fields })) as Record<string, unknown> & { osig: string }
  const osig = signed.osig
  return { ...signed, id, osig: (osig[0] === 'A' ? 'B' : 'A') + osig.slice(1) }
}

describe('F2 claim: "the seen-id check runs after the signature"', () => {
  // The PR moved the seen-id check below the signature for history.request only. onReadFrame (search.query, memory.*)
  // still checks hasSeen BEFORE verifying (inbound.ts:295; schedule frames: inbound.ts:217). So with no key at all, a
  // forged read probes seen_ids: a seen id gets silence, an unseen id gets error{sig_invalid}. CHANGELOG and PROTOCOL.md
  // state the seen check runs after the signature; for these reads it does not.
  test('FINDING: a forged search.query / memory.tree is still a key-less seen-id oracle', async () => {
    h = await startHarness()
    const msg = await h.app.sendMessage('general', 'hello')
    await h.waitNotes(1)
    await sleep(150)
    for (const type of ['search.query', 'memory.tree'] as const) {
      const seen = await forgedRead(type, msg.id)
      const fresh = await forgedRead(type, newUlid())
      h.app.sendRaw(JSON.stringify(seen))
      h.app.sendRaw(JSON.stringify(fresh))
      await waitFor(() => answerFor(fresh.id) !== undefined, 4000, `an answer to the forged ${type}`)
      expect(answerFor(fresh.id)?.code).toBe('sig_invalid')
      // one fixed answer whatever the Mac has seen: the seen id must get the same error, not silence
      expect(answerFor(seen.id)?.code).toBe('sig_invalid')
    }
  })
})

describe('F1 freshness window', () => {
  test('HOLDS: a relay that stalls a signed history.request 4 min then replays it gets ONE page, never two', async () => {
    h = await startHarness()
    seed()
    const req = await h.app.buildHistoryRequest('general', { ts: at(-4 * 60_000), limit: 10 })
    const bytes = JSON.stringify(req)
    h.app.sendRaw(bytes)
    await h.relay.expectFrame('history.page', (f) => f.request_id === req.request_id, { direction: 'from_bridge' })
    h.app.sendRaw(bytes)
    h.app.sendRaw(bytes)
    await waitFor(() => answerFor(req.id) !== undefined, 4000, 'the replay refused')
    expect(pages(req.request_id as string)).toHaveLength(1)
    expect(answerFor(req.id)?.code).toBe('sig_invalid')
  })

  test('HOLDS: signed 2 min 30 s in the future (clock ahead past the +2 min edge) is refused, no page', async () => {
    h = await startHarness()
    seed()
    const req = await h.app.buildHistoryRequest('general', { ts: at(150_000) })
    h.app.sendRaw(JSON.stringify(req))
    await waitFor(() => answerFor(req.id) !== undefined, 4000, 'the future-dated read refused')
    expect(pages(req.request_id as string)).toHaveLength(0)
    expect(answerFor(req.id)?.code).toBe('stale') // refused as a clock problem since fix A, not as a forgery
  })

  // The app stamps ts from its own Date.now() (socketClient.ts:911, no relay/Mac offset). A phone whose clock is 6 min
  // slow (before: 8 days of slack) now fails every read with "signature check failed", and each one posts the agent a
  // "failed its signature check" security notice (inbound.ts ownerFailed). A legit device is locked out of history,
  // search and memory with a message that says forgery, not clock. The rate limit caps the agent noise at 5 per 10 min.
  test('FINDING: a phone clock 6 min slow is told "signature check failed" and the agent gets a security alarm', async () => {
    h = await startHarness()
    seed()
    const before = h.notes.length
    const req = await h.app.buildHistoryRequest('general', { ts: at(-6 * 60_000) })
    h.app.sendRaw(JSON.stringify(req))
    await waitFor(() => answerFor(req.id) !== undefined, 4000, 'the slow-clock read refused')
    expect(pages(req.request_id as string)).toHaveLength(0)
    const err = answerFor(req.id)
    expect(err).toBeDefined()
    // a clock problem should say so, and should not raise a forged-signature alarm to the agent
    expect(h.notes.slice(before).filter((n) => JSON.stringify(n).includes('signature check'))).toHaveLength(0)
    expect(`${err?.code} ${err?.message}`.toLowerCase()).toMatch(/clock|time/)
  })
})

describe('F3 revoke ordering', () => {
  test('HOLDS: with the read queue busy, reads delivered after device.revoked (and still-queued ones) are refused', async () => {
    h = await startHarness()
    seed()
    const queued = await Promise.all(Array.from({ length: 25 }, () => h?.app.buildHistoryRequest('general')))
    for (const q of queued) h.app.sendRaw(JSON.stringify(q))
    h.relay.sendToBridge(mkFrame('device.revoked', { device_id: h.app.device.deviceId }))
    const after = await h.app.buildHistoryRequest('general')
    h.app.sendRaw(JSON.stringify(after))
    await waitFor(() => answerFor(after.id) !== undefined, 10_000, 'the read after the revoke refused')
    expect(pages(after.request_id as string)).toHaveLength(0)
    expect(answerFor(after.id)?.code).toBe('sig_invalid')
    // at most the read whose ECDSA verify was already running when the revoke landed (delivered BEFORE it) is served
    const served = queued.filter((q) => pages(q?.request_id as string).length > 0).length
    expect(served).toBeLessThanOrEqual(1)
  })

  test('HOLDS: revoke applies while the main queue is blocked behind the agent (the original F3 repro)', async () => {
    h = await startHarness()
    seed()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    h.bridge.setEmit(async () => {
      await gate
    })
    extra.push(() => release())
    await h.app.sendMessage('general', 'busy')
    await sleep(100)
    h.relay.sendToBridge(mkFrame('device.revoked', { device_id: h.app.device.deviceId }))
    await waitFor(() => h?.bridge.ctx.devices.isRevoked(h.app.device.deviceId) === true, 4000, 'the revoke applied')
    expect(h.bridge.ctx.devices.isRevoked(h.app.device.deviceId)).toBe(true)
    const s = (await h.app.sign({
      ...mkFrame('search.query'),
      request_id: newUlid(),
      q: 'seeded',
      filters: F0,
      sort: 'relevance',
      cursor: null,
      limit: 5,
    })) as Record<string, unknown> & { id: string }
    h.app.sendRaw(JSON.stringify(s))
    await waitFor(() => answerFor(s.id) !== undefined, 4000, 'the read from a revoked device refused')
    expect(answerFor(s.id)?.code).toBe('sig_invalid')
  })

  // The f9fd554 skip (`!hasSeen(frame.id)`) is keyed on the frame id the RELAY minted (relay auth/index.ts:344), and
  // device.revoked is unsigned. It cannot stop a hostile relay (a fresh id revokes anything) and it has nothing to protect
  // from an honest one: device ids are SPKI hashes and revocation is a permanent tombstone (devices.ts:82 pin() refuses a
  // revoked id; enrollment.ts:52 refuses it too), so "a device enrolled again since" always has a NEW id.
  test('BY DESIGN: a relay-minted revoke with a fresh id revokes any pinned device; a revoked id can never be re-pinned', async () => {
    h = await startHarness()
    const b = await createDeviceKey()
    h.bridge.ctx.devices.pin({ id: b.deviceId, name: 'B', pubkey_jwk: b.publicJwk }, new Date().toISOString())
    const revoke = mkFrame('device.revoked', { device_id: b.deviceId })
    h.relay.sendToBridge(revoke)
    await waitFor(() => h?.bridge.ctx.devices.isRevoked(b.deviceId) === true, 4000, 'the revoke applied')
    expect(h.bridge.ctx.devices.isRevoked(b.deviceId)).toBe(true)
    const repin = h.bridge.ctx.devices.pin(
      { id: b.deviceId, name: 'B again', pubkey_jwk: b.publicJwk },
      new Date().toISOString(),
    )
    expect(repin).toEqual({ ok: false, reason: 'revoked' })
    // a NEW key for the same phone = a new id; the old revoke redelivered (same frame id) leaves it alone
    const b2 = await createDeviceKey()
    h.bridge.ctx.devices.pin({ id: b2.deviceId, name: 'B2', pubkey_jwk: b2.publicJwk }, new Date().toISOString())
    h.relay.sendToBridge(revoke)
    await sleep(200)
    expect(h.bridge.ctx.devices.isRevoked(b2.deviceId)).toBe(false)
  })
})

describe('F5 old-build answer', () => {
  test('HOLDS: an unsigned history.request gets bad_frame + the update text, the same for seen and unseen ids, no data', async () => {
    h = await startHarness()
    seed()
    const msg = await h.app.sendMessage('general', 'hello')
    await h.waitNotes(1)
    await sleep(150)
    const probe = (id: string) =>
      h?.app.sendRaw(
        JSON.stringify({
          v: 1,
          id,
          ts: new Date().toISOString(),
          type: 'history.request',
          request_id: `old-${id}`,
          thread_id: 'general',
          limit: 5,
        }),
      )
    const fresh = newUlid()
    probe(msg.id)
    probe(fresh)
    await waitFor(() => answerFor(msg.id) !== undefined && answerFor(fresh) !== undefined, 4000, 'both answers')
    const a = answerFor(msg.id)
    const b = answerFor(fresh)
    expect(a).toEqual({ ...a, code: 'bad_frame' } as never)
    expect(a?.message).toBe(b?.message as string)
    expect(a?.message.toLowerCase()).toContain('update')
    expect(pages(`old-${msg.id}`)).toHaveLength(0)
    expect(pages(`old-${fresh}`)).toHaveLength(0)
  })
})
