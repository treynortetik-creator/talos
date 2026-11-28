// The Mac's terminal view (src/term/service.ts) against a made-up pane and a fake clock: what goes out, in what order, how
// much, and when it ends. The real tmux is in tmux-real.test.ts. Nothing here waits on the wall clock.
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  b64urlDecode,
  type Frame,
  TERM_IDLE_S,
  TERM_KEY_MAX_BYTES,
  TERM_MAX_OPEN,
  TERM_MAX_S,
  TERM_OUT_MAX_BYTES,
  TERM_RING_BYTES,
  TERM_WINDOW_BYTES,
  TERM_WINDOW_FRAMES,
} from '@talos-app/protocol'
import { type FakeClock, fakeClock } from '@talos-app/testkit'
import { TermAudit } from '../../src/term/audit.ts'
import { KEY_MIN_GAP_MS, TermService } from '../../src/term/service.ts'
import { fakeOpener } from './fake-source.ts'

const dec = new TextDecoder()
const DEV = 'd_aaaaaaaaaaaaaaaaaaaa'
const OTHER = 'd_bbbbbbbbbbbbbbbbbbbb'
let n = 0
const termId = () => `tm_01HXTEST${String(++n).padStart(15, '0')}`

type Out = Record<string, unknown> & { type: string }
let clock: FakeClock
let sent: Out[]
let db: Database
let audit: TermAudit
let opener: ReturnType<typeof fakeOpener>
let svc: TermService
const revoked = new Set<string>()

const make = (over: Partial<ConstructorParameters<typeof TermService>[0]> = {}, o = fakeOpener()) => {
  opener = o
  return new TermService({
    clock,
    log: { debug() {}, info() {}, warn() {}, error() {}, security() {} },
    send: (f: Frame) => {
      sent.push(f as unknown as Out)
      return true
    },
    openSource: opener.open,
    audit,
    deviceOk: (d: string) => !revoked.has(d),
    sessionOf: (t) => (t === 'main' ? 'agent' : /^[a-z]/.test(t) ? `t-${t}` : null),
    ...over,
  })
}
beforeEach(() => {
  revoked.clear()
  clock = fakeClock()
  sent = []
  db = new Database(':memory:')
  audit = new TermAudit(db)
  svc = make()
})

const of = (type: string, from = 0) => sent.slice(from).filter((f) => f.type === type)
const bytes = (f: Out) => b64urlDecode(f.bytes_b64 as string)
const text = (f: Out) => dec.decode(bytes(f))
/** Opens a view on `main` and lets the keyframe go out. Returns its id and the pane. */
async function opened(target = 'main', device = DEV) {
  const id = termId()
  await svc.open({ term_id: id, target }, device)
  await tick()
  return { id, pane: opener.last() }
}
/** The keyframe's snapshot is a promise: let it settle. */
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
const flush = () => clock.advance(16)

