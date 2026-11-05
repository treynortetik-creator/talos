// The sign-in alert is the owner's only warning on the compat path. It must reach the phone however the screens look: a
// visible tab, a socket someone else keeps open, or the chat master switch being off. The REAL CorePush and the REAL hub.
import type { AgentConfigT } from '@talos-app/protocol'
import { fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { setAuthImplementation } from '../../src/auth/contract.ts'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { CorePush, NoopTransport } from '../../src/core/push.ts'
import type { Logger } from '../../src/services.ts'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit } from '../core/helpers.ts'
import { createTestAuth } from '../helpers/test-auth.ts'

const quietLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this
  },
} as Logger

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function rig(over: Partial<AgentConfigT> = {}) {
  const clock = fakeClock('2026-10-31T15:00:00.000Z')
  const r = await startTestRelay({ clock })
  cleanups.push(() => r.stop())
  r.runtime.store.putSub({ endpoint: 'https://push.example/one', keys: { p256dh: 'a', auth: 'b' } })
  const web = new NoopTransport()
  let visible = false
  const cfg: AgentConfigT = { ...DEFAULT_AGENT_CONFIG, ...over }
  const push = new CorePush({
    store: r.runtime.store,
    clock,
    log: quietLog,
    transport: web,
    config: () => cfg,
    anyVisible: () => visible,
  })
  return { push, web, setVisible: (v: boolean) => (visible = v) }
}

describe('sign-in alerts ignore the rules that silence chat', () => {
  it('both sign-in templates go out while a screen is visible; a reply does not', async () => {
    const x = await rig()
    x.setVisible(true)
    await x.push.notify({ template: 'reply', thread_id: 'general' })
    expect(x.web.sent).toHaveLength(0)
    await x.push.notify({ template: 'sign_in' })
    await x.push.notify({ template: 'sign_in_unproven' })
    expect(x.web.sent.map((s) => s.payload.notification.body)).toEqual([
      'New sign-in to Talos',
      'Sign-in on a device that did not prove its key',
    ])
  })

  it('both go out with the chat master switch off; a reply does not', async () => {
    const x = await rig({ notifications: { master: false, show_thread_names: 'fixed_only' } })
    await x.push.notify({ template: 'reply', thread_id: 'general' })
    expect(x.web.sent).toHaveLength(0)
    await x.push.notify({ template: 'sign_in' })
    await x.push.notify({ template: 'sign_in_unproven' })
    expect(x.web.sent).toHaveLength(2)
  })

  it('and through the quiet window, as the other system alerts do', async () => {
    const x = await rig({ quiet_window: { start: '07:00', end: '09:00' }, timezone: 'Etc/GMT+7' })
    await x.push.notify({ template: 'sign_in' })
    expect(x.web.sent).toHaveLength(1)
  })
})

describe('a socket the session never earned cannot report a visible screen', () => {
  it('an unpinned (limited) socket that says it is visible does not count as someone being there', async () => {
    const clock = fakeClock('2026-10-31T15:00:00.000Z')
    const r: TestRelay = await startTestRelay({ clock })
    cleanups.push(() => r.stop())
    // Same test auth, except that a session with no device is not pinned (as in production).
    setAuthImplementation(
      { ...createTestAuth({ bridgeKey: r.bridgeKey }), sessionPinned: (s) => s?.deviceId != null },
      { test: true },
    )
    const limited = await kit(r).connectedApp({ visible: true })
    await waitFor(() => r.runtime.hub.appCount() === 1, 3000, 'socket authed')
    await sleep(100) // the visibility report has been processed by now
    expect(r.runtime.hub.anyVisible()).toBe(false)
    await limited.close()
  })

  it('a pinned socket that is visible still counts (the rule did not just switch presence off)', async () => {
    const clock = fakeClock('2026-10-31T15:00:00.000Z')
    const r: TestRelay = await startTestRelay({ clock })
    cleanups.push(() => r.stop())
    const app = await kit(r).connectedApp({ visible: true })
    await waitFor(() => r.runtime.hub.anyVisible(), 3000, 'visible')
    await app.close()
  })
})
