// Class 7 for the relay hub (SB3b): every socket entry point refuses a frame that should not get through. The REAL hub
// (all modules wired by startRelay) gets fake sockets on a fake clock; the frames are the protocol's own fixtures, one per
// frame type, so a frame is as well-formed as a real peer would send it and a refusal can only come from the hub's checks.
//
// Entry points on the app side: the pre-hello gate, the pairing gate, the owner-device check, the schema, the direction
// check, the size limit and the rate bucket. On the bridge side: the pre-hello gate, a refused hello, the schema, the
// direction check, the size limit, and the two checks the hub makes itself on a durable frame (card shape, inherited
// thread names). Each rule has a control that the same frame goes through when the rule is met.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DIRECTION_TYPES,
  MAX_FRAME_BYTES,
  MAX_FRAME_BYTES_UNAUTH,
  OWNER_FRAME_TYPES,
  WS_CLOSE,
} from '@talos-app/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '../../src/services.ts'
import { type Replay, START_ISO, startReplay, uid } from '../replay/replay-harness.ts'

vi.setConfig({ testTimeout: 60_000 })

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(fileURLToPath(import.meta.resolve(`@talos-app/protocol/fixtures/frames/${name}.json`)), 'utf8'),
  )

/** The fixture of a frame type with a fresh id, so two sends never share one. */
const fresh = (type: string, extra: Record<string, unknown> = {}) => ({
  ...fixture(type),
  id: uid(),
  ts: START_ISO,
  ...extra,
})

const NOT_ENTRY = new Set(['hello', 'ping', 'pong', 'error'])
const appTypes = DIRECTION_TYPES.app_to_relay.filter((t) => !NOT_ENTRY.has(t))
const bridgeTypes = DIRECTION_TYPES.bridge_to_relay.filter((t) => !NOT_ENTRY.has(t))
const bridgeOnly = bridgeTypes.filter((t) => !appTypes.includes(t))
const appOnly = appTypes.filter((t) => !bridgeTypes.includes(t))
/** What an unpinned (pairing) socket may still send. */
const PAIRING_IN = ['visibility']

let rp: Replay | null = null
afterEach(async () => {
  vi.restoreAllMocks()
  await rp?.stop()
  rp = null
})

type Sock = ReturnType<Replay['app']>
const sent = (r: Replay, name: string, from = 0) =>
  r.log.slice(from).flatMap((e) => (e.to === name && 'frame' in e ? [e.frame as Record<string, unknown>] : []))
const errors = (r: Replay, name: string, from = 0) => sent(r, name, from).filter((f) => f.type === 'error')
/** One app frame at a time with the fake clock moved on, so the socket's rate bucket (30/s) never decides the outcome. */
const appSend = async (r: Replay, s: Sock, f: Record<string, unknown> | string) => {
  r.clock.advance(100)
  await r.appSend(s, f)
}
/** Nothing durable changed and nothing is waiting for the Mac. */
const untouched = (r: Replay, seq: number) => {
  expect(r.relay.runtime.store.maxSeq()).toBe(seq)
  expect(r.relay.runtime.store.outboxDepth()).toBe(0)
}

