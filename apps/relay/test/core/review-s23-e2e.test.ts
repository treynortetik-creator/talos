// Review S2+S3 (merged): the REAL web socket client (apps/web/src/lib/socketClient.ts) against the REAL relay, with a raw
/* biome-ignore-all lint/suspicious/noExplicitAny: captured frames are untyped JSON */
// bridge socket that answers from the WP-S1 captures (packages/testkit/fixtures/captured/). Nothing on the app <-> relay
// path is faked: the web client signs, the relay routes, the "bridge" verifies the owner signature and answers with the
// exact frames the real bridge produced (only ids, request_ids, client_ref and the matching payload_hash are re-bound).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type BridgeKeyPair,
  bindingFrom,
  type CardT,
  newUlid,
  payloadHash,
  signChallenge,
  verifyOwnerFrame,
} from '@talos-app/protocol'
import { mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket as WsWebSocket } from 'ws'
import { needsRefetch, pickBanner, rowStatus } from '../../../web/src/features/schedules/logic.ts'
import { TalosClientError } from '../../../web/src/lib/client.ts'
import { createSocketClient, type SocketClient } from '../../../web/src/lib/socketClient.ts'
import { createMemoryStorage } from '../../../web/src/lib/storage.ts'
import { startTestRelay, type TestRelay } from './harness.ts'

vi.setConfig({ testTimeout: 20_000 })

const capturedDir = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/testkit/fixtures/captured')
type Step = {
  label: string
  received_by_bridge: Array<Record<string, any>>
  sent_by_bridge: Array<Record<string, any>>
}
const scenario = (name: string) =>
  (JSON.parse(readFileSync(join(capturedDir, `${name}.json`), 'utf8')) as { steps: Step[] }).steps
const step = (name: string, label: RegExp) => {
  const s = scenario(name).find((x) => label.test(x.label))
  if (!s) throw new Error(`no step ${label} in ${name}`)
  return s
}

/** A bridge socket that authenticates with features and records everything; the test answers by hand. */
async function rawBridge(relay: { wsBase: string }, key: BridgeKeyPair, features: string[]) {
  const got: Array<Record<string, any>> = []
  const ws = new WsWebSocket(`${relay.wsBase}/bridge`)
  await new Promise<void>((resolve, reject) => {
    ws.on('message', async (d) => {
      const f = JSON.parse(d.toString()) as Record<string, any>
      got.push(f)
      if (f.type === 'ping') ws.send(JSON.stringify(mkFrame('pong', { nonce: f.nonce })))
      if (f.type === 'challenge') {
        const sig = await signChallenge(key.privateKey, f as never)
        ws.send(
          JSON.stringify(
            mkFrame('hello', {
              role: 'bridge',
              key_id: key.keyId,
              sig,
              client: { name: 'replay', version: '0', features },
              agent_config_rev: 0,
            }),
          ),
        )
      }
      if (f.type === 'ready') resolve()
    })
    ws.on('error', reject)
  })
  const send = (f: Record<string, unknown>) =>
    ws.send(JSON.stringify({ v: 1, ...f, id: newUlid(), ts: new Date().toISOString() }))
  const next = async (type: string, after = 0) => {
    await waitFor(() => got.slice(after).some((f) => f.type === type), 5000, `bridge got ${type}`)
    return got.slice(after).find((f) => f.type === type) as Record<string, any>
  }
  return { ws, got, send, next, close: () => ws.close() }
}

let relay: TestRelay | null = null
let client: SocketClient | null = null
afterEach(async () => {
  client?.close()
  client = null
  await relay?.stop()
  relay = null
})

async function world() {
  relay = await startTestRelay()
  const bridge = await rawBridge(relay, relay.bridgeKey, ['schedules/1'])
  const headers = relay.appHeaders
  class HeaderWS extends WsWebSocket {
    constructor(url: string) {
      super(url, { headers })
    }
  }
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    WebSocketImpl: HeaderWS as unknown as typeof WebSocket,
    isVisible: () => true,
    isOnline: () => true,
  })
  const dev = await client.ensureDevice()
  await client.start({ pinned: true })
  const c = client
  await waitFor(
    () => c.store.getState().presence.bridge_online && !!c.store.getState().presence.features?.includes('schedules/1'),
    5000,
    'presence with schedules/1',
  )
  return { relay, bridge, client: c, dev }
}

