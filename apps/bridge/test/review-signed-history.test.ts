// Adversarial review of PR #54 (signed history and context reads). Real Bridge + FakeRelay + FakeApp: every frame travels
// app -> relay -> bridge as in production. Tests named "HOLDS" are probes the PR passes (kept as regression guards);
// tests named "FINDING" fail on the PR head and describe the gap. See the review doc for severity.
import { afterEach, describe, expect, test } from 'bun:test'
import { createDeviceKey, newId, newUlid, signOwnerFrame } from '@talos-app/protocol'
import { FakeApp, mkFrame } from '@talos-app/testkit'
import { paths } from '../src/config.ts'
import { DeviceStore } from '../src/devices.ts'
import { type Harness, sleep, startHarness } from './helpers.ts'

let h: Harness | undefined
const extra: Array<{ close(): Promise<void> | void }> = []
afterEach(async () => {
  for (const x of extra.splice(0)) await x.close()
  await h?.stop()
  h = undefined
})

const SECRET_A = 'thread-A-secret'
const SECRET_B = 'thread-B-secret-0xBEEF'
const pages = (h: Harness, rid?: string) =>
  h.relay.frames.filter(
    (r) =>
      r.direction === 'from_bridge' && r.raw.type === 'history.page' && (rid === undefined || r.raw.request_id === rid),
  )
const errFor = (h: Harness, id: string, ms = 3000) =>
  h.relay.expectFrame('error', (f) => f.ref === id, { direction: 'from_bridge', timeoutMs: ms } as never)
const fromBridgeText = (h: Harness) => JSON.stringify(h.relay.frames.filter((r) => r.direction === 'from_bridge'))

function seed(h: Harness, thread: string, text: string, n = 4) {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const m = {
      id: newId('m'),
      thread_id: thread,
      author: 'owner' as const,
      kind: 'text' as const,
      text: `${text} ${i}`,
      format: 'plain' as const,
      attachments: [],
      via: 'app' as const,
      created_at: new Date(Date.now() - (n - i) * 1000).toISOString(),
    }
    ids.push(m.id)
    h.bridge.ctx.store.addMessage(m)
  }
  return ids
}

describe('1. signature coverage: swap a field under a valid signature', () => {
  test('HOLDS: every field that changes the answer is covered (thread, cursor, limit, key, added keys, device)', async () => {
    h = await startHarness()
    const a = seed(h, 'general', SECRET_A, 6)
    seed(h, 'work', SECRET_B, 3)
    const second = await createDeviceKey()
    h.bridge.ctx.devices.pin(
      { id: second.deviceId, name: 'second', pubkey_jwk: second.publicJwk },
      new Date().toISOString(),
    )
    const swaps: Array<[string, Record<string, unknown>]> = [
      ['thread_id', { thread_id: 'work' }],
      ['limit', { limit: 100 }],
      ['before_id -> other id', { before_id: a[5] }],
      ['before_id -> after_id (key rename)', { before_id: undefined, after_id: a[3] }],
      ['before_id -> around_id (key rename)', { before_id: undefined, around_id: a[3] }],
      ['drop the cursor', { before_id: undefined }],
      ['add before_seq', { before_seq: 999_999 }],
      ['add before_ts', { before_ts: new Date().toISOString() }],
      ['request_id (page routing)', { request_id: newUlid() }],
      ['device_id -> another pinned device', { device_id: second.deviceId }],
      ['ts', { ts: new Date(Date.now() - 1000).toISOString() }],
    ]
    const errs: Array<Promise<unknown>> = []
    for (const [, patch] of swaps) {
      // a fresh validly-signed request per swap, patched AFTER signing, same id (so only the signature can stop it)
      const base = await h.app.buildHistoryRequest('general', { limit: 2, before_id: a[3] })
      const forged: Record<string, unknown> = { ...base, ...patch }
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete forged[k]
      h.app.sendRaw(JSON.stringify(forged))
      errs.push(errFor(h, base.id))
    }
    for (const e of await Promise.all(errs)) expect((e as { code: string }).code).toBe('sig_invalid')
    await sleep(400)
    expect(pages(h)).toHaveLength(0)
    expect(fromBridgeText(h)).not.toContain(SECRET_A)
    expect(fromBridgeText(h)).not.toContain(SECRET_B)
  })

  test('HOLDS: the relay-only `relay` meta field is unsigned but changes nothing the Mac returns', async () => {
    h = await startHarness()
    seed(h, 'general', SECRET_A, 3)
    const req = await h.app.buildHistoryRequest('general', { limit: 1 })
    h.app.sendRaw(JSON.stringify({ ...req, relay: { seq: 1, received_at: new Date().toISOString() } }))
    const page = await h.relay.expectFrame('history.page', (f) => f.request_id === req.request_id, {
      direction: 'from_bridge',
    })
    expect(page.messages).toHaveLength(1)
  })
})