describe('hub entry points, app socket', () => {
  it('the table covers every frame type an app may send and every one only the Mac may send', () => {
    expect(appTypes.length).toBeGreaterThan(20)
    expect(bridgeOnly).toEqual(expect.arrayContaining(['reply', 'card.create', 'config.sync', 'status', 'receipt']))
    expect(appOnly).toEqual(expect.arrayContaining(['message', 'card.resolve', 'config.patch', 'history.request']))
  })

  it('before hello, any frame but the hello closes the socket 4401 and stores nothing', async () => {
    rp = await startReplay()
    await rp.bridge('bridge')
    const seq = rp.relay.runtime.store.maxSeq()
    for (const type of appTypes) {
      const s = rp.app(`pre-${type}`)
      await appSend(rp, s, fresh(type))
      expect(s.conn.closed?.code, type).toBe(WS_CLOSE.UNAUTHORIZED)
      // the pre-hello gate's own close carries no reason; 'device_changed' would be the hello check running on a non-hello
      expect(s.conn.closed?.reason, type).toBeUndefined()
    }
    // control: the hello itself opens the socket
    const ok = rp.app('control')
    await rp.hello(ok)
    expect(ok.conn.closed).toBeNull()
    expect(sent(rp, 'control').some((f) => f.type === 'ready')).toBe(true)
    untouched(rp, seq)
  })

  it('before hello, text that is not a frame closes the socket, and a 64 KiB+ frame closes it 4413', async () => {
    rp = await startReplay()
    const junk = rp.app('junk')
    await rp.appSend(junk, 'this is not json')
    expect(junk.conn.closed?.code).toBe(WS_CLOSE.BAD_FRAME)
    const big = rp.app('big')
    await rp.appSend(big, JSON.stringify({ pad: 'x'.repeat(MAX_FRAME_BYTES_UNAUTH + 10) }))
    expect(big.conn.closed?.code).toBe(WS_CLOSE.FRAME_TOO_LARGE)
  })

  it('a hello that claims the bridge role on an app socket closes it 4401', async () => {
    rp = await startReplay()
    const s = rp.app('wrong-role')
    await rp.appSend(s, fresh('hello.bridge'))
    expect(s.conn.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED)
    // the role check refused it, not the device check a real app hello goes on to ('device_changed')
    expect(s.conn.closed?.reason).toBeUndefined()
  })

  it('a device the Mac has not pinned is refused every frame but the pairing ones, and nothing is stored or forwarded', async () => {
    rp = await startReplay()
    await rp.bridge('bridge')
    const s = rp.app('unpinned', { pinned: false })
    await rp.hello(s)
    const seq = rp.relay.runtime.store.maxSeq()
    for (const type of appTypes.filter((t) => !PAIRING_IN.includes(t))) {
      const from = rp.log.length
      await appSend(rp, s, fresh(type))
      const e = errors(rp, 'unpinned', from)
      expect(
        e.map((x) => x.code),
        type,
      ).toEqual(['device_not_pinned'])
    }
    expect(s.conn.closed).toBeNull()
    untouched(rp, seq)
    // control: a pairing frame is not refused
    const from = rp.log.length
    await rp.appSend(s, fresh('visibility'))
    expect(errors(rp, 'unpinned', from)).toEqual([])
  })

  it('a frame signed by a device other than the session is refused as unauthorized, for every signed frame type', async () => {
    rp = await startReplay()
    await rp.bridge('bridge')
    const s = rp.app('app')
    await rp.hello(s)
    const seq = rp.relay.runtime.store.maxSeq()
    // The fixtures carry the protocol's test device, never this session's device.
    const signedTypes = appTypes.filter((t) => (OWNER_FRAME_TYPES as readonly string[]).includes(t))
    expect(signedTypes.length).toBeGreaterThan(10)
    const checked: string[] = []
    for (const type of signedTypes) {
      const from = rp.log.length
      await appSend(rp, s, fresh(type))
      const codes = errors(rp, 'app', from).map((x) => x.code)
      if (codes.includes('unauthorized')) checked.push(type)
      else expect(codes, `${type} is not refused as unauthorized and not a device-check type`).not.toContain('internal')
    }
    // The types that run the device check are the ones that name the owner's device. Pin the set, so a new owner frame
    // that skips the check shows up here as a different list.
    expect(checked.sort()).toEqual(
      [
        'agent.recover',
        'app.request',
        'card.resolve',
        'config.patch',
        'fs.list',
        'heartbeat.test',
        'history.request',
        'media.fetch',
        'memory.read',
        'memory.search',
        'memory.tree',
        'message',
        'schedule.control',
        'schedule.get',
        'schedule.patch',
        'schedule.run_now',
        'schedules.list',
        'search.query',
        'session.control',
        'speak.request',
        'thread.session.control',
        'voice.ask',
        'voice_note',
      ].filter((t) => (signedTypes as string[]).includes(t)),
    )
    untouched(rp, seq)
    // control: the same frame signed by the session's own device gets past that check
    const good = await rp.signed(
      fresh('message', { thread_id: 'general', client_msg_id: uid('m_'), text: 'hi', attachments: [] }),
    )
    const from = rp.log.length
    await rp.appSend(s, good)
    expect(errors(rp, 'app', from)).toEqual([])
    expect(rp.relay.runtime.store.getEventByFrameId(good.id as string)).toBeTruthy()
  })

  it('a frame with a field of the wrong type or no id is refused as bad_frame for every app frame type', async () => {
    rp = await startReplay()
    await rp.bridge('bridge')
    const s = rp.app('app')
    await rp.hello(s)
    const seq = rp.relay.runtime.store.maxSeq()
    for (const type of appTypes) {
      const from = rp.log.length
      const { id: _id, ...noId } = fresh(type)
      await appSend(rp, s, noId)
      expect(
        errors(rp, 'app', from).map((x) => x.code),
        `${type} without an id`,
      ).toEqual(['bad_frame'])
      const wrongType = { ...fresh(type), ts: 12345 }
      const from2 = rp.log.length
      await appSend(rp, s, wrongType)
      expect(
        errors(rp, 'app', from2).map((x) => x.code),
        `${type} with a numeric ts`,
      ).toEqual(['bad_frame'])
    }
    expect(s.conn.closed).toBeNull()
    untouched(rp, seq)
  })

  it('a frame only the Mac may send is refused from an app, and the app can still use its socket after', async () => {
    rp = await startReplay()
    const bridge = await rp.bridge('bridge')
    const s = rp.app('app')
    await rp.hello(s)
    const seq = rp.relay.runtime.store.maxSeq()
    const heard = rp.log.length
    for (const type of bridgeOnly) {
      const from = rp.log.length
      await appSend(rp, s, fresh(type))
      expect(
        errors(rp, 'app', from).map((x) => x.code),
        type,
      ).toEqual(['bad_frame'])
    }
    untouched(rp, seq)
    // nothing an app sent as a Mac frame was passed on to the apps either
    expect(sent(rp, 'app', heard).filter((f) => f.type !== 'error')).toEqual([])
    expect(s.conn.closed).toBeNull()
    expect(bridge.conn.closed).toBeNull()
    // control: the same kind of frame from the Mac itself is stored
    await rp.bridgeSend(bridge, fresh('thread.read'))
    await rp.bridgeSend(
      bridge,
      fresh('reply', {
        message: { ...(fixture('reply').message as object), id: uid('m_'), thread_id: 'general' },
      }),
    )
    expect(rp.relay.runtime.store.maxSeq()).toBeGreaterThan(seq)
  })

  it('an authed app frame over the size limit closes the socket 4413', async () => {
    rp = await startReplay()
    const s = rp.app('app')
    await rp.hello(s)
    await rp.appSend(s, JSON.stringify({ pad: 'x'.repeat(MAX_FRAME_BYTES + 10) }))
    expect(s.conn.closed?.code).toBe(WS_CLOSE.FRAME_TOO_LARGE)
  })

  it('a sender that floods the socket past the queue is closed 4429 and the work already queued is not lost to others', async () => {
    rp = await startReplay()
    await rp.bridge('bridge')
    const flood = rp.app('flood')
    await rp.hello(flood)
    const other = rp.app('other')
    await rp.hello(other)
    for (let i = 0; i < 600; i++) flood.at.onMessage(JSON.stringify(fresh('visibility', { state: 'visible' })))
    expect(flood.conn.closed?.code).toBe(WS_CLOSE.RATE_LIMITED)
    expect(other.conn.closed).toBeNull()
    // the flood did not take the other socket's turn: a frame sent after it is still answered
    const from = rp.log.length
    await appSend(rp, other, fresh('ping', { nonce: 'afterfld' }))
    expect(sent(rp, 'other', from).some((f) => f.type === 'pong' && f.nonce === 'afterfld')).toBe(true)
    expect(errors(rp, 'other', from)).toEqual([])
  })
})

