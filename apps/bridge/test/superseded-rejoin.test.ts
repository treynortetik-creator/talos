// A bridge that another bridge replaced (close 4409) is not lost for good: once the other one is gone it takes its place again.
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { FakeBridge, fakeClock } from '@talos-app/testkit'
import { readStatusFile } from '../src/status-file.ts'
import { advanceSteps, type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness
let other: FakeBridge | undefined
afterEach(async () => {
  await other?.close().catch(() => {})
  other = undefined
  await h?.stop()
})

const hellos = (hh: Harness) => hh.relay.frames.filter((r) => r.direction === 'from_bridge' && r.frame.type === 'hello')

describe('a bridge replaced by another one', () => {
  test('connects again once the other bridge has gone', async () => {
    const clock = fakeClock(new Date().toISOString())
    h = await startHarness({ clock, bridge: { random: () => 0.5 } })
    other = await new FakeBridge({ relayWs: h.relay.wsBase, key: h.relay.bridgeKey, clientName: 'other-mac' }).connect()
    await waitFor(() => h.bridge.client?.connected === false, 4000, 'the first bridge to be replaced')
    await h.waitNotes(1)
    expect(h.notes[0]?.content).toContain('Another bridge connected')
    // while another bridge owns the key, nothing that needs the live session is offered: no tool prompts, no live-only tools
    expect(h.bridge.ctx.superseded).toBe(true)
    const refused = await h.bridge.callTool('talos_mod_hello', {})
    expect(refused.isError).toBe(true)
    expect(refused.content[0]?.text).toContain('needs a live session')

    await other.close() // the other bridge exits
    await waitFor(() => !h.relay.bridgeConnected, 4000, 'the relay to see the other bridge go')
    await advanceSteps(clock, 10 * 60_000, 30_000)
    await waitFor(() => h.bridge.client?.connected === true, 4000, 'the first bridge to be back')
    expect(h.relay.bridgeConnected).toBe(true)

    // it is live again, not a half-restored process: an owner message reaches the agent and a reply goes out
    const before = h.notes.length
    const sent = await h.app.sendMessage('general', 'are you back')
    await h.waitNotes(before + 1)
    expect(h.notes.at(-1)?.content).toContain('are you back')
    expect(sent.id).toBeTruthy()
    expect(h.bridge.live).toBe(true)
    expect(h.bridge.ctx.superseded).toBe(false)
    // what the pause stopped runs again: the agent is told, the status file says live, the problem filer is back
    expect(h.notes.some((n) => n.content.includes('connected to the app again'))).toBe(true)
    await waitFor(
      () => readStatusFile(join(h.home, 'status.json'))?.mode === 'live',
      4000,
      'status.json to say live again',
    )
    expect((h.bridge.ctx.problems as unknown as { timer: unknown }).timer).not.toBeNull()
  }, 30_000)

  test('against a relay that cannot take a standby hello it stays down instead of replacing the live bridge', async () => {
    const clock = fakeClock(new Date().toISOString())
    h = await startHarness({ clock, relay: { relayFeatures: ['schedules/1'] }, bridge: { random: () => 0.5 } })
    other = await new FakeBridge({ relayWs: h.relay.wsBase, key: h.relay.bridgeKey, clientName: 'other-mac' }).connect()
    await waitFor(() => h.bridge.client?.connected === false, 4000, 'the first bridge to be replaced')
    await advanceSteps(clock, 30 * 60_000, 30_000)
    expect(hellos(h).filter((r) => (r.frame as { standby?: boolean }).standby === true)).toHaveLength(0)
    expect(hellos(h)).toHaveLength(2) // the first bridge's own and the other one's
    expect(other.closeCode).toBeNull()
  }, 30_000)
})

describe('two live bridges with one key', () => {
  test('the replaced one keeps asking but never takes the slot back, so the two never trade it', async () => {
    const clock = fakeClock(new Date().toISOString())
    h = await startHarness({ clock, bridge: { random: () => 0.5 } })
    other = await new FakeBridge({ relayWs: h.relay.wsBase, key: h.relay.bridgeKey, clientName: 'other-mac' }).connect()
    await waitFor(() => h.bridge.client?.connected === false, 4000, 'the first bridge to be replaced')

    await advanceSteps(clock, 30 * 60_000, 30_000)
    const asks = hellos(h).filter((r) => (r.frame as { standby?: boolean }).standby === true)
    expect(asks.length).toBeGreaterThan(2) // it kept trying through half an hour of fake time
    expect(other.connected).toBe(true) // and the other bridge was never closed by it
    expect(other.closeCode).toBeNull()
    expect(h.relay.bridgeConnected).toBe(true)
    expect(h.bridge.client?.connected).toBe(false)
    // replies from the replaced one still go out over signed HTTP
    const res = await h.bridge.callTool('reply', { thread_id: 'general', text: 'still here' })
    expect(res.isError).toBeFalsy()
    expect(h.relay.http.some((r) => r.path === '/bridge/post' && r.status === 200)).toBe(true)
  }, 30_000)
})
