// @vitest-environment node
// Read marks between this device, the relay and the owner's other devices (bug hunt 2026-11-10, web findings 6 and 8).
//  - A thread read while the socket is down clears the count here; the mark must still reach the relay once the socket is
//    back, or the relay (push badge, `ready.unread`, the other devices) goes on counting a thread the owner has read.
//  - A `thread.read` from another device says how far THAT device read (`up_to_seq`). A reply this device got after that
//    point is still unread on the relay, so it stays unread here.
import { newId } from '@talos-app/protocol'
import { FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'
import { scriptedSockets } from './helpers/scripted-socket.ts'

let relay: FakeRelay
let client: SocketClient
let up = true

beforeEach(async () => {
  up = true
  relay = await new FakeRelay().start()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => up,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
})
afterEach(async () => {
  client.close()
  await relay.stop()
})

const at = () => new Date().toISOString()
const liveReply = (seq: number, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...mkFrame('reply', {
    message: {
      id: newId('m'),
      thread_id: 'general',
      author: 'agent',
      kind: 'text',
      text,
      format: 'markdown',
      attachments: [],
      via: 'app',
      created_at: at(),
    },
    ...extra,
  }),
  relay: { seq, received_at: at() },
})
const sent = (type: string) => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === type)
const readMarksSent = () => sent('thread.read').map((f) => f.raw.up_to_seq)
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

async function goOffline() {
  up = false
  relay.dropApps()
  await waitFor(() => client.store.getState().connection !== 'online', 2000, 'dropped')
}
async function comeBack() {
  up = true
  client.reconnect()
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'back')
  await settle()
}

describe('read marks', () => {
  it('a thread read while the socket is down is reported to the relay once the socket is back', async () => {
    relay.sendToApps(liveReply(1, 'one'))
    await waitFor(() => client.store.getState().unread.general === 1, 2000, 'unread 1')
    await goOffline()

    // The open thread marks itself read (Timeline does this with no `needConnection`).
    expect(client.markThreadRead('general', 1)).toBe(true)
    expect(client.store.getState().unread.general).toBe(0)
    await comeBack()

    // The relay must learn it, or its count (push badge, `ready.unread`, other devices) stays at 1.
    expect(readMarksSent()).toEqual([1])
    // and once it has gone out on a live socket it is not sent again by the next connection
    await goOffline()
    await comeBack()
    expect(readMarksSent()).toEqual([1])
  })

  it('a mark made on a live socket goes out once, at once', async () => {
    relay.sendToApps(liveReply(1, 'one'))
    await waitFor(() => client.store.getState().unread.general === 1, 2000, 'unread 1')
    expect(client.markThreadRead('general', 1)).toBe(true)
    await waitFor(() => readMarksSent().length === 1, 2000, 'sent')
    await settle(100)
    expect(readMarksSent()).toEqual([1])
  })

  it('a read mark from another device does not clear a reply that arrived after that mark', async () => {
    relay.sendToApps(liveReply(1, 'one'))
    relay.sendToApps(liveReply(2, 'two'))
    await waitFor(() => client.store.getState().unread.general === 2, 2000, 'unread 2')

    // The other device read up to seq 1; it had not seen seq 2 when it sent this.
    relay.sendToApps(mkFrame('thread.read', { thread_id: 'general', up_to_seq: 1 }))
    await settle(100)
    expect(client.store.getState().unread.general).toBe(1)

    // and a mark that covers everything still clears it
    relay.sendToApps(mkFrame('thread.read', { thread_id: 'general', up_to_seq: 2 }))
    await waitFor(() => client.store.getState().unread.general === 0, 2000, 'cleared')
  })

  it('a silent reply above the other device`s mark is not counted as unread', async () => {
    relay.sendToApps(liveReply(1, 'one'))
    relay.sendToApps(liveReply(2, 'spoken copy', { silent: true }))
    await waitFor(() => (client.store.getState().messages.general ?? []).length === 2, 2000, 'rows')
    expect(client.store.getState().unread.general).toBe(1)
    relay.sendToApps(mkFrame('thread.read', { thread_id: 'general', up_to_seq: 1 }))
    await settle(100)
    expect(client.store.getState().unread.general).toBe(0)
  })

  it('an old or unknown mark never raises the count', async () => {
    relay.sendToApps(liveReply(5, 'five'))
    await waitFor(() => client.store.getState().unread.general === 1, 2000, 'unread 1')
    relay.sendToApps(mkFrame('thread.read', { thread_id: 'general', up_to_seq: 0 }))
    await settle(100)
    expect(client.store.getState().unread.general).toBe(1)
    relay.sendToApps(mkFrame('thread.read', { thread_id: 'never-seen', up_to_seq: 3 }))
    await settle(100)
    expect(client.store.getState().unread['never-seen'] ?? 0).toBe(0)
  })
})

