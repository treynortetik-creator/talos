// D26 (iPhone): the app learns a thread's opaque notification reference so it can clear and silence a named thread's
// notifications. Real relay over HTTP; the named thread arrives through a real config.sync from a fake bridge.

import { buildPushPayload, ThreadId } from '@talos-app/protocol'
import { fakeClock, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { forApple } from '../../src/core/push.ts'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const NAMED = 'severance_talks_with_bob'
const get = (r: TestRelay, thread: string, headers: Record<string, string> | null = r.appHeaders) =>
  fetch(`${r.httpBase}/api/push/thread-ref/${thread}`, headers ? { headers } : {})

async function world() {
  relay = await startTestRelay({ clock: fakeClock('2026-10-31T15:00:00.000Z') })
  const r = relay
  const k = kit(r)
  const app = await k.connectedApp({ visible: false })
  const bridge = await k
    .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, autoReply: false })
    .connect()
  const general = DEFAULT_AGENT_CONFIG.threads[0]
  if (!general) throw new Error('no default thread')
  bridge.send({
    type: 'config.sync',
    config: {
      ...DEFAULT_AGENT_CONFIG,
      rev: 1,
      threads: [
        ...DEFAULT_AGENT_CONFIG.threads,
        { ...general, id: NAMED, name: 'Severance talks with Bob', kind: 'agent' },
      ],
    },
    rev: 1,
  })
  await waitFor(() => app.rec.frames.some((x) => x.raw.type === 'config.sync'), 3000, 'config')
  return { r }
}

describe('GET /api/push/thread-ref/:thread', () => {
  it('returns the same ref a push for that thread carries, so the app can match its notifications', async () => {
    const { r } = await world()
    const res = await get(r, NAMED)
    expect(res.status).toBe(200)
    const { ref } = (await res.json()) as { ref: string }
    expect(ref).toMatch(/^r_[A-Za-z0-9_-]{16}$/)
    expect(ref).not.toMatch(/severance/)
    // the ref is what forApple puts in the tag of a push for this thread
    const cfg = { ...DEFAULT_AGENT_CONFIG }
    const apple = forApple(buildPushPayload({ template: 'reply', thread_id: NAMED }, cfg), (t) =>
      r.runtime.store.pushRef(t),
    )
    expect(apple.notification.tag).toBe(`thread:${ref}`)
    // stable, and the reverse route agrees
    expect(((await (await get(r, NAMED)).json()) as { ref: string }).ref).toBe(ref)
    expect(r.runtime.store.threadForPushRef(ref)).toBe(NAMED)
  })

  it('a push that arrives before the app ever asked still carries the ref the app then receives', async () => {
    const { r } = await world()
    const pushed = r.runtime.store.pushRef(NAMED) // what the first push mints
    expect(((await (await get(r, NAMED)).json()) as { ref: string }).ref).toBe(pushed)
  })

  it('needs a session; refuses a malformed id; 404s a thread that does not exist (and mints nothing for it)', async () => {
    const { r } = await world()
    expect((await get(r, NAMED, null)).status).toBe(401)
    expect((await get(r, 'Bad-Id')).status).toBe(400)
    expect((await get(r, 'all')).status).toBe(400)
    expect(ThreadId.safeParse('nosuch').success).toBe(true)
    const before = (r.relay.services.db.prepare('select count(*) as n from core_push_refs').get() as { n: number }).n
    expect((await get(r, 'nosuch')).status).toBe(404)
    const after = (r.relay.services.db.prepare('select count(*) as n from core_push_refs').get() as { n: number }).n
    expect(after).toBe(before)
  })

  it('General and Inbox answer too (the app uses their ids directly, but the route must not break for them)', async () => {
    const { r } = await world()
    expect((await get(r, 'general')).status).toBe(200)
    expect((await get(r, 'inbox')).status).toBe(200)
  })
})
