// WP-C3, the bridge end of session controls, driven through the REAL bridge (inbound, owner signature, policy,
// ModLink queue, recorded result) with FakeMod standing in for the Claude Code mod and FakeRelay/FakeApp for the wire.

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { MODEL_SWITCH_TIMEOUT_MS, type ModControlT, newUlid } from '@talos-app/protocol'
import { FakeMod, fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { CONTROL_NO_ANSWER_MS, SessionControls } from '../src/session/controls.ts'
import { startHarness } from './helpers.ts'
import { signingLink } from './mod-sign.ts'

type H = Awaited<ReturnType<typeof startHarness>>
let h: H | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

/** A mod that has said hello and synced once, so the bridge holds a live state and inventory. */
async function liveMod(
  harness: H,
  opts: ConstructorParameters<typeof FakeMod>[0] extends infer O ? Partial<O> : never = {},
) {
  const clock = fakeClock()
  const mod = new FakeMod({ clock, ...opts })
  const link = signingLink(harness.bridge.ctx.mod, () => Date.now())
  const file = () => readFileSync(harness.bridge.ctx.paths.modKey, 'utf8').trim()
  expect(link.hello(file())).toEqual({ ok: true })
  const sync = () => {
    const r = link.sync(mod.syncRequest(file()))
    if (!r.ok) throw new Error(r.message)
    return r.response.controls
  }
  sync()
  return { mod, sync, clock }
}

/** Syncs as the mod would until the bridge hands it a control. */
async function nextControls(sync: () => ModControlT[], what: string): Promise<ModControlT[]> {
  let out: ModControlT[] = []
  await waitFor(
    () => {
      out = sync()
      return out.length > 0
    },
    4000,
    what,
  )
  return out
}

const resultFor = (harness: H, id: string) =>
  harness.app.expectFrame('session.control.result', (f) => f.control_id === id, { timeoutMs: 4000 })

describe('session.control through the real bridge', () => {
  test('no mod: refused with capability_missing, and the refusal is a recorded, delivered result', async () => {
    h = await startHarness()
    const f = await h.app.sendSessionControl('general', { action: 'compact', ts: new Date().toISOString() })
    const r = await resultFor(h, f.control_id as string)
    expect(r).toMatchObject({ ok: false, code: 'capability_missing' })
    expect(h.bridge.ctx.store.kvGet(`ctl:${f.control_id}`)).toBeString()
  })

  test('stop with the shown turn id reaches the mod, and its result reaches the app', async () => {
    h = await startHarness()
    const { mod, sync } = await liveMod(h)
    mod.engine.startTurn('turn_1')
    sync()
    const f = await h.app.sendSessionControl('general', { action: 'stop', turn_id: 'turn_1' })
    const controls = await nextControls(sync, 'stop delivered')
    expect(controls[0]).toMatchObject({ control_id: f.control_id, action: 'stop', turn_id: 'turn_1' })
    await mod.execute(controls[0] as ModControlT)
    sync()
    expect(await resultFor(h as H, f.control_id as string)).toMatchObject({ ok: true })
    expect(mod.state().busy).toBe(false)
  })

  test('stop for a turn that is no longer the running one is turn_mismatch and never reaches the mod', async () => {
    h = await startHarness()
    const { mod, sync } = await liveMod(h)
    mod.engine.startTurn('turn_2')
    sync()
    const f = await h.app.sendSessionControl('general', { action: 'stop', turn_id: 'turn_1' })
    expect(await resultFor(h, f.control_id as string)).toMatchObject({ ok: false, code: 'turn_mismatch' })
    expect(sync()).toEqual([])
  })

  test('a control older than 2 minutes is control_stale', async () => {
    h = await startHarness()
    await liveMod(h)
    const f = await h.app.sendSessionControl('general', {
      action: 'compact',
      ts: new Date(Date.now() - 3 * 60_000).toISOString(),
    })
    expect(await resultFor(h, f.control_id as string)).toMatchObject({ ok: false, code: 'control_stale' })
  })

  test('a model outside the configured list is model_not_allowed; one inside carries a one-shot ticket to the mod', async () => {
    h = await startHarness()
    const { sync } = await liveMod(h)
    const bad = await h.app.sendSessionControl('general', {
      action: 'command',
      command: 'model',
      source: 'builtin',
      args: 'opus-evil',
    })
    expect(await resultFor(h, bad.control_id as string)).toMatchObject({ ok: false })
    const ok = await h.app.sendSessionControl('general', {
      action: 'command',
      command: 'model',
      source: 'builtin',
      args: 'sonnet',
    })
    const controls = await nextControls(sync, 'model control delivered')
    const c = controls[0] as ModControlT
    expect(c).toMatchObject({
      control_id: ok.control_id,
      action: 'command',
      command: 'model',
      source: 'builtin',
      args: 'sonnet',
    })
    const ticket = c.model_ticket
    expect(ticket?.to_model).toBe('sonnet')
    expect(Date.parse(ticket?.expires_at ?? '') - Date.now()).toBeLessThanOrEqual(MODEL_SWITCH_TIMEOUT_MS)
  })

  test('a built-in outside the allowlist, and a skill sent as a command, are command_not_allowed', async () => {
    h = await startHarness()
    await liveMod(h)
    const a = await h.app.sendSessionControl('general', {
      action: 'command',
      command: 'permissions',
      source: 'builtin',
    })
    expect(await resultFor(h, a.control_id as string)).toMatchObject({ ok: false, code: 'command_not_allowed' })
  })

  test("the mod's result is recorded before the frame is consumed, and a replay re-sends it without a second run", async () => {
    h = await startHarness()
    const { mod, sync } = await liveMod(h)
    const f = await h.app.sendSessionControl('general', { action: 'compact' })
    const controls = await nextControls(sync, 'compact delivered')
    await mod.execute(controls[0] as ModControlT)
    sync() // the result travels on the next sync
    const first = await resultFor(h, f.control_id as string)
    expect(first.ok).toBe(true)
    // the relay replays the frame after a restart: same control, stored result back, nothing queued for the mod
    h.bridge.ctx.session.onControl({ ...(f as Record<string, unknown>), id: newUlid() } as never, () => {})
    await sleep(80)
    expect(sync()).toEqual([])
  })
})

describe('hello features (review R1)', () => {
  test('the bridge advertises session/1 next to schedules/1, or the sheet never appears', async () => {
    h = await startHarness()
    const hello = await h.relay.expectFrame('hello', (f) => f.role === 'bridge', { direction: 'from_bridge' })
    expect((hello.client as { features?: string[] }).features).toEqual(
      expect.arrayContaining(['session/1', 'schedules/1']),
    )
  })
})

describe('SessionControls backstop', () => {
  test('a mod that never answers: mac_offline after the backstop, and a late result is dropped', () => {
    const clock = fakeClock()
    const sent: unknown[] = []
    const kv = new Map<string, string>()
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
      transport: { sendDurable: async (f: unknown) => void sent.push(f) },
      mod: {
        liveState: () => ({
          session_id: 's',
          source: 'mod',
          capabilities: ['compact'],
          rate_limits: [],
          surfaces: [],
          at: new Date(clock.now()).toISOString(),
        }),
        liveInventory: () => undefined,
        enqueue: (c: ModControlT) => (queue.push(c), true),
      },
    } as never
    const s = new SessionControls(ctx)
    const id = newUlid()
    let finished = 0
    s.onControl(
      { type: 'session.control', control_id: id, action: 'compact', ts: new Date(clock.now()).toISOString() } as never,
      () => finished++,
    )
    expect(queue).toHaveLength(1)
    expect(finished).toBe(0)
    clock.advance(CONTROL_NO_ANSWER_MS + 1)
    expect(finished).toBe(1)
    expect(sent.at(-1)).toMatchObject({ type: 'session.control.result', ok: false, code: 'mac_offline' })
    s.onModResult({ control_id: id, ok: true, text: 'late' })
    expect(sent).toHaveLength(1)
  })
})
