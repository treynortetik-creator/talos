// Real words in browser pushes: the thread name and a one-line preview of a reply, for browsers only. Real CorePush on a
// real relay store; the hub path runs through the real relay with a fake bridge. Apple's copy never gets the words, and no
// log line carries them.
import { type AgentConfigT, buildApnsBody, buildPushPayload, PushPayload } from '@talos-app/protocol'
import { fakeClock, t, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import webpush from 'web-push'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { appleConfig, CorePush, createWebPushTransport, forApple, NoopTransport } from '../../src/core/push.ts'
import { readQuietHeld } from '../../src/core/quiet-summary.ts'
import type { Logger, PushTransport } from '../../src/services.ts'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit, sub } from '../core/helpers.ts'

vi.setConfig({ testTimeout: t(30_000) })

const WORDS = 'the launch window opens at nine, bring the blue folder'
const THREAD = 'Quarterly planning notes'
const NAMES = (mode: 'fixed_only' | 'all' | 'none') => ({
  notifications: { ...DEFAULT_AGENT_CONFIG.notifications, show_thread_names: mode },
})

const relays: TestRelay[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const r of relays.splice(0)) await r.stop()
})

function recordingLog(lines: string[]): Logger {
  const rec = (...a: unknown[]) => void lines.push(JSON.stringify(a))
  return {
    debug: rec,
    info: rec,
    warn: rec,
    error: rec,
    child() {
      return this
    },
  } as Logger
}

const withAgentThread = (over: Partial<AgentConfigT>): AgentConfigT => ({
  ...DEFAULT_AGENT_CONFIG,
  threads: [
    ...DEFAULT_AGENT_CONFIG.threads,
    { id: 'quarterly_planning', name: THREAD, kind: 'agent', notify: 'all' } as AgentConfigT['threads'][number],
  ],
  ...over,
})

/** A real CorePush on a real relay store, with a recording transport. */
async function rig(
  over: Partial<AgentConfigT> = {},
  transport: PushTransport = new NoopTransport(),
  lines: string[] = [],
) {
  const clock = fakeClock('2026-10-31T15:00:00.000Z')
  const r = await startTestRelay({ clock })
  relays.push(r)
  r.runtime.store.putSub(sub())
  const cfg = withAgentThread(over)
  const push = new CorePush({ store: r.runtime.store, clock, log: recordingLog(lines), transport, config: () => cfg })
  return { push, transport, store: r.runtime.store }
}
const sent = (x: { transport: PushTransport }) => (x.transport as NoopTransport).sent

describe('what a browser push says', () => {
  it('a reply carries the thread name and a preview of the reply', async () => {
    const x = await rig()
    await x.push.notify({ template: 'reply', thread_id: 'general' }, { rich: { text: WORDS } })
    expect(sent(x)[0]?.payload.notification).toMatchObject({ title: 'General', body: WORDS })
    expect(PushPayload.safeParse(sent(x)[0]?.payload).success).toBe(true)
  })

  it('an agent-named thread shows by name only when the owner chose "all"; otherwise the agent name and the reply', async () => {
    const fixed = await rig()
    await fixed.push.notify({ template: 'reply', thread_id: 'quarterly_planning' }, { rich: { text: WORDS } })
    expect(sent(fixed)[0]?.payload.notification).toMatchObject({ title: 'Talos', body: WORDS })
    const all = await rig(NAMES('all'))
    await all.push.notify({ template: 'reply', thread_id: 'quarterly_planning' }, { rich: { text: WORDS } })
    expect(sent(all)[0]?.payload.notification).toMatchObject({ title: THREAD, body: WORDS })
  })

  it('with thread names set to none the words still come, under the agent name', async () => {
    const x = await rig(NAMES('none'))
    await x.push.notify({ template: 'reply', thread_id: 'general' }, { rich: { text: WORDS } })
    expect(sent(x)[0]?.payload.notification).toMatchObject({ title: 'Talos', body: WORDS })
  })

  it('with message text off the push is the fixed text, and the thread name still follows its own setting', async () => {
    const off = { notifications: { ...DEFAULT_AGENT_CONFIG.notifications, web_message_text: false } }
    const named = await rig({ notifications: { ...off.notifications, show_thread_names: 'all' } })
    await named.push.notify({ template: 'reply', thread_id: 'quarterly_planning' }, { rich: { text: WORDS } })
    const fixed = await rig(off)
    await fixed.push.notify({ template: 'reply', thread_id: 'quarterly_planning' }, { rich: { text: WORDS } })
    expect(sent(named)[0]?.payload.notification).toMatchObject({ title: 'Talos', body: `New reply in ${THREAD}` })
    expect(sent(fixed)[0]?.payload.notification).toMatchObject({ title: 'Talos', body: 'New reply in a thread' })
    expect(JSON.stringify([sent(named), sent(fixed)])).not.toContain('launch window')
  })

  it('a password in the reply never reaches the push, and the default is message text on', async () => {
    expect(DEFAULT_AGENT_CONFIG.notifications.web_message_text).toBe(true)
    const x = await rig()
    await x.push.notify({ template: 'reply', thread_id: 'general' }, { rich: { text: 'the password: hunter2 is set' } })
    expect(JSON.stringify(sent(x))).not.toContain('hunter2')
    expect(sent(x)[0]?.payload.notification.body).toContain('the password')
  })

  it('no words given, or a card or a system alert: the fixed text, as before', async () => {
    const x = await rig()
    await x.push.notify({ template: 'reply', thread_id: 'general' })
    await x.push.notify(
      { template: 'needs_you', thread_id: 'general', card_id: 'c_01JABCDEFGHJKMNPQRSTVWXYZ0' },
      { rich: { text: WORDS } },
    )
    await x.push.notify({ template: 'settings_changed', thread_id: 'general' }, { rich: { text: WORDS } })
    expect(sent(x).map((s) => s.payload.notification.body)).toEqual([
      'New reply in General',
      'Needs you in General',
      'Talos changed a setting that affects your alerts',
    ])
  })

  it('Apple never gets the words: the Apple body is built from the fixed config, apart from the web payload', () => {
    const cfg = withAgentThread(NAMES('all'))
    const apple = forApple(
      buildPushPayload({ template: 'reply', thread_id: 'quarterly_planning' }, appleConfig(cfg)),
      () => 'ref',
    )
    const body = JSON.stringify(buildApnsBody(apple))
    expect(body).not.toContain(THREAD)
    expect(body).not.toContain('launch window')
  })
})