describe('opening a view', () => {
  test('term.opened reports the pane size and the times, then one keyframe at the current offset, then nothing', async () => {
    const o = fakeOpener({ cols: 120, rows: 40 })
    svc = make({}, o)
    const id = termId()
    await svc.open({ term_id: id, target: 'main' }, DEV)
    await tick()
    expect(sent.map((f) => f.type)).toEqual(['term.opened', 'term.key'])
    expect(sent[0]).toMatchObject({
      term_id: id,
      tier: 'view',
      cols: 120,
      rows: 40,
      idle_s: TERM_IDLE_S,
      max_s: TERM_MAX_S,
    })
    expect(sent[1]).toMatchObject({ term_id: id, at: 0 })
    expect(text(sent[1] as Out)).toBe('SCREEN')
    expect(o.made[0]?.session).toBe('agent')
  })

  test("a thread target watches that thread's own session", async () => {
    await opened('release_notes')
    expect(opener.made[0]?.session).toBe('t-release_notes')
  })

  test('a keyframe is exact for the offset it names: output that came before it is not sent again, output after it follows', async () => {
    const o = fakeOpener()
    svc = make({}, o)
    const id = termId()
    const p = svc.open({ term_id: id, target: 'main' }, DEV)
    await tick()
    const pane = o.last()
    pane.emit('before ') // before the open settled: part of the picture
    await p
    await tick()
    pane.emit('after')
    flush()
    const key = of('term.key')[0] as Out
    const out = of('term.out')
    expect(key.at).toBe(0) // the fake's snapshot is exact for what it had counted when asked
    expect(out.length).toBe(1)
    // a real source takes `at` from the stream at the moment of the capture; here the viewer is sent from there on
    expect(out[0]?.at).toBe(0)
    expect(text(out[0] as Out)).toBe('before after')
  })

  test('a target with no session, a session with no pane, and a fifth view are each answered with a closed and nothing opens', async () => {
    const o = fakeOpener({ fail: new Set(['t-gone']) })
    svc = make({}, o)
    await svc.open({ term_id: termId(), target: '9bad' }, DEV)
    await svc.open({ term_id: termId(), target: 'gone' }, DEV)
    expect(of('term.closed').map((f) => f.why)).toEqual(['no_pane', 'no_pane'])
    expect(svc.viewCount()).toBe(0)
    for (let i = 0; i < TERM_MAX_OPEN; i++) await svc.open({ term_id: termId(), target: 'main' }, DEV)
    const before = sent.length
    await svc.open({ term_id: termId(), target: 'main' }, DEV)
    expect(sent.slice(before).map((f) => [f.type, f.why])).toEqual([['term.closed', 'too_many']])
    expect(svc.viewCount()).toBe(TERM_MAX_OPEN)
  })

  test('two opens at once for the same session start one control client and share it', async () => {
    await Promise.all([
      svc.open({ term_id: termId(), target: 'main' }, DEV),
      svc.open({ term_id: termId(), target: 'main' }, DEV),
    ])
    expect(opener.made.length).toBe(1)
    expect(svc.viewCount()).toBe(2)
    expect(svc.watchCount()).toBe(1)
  })

  test('opening the same id twice never leaves two views: the repeat ends the first with refused', async () => {
    const id = termId()
    await svc.open({ term_id: id, target: 'main' }, DEV)
    await svc.open({ term_id: id, target: 'main' }, DEV)
    expect(of('term.opened').length).toBe(1)
    expect(svc.viewCount()).toBe(0)
    expect(of('term.closed').map((f) => [f.term_id, f.why])).toEqual([[id, 'refused']])
  })
})

describe('a tmux that cannot give a client that ignores size', () => {
  test('the view fails with the unsupported words, and no attach that could resize is tried instead', async () => {
    const made: string[] = []
    svc = make({ openSource: async (session) => (made.push(session), { error: 'unavailable' as const }) })
    const id = termId()
    await svc.open({ term_id: id, target: 'main' }, DEV)
    expect(of('term.closed').map((f) => [f.term_id, f.why])).toEqual([[id, 'unsupported']])
    expect(made).toEqual(['agent']) // asked once; there is no second, looser way
    expect(svc.viewCount()).toBe(0)
  })
})

