// The device the owner's latest message came from is kept (kv `last_owner_device`) so `devices revoke` from the agent can refuse to
// lock him out (agent-cli.ts). Written by an owner message only: not by a share, a peer message or a bridge-made row.
import { afterEach, describe, expect, test } from 'bun:test'
import { newId } from '@talos-app/protocol'
import { LAST_OWNER_DEVICE_KEY } from '../src/agent-cli.ts'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { nullLogger } from '../src/log.ts'
import { fixture, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})
const kv = () => {
  const v = (h as Harness).bridge.ctx.store.kvGet(LAST_OWNER_DEVICE_KEY)
  return v === undefined ? undefined : (JSON.parse(v) as { device_id: string; at: number })
}

describe('last_owner_device', () => {
  test('nothing before he has written; an owner message records its device and time', async () => {
    h = await startHarness()
    expect(kv()).toBeUndefined()
    const sent = await h.app.sendMessage('general', 'hello')
    await waitFor(() => kv() !== undefined, 4000, 'the device to be recorded')
    expect(kv()?.device_id).toBe(h.app.device.deviceId)
    // the time kept is the bridge's own receive time, never the phone's
    expect(Math.abs((kv()?.at as number) - Date.now())).toBeLessThan(10_000)
    expect(sent.ts).toBeDefined()
  })
  test('a share is not him speaking: nothing is recorded', async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'look', { share_content: { title: 'A page', url: 'https://example.com/a' } })
    await h.waitNotes(1)
    await h.bridge.inbound?.idle()
    expect(kv()).toBeUndefined()
  })
  test("a phone clock fast (as far as the bridge accepts, 2 minutes): the order is the bridge's receive order, so the next message still wins", async () => {
    h = await startHarness()
    await h.app.sendMessage('general', 'fast clock', { ts: new Date(Date.now() + 100_000).toISOString() })
    await waitFor(() => kv() !== undefined, 4000, 'first')
    const first = kv()?.at as number
    expect(first).toBeLessThan(Date.now() + 60_000) // not the phone's time
    await sleep(20)
    await h.app.sendMessage('general', 'right clock')
    await waitFor(() => (kv()?.at as number) > first, 4000, 'the later receive')
  })

  test('the time is when the frame arrived, not when its turn in a busy lane came: outside text between the two refuses', async () => {
    h = await startHarness()
    const inbound = h.bridge.inbound as unknown as { messageExtras: (f: unknown) => Promise<unknown> }
    const real = inbound.messageExtras.bind(inbound)
    let held = true
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    inbound.messageExtras = async (f) => {
      if (held) {
        held = false
        await gate // the first message sits in processing
      }
      return real(f)
    }
    await h.app.sendMessage('general', 'one')
    await sleep(150)
    await h.app.sendMessage('general', 'two') // arrives now, waits behind the first
    await sleep(300)
    const outside = Date.now() // outside text lands after both arrived, before either is processed
    h.bridge.ctx.store.kvSet('outside_text_at:general', String(outside))
    await sleep(50)
    release()
    await h.waitNotes(2)
    await h.bridge.inbound?.idle()
    expect(kv()?.at as number).toBeLessThan(outside)
  })
  test('a resent message (same client_msg_id, a new frame id) does not move the time', async () => {
    h = await startHarness()
    const id = newId('m')
    await h.app.sendMessage('general', 'once', { client_msg_id: id })
    await waitFor(() => kv() !== undefined, 4000, 'first')
    const first = kv()?.at as number
    await sleep(40)
    await h.app.sendMessage('general', 'once', { client_msg_id: id })
    await sleep(300)
    await h.bridge.inbound?.idle()
    expect(kv()?.at).toBe(first)
  })

  test("the relay's receive time, when earlier, is the one kept: a message held at the relay while outside text arrived is still refused", async () => {
    h = await startHarness()
    const heldSince = Date.now() - 5 * 60_000
    const f = await h.app.buildMessage('general', 'sent while the Mac was away')
    h.relay.sendToBridge({ ...f, relay: { seq: 1, received_at: new Date(heldSince).toISOString() } })
    await waitFor(() => kv() !== undefined, 4000, 'the device to be recorded')
    expect(kv()?.at).toBe(heldSince) // the earlier of the two: it can only make the checks stricter
    // outside text that arrived locally after the relay got his message, before this bridge did
    h.bridge.ctx.store.kvSet('outside_text_at:general', String(heldSince + 60_000))
    const { agentCliRefusal } = await import('../src/agent-cli.ts')
    expect(
      agentCliRefusal(h.bridge.ctx.env, ['peer', 'create', 'work'], { terminal: false, raw: {}, cwd: h.home }),
    ).toMatch(/outside text/)
  })
  test('a voice note moves it too', async () => {
    h = await startHarness({ env: { TALOS_APP_STT_CMD: JSON.stringify([fixture('fake-stt.sh'), '{in}']) } })
    const res = await fetch(`${h.relay.httpUrl}/api/media`, {
      method: 'POST',
      headers: { 'content-type': 'audio/mp4', 'x-talos-name': 'note.m4a', 'x-talos-duration-ms': '5000' },
      body: 'audio bytes',
    })
    const ref = (await res.json()) as Record<string, unknown>
    expect(kv()).toBeUndefined()
    await h.app.sendVoiceNote('general', { ...ref, kind: 'voice_note', role: 'attachment' })
    await waitFor(() => kv() !== undefined, 6000, 'the voice note to be recorded')
    expect(kv()?.device_id).toBe(h.app.device.deviceId)
  })
  test('a message folded into a backlog (replayed after the Mac was off, long after the relay got it) moves it too', async () => {
    h = await startHarness()
    const x = h
    const old = Date.now() - 20 * 60_000
    const frames = [
      await x.app.buildMessage('general', 'first, while away'),
      await x.app.buildMessage('general', 'second'),
    ]
    await x.bridge.stop()
    frames.forEach((f, i) => {
      x.relay.sendToBridge({ ...f, relay: { seq: i + 1, received_at: new Date(old + i * 1000).toISOString() } })
    })
    const env = loadEnv({ TALOS_APP_HOME: x.home, TALOS_APP_RELAY_URL: x.relay.httpUrl, TALOS_APP_BRIDGE: '1' })
    const b = await Bridge.create({ env, logger: nullLogger, inbound: { settleMs: 20, maxSettleMs: 200 } })
    const notes: Array<{ meta: Record<string, string> }> = []
    b.setEmit(async (n) => {
      notes.push(n)
    })
    try {
      b.start()
      await waitFor(() => notes.some((n) => n.meta.kind === 'backlog'), 8000, 'the backlog note')
      const v = JSON.parse(b.ctx.store.kvGet(LAST_OWNER_DEVICE_KEY) ?? 'null') as {
        device_id: string
        at: number
      } | null
      expect(v?.device_id).toBe(x.app.device.deviceId)
      expect(v?.at).toBeLessThanOrEqual(old + 1000)
    } finally {
      await b.stop()
    }
  })
})
