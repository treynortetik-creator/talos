// @vitest-environment node
// The real socket client against the testkit FakeRelay: the signed app.request, app.update in the store (live, replayed,
// persisted), and what a broken or unknown frame does.
import { newId, newUlid, verifyOwnerFrame } from '@talos-app/protocol'
import { assertWebSentOnlyValidFrames, FakeBridge, FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TalosClientError } from '../../src/lib/client.ts'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage, type Storage } from '../../src/lib/storage.ts'
import { makeView, viewReply } from './helpers.ts'

let relay: FakeRelay
let client: SocketClient
let storage: Storage

const make = () =>
  createSocketClient({ storage, wsUrl: `${relay.wsBase}/ws`, backoff: { baseMs: 20, maxMs: 40 }, isOnline: () => true })

beforeEach(async () => {
  relay = await new FakeRelay().start()
  storage = createMemoryStorage()
  client = make()
})
afterEach(async () => {
  client.close()
  await bridge?.close()
  bridge = null
  await relay.stop()
})

async function online(pinned = true) {
  await client.ensureDevice()
  await client.start({ pinned })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
}
/** The client's `sendAppRequest` (optional on the shared interface, always there on the socket client). */
const sendApp = (frame: Record<string, unknown>) => {
  if (!client.sendAppRequest) throw new Error('sendAppRequest missing')
  return client.sendAppRequest(frame)
}
const appRequest = (over: Record<string, unknown> = {}) => ({
  type: 'app.request',
  thread_id: 'general',
  view_id: `av_${newUlid()}`,
  request_id: `ar_${newUlid()}`,
  method: 'tools/call',
  tool_name: 'read_note',
  arguments: { id: 'n1' },
  user_gesture: true,
  ...over,
})
const sentAppRequests = () => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'app.request')
const update = (view_id: string, state: string) =>
  mkFrame('app.update', { view_id, thread_id: 'general', state, reason: 'because' })

/** The testkit relay routes app.request like AP2's: no bridge connected -> `app.response failed mac_offline`. The cases
 * below need the relay to hold a request, so a silent bridge (it never answers an app.request) is connected. */
let bridge: FakeBridge | null = null
async function relayAcceptsAppRequests() {
  bridge = await new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey }).connect()
}

describe('sendAppRequest', () => {
  it('signs on the raw JSON and parses as app->relay; resolves when the relay acks it', async () => {
    await relayAcceptsAppRequests()
    await online()
    const key = await client.deviceKey()
    if (!key) throw new Error('no key')
    const sent = sendApp(appRequest())
    const outcome = await Promise.race([
      sent.then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('waiting'), 200)),
    ])
    expect(outcome).toBe('waiting')
    await waitFor(() => sentAppRequests().length === 1, 2000, 'frame')
    const raw = sentAppRequests()[0]?.raw as Record<string, unknown>
    expect(raw).toMatchObject({ tool_name: 'read_note', user_gesture: true, device_id: key.deviceId })
    expect(await verifyOwnerFrame(raw, key.publicJwk)).toBe(true)
    await assertWebSentOnlyValidFrames(relay, { [key.deviceId]: key.publicJwk })
    relay.sendToApps(mkFrame('ack', { ref: raw.id }))
    await expect(sent).resolves.toBeUndefined()
  })

  it('an older relay answers bad_frame: that request rejects, the connection stays', async () => {
    await relayAcceptsAppRequests()
    await online()
    const sent = sendApp(appRequest()).then(
      () => 'ok',
      (e: TalosClientError) => e.code,
    )
    await waitFor(() => sentAppRequests().length === 1, 2000, 'frame')
    relay.sendToApps(
      mkFrame('error', {
        ref: sentAppRequests()[0]?.raw.id,
        code: 'bad_frame',
        message: 'unexpected app.request from app',
      }),
    )
    expect(await sent).toBe('bad_frame')
    expect(client.store.getState().connection).toBe('online')
  })

  it('an unpinned device sends nothing and rejects with device_not_pinned', async () => {
    await online(false)
    await expect(sendApp(appRequest())).rejects.toMatchObject({ code: 'device_not_pinned' })
    await new Promise((r) => setTimeout(r, 80))
    expect(sentAppRequests()).toHaveLength(0)
    expect(client.outboxSize()).toBe(0) // never queued: a stale request is refused by the Mac anyway
  })

  it('offline rejects with mac_offline and queues nothing', async () => {
    await client.ensureDevice()
    await expect(sendApp(appRequest())).rejects.toBeInstanceOf(TalosClientError)
    await expect(sendApp(appRequest())).rejects.toMatchObject({ code: 'mac_offline' })
    expect(client.outboxSize()).toBe(0)
  })

  it('an error{ref} from the relay rejects that request only', async () => {
    await relayAcceptsAppRequests()
    await online()
    const ra = `ar_${newUlid()}`
    const rb = `ar_${newUlid()}`
    const a = sendApp(appRequest({ request_id: ra })).then(
      () => 'ok',
      (e: TalosClientError) => e.code,
    )
    const b = sendApp(appRequest({ request_id: rb })).then(
      () => 'ok',
      (e: TalosClientError) => e.code,
    )
    await waitFor(() => sentAppRequests().length === 2, 2000, 'both frames')
    const idOf = (rid: string) => sentAppRequests().find((f) => f.raw.request_id === rid)?.raw.id as string
    relay.sendToApps(mkFrame('error', { ref: idOf(ra), code: 'rate_limited', message: 'slow down' }))
    expect(await a).toBe('rate_limited')
    expect(await Promise.race([b, new Promise((r) => setTimeout(() => r('pending'), 150))])).toBe('pending')
    relay.sendToApps(mkFrame('ack', { ref: idOf(rb) }))
    expect(await b).toBe('ok')
  })

  it('two requests at once get distinct frame ids and both verify', async () => {
    await relayAcceptsAppRequests()
    await online()
    const key = await client.deviceKey()
    if (!key) throw new Error('no key')
    sendApp(appRequest()).catch(() => {}) // closing the client ends them
    sendApp(appRequest({ method: 'ui/message', tool_name: undefined, arguments: undefined, text: 'hi' })).catch(
      () => {},
    )
    await waitFor(() => sentAppRequests().length === 2, 2000, 'both')
    const [x, y] = sentAppRequests().map((f) => f.raw)
    expect(x?.id).not.toBe(y?.id)
    expect(await verifyOwnerFrame(x as Record<string, unknown>, key.publicJwk)).toBe(true)
    expect(await verifyOwnerFrame(y as Record<string, unknown>, key.publicJwk)).toBe(true)
  })
})