describe('output: coalesced, ordered, windowed, and the pane never stalled', () => {
  test('output inside 16 ms goes out as one frame with the bytes in order, at the offset of its first byte', async () => {
    const { pane } = await opened()
    pane.emit('abc')
    clock.advance(10)
    pane.emit('def')
    expect(of('term.out')).toEqual([]) // not yet: coalescing
    clock.advance(6)
    const outs = of('term.out')
    expect(outs.length).toBe(1)
    expect(text(outs[0] as Out)).toBe('abcdef')
    expect(outs[0]?.at).toBe(0)
    pane.emit('g')
    flush()
    expect(of('term.out')[1]).toMatchObject({ at: 6 })
  })

  test(`a burst is cut into frames of at most ${TERM_OUT_MAX_BYTES} bytes, no gap and no overlap`, async () => {
    const { id, pane } = await opened()
    pane.emit('x'.repeat(40 * 1024))
    flush()
    const outs = of('term.out')
    expect(outs.map((f) => bytes(f).length)).toEqual([16384, 16384, 8192])
    expect(outs.map((f) => f.at)).toEqual([0, 16384, 32768])
    expect(svc.position(id)?.next).toBe(40 * 1024)
  })

  test(`at most ${TERM_WINDOW_FRAMES} frames or ${TERM_WINDOW_BYTES} bytes unacked per viewer, and the pane is still read`, async () => {
    const { id, pane } = await opened()
    // 300 small bursts: the window is frames (the keyframe is one)
    for (let i = 0; i < 300; i++) {
      pane.emit(`line ${i}\n`)
      flush()
    }
    expect(of('term.out').length).toBe(TERM_WINDOW_FRAMES - 1) // the keyframe took one place
    expect(svc.position(id)?.inflight).toBe(TERM_WINDOW_FRAMES)
    // the pane was read the whole time: the ring has every byte
    expect(svc.head('agent')).toBe(pane.total)
    // an ack that covers it all reopens the window, and the next frame carries everything not yet sent, in order
    svc.ack(id, svc.position(id)?.next as number)
    const sentBytes = of('term.out').reduce((s, f) => s + bytes(f).length, 0)
    const rest = of('term.out').slice(TERM_WINDOW_FRAMES - 1)
    expect(rest.length).toBeGreaterThan(0)
    expect(rest[0]?.at).toBe(sentBytes - rest.reduce((s, f) => s + bytes(f).length, 0))
  })

  test(`a viewer is never sent more than ${TERM_WINDOW_BYTES} bytes past what it acked`, async () => {
    const { id, pane } = await opened()
    pane.emit('z'.repeat(200 * 1024))
    flush()
    const outs = of('term.out')
    expect(outs.reduce((s, f) => s + bytes(f).length, 0)).toBe(TERM_WINDOW_BYTES)
    expect(outs.length).toBe(4) // 4 x 16 KiB: under the 7 frames, at the byte limit
    svc.ack(id, 16384) // the first frame drawn
    expect(of('term.out').length).toBe(5)
    expect(svc.position(id)?.next).toBe(TERM_WINDOW_BYTES + 16384)
  })

  test('the pane is never stalled: the control client is read to the end however slow the viewer is', async () => {
    const { pane } = await opened()
    pane.emit('p'.repeat(1024 * 1024))
    flush()
    expect(svc.head('agent')).toBe(1024 * 1024)
    expect(of('term.out').length).toBeLessThanOrEqual(TERM_WINDOW_FRAMES)
  })

  test('a ring overrun gives the next frame as a fresh keyframe (a skip ahead), and the skipped bytes are never sent', async () => {
    const { id, pane } = await opened()
    clock.advance(KEY_MIN_GAP_MS) // the first picture is old enough for another
    pane.emit('a'.repeat(TERM_WINDOW_BYTES)) // fills the window by bytes: the viewer has not acked any of it
    flush()
    const outsBefore = of('term.out')
    expect(outsBefore.reduce((s, f) => s + bytes(f).length, 0)).toBe(TERM_WINDOW_BYTES)
    const keysBefore = of('term.key').length
    pane.screen = new TextEncoder().encode('SCREEN-AFTER-OVERRUN')
    pane.holdSnapshots()
    pane.emit('b'.repeat(2 * TERM_RING_BYTES)) // far past the ring: what the viewer is owed next has fallen out of it
    flush()
    expect(pane.snapshots).toBe(keysBefore + 1) // a fresh picture is asked for, once, not the bytes
    const at = pane.total
    pane.emit('NEWEST') // arrives while the picture is on its way
    flush()
    pane.hold?.()
    await tick()
    flush()
    const keys = of('term.key')
    expect(keys.length).toBe(keysBefore + 1)
    expect(text(keys[keys.length - 1] as Out)).toBe('SCREEN-AFTER-OVERRUN')
    expect(keys[keys.length - 1]?.at).toBe(at)
    // the stream goes on from the picture's offset: NEWEST, and none of the 512 KiB it skipped
    expect(
      of('term.out')
        .slice(outsBefore.length)
        .map((f) => [f.at, text(f)]),
    ).toEqual([[at, 'NEWEST']])
    // the credit counts from the picture: the viewer's ack of it lets everything after through
    svc.ack(id, at)
    expect(svc.position(id)).toMatchObject({ acked: at })
  })

  test('output that arrives while a keyframe is on its way is sent after it, not lost and not twice', async () => {
    const o = fakeOpener({ hold: true })
    svc = make({}, o)
    const id = termId()
    const p = svc.open({ term_id: id, target: 'main' }, DEV)
    await tick()
    const pane = o.last()
    pane.emit('first')
    await p
    await tick()
    pane.emit('second') // arrives while the keyframe (the first picture) waits
    flush()
    expect(of('term.key')).toEqual([])
    pane.hold?.()
    await tick()
    expect(of('term.key')[0]).toMatchObject({ at: 0 }) // the picture is exact for the offset it was asked at
    expect(of('term.out').map((f) => [f.at, text(f)])).toEqual([[0, 'firstsecond']])
    expect(id).toBeTruthy()
  })
})

