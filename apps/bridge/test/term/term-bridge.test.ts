// The terminal view through the REAL Bridge, over the (fake) relay: the Mac lists term-view/1, and a signed term.open from a
// (fake) app is checked the way every owner frame is (signature over the raw JSON, pinned device, age, an id never seen), then
// shows the pane. The pane is a made-up one (the live tmux is in tmux-real.test.ts); everything else is the real wiring.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { b64urlDecode, createDeviceKey, newUlid, TERM_VIEW_FEATURE } from '@talos-app/protocol'
import { mkFrame, t } from '@talos-app/testkit'
import { bridgeFeatures } from '../../src/handshake.ts'
import { TermAudit } from '../../src/term/audit.ts'
import { type Harness, startHarness, waitFor } from '../helpers.ts'
import { fakeOpener } from './fake-source.ts'

setDefaultTimeout(t(300_000)) // the waits below scale with the machine; so does the limit on the whole test

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const dec = new TextDecoder()
const tid = () => `tm_${newUlid()}`
type Raw = Record<string, unknown>
const inbound = (x: Harness, pick: (r: Raw) => boolean): Raw[] =>
  x.app.rec.frames.filter((r) => r.direction === 'in' && pick(r.raw)).map((r) => r.raw)
const ofType = (x: Harness, type: string) => inbound(x, (r) => r.type === type)
const opener = () => fakeOpener()

async function start(over: Partial<{ openSource: ReturnType<typeof fakeOpener>['open'] }> = {}, o = opener()) {
  h = await startHarness({ bridge: { term: { openSource: o.open, ...over } } })
  return { x: h, pane: o }
}
const openFrame = (x: Harness, id = tid(), fields: Raw = {}, ts?: string) =>
  x.app.sign({
    ...mkFrame('term.open', {}, ts),
    term_id: id,
    tier: 'view',
    target: 'main',
    cols: 120,
    rows: 40,
    ...fields,
  })

describe('the Mac lists the terminal view', () => {
  test('term-view/1 is in its features when the service is there, and not when it is not', async () => {
    const { x } = await start()
    expect(bridgeFeatures(x.bridge.ctx)).toContain(TERM_VIEW_FEATURE)
    expect(bridgeFeatures({})).not.toContain(TERM_VIEW_FEATURE)
  })
})

describe('a signed open shows the pane', () => {
  test('term.opened, then the keyframe, then live output in order, then the credit and the close', async () => {
    const { x, pane } = await start()
    const id = tid()
    x.app.send(await openFrame(x, id))
    await waitFor(() => ofType(x, 'term.key').length === 1, t(5000), 'the keyframe')
    expect(ofType(x, 'term.opened')[0]).toMatchObject({ term_id: id, tier: 'view', cols: 100, rows: 30 })
    const src = pane.last()
    src.emit('hello ')
    src.emit('world')
    await waitFor(() => ofType(x, 'term.out').length > 0, t(5000), 'the output')
    expect(
      dec.decode(Uint8Array.from(ofType(x, 'term.out').flatMap((f) => [...b64urlDecode(f.bytes_b64 as string)]))),
    ).toBe('hello world')
    x.app.send({ ...mkFrame('term.ack'), term_id: id, upto: 11 })
    const close = await x.app.sign({ ...mkFrame('term.close'), term_id: id })
    x.app.send(close)
    await waitFor(() => src.closed, t(5000), 'the control client to stop with its last viewer')
    expect(x.bridge.ctx.term?.viewCount()).toBe(0)
    const rows = new TermAudit(x.bridge.ctx.store.db).rows()
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({
      term_id: id,
      tier: 'view',
      device_id: x.app.device.deviceId,
      target: 'main',
      why: 'closed',
    })
  })

  test("the relay saying the viewer's socket closed ends the view", async () => {
    const { x, pane } = await start()
    const id = tid()
    x.app.send(await openFrame(x, id))
    await waitFor(() => ofType(x, 'term.key').length === 1, t(5000), 'the keyframe')
    x.relay.sendToBridge({ ...mkFrame('term.closed'), term_id: id, why: 'socket_closed' }, { durable: false })
    await waitFor(() => x.bridge.ctx.term?.viewCount() === 0, t(5000), 'the view to end')
    expect(pane.last().closed).toBe(true)
  })
})