describe('hub entry points, bridge socket', () => {
  it('before its hello, any frame but a bridge hello closes the socket 4401', async () => {
    rp = await startReplay()
    const refusal = watchHelloRefusals(rp)
    for (const type of bridgeTypes) {
      const s = await openUnauthedBridge(rp, `pre-${type}`)
      await rp.bridgeSend(s, fresh(type))
      expect(s.conn.closed?.code, type).toBe(WS_CLOSE.UNAUTHORIZED)
    }
    // refused by the pre-hello gate, before any signature check: no "hello refused" warning
    refusal.expectNone()
    expect(rp.relay.runtime.hub.bridgeOnline()).toBe(false)
  })

  it('a hello that claims the app role on the bridge socket closes it 4401', async () => {
    rp = await startReplay()
    const refusal = watchHelloRefusals(rp)
    const s = await openUnauthedBridge(rp, 'wrong-role')
    await rp.bridgeSend(s, fresh('hello.app'))
    expect(s.conn.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED)
    refusal.expectNone()
  })

  it('text that is not a frame and an oversize frame close an unauthenticated bridge socket', async () => {
    rp = await startReplay()
    const junk = await openUnauthedBridge(rp, 'junk')
    await rp.bridgeSend(junk, 'not json')
    expect(junk.conn.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED)
    const big = await openUnauthedBridge(rp, 'big')
    big.at.onMessage(JSON.stringify({ pad: 'x'.repeat(MAX_FRAME_BYTES_UNAUTH + 10) }))
    expect(big.conn.closed?.code).toBe(WS_CLOSE.FRAME_TOO_LARGE)
  })

  it('an untrusted key and a signature over another challenge are refused, and the trusted Mac still connects after', async () => {
    rp = await startReplay()
    const { generateBridgeKey } = await import('@talos-app/protocol')
    const refusal = watchHelloRefusals(rp)
    const stranger = await rp.bridge('stranger', { key: await generateBridgeKey() })
    // control for the watcher: a refusal by the signature check IS logged and counted
    expect(refusal.warned()).toBe(1)
    expect(stranger.conn.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED)
    const forger = await rp.bridge('forger', { badSig: true })
    expect(forger.conn.closed?.code).toBe(WS_CLOSE.UNAUTHORIZED)
    expect(rp.relay.runtime.hub.bridgeOnline()).toBe(false)
    const good = await rp.bridge('good')
    expect(good.conn.closed).toBeNull()
    expect(rp.relay.runtime.hub.bridgeOnline()).toBe(true)
  })

  it('an authed bridge frame with no id or a wrong-typed field is refused as bad_frame, for every bridge frame type', async () => {
    rp = await startReplay()
    const bridge = await rp.bridge('bridge')
    const seq = rp.relay.runtime.store.maxSeq()
    for (const type of bridgeTypes) {
      const { id: _id, ...noId } = fresh(type)
      const from = rp.log.length
      await rp.bridgeSend(bridge, noId)
      expect(
        errors(rp, 'bridge', from).map((x) => x.code),
        `${type} without an id`,
      ).toEqual(['bad_frame'])
      const from2 = rp.log.length
      await rp.bridgeSend(bridge, { ...fresh(type), ts: 12345 })
      expect(
        errors(rp, 'bridge', from2).map((x) => x.code),
        `${type} with a numeric ts`,
      ).toEqual(['bad_frame'])
    }
    expect(bridge.conn.closed).toBeNull()
    expect(rp.relay.runtime.store.maxSeq()).toBe(seq)
  })

  it('a frame only an app may send is refused from the Mac, and nothing reaches the apps', async () => {
    rp = await startReplay()
    const bridge = await rp.bridge('bridge')
    const app = rp.app('app')
    await rp.hello(app)
    const seq = rp.relay.runtime.store.maxSeq()
    const heard = rp.log.length
    for (const type of appOnly) {
      const from = rp.log.length
      await rp.bridgeSend(bridge, fresh(type))
      expect(
        errors(rp, 'bridge', from).map((x) => x.code),
        type,
      ).toEqual(['bad_frame'])
    }
    expect(rp.relay.runtime.store.maxSeq()).toBe(seq)
    expect(sent(rp, 'app', heard)).toEqual([])
    expect(bridge.conn.closed).toBeNull()
  })

  it('an authed bridge frame over the size limit closes the socket 4413', async () => {
    rp = await startReplay()
    const bridge = await rp.bridge('bridge')
    bridge.at.onMessage(JSON.stringify({ pad: 'x'.repeat(MAX_FRAME_BYTES + 10) }))
    expect(bridge.conn.closed?.code).toBe(WS_CLOSE.FRAME_TOO_LARGE)
  })

  it('a card the relay cannot show safely is refused by the hub and never stored, queued or sent to an app', async () => {
    rp = await startReplay()
    const bridge = await rp.bridge('bridge')
    const app = rp.app('app')
    await rp.hello(app)
    const seq = rp.relay.runtime.store.maxSeq()
    const heard = rp.log.length
    const card = fixture('card.create').card as Record<string, unknown>
    const badCard = { ...card, id: uid('c_'), title: '' }
    const bad = fresh('card.create', { card: badCard })
    const from = rp.log.length
    await rp.bridgeSend(bridge, bad)
    expect(errors(rp, 'bridge', from).length).toBeGreaterThan(0)
    expect(rp.relay.runtime.store.getCard(badCard.id)).toBeFalsy()
    expect(rp.relay.runtime.store.maxSeq()).toBe(seq)
    expect(sent(rp, 'app', heard)).toEqual([])
  })

  it('a thread whose id is a name every object already has is refused, not stored', async () => {
    rp = await startReplay()
    const bridge = await rp.bridge('bridge')
    const seq = rp.relay.runtime.store.maxSeq()
    const thread = fixture('thread.upsert').thread as Record<string, unknown>
    const from = rp.log.length
    await rp.bridgeSend(bridge, fresh('thread.upsert', { thread: { ...thread, id: 'constructor' } }))
    expect(errors(rp, 'bridge', from).map((x) => x.code)).toEqual(['bad_frame'])
    expect(rp.relay.runtime.store.maxSeq()).toBe(seq)
    // control: an ordinary new thread id is stored
    await rp.bridgeSend(bridge, fresh('thread.upsert', { thread: { ...thread, id: 'ordinary_new_thread' } }))
    expect(rp.relay.runtime.store.maxSeq()).toBeGreaterThan(seq)
  })
})

/**
 * Counts the hub's "bridge hello refused" warnings from now on. The hub logs one for every hello the signature check
 * refuses, in the same branch where the real auth counts a failure against the address (the test auth has no such counter).
 */
function watchHelloRefusals(r: Replay) {
  const warn = vi.spyOn((r.relay.runtime.hub as unknown as { d: { log: Logger } }).d.log, 'warn')
  const warned = () => warn.mock.calls.filter((c) => c[1] === 'bridge hello refused').length
  return {
    warned,
    expectNone() {
      expect(warned()).toBe(0)
    },
  }
}

/** A bridge socket that has been challenged and has not sent its hello. */
async function openUnauthedBridge(r: Replay, name: string) {
  const { FakeConn } = await import('../replay/replay-harness.ts')
  const conn = new FakeConn(name, r.log)
  const at = r.relay.runtime.hub.attachBridge(conn, { ip: '203.0.113.9', relayHost: 'relay.example.com' })
  return { conn, at }
}