describe('resuming', () => {
  test('from an offset still in the ring: the bytes from there, no keyframe', async () => {
    const { id, pane } = await opened()
    pane.emit('0123456789')
    flush()
    svc.ack(id, 10)
    const keys = of('term.key').length
    const before = sent.length
    svc.resume(id, 4, DEV)
    expect(of('term.key').length).toBe(keys)
    const outs = sent.slice(before).filter((f) => f.type === 'term.out')
    expect(outs.map((f) => [f.at, text(f)])).toEqual([[4, '456789']])
  })

  test('from an offset that fell out of the ring (or never was): a fresh keyframe', async () => {
    const { id, pane } = await opened()
    clock.advance(KEY_MIN_GAP_MS) // a second picture is allowed this long after the first
    pane.emit('q'.repeat(TERM_RING_BYTES + 5000))
    flush()
    const keys = of('term.key').length
    svc.resume(id, 10, DEV)
    await tick()
    expect(of('term.key').length).toBe(keys + 1)
    clock.advance(KEY_MIN_GAP_MS)
    const ahead = termId()
    await svc.open({ term_id: ahead, target: 'main' }, DEV)
    await tick()
    clock.advance(KEY_MIN_GAP_MS)
    const k2 = of('term.key').length
    svc.resume(ahead, pane.total + 1000, DEV)
    await tick()
    expect(of('term.key').length).toBe(k2 + 1)
  })

  test('a resume from another device, or for an id that is not open, does nothing', async () => {
    const { id, pane } = await opened()
    pane.emit('abc')
    flush()
    const before = sent.length
    svc.resume(id, 0, OTHER)
    svc.resume(termId(), 0, DEV)
    expect(sent.length).toBe(before)
  })
})