describe('tap, then leave: the order the relay frames are handled in', () => {
  test('socket_closed from the relay, handled at once, beats the open that is still being verified', async () => {
    const { x, pane } = await start()
    const id = tid()
    const f = await openFrame(x, id)
    x.relay.sendToBridge(f, { durable: false })
    x.relay.sendToBridge({ ...mkFrame('term.closed'), term_id: id, why: 'socket_closed' }, { durable: false })
    await waitFor(() => x.bridge.ctx.store.hasSeen(f.id as string), t(5000), 'the open handled')
    await x.bridge.inbound?.termQueue // the open has gone through the service now
    expect(ofType(x, 'term.opened').filter((o) => o.term_id === id)).toEqual([])
    expect(x.bridge.ctx.term?.viewCount()).toBe(0)
    expect(pane.made.length).toBe(0) // no tmux client was started for nobody
  })
})

describe('a term frame that does not parse never becomes a stored message', () => {
  const errorsSent = (x: Harness, id: string) =>
    x.relay.frames.filter(
      (f) => f.direction === 'from_bridge' && (f.raw as Raw).type === 'error' && (f.raw as Raw).ref === id,
    )

  test('an unsigned term.ack or term.closed that fails its schema is dropped with no error naming it', async () => {
    const { x } = await start()
    const ids = [newUlid(), newUlid()]
    const control = newUlid() // an ordinary unparseable frame, sent last: its error reaching the relay proves the others had their turn
    const bad = (id: string, type: string, more: Raw = {}) =>
      x.bridge.inbound?.onBadFrame({ v: 1, id, ts: new Date().toISOString(), type, ...more }, 'bad')
    bad(ids[0] as string, 'term.ack', { term_id: 'nope', upto: -1 })
    bad(ids[1] as string, 'term.closed', { term_id: 'nope' })
    bad(control, 'thread.read')
    await waitFor(() => errorsSent(x, control).length === 1, t(5000), 'the control refusal')
    for (const id of ids) expect(errorsSent(x, id)).toEqual([])
    expect(x.bridge.ctx.store.hasSeen(ids[0] as string)).toBe(false) // and nothing is remembered for it
  })
})

