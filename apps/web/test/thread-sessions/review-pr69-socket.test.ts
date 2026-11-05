// @vitest-environment node
// PR #69 review: the real socket client and the thread-sessions store against the testkit FakeRelay. A newer bridge
// that adds a worker state (or failure code, or governor state) must not knock the app over: the frame is parsed by the
// app's own parseFrame before any store sees it.
import { FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getThreadSessionsController } from '../../src/features/thread-sessions/store.ts'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

let relay: FakeRelay
let client: SocketClient

beforeEach(async () => {
  relay = await new FakeRelay().start()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
})
afterEach(async () => {
  client.close()
  await relay.stop()
})

const status = (threads: Array<Record<string, unknown>>, at: string, governor = 'ok') => ({
  supported: true,
  supervisor_online: true,
  threads,
  governor: { state: governor },
  at,
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('PR69 review: socket client and workers.status', () => {
  it('a known workers.status reaches the store (harness check)', async () => {
    const ctl = getThreadSessionsController(client)
    const stop = ctl.start()
    relay.sendToApps(
      mkFrame('workers.status', { status: status([{ thread_id: 'trip', state: 'live' }], '2026-10-30T00:00:01.000Z') }),
    )
    await waitFor(() => ctl.store.getState().status !== undefined, 2000, 'status')
    expect(ctl.store.getState().status?.threads[0]?.state).toBe('live')
    stop()
  })

  it('REVIEW-FAIL: a newer bridge with an unknown worker state still updates the status (other threads stay correct)', async () => {
    const ctl = getThreadSessionsController(client)
    const stop = ctl.start()
    relay.sendToApps(
      mkFrame('workers.status', { status: status([{ thread_id: 'trip', state: 'live' }], '2026-10-30T00:00:01.000Z') }),
    )
    await waitFor(() => ctl.store.getState().status !== undefined, 2000, 'first status')
    relay.sendToApps(
      mkFrame('workers.status', {
        status: status(
          [
            { thread_id: 'trip', state: 'parked' },
            { thread_id: 'work', state: 'hibernating', error: 'quota_wait' },
          ],
          '2026-10-30T00:00:02.000Z',
          'cooling',
        ),
      }),
    )
    // the parked trip must not keep showing "Live"
    await waitFor(
      () => ctl.store.getState().status?.threads.find((t) => t.thread_id === 'trip')?.state === 'parked',
      2000,
      'the second status applied',
    )
    expect(ctl.store.getState().status?.threads.find((t) => t.thread_id === 'trip')?.state).toBe('parked')
    stop()
  })

  it('a ready with a known workers_status is applied (harness check for the test below)', async () => {
    const ctl = getThreadSessionsController(client)
    const stop = ctl.start()
    const s = client.store.getState()
    relay.sendToApps(
      mkFrame('ready', {
        session_id: 'sess_2',
        policy: { max_frame_bytes: 262144, ping_ms: 25000 },
        server_seq: 0,
        presence: s.presence,
        unread: { general: 7 },
        workers_status: status([{ thread_id: 'trip', state: 'live' }], '2026-10-30T00:00:03.000Z'),
      }),
    )
    await waitFor(() => client.store.getState().unread.general === 7, 2000, 'ready applied')
    expect(ctl.store.getState().status?.threads[0]?.state).toBe('live')
    stop()
  })

  it('REVIEW-FAIL: a ready whose workers_status has an unknown worker state is still applied (the app is not stranded)', async () => {
    const s = client.store.getState()
    relay.sendToApps(
      mkFrame('ready', {
        session_id: 'sess_2',
        policy: { max_frame_bytes: 262144, ping_ms: 25000 },
        server_seq: 0,
        presence: s.presence,
        unread: { general: 7 },
        workers_status: status([{ thread_id: 'trip', state: 'hibernating' }], '2026-10-30T00:00:03.000Z'),
      }),
    )
    // the whole ready (config, cards, unread, presence) is dropped today
    await waitFor(() => client.store.getState().unread.general === 7, 2000, 'ready applied')
    expect(client.store.getState().unread.general).toBe(7)
  })

  it('thread.session.control goes out signed with the thread id, and only its own control_id settles it', async () => {
    const ctl = getThreadSessionsController(client)
    const stop = ctl.start()
    const done = ctl.control('trip', 'park')
    await waitFor(
      () => relay.frames.some((f) => f.direction === 'from_app' && f.raw.type === 'thread.session.control'),
      2000,
      'control sent',
    )
    const sent = relay.frames.find((f) => f.direction === 'from_app' && f.raw.type === 'thread.session.control')
      ?.raw as Record<string, unknown>
    expect(sent).toMatchObject({ thread_id: 'trip', action: 'park' })
    expect(typeof sent.osig).toBe('string')
    let settled = false
    void done.then(() => {
      settled = true
    })
    relay.sendToApps(
      mkFrame('session.control.result', {
        control_id: '01JBF3V7Q8K2M4N6P8R0S00000',
        ok: true,
        text: 'other',
        at: '2026-10-30T00:00:00.000Z',
      }),
    )
    await sleep(150)
    expect(settled).toBe(false)
    relay.sendToApps(
      mkFrame('session.control.result', {
        control_id: sent.control_id as string,
        ok: true,
        text: 'Parking.',
        at: '2026-10-30T00:00:00.000Z',
      }),
    )
    expect(await done).toMatchObject({ ok: true, text: 'Parking.' })
    stop()
  })
})