describe('time: idle, maximum, and who may close', () => {
  test(`idle ${TERM_IDLE_S}s closes it; any ack moves the time on; the audit says why`, async () => {
    const { id } = await opened()
    clock.advance(TERM_IDLE_S * 1000 - 1)
    expect(svc.viewCount()).toBe(1)
    svc.ack(id, 0) // a heartbeat
    clock.advance(TERM_IDLE_S * 1000 - 1)
    expect(svc.viewCount()).toBe(1)
    clock.advance(1)
    expect(svc.viewCount()).toBe(0)
    expect(of('term.closed').map((f) => f.why)).toEqual(['idle'])
    expect(audit.rows()[0]?.why).toBe('idle')
  })

  test(`${TERM_MAX_S}s in all closes it, however lively`, async () => {
    const { id } = await opened()
    for (let t = 0; t < TERM_MAX_S; t += 300) {
      svc.ack(id, 0)
      clock.advance(300_000)
    }
    expect(svc.viewCount()).toBe(0)
    expect(of('term.closed').map((f) => f.why)).toEqual(['max'])
  })

  test('the owner closes it from the device that opened it; another device cannot; no closed frame is sent back', async () => {
    const { id } = await opened()
    svc.close(id, OTHER)
    expect(svc.viewCount()).toBe(1)
    svc.close(id, DEV)
    expect(svc.viewCount()).toBe(0)
    expect(of('term.closed')).toEqual([]) // the relay already took the view down when it passed the close on
    expect(audit.rows()[0]?.why).toBe('closed')
  })

  test("the relay saying the viewer's socket closed ends it quietly", async () => {
    const { id } = await opened()
    svc.viewerGone(id, 'socket_closed')
    expect(svc.viewCount()).toBe(0)
    expect(of('term.closed')).toEqual([])
    expect(audit.rows()[0]?.why).toBe('socket_closed')
  })

  test('stopAll (a bridge restart) closes every view, tells each page, and refuses new ones', async () => {
    await opened()
    await opened()
    svc.stopAll('restart')
    expect(of('term.closed').map((f) => f.why)).toEqual(['restart', 'restart'])
    expect(svc.viewCount()).toBe(0)
    expect(audit.rows().map((r) => r.why)).toEqual(['restart', 'restart'])
    await svc.open({ term_id: termId(), target: 'main' }, DEV)
    expect(of('term.closed').length).toBe(3)
  })

  test("endAll (the relay's socket closed) ends every view without telling anyone, and new views may open after", async () => {
    await opened()
    await opened()
    const before = sent.length
    svc.endAll('mac_offline', false)
    expect(svc.viewCount()).toBe(0)
    expect(sent.length).toBe(before) // nobody is there to tell
    expect(audit.rows().map((r) => r.why)).toEqual(['mac_offline', 'mac_offline'])
    await opened()
    expect(svc.viewCount()).toBe(1)
  })

  test('a row a crash left open is closed as a restart by the next start', () => {
    audit.open({ term_id: termId(), tier: 'view', device_id: DEV, target: 'main', opened_at: 1 })
    expect(audit.rows()[0]?.closed_at).toBeNull()
    clock.advance(5)
    make()
    expect(audit.rows()[0]).toMatchObject({ why: 'restart' })
    expect(audit.rows()[0]?.closed_at).not.toBeNull()
  })
})

