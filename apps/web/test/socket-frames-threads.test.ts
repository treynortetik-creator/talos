// @vitest-environment node
// The threads family (src/lib/socket-frames-threads.ts): thread list, status, presence and read marks still reach the store.
import { mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AT, connectedRig, type Rig, STAMP } from './helpers/socket-frames.ts'

let rig: Rig
beforeEach(async () => {
  rig = await connectedRig()
})
afterEach(async () => {
  await rig.stop()
})

const thread = (id: string, order: number) => ({
  id,
  name: id,
  kind: 'agent',
  order,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: AT,
})

describe('threads frames', () => {
  it('thread.upsert keeps threads in order, thread.archive flags one, thread.read zeroes its count', async () => {
    rig.relay.sendToApps(mkFrame('thread.upsert', { thread: thread('later', 1002), ...STAMP(1) }))
    rig.relay.sendToApps(mkFrame('thread.upsert', { thread: thread('first', 1001), ...STAMP(2) }))
    await waitFor(() => rig.client.store.getState().threads.some((t) => t.id === 'first'), 2000, 'threads')
    const ids = rig.client.store.getState().threads.map((t) => t.id)
    expect(ids.indexOf('first')).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf('first')).toBeLessThan(ids.indexOf('later'))
    rig.relay.sendToApps(mkFrame('thread.archive', { thread_id: 'later', ...STAMP(3) }))
    await waitFor(
      () => rig.client.store.getState().threads.find((t) => t.id === 'later')?.archived === true,
      2000,
      'archived',
    )
    expect(rig.client.store.getState().lastSeq).toBe(3)
    rig.relay.sendToApps(mkFrame('thread.unread', { thread_id: 'first', count: 3 }))
    await waitFor(() => rig.client.store.getState().unread.first === 3, 2000, 'unread')
    rig.relay.sendToApps(mkFrame('thread.read', { thread_id: 'first', up_to_seq: 3 }))
    await waitFor(() => rig.client.store.getState().unread.first === 0, 2000, 'read')
  })

  it('status and presence replace what the store held', async () => {
    rig.relay.sendToApps(mkFrame('status', { thread_id: 'general', state: 'working', label: 'Reading', since: AT }))
    rig.relay.sendToApps(
      mkFrame('presence', { bridge_online: true, last_seen: AT, queue_depth: 4, features: ['schedules/1'] }),
    )
    await waitFor(() => rig.client.store.getState().presence.queue_depth === 4, 2000, 'presence')
    const s = rig.client.store.getState()
    expect(s.statuses.general).toEqual({ thread_id: 'general', state: 'working', label: 'Reading', since: AT })
    expect(s.presence).toMatchObject({ bridge_online: true, queue_depth: 4, features: ['schedules/1'] })
  })
})