describe('app.update and app rows', () => {
  it('app.update lands in the store; app.response reaches listeners and leaves the store alone', async () => {
    await online()
    const view = makeView()
    const seen: unknown[] = []
    client.onFrame('app.response', (f) => void seen.push(f))
    relay.sendToApps(update(view.view_id, 'superseded'))
    await waitFor(() => view.view_id in client.store.getState().appStates, 2000, 'update')
    expect(client.store.getState().appStates[view.view_id]).toEqual({ state: 'superseded', reason: 'because' })
    const before = client.store.getState()
    relay.sendToApps(
      mkFrame('app.response', {
        view_id: view.view_id,
        request_id: `ar_${newUlid()}`,
        state: 'done',
        result: { content: [] },
      }),
    )
    await waitFor(() => seen.length === 1, 2000, 'response')
    expect(client.store.getState().appStates).toBe(before.appStates)
  })

  it('an unknown state is ignored, not stored and not fatal', async () => {
    await online()
    const view = makeView()
    relay.sendToApps(update(view.view_id, 'exploded'))
    relay.sendToApps(update(view.view_id, 'revoked'))
    await waitFor(() => view.view_id in client.store.getState().appStates, 2000, 'good one')
    expect(client.store.getState().appStates[view.view_id]?.state).toBe('revoked')
    expect(client.store.getState().connection).toBe('online')
  })

  it('a replayed app.update (catch-up batch) is applied', async () => {
    await online()
    const view = makeView()
    relay.sendToApps(
      mkFrame('catchup.batch', { from_seq: 1, to_seq: 1, frames: [update(view.view_id, 'closed')], more: false }),
    )
    await waitFor(() => view.view_id in client.store.getState().appStates, 2000, 'replay')
    expect(client.store.getState().appStates[view.view_id]?.state).toBe('closed')
  })

  it('survives a reload: the cached state is back before the socket is', async () => {
    await online()
    const view = makeView()
    relay.sendToApps(update(view.view_id, 'superseded'))
    await waitFor(() => view.view_id in client.store.getState().appStates, 2000, 'update')
    await new Promise((r) => setTimeout(r, 400)) // the cache saves after 250 ms
    client.close()
    const again = make()
    try {
      await again.start({ pinned: true })
      expect(again.store.getState().appStates[view.view_id]?.state).toBe('superseded')
    } finally {
      again.close()
    }
    client = make()
  })

  it('an app row arrives with its view; one whose view is broken degrades to a row without it', async () => {
    await online()
    const view = makeView()
    const good = viewReply(view)
    relay.sendToApps(good as never)
    const broken = viewReply(view, { id: newId('m'), app: { ...view, csp: { connect_domains: ['*'] } } })
    relay.sendToApps(broken as never)
    await waitFor(() => (client.store.getState().messages.general ?? []).length >= 2, 2000, 'rows')
    const rows = client.store.getState().messages.general ?? []
    expect(rows.find((m) => m.id === good.message.id)?.app?.view_id).toBe(view.view_id)
    const b = rows.find((m) => m.id === broken.message.id)
    expect(b).toBeTruthy()
    expect(b?.app).toBeUndefined()
    expect(b?.kind).toBe('app')
  })
})
