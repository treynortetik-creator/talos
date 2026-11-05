// A relay turned on after the session declared nothing is not a relay: enabled is false, so no card is made for a prompt
// that could not have come, and open cards never claim one.
import { describe, expect, test } from 'bun:test'
import { permissionFixture, sleep, waitFor } from '@talos-app/testkit'
import { RELAY_RESTART_NOTICE } from '../src/bridge.ts'
import { startHarness } from './helpers.ts'

describe('PermissionRelay: configured vs declared', () => {
  test('configured on but declared off: not enabled, needs a restart, onRequest makes no card', async () => {
    const h = await startHarness({ config: (c) => ({ ...c, permission_relay: false }) })
    try {
      h.bridge.declarePermissionRelay(false) // what server.ts does when it started with the relay off
      h.bridge.ctx.config.config.permission_relay = true // the owner turns it on live
      const p = h.bridge.ctx.permission
      expect(p.configured).toBe(true)
      expect(p.declared).toBe(false)
      expect(p.enabled).toBe(false)
      expect(p.needsRestart).toBe(true)
      h.bridge.setClientVersion(() => '2.1.312')
      h.bridge.setPermissionSender(async () => {})
      await p.onRequest(permissionFixture('plain_bash').params)
      expect(p.openCount).toBe(0)
      expect(h.relay.frames.some((f) => f.direction === 'from_bridge' && f.raw.type === 'card.create')).toBe(false)
    } finally {
      await h.stop()
    }
  })

  test('declared on, then turned off live: off at once, no restart needed', async () => {
    const h = await startHarness({ config: (c) => ({ ...c, permission_relay: true }) })
    try {
      h.bridge.declarePermissionRelay(true)
      expect(h.bridge.ctx.permission.enabled).toBe(true)
      h.bridge.ctx.config.config.permission_relay = false
      expect(h.bridge.ctx.permission.enabled).toBe(false)
      expect(h.bridge.ctx.permission.needsRestart).toBe(false)
    } finally {
      await h.stop()
    }
  })

  test('the owner is told once, across several real polls (the poll interval is injectable)', async () => {
    const h = await startHarness({ config: (c) => ({ ...c, permission_relay: false }), bridge: { pollMs: 100 } })
    try {
      const told = () =>
        h.relay.frames.filter(
          (f) =>
            f.direction === 'from_bridge' &&
            f.raw.type === 'reply' &&
            (f.raw as { message?: { text?: string } }).message?.text === RELAY_RESTART_NOTICE,
        ).length
      let polls = 0
      const real = h.bridge.poll.bind(h.bridge)
      h.bridge.poll = async () => {
        polls++
        return real()
      }
      h.bridge.declarePermissionRelay(false)
      h.bridge.ctx.config.config.permission_relay = true // in memory only: no file event, so only the timer can notice
      await waitFor(() => told() >= 1, 3000, 'notice from a timed poll')
      await sleep(800) // about eight more polls
      expect(told()).toBe(1)
      expect(polls).toBeGreaterThanOrEqual(5) // real timed polls ran in that time, not one
    } finally {
      await h.stop()
    }
  })

  test('the notice names the terminal way as well as the menu bar', () => {
    expect(RELAY_RESTART_NOTICE).toMatch(/Restart session/)
    expect(RELAY_RESTART_NOTICE).toMatch(/quit and restart Claude Code in your terminal/)
  })
})