describe('a viewer that is gone before its open is handled', () => {
  test('the relay saying the socket closed first means the open that follows opens nothing', async () => {
    const id = termId()
    svc.viewerGone(id, 'socket_closed') // handled at once; the open was still waiting for its signature check
    await svc.open({ term_id: id, target: 'main' }, DEV)
    expect(svc.viewCount()).toBe(0)
    expect(opener.made.length).toBe(0) // no tmux client was started for nobody
    expect(of('term.opened')).toEqual([])
    expect(of('term.closed').map((f) => [f.term_id, f.why])).toEqual([[id, 'refused']])
  })

  test('the memory of a gone id lasts the two-minute open window, then the id is free', async () => {
    const id = termId()
    svc.viewerGone(id, 'socket_closed')
    clock.advance(2 * 60_000 + 1)
    await svc.open({ term_id: id, target: 'main' }, DEV)
    expect(svc.viewCount()).toBe(1)
  })

  test('four taps-then-leaves do not fill the limit', async () => {
    for (let i = 0; i < TERM_MAX_OPEN; i++) {
      const id = termId()
      svc.viewerGone(id, 'socket_closed')
      await svc.open({ term_id: id, target: 'main' }, DEV)
    }
    await svc.open({ term_id: termId(), target: 'main' }, DEV)
    expect(svc.viewCount()).toBe(1)
    expect(of('term.opened')).toHaveLength(1)
  })

  test('an open for an id already in use closes that view too, so the relay (which drops its binding on the closed) and the Mac stay in step', async () => {
    const { id, pane } = await opened()
    const before = sent.length
    await svc.open({ term_id: id, target: 'main' }, DEV)
    expect(sent.slice(before).map((f) => [f.type, f.term_id, f.why])).toEqual([['term.closed', id, 'refused']])
    expect(svc.viewCount()).toBe(0)
    expect(pane.closed).toBe(true)
    expect(audit.rows()[0]?.why).toBe('refused')
  })

  test('the open that passed its check is still starting the control client when the viewer is gone: the client is not left running', async () => {
    const id = termId()
    const p = svc.open({ term_id: id, target: 'main' }, DEV) // awaiting the tmux client
    svc.viewerGone(id, 'socket_closed') // the relay's word, handled at once
    await p
    expect(svc.viewCount()).toBe(0)
    expect(svc.watchCount()).toBe(0)
    expect(opener.made).toHaveLength(1)
    expect(opener.last().closed).toBe(true)
    expect(of('term.opened')).toEqual([])
  })

  test('the same when the Mac stops, or a device ends, or everything ends, while the client is starting', async () => {
    for (const end of [
      () => svc.stopAll('restart'),
      () => svc.endDevice(DEV),
      () => svc.endAll('mac_offline', false),
    ]) {
      svc = make()
      const made = opener.made
      const p = svc.open({ term_id: termId(), target: 'main' }, DEV)
      end()
      await p
      expect(svc.watchCount()).toBe(0)
      expect(made.at(-1)?.source.closed).toBe(true)
    }
  })

  test('the memory of gone ids is capped, newest kept', () => {
    for (let i = 0; i < 1500; i++) svc.viewerGone(`tm_gone${i}`, 'socket_closed')
    expect(svc.goneCount()).toBeLessThanOrEqual(1000)
    const id = termId()
    svc.viewerGone(id, 'socket_closed')
    expect(svc.goneCount()).toBeLessThanOrEqual(1000)
  })
})

describe('the control client lives only as long as someone watches', () => {
  test('two viewers share one source and one ring; it stops with the last one', async () => {
    const a = await opened()
    const b = await opened()
    expect(opener.made.length).toBe(1)
    a.pane.emit('shared')
    flush()
    expect(of('term.out').filter((f) => f.term_id === a.id).length).toBe(1)
    expect(of('term.out').filter((f) => f.term_id === b.id).length).toBe(1)
    svc.close(a.id, DEV)
    expect(a.pane.closed).toBe(false)
    svc.close(b.id, DEV)
    expect(a.pane.closed).toBe(true)
    expect(svc.watchCount()).toBe(0)
    // a new viewer starts a new one
    await opened()
    expect(opener.made.length).toBe(2)
  })

  test('the pane ending closes every view with pane_gone and drops the watch', async () => {
    const a = await opened()
    await opened()
    a.pane.end()
    expect(of('term.closed').map((f) => f.why)).toEqual(['pane_gone', 'pane_gone'])
    expect(svc.viewCount()).toBe(0)
    expect(svc.watchCount()).toBe(0)
    expect(a.pane.closed).toBe(true)
  })

  test("the pane changing size (the Mac's own window) tells each page the new size and sends a fresh picture", async () => {
    const { id, pane } = await opened()
    clock.advance(KEY_MIN_GAP_MS)
    pane.screen = new TextEncoder().encode('RESIZED')
    pane.resize(90, 25)
    await tick()
    const opens = of('term.opened')
    expect(opens[opens.length - 1]).toMatchObject({ term_id: id, cols: 90, rows: 25 })
    // the page has not acked the first keyframe, so the new one waits for room; ack it
    svc.ack(id, svc.position(id)?.next as number)
    await tick()
    expect(text(of('term.key').pop() as Out)).toBe('RESIZED')
  })
})