// The testkit relay's `ready` carries no counts, so these drive the real client with a scripted socket
// (helpers/scripted-socket.ts).
describe('read marks made offline, against what the next `ready` says', () => {
  type Script = { unread: Record<string, number>; read_upto?: Record<string, number> }
  let rig = scriptedSockets()
  let c2: SocketClient
  let online = true
  const marks = () => rig.sent('thread.read').map((f) => f.up_to_seq)

  async function startScripted(first: Script) {
    rig = scriptedSockets(first)
    online = true
    c2 = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: 'ws://scripted.invalid/ws',
      WebSocketImpl: rig.Impl,
      backoff: { baseMs: 5, maxMs: 10 },
      isOnline: () => online,
    })
    await c2.ensureDevice()
    await c2.start({ pinned: true })
    await waitFor(() => c2.store.getState().connection === 'online', 4000, 'online')
  }
  async function dropThenReturn(next: Script, whileDown: () => void) {
    const had = rig.sockets.length
    online = false
    rig.drop()
    await waitFor(() => c2.store.getState().connection !== 'online', 2000, 'down')
    whileDown()
    rig.script = next
    online = true
    c2.reconnect()
    await waitFor(() => rig.sockets.length === had + 1 && c2.store.getState().connection === 'online', 4000, 'back')
    await settle(50)
  }
  afterEach(() => c2?.close())

  it('the relay`s older count does not bring the read rows back, and rows that came while away still count', async () => {
    await startScripted({ unread: { general: 2 }, read_upto: { general: 0 } })
    expect(c2.store.getState().unread.general).toBe(2)
    // the relay never heard the mark: its count is the 2 read rows plus 1 that arrived while this device was away
    await dropThenReturn({ unread: { general: 3 }, read_upto: { general: 0 } }, () => {
      expect(c2.markThreadRead('general', 5)).toBe(true)
      expect(c2.store.getState().unread.general).toBe(0)
    })
    expect(marks()).toEqual([5])
    expect(c2.store.getState().unread.general).toBe(1)
    expect(c2.store.getState().readUpto?.general).toBe(5)
  })

  it('a mark the relay already holds (another device read further) is not sent and changes nothing', async () => {
    await startScripted({ unread: { general: 2 }, read_upto: { general: 0 } })
    await dropThenReturn({ unread: { general: 1 }, read_upto: { general: 9 } }, () => {
      c2.markThreadRead('general', 5)
    })
    expect(marks()).toEqual([])
    expect(c2.store.getState().unread.general).toBe(1)
    expect(c2.store.getState().readUpto?.general).toBe(9)
  })

  it('an older relay (no `read_upto`) still gets the mark, and the count never goes below zero', async () => {
    await startScripted({ unread: { general: 2 } })
    await dropThenReturn({ unread: { general: 1 } }, () => {
      c2.markThreadRead('general', 5)
    })
    expect(marks()).toEqual([5])
    expect(c2.store.getState().unread.general).toBe(0)
  })

  it('two reads of one thread while down go out as one mark, the higher', async () => {
    await startScripted({ unread: { general: 2, other: 1 }, read_upto: {} })
    await dropThenReturn({ unread: { general: 2, other: 1 }, read_upto: {} }, () => {
      c2.markThreadRead('general', 5)
      c2.store.setState((s) => ({ unread: { ...s.unread, general: 1 } })) // a held frame bumped it again
      c2.markThreadRead('general', 4)
    })
    expect(marks()).toEqual([5])
    expect(c2.store.getState().unread).toMatchObject({ general: 0, other: 1 })
  })

  // Opus review of 774430bb, finding 1 (blocker): the relay's mark moved while this device was away, so some other device
  // spoke last (a mark-unread lowers it, or puts it just under the newest row). Sending the offline read then would raise
  // the mark again and clear the unread the owner asked for.
  it('review 1: an offline read is dropped when the relay`s mark went down meanwhile (another device marked unread)', async () => {
    await startScripted({ unread: { general: 1 }, read_upto: { general: 5 } })
    await dropThenReturn({ unread: { general: 1 }, read_upto: { general: 4 } }, () => {
      c2.markThreadRead('general', 6)
    })
    expect(marks()).toEqual([])
    expect(c2.store.getState().unread.general).toBe(1)
    expect(c2.store.getState().readUpto?.general).toBe(4)
  })

  it('review 1: the same when the mark-unread left the relay`s mark between what this device knew and what it read', async () => {
    // knew 3, read offline to 5; the desktop marked unread, which puts the mark just under the newest row: 4
    await startScripted({ unread: { general: 2 }, read_upto: { general: 3 } })
    await dropThenReturn({ unread: { general: 1 }, read_upto: { general: 4 } }, () => {
      c2.markThreadRead('general', 5)
    })
    expect(marks()).toEqual([])
    expect(c2.store.getState().unread.general).toBe(1)
    expect(c2.store.getState().readUpto?.general).toBe(4)
    // and nothing is left waiting to go out on a later connection
    await dropThenReturn({ unread: { general: 1 }, read_upto: { general: 4 } }, () => {})
    expect(marks()).toEqual([])
  })

  // Review finding 2: the desktop read the same rows (its mark stops below this device's), then two new rows came in.
  // Taking this device's cleared count off the relay's number would hide them.
  it('review 2: rows another device already read are not taken off the relay`s count a second time', async () => {
    await startScripted({ unread: { general: 2 }, read_upto: { general: 2 } })
    await dropThenReturn({ unread: { general: 2 }, read_upto: { general: 4 } }, () => {
      c2.markThreadRead('general', 5)
    })
    expect(c2.store.getState().unread.general).toBe(2)
  })

  // Review finding 4: the relay refuses an unpinned device's frames, and a read mark is not answered or retried.
  it('review 4: a read mark waits until the Mac has pinned this device', async () => {
    rig = scriptedSockets({ unread: { general: 2 }, read_upto: { general: 0 } })
    online = true
    c2 = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: 'ws://scripted.invalid/ws',
      WebSocketImpl: rig.Impl,
      isOnline: () => online,
    })
    const key = await c2.ensureDevice()
    await c2.start({ pinned: false })
    await waitFor(() => c2.store.getState().connection === 'online', 4000, 'online')
    expect(c2.markThreadRead('general', 5)).toBe(true)
    expect(c2.store.getState().unread.general).toBe(0)
    await settle(50)
    expect(marks()).toEqual([])
    rig.push(mkFrame('device.pinned', { device_id: key.deviceId, ok: true }))
    await waitFor(() => marks().length === 1, 2000, 'sent once pinned')
    expect(marks()).toEqual([5])
  })

  it('review 4: setPinned(true) sends it too', async () => {
    rig = scriptedSockets({ unread: { general: 2 }, read_upto: { general: 0 } })
    c2 = createSocketClient({
      storage: createMemoryStorage(),
      wsUrl: 'ws://scripted.invalid/ws',
      WebSocketImpl: rig.Impl,
      isOnline: () => true,
    })
    await c2.ensureDevice()
    await c2.start({ pinned: false })
    await waitFor(() => c2.store.getState().connection === 'online', 4000, 'online')
    c2.markThreadRead('general', 5)
    expect(marks()).toEqual([])
    c2.setPinned(true)
    expect(marks()).toEqual([5])
  })

  // Review finding 3: the relay stores receipts now. One that is the newest stored frame must move `lastSeq`, or every
  // later hello asks for it again.
  it('review 3: a stored receipt moves lastSeq, so the next hello does not ask for it again', async () => {
    await startScripted({ unread: {} })
    rig.push({
      ...mkFrame('receipt', { message_id: newId('m'), state: 'delivered' }),
      relay: { seq: 7, received_at: new Date().toISOString() },
    })
    expect(c2.store.getState().lastSeq).toBe(7)
    await dropThenReturn({ unread: {} }, () => {})
    expect(rig.sent('hello').at(-1)?.last_seq).toBe(7)
  })
})