/** Re-binds a captured bridge frame to the live request: new ids, live request_id/ref. */
function rebind(out: Record<string, any>, live: { id: string; request_id?: string }) {
  const f = { ...out }
  delete f.id
  delete f.ts
  if (typeof f.ref === 'string') f.ref = live.id
  if (typeof f.request_id === 'string' && live.request_id) f.request_id = live.request_id
  return f
}

describe('S2+S3 merged: the web client, the real relay, the captured bridge', () => {
  it('list: the signed frame reaches the bridge untouched; the captured snapshot lands in the slice; rows read right', async () => {
    const { bridge, client, dev } = await world()
    const s = step('13-states-and-health', /no_session/)
    const p = client.schedules.listSchedules()
    const inbound = await bridge.next('schedules.list')
    expect(await verifyOwnerFrame(inbound, dev.publicJwk)).toBe(true)
    for (const out of s.sent_by_bridge) bridge.send(rebind(out, inbound as never))
    const snap = await p
    const captured = s.sent_by_bridge.find((x) => x.type === 'schedules.snapshot')?.snapshot
    expect(snap).toEqual(captured)
    const tz = snap.health.tz
    const word = (id: string) =>
      rowStatus(snap.schedules.find((x) => x.id === id) as never, {
        nowMs: Date.parse(snap.as_of),
        tz,
        macOnline: true,
      }).word
    expect(word('daily-digest')).toBe("Waiting: agent session isn't running")
    expect(word('missed-job')).toBe('Missed')
    expect(pickBanner(snap)?.code).toBe('no_session')
  })

  it('patch -> captured card (high risk) -> card.resolve with step-up -> done + status that asks for exactly one re-fetch', async () => {
    const { relay: r, bridge, client } = await world()
    // prime the slice with the list the update was drawn against
    const list = scenario('02-list-three-jobs')[0] as Step
    const lp = client.schedules.listSchedules()
    const li = await bridge.next('schedules.list')
    for (const out of list.sent_by_bridge) bridge.send(rebind(out, li as never))
    await lp

    const propose = step('05-patch-update', /rewrites the prompt/)
    const approve = step('05-patch-update', /approves the new prompt/)
    const change = propose.received_by_bridge[0]?.change
    const before = bridge.got.length
    const { clientRef } = await (async () => {
      const pp = client.schedules.proposeScheduleChange(change, 'general')
      const inbound = await bridge.next('schedule.patch', before)
      expect(inbound.id).toBeDefined()
      const ack = propose.sent_by_bridge.find((x) => x.type === 'ack') as Record<string, any>
      bridge.send(rebind(ack, inbound as never))
      const out = await pp
      expect(out.clientRef).toBe(inbound.id)
      // the captured card, bound to this patch (client_ref) with its hash recomputed the way the bridge mints it
      const cc = propose.sent_by_bridge.find((x) => x.type === 'card.create') as { card: CardT }
      const card: CardT = {
        ...cc.card,
        id: `c_${newUlid()}`,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        payload: { ...(cc.card.payload as object), client_ref: inbound.id },
      }
      card.payload_hash = payloadHash(bindingFrom(card))
      bridge.send({ type: 'card.create', card })
      return out
    })()
    await waitFor(
      () => client.store.getState().cards.some((c) => (c.payload as { client_ref?: string }).client_ref === clientRef),
      5000,
      'card reached the web client',
    )
    const card = client.store
      .getState()
      .cards.find((c) => (c.payload as { client_ref?: string }).client_ref === clientRef) as CardT
    expect(card.risk).toBe('high')
    expect(payloadHash(bindingFrom(card))).toBe(card.payload_hash) // not "altered" after the relay round trip

    // no step-up: the relay refuses
    await expect(
      client.resolveCard(card.id, { action: 'primary', payloadHash: card.payload_hash }),
    ).rejects.toMatchObject({
      code: 'stepup_required',
    })
    const statuses: Array<Record<string, any>> = []
    client.onFrame('schedule.status', (f) => statuses.push(f as never))
    const b2 = bridge.got.length
    await client.resolveCard(card.id, {
      action: 'primary',
      payloadHash: card.payload_hash,
      stepupToken: await r.mintStepup(`card:${card.id}`),
    })
    const resolve = await bridge.next('card.resolve', b2)
    expect(resolve.payload_hash).toBe(card.payload_hash)
    expect(resolve.stepup_token).toBeUndefined() // stripped by the relay
    for (const out of approve.sent_by_bridge) {
      const f = { ...out }
      delete f.id
      delete f.ts
      if (f.type === 'ack') f.ref = resolve.id
      if (f.type === 'card.update') f.card_id = card.id
      if (f.resolution) f.resolution = { ...f.resolution, payload_hash: card.payload_hash }
      bridge.send(f)
    }
    await waitFor(() => client.store.getState().cards.find((c) => c.id === card.id)?.state === 'done', 5000, 'done')
    await waitFor(() => statuses.length === 1, 5000, 'status fanned out')
    expect(needsRefetch(statuses[0] as never, client.store.getState().schedules.revs)).toBe(true)
  })

  it('run now: one signed frame, id/osig untouched; a resend of the same bytes is acked by the relay and never forwarded', async () => {
    const { bridge, client, dev } = await world()
    const s = step('07-run-now', /session job/)
    const b0 = bridge.got.length
    const p = client.schedules.runScheduleNow('daily-digest', { again: false, where: 'default' })
    const inbound = await bridge.next('schedule.run_now', b0)
    expect(await verifyOwnerFrame(inbound, dev.publicJwk)).toBe(true)
    expect(inbound).toMatchObject({ schedule_id: 'daily-digest', again: false, where: 'default' })
    bridge.send(rebind(s.sent_by_bridge[0] as never, inbound as never))
    await p
    expect(bridge.got.filter((f) => f.type === 'schedule.run_now')).toHaveLength(1)
  })

  it('schedule_invalid with fields reaches the form as TalosClientError.fields', async () => {
    const { bridge, client } = await world()
    const s = step('11-errors', /schedule_invalid/)
    const b0 = bridge.got.length
    const p = client.schedules.proposeScheduleChange(s.received_by_bridge[0]?.change, 'general')
    const inbound = await bridge.next('schedule.patch', b0)
    bridge.send(rebind(s.sent_by_bridge[0] as never, inbound as never))
    const e = await p.catch((x: unknown) => x)
    expect(e).toBeInstanceOf(TalosClientError)
    expect((e as TalosClientError).code).toBe('schedule_invalid')
    expect((e as TalosClientError).fields?.length).toBeGreaterThan(0)
  })

  it('a bridge that does not advertise schedules/1 is "update the Mac", and nothing is sent', async () => {
    relay = await startTestRelay()
    const bridge = await rawBridge(relay, relay.bridgeKey, [])
    const headers = relay.appHeaders
    class HeaderWS extends WsWebSocket {
      constructor(url: string) {
        super(url, { headers })
      }
    }
    client = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: `${relay.wsBase}/ws`,
      WebSocketImpl: HeaderWS as unknown as typeof WebSocket,
      isVisible: () => true,
      isOnline: () => true,
    })
    await client.ensureDevice()
    await client.start({ pinned: true })
    const c = client
    await waitFor(() => c.store.getState().presence.bridge_online, 5000, 'online')
    await expect(c.schedules.listSchedules()).rejects.toMatchObject({ code: 'scheduler_unavailable' })
    expect(bridge.got.some((f) => f.type === 'schedules.list')).toBe(false)
  })

  // B2: the spec gives the Mac 20 s (S2.2 "If the app gets no answer within 20 s"), and the real bridge acks a patch or a
  // get only AFTER its adapter calls (each may take up to 15 s, serialized behind the watch/tick queue). The web client
  // waits through sendAndWait's 12 s card.resolve timer instead, so a Mac answering at 13 s is reported as "The relay did
  // not answer" while the card it minted still lands in the thread.
  it('B2: a bridge that answers a patch at 13 s (inside the 20 s budget) is not reported as no answer', async () => {
    const { bridge, client } = await world()
    const s = step('05-patch-update', /renames the job/)
    const b0 = bridge.got.length
    const p = client.schedules.proposeScheduleChange(s.received_by_bridge[0]?.change, 'general')
    const inbound = await bridge.next('schedule.patch', b0)
    setTimeout(() => bridge.send(rebind(s.sent_by_bridge[0] as never, inbound as never)), 13_000)
    await expect(p).resolves.toMatchObject({ clientRef: inbound.id }) // FAILS: rejects at 12 s
  }, 30_000)
})