describe('keyframes: bounded in size and in rate', () => {
  test('a picture over 128 KiB is never sent: the view is closed with why keyframe', async () => {
    const o = fakeOpener({ hold: true })
    svc = make({}, o)
    const id = termId()
    const p = svc.open({ term_id: id, target: 'main' }, DEV)
    await tick()
    o.last().screen = new Uint8Array(TERM_KEY_MAX_BYTES + 1)
    await p
    o.last().hold?.()
    await tick()
    expect(of('term.key')).toEqual([])
    expect(of('term.closed').map((f) => [f.term_id, f.why])).toEqual([[id, 'keyframe']])
    expect(svc.viewCount()).toBe(0)
  })

  test('a picture exactly at the cap goes out', async () => {
    const o = fakeOpener({ hold: true })
    svc = make({}, o)
    const p = svc.open({ term_id: termId(), target: 'main' }, DEV)
    await tick()
    o.last().screen = new Uint8Array(TERM_KEY_MAX_BYTES)
    await p
    o.last().hold?.()
    await tick()
    expect(of('term.key')).toHaveLength(1)
  })

  test('a second picture inside two seconds waits for the gap, and a viewer that keeps asking is closed', async () => {
    const { id, pane } = await opened()
    expect(of('term.key')).toHaveLength(1)
    // asks again at once (a resume from an offset that never was): it waits, it does not spin
    svc.resume(id, pane.total + 1000, DEV)
    await tick()
    expect(of('term.key')).toHaveLength(1)
    clock.advance(KEY_MIN_GAP_MS)
    await tick()
    expect(of('term.key')).toHaveLength(2)
    // and keeps on, again and again inside the gap: after a handful it is closed, not served forever
    for (let i = 0; i < 8 && svc.viewCount() > 0; i++) {
      svc.resume(id, pane.total + 1000 + i, DEV)
      clock.advance(100) // inside the gap: it has to wait
      clock.advance(KEY_MIN_GAP_MS) // and then it is served, and asks again
      await tick()
      svc.ack(id, svc.position(id)?.next ?? 0)
    }
    expect(of('term.closed').map((f) => f.why)).toEqual(['keyframe'])
    expect(svc.viewCount()).toBe(0)
  })

  test('a picture asked for after the gap goes at once (a normal overrun is not held up)', async () => {
    const { id, pane } = await opened()
    clock.advance(KEY_MIN_GAP_MS)
    svc.resume(id, pane.total + 1000, DEV)
    await tick()
    expect(of('term.key')).toHaveLength(2)
  })
})

describe('a keyframe the Mac needs is not a viewer that asks again and again', () => {
  test('a slow phone on a fast log (an overrun every two seconds, for minutes) is served one picture per gap and stays open', async () => {
    const { id, pane } = await opened()
    for (let i = 0; i < 40; i++) {
      clock.advance(KEY_MIN_GAP_MS)
      pane.emit('o'.repeat(2 * TERM_RING_BYTES)) // more than the ring holds while the phone acks nothing
      flush()
      await tick()
      svc.ack(id, svc.position(id)?.next ?? 0)
      await tick()
    }
    expect(svc.viewCount()).toBe(1)
    expect(of('term.closed')).toEqual([])
    expect(of('term.key').length).toBeGreaterThan(30)
  })

  test('and overruns inside the gap wait for it (one picture per two seconds at most), without counting against it', async () => {
    const { id, pane } = await opened()
    for (let i = 0; i < 20; i++) {
      pane.emit('o'.repeat(2 * TERM_RING_BYTES))
      flush()
      await tick()
      svc.ack(id, svc.position(id)?.next ?? 0)
    }
    expect(svc.viewCount()).toBe(1)
    expect(of('term.key')).toHaveLength(1) // inside the gap: no second one yet
    clock.advance(KEY_MIN_GAP_MS)
    await tick()
    expect(of('term.key')).toHaveLength(2)
  })

  test('dragging the Mac window (a resize every 100 ms for twenty seconds) keeps the view open, a picture per gap', async () => {
    const { id, pane } = await opened()
    for (let i = 0; i < 200; i++) {
      pane.resize(80 + (i % 40), 24)
      clock.advance(100)
      await tick()
      svc.ack(id, svc.position(id)?.next ?? 0)
    }
    expect(svc.viewCount()).toBe(1)
    expect(of('term.closed')).toEqual([])
    expect(of('term.key').length).toBeLessThanOrEqual(12)
  })
})