describe('the words are handled as content', () => {
  it('no log line carries the thread name or the reply, on a send that works or one that fails', async () => {
    const lines: string[] = []
    for (const ok of [true, false]) {
      const x = await rig(NAMES('all'), { name: 'webpush', send: async () => ({ ok, gone: false }) }, lines)
      await x.push.notify({ template: 'reply', thread_id: 'quarterly_planning' }, { rich: { text: WORDS } })
    }
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      expect(l).not.toContain('launch window')
      expect(l).not.toContain(THREAD)
    }
  })

  it('the real web transport gets the words only to encrypt them, and nothing of them is logged when the push service refuses', async () => {
    const lines: string[] = []
    const seen: string[] = []
    vi.spyOn(webpush, 'sendNotification').mockImplementation(async (_sub, body) => {
      seen.push(String(body))
      throw Object.assign(new Error(`push service said no to ${String(body)}`), { statusCode: 500, body: String(body) })
    })
    const vapid = webpush.generateVAPIDKeys()
    const transport = createWebPushTransport({ ...vapid, subject: 'mailto:alex@example.com' })
    const x = await rig({}, transport, lines)
    const counts = await x.push.notify({ template: 'reply', thread_id: 'general' }, { rich: { text: WORDS } })
    expect(counts).toMatchObject({ sent: 1, ok: 0 })
    expect(seen).toHaveLength(1)
    expect(JSON.parse(seen[0] ?? '{}').notification.body).toBe(WORDS)
    for (const l of lines) expect(l).not.toContain('launch window')
  })

  it('a reply held by the quiet window leaves only a count behind, never the words', async () => {
    const x = await rig({ quiet_window: { start: '09:00', end: '23:00' }, timezone: 'UTC' })
    await x.push.notify({ template: 'reply', thread_id: 'general' }, { rich: { text: WORDS } })
    expect(sent(x)).toHaveLength(0)
    const held = readQuietHeld(x.store)
    expect(held.replies).toBe(1)
    expect(JSON.stringify(held)).not.toContain('launch window')
  })

  it('through the real relay: a bridge reply reaches the browser with words while a Mac window is visible, and no log carries them', async () => {
    const lines: string[] = []
    const relay = await startTestRelay({ clock: fakeClock(new Date().toISOString()), log: recordingLog(lines) })
    relays.push(relay)
    relay.runtime.store.putSub(sub())
    const k = kit(relay)
    const app = await k.connectedApp({ visible: true })
    const bridge = await k.bridge().connect()
    bridge.reply('general', WORDS)
    await app.expectFrame('reply')
    await waitFor(() => relay.transport.sent.length >= 1, 10_000, 'the push')
    expect(relay.transport.sent[0]?.payload.notification).toMatchObject({ title: 'General', body: WORDS })
    for (const l of lines) expect(l).not.toContain('launch window')
  })
})
