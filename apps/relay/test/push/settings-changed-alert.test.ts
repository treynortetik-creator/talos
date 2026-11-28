// settings_changed: the agent changed, because the owner asked, a setting that decides which alerts reach him. A change that
// silences him must not itself be silenced: it goes through the quiet window, the master switch and a thread's alerts being off.
// The REAL CorePush.
import type { AgentConfigT } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { CorePush, NoopTransport } from '../../src/core/push.ts'
import type { Logger } from '../../src/services.ts'
import { startTestRelay, type TestRelay } from '../core/harness.ts'

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
  const cfg: AgentConfigT = { ...DEFAULT_AGENT_CONFIG, ...over }
  const push = new CorePush({
    store: r.runtime.store,
    clock,
    log: quietLog,
    transport: web,
    config: () => cfg,
  })
  return { push, web }
}

describe('settings_changed reaches the owner whatever the alert settings now say', () => {
  it('through the quiet window, where a reply is held for the summary', async () => {
    const x = await rig({ quiet_window: { start: '09:00', end: '11:00' }, timezone: 'Etc/GMT+5' })
    await x.push.notify({ template: 'reply', thread_id: 'general' })
    expect(x.web.sent).toHaveLength(0)
    await x.push.notify({ template: 'settings_changed', thread_id: 'general' })
    expect(x.web.sent.map((s) => s.payload.notification.body)).toEqual([
      'Talos changed a setting that affects your alerts',
    ])
  })

  it('with the master switch off', async () => {
    const x = await rig({ notifications: { master: false, show_thread_names: 'fixed_only', web_message_text: true } })
    await x.push.notify({ template: 'settings_changed', thread_id: 'general' })
    expect(x.web.sent).toHaveLength(1)
  })

  it("with the thread's alerts off", async () => {
    const x = await rig({
      threads: DEFAULT_AGENT_CONFIG.threads.map((t) => (t.id === 'general' ? { ...t, notify: 'off' as const } : t)),
    })
    await x.push.notify({ template: 'reply', thread_id: 'general' })
    expect(x.web.sent).toHaveLength(0)
    await x.push.notify({ template: 'settings_changed', thread_id: 'general' })
    expect(x.web.sent).toHaveLength(1)
  })
})