describe('an open is refused like every owner frame, and nothing opens', () => {
  const none = (x: Harness) => {
    expect(x.bridge.ctx.term?.viewCount()).toBe(0)
    expect(ofType(x, 'term.opened')).toEqual([])
  }
  // what the Mac sent the relay about this frame (an error{ref} the relay would pass on to the asker)
  const errors = (x: Harness, ref: string) =>
    x.relay.frames
      .filter((f) => f.direction === 'from_bridge' && (f.raw as Raw).type === 'error' && (f.raw as Raw).ref === ref)
      .map((f) => f.raw as Raw)

  test('a replayed open is refused: the id is in the persistent seen-id store, so the same bytes never reopen it', async () => {
    const { x } = await start()
    const id = tid()
    const f = await openFrame(x, id)
    x.app.send(f)
    await waitFor(() => ofType(x, 'term.opened').length === 1, t(5000), 'the first open')
    const close = await x.app.sign({ ...mkFrame('term.close'), term_id: id })
    x.app.send(close)
    await waitFor(() => x.bridge.ctx.term?.viewCount() === 0, t(5000), 'closed')
    expect(x.bridge.ctx.store.hasSeen(f.id as string)).toBe(true)
    // the same signed bytes again, straight to the Mac past the relay
    x.relay.sendToBridge(f, { durable: false })
    await waitFor(() => errors(x, f.id as string).length > 0, t(5000), 'the refusal')
    expect(errors(x, f.id as string)[0]?.code).toBe('sig_invalid')
    expect(ofType(x, 'term.opened').length).toBe(1)
    expect(x.bridge.ctx.term?.viewCount()).toBe(0)
  })

  test('older than two minutes, or more than two minutes ahead: refused as stale, with the clock words', async () => {
    const { x } = await start()
    for (const offset of [-3 * 60_000, 3 * 60_000]) {
      const f = await openFrame(x, tid(), {}, new Date(Date.now() + offset).toISOString())
      x.app.send(f)
      await waitFor(() => errors(x, f.id as string).length > 0, t(5000), 'the refusal')
      expect(errors(x, f.id as string)[0]?.code).toBe('stale')
    }
    none(x)
    // control: a minute either way is inside the window
    const ok = await openFrame(x, tid(), {}, new Date(Date.now() - 60_000).toISOString())
    x.app.send(ok)
    await waitFor(() => ofType(x, 'term.opened').length === 1, t(5000), 'an open inside the window')
  })

  test('a device the Mac never pinned, a changed byte, and a missing signature each open nothing', async () => {
    const { x } = await start()
    // a device key the Mac does not know
    const stranger = await createDeviceKey()
    const { signOwnerFrame } = await import('@talos-app/protocol')
    const f1 = await signOwnerFrame(
      {
        ...mkFrame('term.open'),
        term_id: tid(),
        tier: 'view',
        target: 'main',
        cols: 80,
        rows: 24,
        device_id: stranger.deviceId,
      },
      stranger.privateKey,
    )
    // a signed frame with a byte changed after signing
    const f2 = { ...(await openFrame(x)), cols: 81 }
    // no signature at all (the relay's own schema refuses it before the Mac sees it; sent past the relay to prove the Mac does too)
    const { osig: _o, ...f3 } = await openFrame(x)
    for (const f of [f1, f2, f3]) x.relay.sendToBridge(f as Raw, { durable: false })
    await waitFor(() => [f1, f2, f3].every((f) => errors(x, f.id as string).length > 0), t(5000), 'three refusals')
    for (const f of [f1, f2]) expect(errors(x, f.id as string)[0]?.code).toBe('sig_invalid')
    none(x)
  })

  test('another pinned device cannot close or resume a view it did not open', async () => {
    const { x } = await start()
    const other = await createDeviceKey()
    x.bridge.ctx.devices.pin(
      { id: other.deviceId, name: 'Other', pubkey_jwk: other.publicJwk },
      new Date().toISOString(),
    )
    const id = tid()
    x.app.send(await openFrame(x, id))
    await waitFor(() => ofType(x, 'term.key').length === 1, t(5000), 'the keyframe')
    const { signOwnerFrame } = await import('@talos-app/protocol')
    const sent: string[] = []
    for (const frame of [
      { ...mkFrame('term.close'), term_id: id },
      { ...mkFrame('term.resume'), term_id: id, from: 0 },
    ]) {
      const signed = await signOwnerFrame({ ...frame, device_id: other.deviceId }, other.privateKey)
      sent.push(signed.id as string)
      x.relay.sendToBridge(signed, { durable: false })
    }
    // both were verified and used up (they are good signatures from a pinned device), and neither touched the view
    await waitFor(() => sent.every((s) => x.bridge.ctx.store.hasSeen(s)), t(5000), 'both frames handled')
    expect(x.bridge.ctx.term?.viewCount()).toBe(1)
  })

  test('a device revoked while it watches: its view ends at the next output, and the page is told', async () => {
    const { x, pane } = await start()
    const id = tid()
    x.app.send(await openFrame(x, id))
    await waitFor(() => ofType(x, 'term.key').length === 1, t(5000), 'the keyframe')
    x.bridge.ctx.devices.revoke(x.app.device.deviceId, new Date().toISOString()) // as the CLI does, in the devices file
    pane.last().emit('more output')
    await waitFor(() => ofType(x, 'term.closed').length === 1, t(5000), 'the page to be told')
    expect(x.bridge.ctx.term?.viewCount()).toBe(0)
    expect(ofType(x, 'term.closed').map((f) => f.why)).toEqual(['revoked'])
    expect(new TermAudit(x.bridge.ctx.store.db).rows()[0]?.why).toBe('revoked')
  })

  test("the Mac's device.revoked frame ends that device's views at once", async () => {
    const { x } = await start()
    const id = tid()
    x.app.send(await openFrame(x, id))
    await waitFor(() => ofType(x, 'term.key').length === 1, t(5000), 'the keyframe')
    x.bridge.ctx.term?.endDevice(x.app.device.deviceId)
    expect(x.bridge.ctx.term?.viewCount()).toBe(0)
  })

  test('with no terminal service (no tmux on this Mac) an open is answered unsupported', async () => {
    h = await startHarness({ bridge: { term: { off: true } } })
    const x = h
    expect(x.bridge.ctx.term).toBeUndefined()
    const id = tid()
    x.app.send(await openFrame(x, id))
    await waitFor(() => ofType(x, 'term.closed').length === 1, t(5000), 'the answer')
    expect(ofType(x, 'term.closed')[0]).toMatchObject({ term_id: id, why: 'unsupported' })
    expect(bridgeFeatures(x.bridge.ctx)).not.toContain(TERM_VIEW_FEATURE)
  })
})