describe('a device the owner revoked', () => {
  test('its views end at once when the Mac says so, and the page is told', async () => {
    const a = await opened('main', DEV)
    await opened('main', OTHER)
    svc.endDevice(DEV)
    expect(of('term.closed').map((f) => [f.term_id, f.why])).toEqual([[a.id, 'revoked']])
    expect(svc.viewCount()).toBe(1)
    expect(audit.rows().find((r) => r.term_id === a.id)?.why).toBe('revoked')
  })

  test('a revoke made in another process (the devices file) is noticed within a second of output', async () => {
    revoked.add(DEV)
    const { pane } = await opened('main', DEV)
    pane.emit('x')
    clock.advance(1000)
    expect(of('term.closed').map((f) => f.why)).toEqual(['revoked'])
    expect(svc.viewCount()).toBe(0)
  })
})

describe('what is kept', () => {
  test('the audit row has tier, device, target, times, why and counts, and never a byte of what the pane showed', async () => {
    const { id, pane } = await opened()
    pane.emit('CANARY-secret-text-123')
    flush()
    svc.close(id, DEV)
    const rows = audit.rows()
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ term_id: id, tier: 'view', device_id: DEV, target: 'main', why: 'closed' })
    expect(rows[0]?.closed_at).toBeGreaterThanOrEqual(rows[0]?.opened_at as number)
    expect(rows[0]?.frames_out).toBe(2) // the keyframe and one out
    expect(rows[0]?.bytes_out).toBe('SCREEN'.length + 'CANARY-secret-text-123'.length)
    expect(Object.keys(rows[0] as object).sort()).toEqual(
      ['bytes_out', 'closed_at', 'device_id', 'frames_out', 'opened_at', 'target', 'term_id', 'tier', 'why'].sort(),
    )
    // nothing in the whole database holds the canary
    for (const t of ['term_audit']) {
      const all = JSON.stringify(db.query(`SELECT * FROM ${t}`).all())
      expect(all).not.toContain('CANARY')
    }
  })

  test('old rows age out', () => {
    audit.open({ term_id: termId(), tier: 'view', device_id: DEV, target: 'main', opened_at: 1 })
    audit.open({ term_id: termId(), tier: 'view', device_id: DEV, target: 'main', opened_at: 1 + 91 * 24 * 3600_000 })
    expect(audit.rows().length).toBe(1)
  })
})

describe('no typing path in this piece', () => {
  test("the pane source offers no way to write, and the control client's stdin takes only the two read commands", async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(import.meta.dir, '../../src/term')
    const control = readFileSync(join(dir, 'control.ts'), 'utf8')
    // the control client's stdin has ONE writer (writeControl, which refuses anything not on the allowlist before it writes): no other
    // call writes to it, and the allowlist itself names only the two read commands
    expect([...control.matchAll(/stdin\.write\(/g)]).toHaveLength(1)
    expect(control).toMatch(/export function writeControl/)
    expect([...control.matchAll(/writeControl\(/g)].length).toBeGreaterThanOrEqual(2)
    // the client is a control-mode client that ignores size, and is NOT attached read-only: a read-only client makes every plain
    // `send-keys` on the session fail ("client is read-only"), which silently breaks the agent's own keys while someone watches.
    // (tmux-real.test.ts runs it against a real tmux: the supervisor's keys reach the pane, and the pane never changes size.)
    expect(control).toMatch(/'attach',\s*'-f',\s*'ignore-size'/)
    expect(control).not.toMatch(/'attach',\s*'-r'/)
    // no file of the term folder names a key-sending, pasting or resizing command in code
    for (const f of readdirSync(dir)) {
      const code = readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
        .join('\n')
      for (const bad of ['send-keys', 'paste-buffer', 'refresh-client', 'resize-', 'run-shell', 'respawn', 'kill-']) {
        expect(code.includes(bad), `${f} mentions ${bad}`).toBe(false)
      }
    }
  })
})
