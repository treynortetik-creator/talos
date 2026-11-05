// @vitest-environment node
// The catch-up family (src/lib/socket-frames-catchup.ts): ready, batches, the reset and the summary still move the store
// and lastSeq the way they did inside createSocketClient.
import { newId } from '@talos-app/protocol'
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

const row = (id: string, seq?: number) => ({
  id,
  thread_id: 'general',
  author: 'agent',
  kind: 'text',
  text: id,
  format: 'plain',
  attachments: [],
  via: 'app',
  created_at: AT,
  ...(seq !== undefined ? { seq } : {}),
})

describe('catch-up frames', () => {
  it('ready bumps readySeq and takes the presence it carries', async () => {
    const before = rig.client.store.getState().readySeq ?? 0
    rig.relay.sendToApps(
      mkFrame('ready', {
        session_id: 'sess_catchup',
        policy: { max_frame_bytes: 262144, ping_ms: 25000 },
        server_seq: 40,
        presence: { bridge_online: true, last_seen: AT, queue_depth: 2 },
        not_delivered: [],
      }),
    )
    await waitFor(() => (rig.client.store.getState().readySeq ?? 0) > before, 2000, 'ready')
    expect(rig.client.store.getState().presence.queue_depth).toBe(2)
    expect(rig.client.store.getState().serverSeq).toBe(40)
  })

  it('catchup.batch applies its stored frames without counting them unread, and lastSeq reaches to_seq', async () => {
    const id = newId('m')
    rig.relay.sendToApps(
      mkFrame('catchup.batch', {
        from_seq: 0,
        to_seq: 12,
        more: false,
        frames: [{ ...mkFrame('reply', { message: row(id, 11) }), ...STAMP(11) }],
      }),
    )
    await waitFor(() => rig.client.store.getState().lastSeq === 12, 2000, 'to_seq')
    const s = rig.client.store.getState()
    expect(s.messages.general?.map((m) => m.id)).toEqual([id])
    expect(s.unread.general ?? 0).toBe(0)
  })

  it('catchup.reset drops rows below min_seq, and catchup.summary is stored', async () => {
    const old = newId('m')
    const kept = newId('m')
    rig.relay.sendToApps(mkFrame('reply', { message: row(old, 2), ...STAMP(2) }))
    rig.relay.sendToApps(mkFrame('reply', { message: row(kept, 30), ...STAMP(30) }))
    await waitFor(() => rig.client.store.getState().messages.general?.length === 2, 2000, 'rows')
    rig.relay.sendToApps(mkFrame('catchup.reset', { min_seq: 20 }))
    await waitFor(() => rig.client.store.getState().messages.general?.length === 1, 2000, 'reset')
    expect(rig.client.store.getState().messages.general?.[0]?.id).toBe(kept)
    rig.relay.sendToApps(mkFrame('catchup.summary', { since_seq: 1, threads: [], open_cards: 3 }))
    await waitFor(() => rig.client.store.getState().catchup !== null, 2000, 'summary')
    expect(rig.client.store.getState().catchup).toMatchObject({ since_seq: 1, open_cards: 3 })
  })
})