describe('2. replay protection', () => {
  test('HOLDS: seen ids live in SQLite, so a replay after a bridge restart is still refused', async () => {
    h = await startHarness()
    seed(h, 'general', SECRET_A, 3)
    const req = await h.app.buildHistoryRequest('general', { limit: 10 })
    const bytes = JSON.stringify(req)
    h.app.sendRaw(bytes)
    await h.relay.expectFrame('history.page', (f) => f.request_id === req.request_id, { direction: 'from_bridge' })
    await h.bridge.stop()
    const { Bridge } = await import('../src/bridge.ts')
    const { nullLogger } = await import('../src/log.ts')
    const b2 = await Bridge.create({
      env: h.bridge.ctx.env,
      logger: nullLogger,
      inbound: { settleMs: 20, maxSettleMs: 200 },
    })
    b2.setEmit(async () => {})
    b2.start()
    extra.push({ close: () => b2.stop() })
    await h.relay.expectFrame('ready', () => true, { direction: 'to_bridge' })
    await sleep(300)
    h.app.sendRaw(bytes)
    const err = await errFor(h, req.id)
    expect(err.code).toBe('sig_invalid')
    await sleep(150)
    expect(pages(h, req.request_id as string)).toHaveLength(1)
  })

  // Reads are never queued by the app ("Never queued: offline, it fails"), yet the Mac accepts a history.request signed
  // up to 8 days ago. A relay that swallows a signed request (the app just sees a timeout) can fire it days later and get
  // that page as it is THEN, e.g. the newest page of a thread. A read needs a window of minutes, not the 8 days that
  // durable owner frames (queued offline) need. Same applies to search.query / memory.* (pre-existing).
  test('FINDING: a signed history.request withheld for 3 days is still served (8-day ts window on an interactive read)', async () => {
    h = await startHarness()
    seed(h, 'general', SECRET_A, 3)
    const old = new Date(Date.now() - 3 * 24 * 3600_000).toISOString()
    const req = await h.app.sign({
      ...mkFrame('history.request', {}, old),
      request_id: newUlid(),
      thread_id: 'general',
      limit: 10,
    })
    h.app.sendRaw(JSON.stringify(req))
    await sleep(400)
    expect(pages(h, req.request_id)).toHaveLength(0)
  })

  // The seen-id check runs before the "is it signed at all" check, against the ONE seen_ids table that also holds message
  // frame ids, client_msg_ids and every read id. Anyone who can put a frame on the bridge socket can ask "has the Mac
  // seen id X?" without a key: "That request was already used." vs "Update the Talos app...". Low value today (those ids
  // crossed the relay), but an unsigned frame should get one fixed answer and learn nothing.
  test('FINDING: an unsigned request is a key-less seen-id oracle (answer differs for an id the Mac has seen)', async () => {
    h = await startHarness()
    const msg = await h.app.sendMessage('general', 'hello')
    await h.waitNotes(1)
    await sleep(100)
    const probe = (id: string) => {
      h?.app.sendRaw(
        JSON.stringify({
          v: 1,
          id,
          ts: new Date().toISOString(),
          type: 'history.request',
          request_id: newUlid(),
          thread_id: 'general',
          limit: 1,
        }),
      )
      return errFor(h as Harness, id)
    }
    const seenAnswer = await probe(msg.id)
    const freshAnswer = await probe(newUlid())
    expect(seenAnswer.message).toBe(freshAnswer.message)
  })
})

