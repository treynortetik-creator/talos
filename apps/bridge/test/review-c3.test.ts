// Regression tests for the bridge end of the Claude Code session controls; each test names the bug it guards.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { type ModControlT, newUlid } from '@talos-app/protocol'
import { FakeMod, fakeClock, sleep } from '@talos-app/testkit'
import { CONTROL_NO_ANSWER_MS, SessionControls } from '../src/session/controls.ts'
import { eventually, startHarness } from './helpers.ts'
import { signingLink } from './mod-sign.ts'

/** The same hand-made context the builder's backstop test uses; `kv` is history.sqlite's kv table and survives. */
function rig(kv = new Map<string, string>()) {
  const clock = fakeClock()
  const sent: Array<Record<string, unknown>> = []
  const queue: ModControlT[] = []
  const ctx = {
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {}, security() {} },
    config: { config: { session_models: ['default', 'opus'] } },
    store: {
      kvGet: (k: string) => kv.get(k),
      kvSet: (k: string, v: string) => void kv.set(k, v),
      kvDelete: (k: string) => void kv.delete(k),
    },
    transport: { sendDurable: async (f: Record<string, unknown>) => void sent.push(f) },
    mod: {
      liveState: () => ({
        session_id: 's',
        source: 'mod',
        capabilities: ['compact', 'clear'],
        rate_limits: [],
        surfaces: [],
        at: new Date(clock.now()).toISOString(),
      }),
      liveInventory: () => undefined,
      enqueue: (c: ModControlT) => (queue.push(c), true),
    },
  } as never
  return { clock, sent, queue, kv, s: new SessionControls(ctx) }
}

const control = (clock: { now(): number }, action: 'compact' | 'clear', id = newUlid()) =>
  ({
    type: 'session.control',
    id: newUlid(),
    control_id: id,
    action,
    ts: new Date(clock.now()).toISOString(),
  }) as never

describe('R3: the 45 s backstop is shorter than the work it waits on', () => {
  // `$.session.compact` waits for the summary model call; `$.command.run('clear')` is "queued and run once the session is
  // idle" (engine d.ts), so a clear sent mid-turn waits for the turn. Either can pass 45 s. The bridge then records
  // mac_offline ("The Mac did not answer"), consumes the frame, and drops the mod's real result. The owner taps again
  // and gets a second compact.
  test('a compact the mod finishes after 60 s ends as ok, not mac_offline', () => {
    const r = rig()
    const f = control(r.clock, 'compact')
    r.s.onControl(f, () => {})
    expect(r.queue).toHaveLength(1)
    r.clock.advance(60_000) // a long compaction
    r.s.onModResult({ control_id: (f as { control_id: string }).control_id, ok: true, text: 'Compacted.' })
    const last = r.sent.at(-1)
    expect(last).toMatchObject({ type: 'session.control.result', ok: true, text: 'Compacted.' })
    expect(CONTROL_NO_ANSWER_MS).toBeGreaterThan(60_000)
  })
})

describe('R5: a bridge restart between dispatch and result runs the control twice', () => {
  // C2.5: "a relay replay after a bridge restart finds the id ... instead of running twice". Only true once the result
  // is recorded. Until then `pending` lives in memory: a restart loses it, the frame is not consumed, the relay replays it
  // on the new hello, and the new SessionControls hands the same clear/compact to the (still running) mod again.
  test('the replayed control is not handed to the mod a second time', () => {
    const kv = new Map<string, string>()
    const first = rig(kv)
    const id = newUlid()
    first.s.onControl(control(first.clock, 'clear', id), () => {})
    expect(first.queue).toHaveLength(1) // the mod takes it on its next sync and runs /clear
    first.s.close() // Bridge.stop(): "A pending control stays unconsumed, so the relay replays it"

    const second = rig(kv) // same history.sqlite, new process
    second.s.onControl(control(second.clock, 'clear', id), () => {})
    expect(second.queue).toHaveLength(0)
  })
})

// ---- probes that PASS (kept as regressions): the relay cannot forge or alter a control ---------------------------

describe('probe: only an owner-signed, unaltered control reaches the mod', () => {
  test('a re-labelled signed frame (compact -> clear) and an unsigned one are never queued', async () => {
    const h = await startHarness()
    try {
      const mod = new FakeMod({ clock: fakeClock() })
      const link = signingLink(h.bridge.ctx.mod, () => Date.now())
      const file = () => readFileSync(h.bridge.ctx.paths.modKey, 'utf8').trim()
      expect(link.hello(file())).toEqual({ ok: true })
      const sync = () => {
        const r = link.sync(mod.syncRequest(file()))
        if (!r.ok) throw new Error(r.message)
        return r.response.controls
      }
      sync()
      const signed = await h.app.sign({
        type: 'session.control',
        v: 1,
        id: newUlid(),
        ts: new Date().toISOString(),
        control_id: newUlid(),
        thread_id: 'general',
        action: 'compact',
      })
      h.app.send({ ...signed, action: 'clear' }) // what a hostile relay would do
      h.app.send({
        type: 'session.control',
        control_id: newUlid(),
        thread_id: 'general',
        action: 'clear',
        device_id: signed.device_id,
        osig: 'A'.repeat(86),
      })
      await sleep(400)
      expect([...sync(), ...sync()]).toEqual([])
      // control: the same shape, signed and unaltered, does reach the mod (so the empty queue above is not vacuous)
      const good = await h.app.sign({
        type: 'session.control',
        v: 1,
        id: newUlid(),
        ts: new Date().toISOString(),
        control_id: newUlid(),
        thread_id: 'general',
        action: 'compact',
      })
      h.app.send(good)
      await sleep(400)
      await eventually(() => expect(sync().map((c) => c.control_id)).toEqual([good.control_id]))
    } finally {
      await h.stop()
    }
  })
})