describe('3. a device revoked mid-session', () => {
  test('HOLDS: revoked on the Mac (CLI writes devices.json) after a good page: the next request is refused', async () => {
    h = await startHarness()
    seed(h, 'general', SECRET_A, 3)
    const ok = await h.app.sendHistoryRequest('general', { limit: 10 })
    await h.relay.expectFrame('history.page', (f) => f.request_id === ok.request_id, { direction: 'from_bridge' })
    await sleep(20) // mtime granularity
    new DeviceStore(paths(h.home).devicesJson).revoke(h.app.device.deviceId, new Date().toISOString())
    const req = await h.app.sendHistoryRequest('general', { limit: 10 })
    expect((await errFor(h, req.id)).code).toBe('sig_invalid')
    await sleep(100)
    expect(pages(h)).toHaveLength(1)
  })

  // device.revoked from the relay goes through the main inbound queue; history.request uses the separate read queue.
  // While the main queue is busy (here: the agent has not taken the previous message yet), a history.request that the
  // relay delivered AFTER the revoke is still served from the revoked device. Same class as memory/search reads.
  test('FINDING: a history.request that arrives after device.revoked is served while the main queue is busy', async () => {
    h = await startHarness()
    seed(h, 'general', SECRET_A, 3)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    h.bridge.setEmit(async () => {
      await gate
    })
    extra.push({ close: () => release() })
    await h.app.sendMessage('general', 'keep the main queue busy')
    await sleep(100)
    h.relay.sendToBridge(mkFrame('device.revoked', { device_id: h.app.device.deviceId }))
    await sleep(50)
    const req = await h.app.sendHistoryRequest('general', { limit: 10 })
    await sleep(400)
    release()
    // control: the revoke itself is applied once the main queue drains, so the gap is ordering, not a lost revoke
    const deadline = Date.now() + 3000
    while (!h.bridge.ctx.devices.isRevoked(h.app.device.deviceId) && Date.now() < deadline) await sleep(20)
    expect(h.bridge.ctx.devices.isRevoked(h.app.device.deviceId)).toBe(true)
    expect(pages(h, req.request_id)).toHaveLength(0)
  })
})

describe('4. cross-thread', () => {
  test('HOLDS: signed for thread A with an around_id / before_id from thread B returns nothing of B', async () => {
    h = await startHarness()
    seed(h, 'general', SECRET_A, 3)
    const b = seed(h, 'work', SECRET_B, 3)
    for (const key of ['around_id', 'before_id', 'after_id'] as const) {
      const req = await h.app.sendHistoryRequest('general', { [key]: b[1], limit: 50 })
      const page = await h.relay.expectFrame('history.page', (f) => f.request_id === req.request_id, {
        direction: 'from_bridge',
      })
      expect(JSON.stringify(page)).not.toContain(SECRET_B)
    }
  })
})

describe('5. relay forging device_id', () => {
  test('HOLDS: an old frame signed by device B, re-labelled to pinned device A, or replayed after B is revoked, is refused', async () => {
    h = await startHarness()
    seed(h, 'general', SECRET_A, 3)
    const b = await createDeviceKey()
    h.bridge.ctx.devices.pin({ id: b.deviceId, name: 'B', pubkey_jwk: b.publicJwk }, new Date().toISOString())
    const signedByB = await signOwnerFrame(
      { ...mkFrame('history.request'), request_id: newUlid(), thread_id: 'general', limit: 10, device_id: b.deviceId },
      b.privateKey,
    )
    // relabel to A (pinned): the device id is inside the signing input and must match the key
    const relabelled = { ...signedByB, device_id: h.app.device.deviceId }
    h.app.sendRaw(JSON.stringify(relabelled))
    expect((await errFor(h, relabelled.id)).code).toBe('sig_invalid')
    // B revoked; the relay still holds B's never-delivered signed request (fresh id, never seen) and sends it now
    const held = await signOwnerFrame(
      { ...mkFrame('history.request'), request_id: newUlid(), thread_id: 'general', limit: 10, device_id: b.deviceId },
      b.privateKey,
    )
    h.bridge.ctx.devices.revoke(b.deviceId, new Date().toISOString())
    h.relay.sendToBridge(held as never, { durable: false } as never)
    expect((await errFor(h, held.id)).code).toBe('sig_invalid')
    await sleep(100)
    expect(pages(h)).toHaveLength(0)
  })
})

describe('6. error paths leak nothing', () => {
  test('HOLDS: unsigned, forged, unpinned and replayed errors carry no counts, message ids or text', async () => {
    h = await startHarness()
    const ids = seed(h, 'general', SECRET_A, 5)
    const unsigned = h.app.send({
      type: 'history.request',
      request_id: newUlid(),
      thread_id: 'general',
      around_id: ids[2],
      limit: 5,
    })
    const good = await h.app.buildHistoryRequest('general', { around_id: ids[2], limit: 5 })
    h.app.sendRaw(JSON.stringify({ ...good, limit: 6 }))
    const rogue = new FakeApp({ relayWs: h.relay.wsBase })
    await rogue.connect()
    extra.push(rogue)
    const r = await rogue.sendHistoryRequest('general', { around_id: ids[2], limit: 5 })
    const errs = [await errFor(h, unsigned.id as string), await errFor(h, good.id), await errFor(h, r.id)]
    const text = JSON.stringify(errs)
    for (const id of ids) expect(text).not.toContain(id)
    expect(text).not.toContain(SECRET_A)
    expect(text).not.toMatch(/\b[0-9]+ (messages?|items?)\b/)
    for (const e of errs) expect(Object.keys(e).sort()).toEqual(['code', 'id', 'message', 'ref', 'ts', 'type', 'v'])
  })
})
