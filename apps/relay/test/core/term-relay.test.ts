// The remote terminal's view through the REAL relay hub (core/term.ts): a stream of its own beside the chat path. The frames go
// between one app socket and the Mac and are never stored, replayed, pushed or given a sequence number. The hub, the router and
// the protocol's schemas are real; the sockets are the replay driver's fakes on a fake clock.
import {
  b64urlEncode,
  TERM_MAX_OPEN,
  TERM_SOCKET_BUFFER_MAX,
  TERM_VIEW_FEATURE,
  TERM_WINDOW_BYTES,
  TERM_WINDOW_FRAMES,
} from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TERM_FORWARDED_MAX } from '../../src/core/term.ts'
import { frame, type Replay, startReplay, uid } from '../replay/replay-harness.ts'

vi.setConfig({ testTimeout: t(60_000) })

let rp: Replay | null = null
afterEach(async () => {
  vi.restoreAllMocks()
  await rp?.stop()
  rp = null
})

type Sock = ReturnType<Replay['app']>
const termId = () => uid('tm_')
const text = (n: number) => b64urlEncode(new Uint8Array(n).fill(0x61))

/** The frames a socket was sent, from log position `from`. */
const sent = (r: Replay, name: string, from = 0) =>
  r.log.slice(from).flatMap((e) => (e.to === name && 'frame' in e ? [e.frame as Record<string, unknown>] : []))
const ofType = (r: Replay, name: string, type: string, from = 0) => sent(r, name, from).filter((f) => f.type === type)

/** A relay with the Mac listing term-view/1, and one pinned app socket that has said hello. */
async function setup(opts: { features?: string[]; bridge?: boolean } = {}) {
  const r = await startReplay()
  rp = r
  const bridge =
    opts.bridge === false ? null : await r.bridge('bridge', { features: opts.features ?? [TERM_VIEW_FEATURE] })
  const app = r.app('app')
  await r.hello(app)
  return { r, bridge, app }
}
const open = (r: Replay, id: string, extra: Record<string, unknown> = {}) =>
  r.signed(frame('term.open', { term_id: id, tier: 'view', target: 'main', cols: 120, rows: 40, ...extra }))
/** The Mac's answer to an open: term.opened, then the keyframe. */
async function accepted(r: Replay, bridge: NonNullable<Awaited<ReturnType<typeof setup>>['bridge']>, id: string) {
  await r.bridgeSend(
    bridge,
    frame('term.opened', { term_id: id, tier: 'view', cols: 120, rows: 40, idle_s: 600, max_s: 3600 }),
  )
  await r.bridgeSend(bridge, frame('term.key', { term_id: id, at: 0, bytes_b64: text(10) }))
}

describe('a view through the relay is never stored, queued or pushed', () => {
  it('open, output, credit, resume and close touch no appendEvent, outbox, push or relay.seq', async () => {
    const { r, bridge, app } = await setup()
    const append = vi.spyOn(r.relay.runtime.store, 'appendEvent')
    const notify = vi.spyOn(r.relay.runtime.push, 'notify')
    const seq = r.relay.runtime.store.maxSeq()
    const id = termId()
    await r.appSend(app, await open(r, id))
    await accepted(r, bridge!, id)
    await r.bridgeSend(bridge!, frame('term.out', { term_id: id, at: 10, bytes_b64: text(100) }))
    await r.appSend(app, frame('term.ack', { term_id: id, upto: 110 }))
    await r.appSend(app, await r.signed(frame('term.resume', { term_id: id, from: 110 })))
    await r.appSend(app, await r.signed(frame('term.close', { term_id: id })))
    expect(append).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(r.relay.runtime.store.maxSeq()).toBe(seq)
    expect(r.relay.runtime.store.outboxDepth()).toBe(0)
    // the frames the app got carry no relay block (no seq, no received_at)
    for (const f of sent(r, 'app')) if (String(f.type).startsWith('term.')) expect(f.relay).toBeUndefined()
    // control: this spy does see a stored frame
    await r.bridgeSend(bridge!, frame('thread.read', { thread_id: 'general', up_to_seq: 0 }))
    expect(r.relay.runtime.store.maxSeq()).toBeGreaterThanOrEqual(seq)
  })

  it('the Mac receives the signed open exactly as the app sent it, and the credit and close that follow', async () => {
    const { r, bridge, app } = await setup()
    const id = termId()
    const signed = await open(r, id)
    await r.appSend(app, signed)
    expect(ofType(r, 'bridge', 'term.open')).toEqual([signed])
    await accepted(r, bridge!, id)
    await r.appSend(app, frame('term.ack', { term_id: id, upto: 10 }))
    expect(ofType(r, 'bridge', 'term.ack').map((f) => f.upto)).toEqual([10])
    const close = await r.signed(frame('term.close', { term_id: id }))
    await r.appSend(app, close)
    expect(ofType(r, 'bridge', 'term.close')).toEqual([close])
  })

  it('nothing is re-sent to a bridge that says hello again: the view ended when the Mac went away', async () => {
    const { r, bridge, app } = await setup()
    const id = termId()
    await r.appSend(app, await open(r, id))
    await accepted(r, bridge!, id)
    bridge!.at.onClose()
    expect(ofType(r, 'app', 'term.closed').map((f) => f.why)).toEqual(['mac_offline'])
    const again = await r.bridge('bridge2', { features: [TERM_VIEW_FEATURE] })
    expect(sent(r, 'bridge2').filter((f) => String(f.type).startsWith('term.'))).toEqual([])
    // the old id is not a view any more: the credit for it goes nowhere
    await r.appSend(app, frame('term.ack', { term_id: id, upto: 10 }))
    expect(sent(r, 'bridge2').filter((f) => String(f.type).startsWith('term.'))).toEqual([])
    expect(again.conn.closed).toBeNull()
  })
})

describe('output goes only to the socket that opened the view', () => {
  it('another socket of the same device hears nothing, and cannot send credit, resume or close for it', async () => {
    const { r, bridge, app } = await setup()
    const other = r.app('other')
    await r.hello(other)
    const id = termId()
    await r.appSend(app, await open(r, id))
    await accepted(r, bridge!, id)
    const mark = r.log.length
    await r.bridgeSend(bridge!, frame('term.out', { term_id: id, at: 10, bytes_b64: text(5) }))
    expect(ofType(r, 'app', 'term.out', mark)).toHaveLength(1)
    expect(sent(r, 'other', mark)).toEqual([])
    // the other socket's credit, resume and close for that id are dropped, and never reach the Mac
    const at = r.log.length
    await r.appSend(other, frame('term.ack', { term_id: id, upto: 15 }))
    await r.appSend(other, await r.signed(frame('term.resume', { term_id: id, from: 0 })))
    await r.appSend(other, await r.signed(frame('term.close', { term_id: id })))
    expect(sent(r, 'bridge', at).filter((f) => String(f.type).startsWith('term.'))).toEqual([])
    expect(r.relay.runtime.hub.term.count()).toBe(1)
  })

  it('a frame from the Mac for an id nobody opened is dropped', async () => {
    const { r, bridge, app } = await setup()
    const mark = r.log.length
    await r.bridgeSend(bridge!, frame('term.out', { term_id: termId(), at: 0, bytes_b64: text(5) }))
    await r.bridgeSend(bridge!, frame('term.key', { term_id: termId(), at: 0, bytes_b64: text(5) }))
    expect(sent(r, 'app', mark)).toEqual([])
    expect(app.conn.closed).toBeNull()
  })

  it('a second open of an id in use is refused, and the first view goes on', async () => {
    const { r, bridge, app } = await setup()
    const id = termId()
    await r.appSend(app, await open(r, id))
    await accepted(r, bridge!, id)
    const at = r.log.length
    await r.appSend(app, await open(r, id))
    expect(
      sent(r, 'app', at)
        .filter((f) => f.type === 'error')
        .map((f) => f.code),
    ).toEqual(['bad_frame'])
    expect(ofType(r, 'bridge', 'term.open')).toHaveLength(1)
  })

  it('when the viewing socket closes the Mac is told the viewer is gone, and the view is no longer counted', async () => {
    const { r, bridge, app } = await setup()
    const id = termId()
    await r.appSend(app, await open(r, id))
    await accepted(r, bridge!, id)
    app.at.onClose()
    expect(ofType(r, 'bridge', 'term.closed').map((f) => [f.term_id, f.why])).toEqual([[id, 'socket_closed']])
    expect(r.relay.runtime.hub.term.count()).toBe(0)
  })
})

describe('an error the Mac sends about any term frame is never stored as a message', () => {
  const refused = async (r: Replay, bridge: NonNullable<Awaited<ReturnType<typeof setup>>['bridge']>, ref: string) => {
    const append = vi.spyOn(r.relay.runtime.store, 'appendEvent')
    const seq = r.relay.runtime.store.maxSeq()
    await r.bridgeSend(bridge, frame('error', { ref, code: 'sig_invalid', message: 'refused' }))
    expect(append).not.toHaveBeenCalled()
    expect(r.relay.runtime.store.maxSeq()).toBe(seq)
  }

  it('a refused resume reaches the asker and is not stored', async () => {
    const { r, bridge, app } = await setup()
    const id = termId()
    await r.appSend(app, await open(r, id))
    await accepted(r, bridge!, id)
    const resume = await r.signed(frame('term.resume', { term_id: id, from: 10 }))
    await r.appSend(app, resume)
    const at = r.log.length
    await refused(r, bridge!, resume.id as string)
    expect(sent(r, 'app', at).filter((f) => f.type === 'error' && f.ref === resume.id)).toHaveLength(1)
  })

  it('a refused close reaches the asker and is not stored', async () => {
    const { r, bridge, app } = await setup()
    const id = termId()
    await r.appSend(app, await open(r, id))
    await accepted(r, bridge!, id)
    const close = await r.signed(frame('term.close', { term_id: id }))
    await r.appSend(app, close)
    const at = r.log.length
    await refused(r, bridge!, close.id as string)
    expect(sent(r, 'app', at).filter((f) => f.type === 'error' && f.ref === close.id)).toHaveLength(1)
  })

  it('a refused open that answers after its socket closed is swallowed, not stored', async () => {
    const { r, bridge, app } = await setup()
    const o = await open(r, termId())
    await r.appSend(app, o)
    app.at.onClose()
    await refused(r, bridge!, o.id as string)
    // and nothing was sent to a socket that is gone
    expect(sent(r, 'app').filter((f) => f.type === 'error' && f.ref === o.id)).toHaveLength(0)
  })

  it('an error about a frame this relay never forwarded is still the ordinary path (control)', async () => {
    const { r, bridge } = await setup()
    const append = vi.spyOn(r.relay.runtime.store, 'appendEvent')
    await r.bridgeSend(bridge!, frame('error', { ref: uid(), code: 'sig_invalid', message: 'refused' }))
    expect(append).toHaveBeenCalled()
  })

  it('the remembered ids age out with the open window', async () => {
    const { r, bridge, app } = await setup()
    const id = termId()
    await r.appSend(app, await open(r, id))
    await accepted(r, bridge!, id)
    const resume = await r.signed(frame('term.resume', { term_id: id, from: 10 }))
    await r.appSend(app, resume)
    r.clock.advance(3 * 60_000)
    const append = vi.spyOn(r.relay.runtime.store, 'appendEvent')
    await r.bridgeSend(bridge!, frame('error', { ref: resume.id, code: 'sig_invalid', message: 'late' }))
    expect(append).toHaveBeenCalled() // forgotten: an old ref is the ordinary path again
  })
})

describe('the remembered frame ids are bounded', () => {
  it(`at ${TERM_FORWARDED_MAX} ids inside the window a new frame is refused with rate_limited, not forwarded, and nothing old is dropped`, async () => {
    const { r, bridge, app } = await setup()
    const id = termId()
    await r.appSend(app, await open(r, id))
    await accepted(r, bridge!, id)
    const first = await r.signed(frame('term.resume', { term_id: id, from: 0 }))
    await r.appSend(app, first)
    for (let i = 1; i < TERM_FORWARDED_MAX - 1; i++) {
      r.clock.advance(100)
      await r.appSend(app, await r.signed(frame('term.resume', { term_id: id, from: i })))
    }
    // the open and these resumes fill the set; one more is refused
    const forwarded = ofType(r, 'bridge', 'term.resume').length
    const extra = await r.signed(frame('term.resume', { term_id: id, from: 999 }))
    r.clock.advance(100)
    const at = r.log.length
    await r.appSend(app, extra)
    expect(
      sent(r, 'app', at)
        .filter((f) => f.type === 'error')
        .map((f) => [f.code, f.ref]),
    ).toEqual([['rate_limited', extra.id]])
    expect(ofType(r, 'bridge', 'term.resume')).toHaveLength(forwarded)
    // the oldest is still remembered: its refusal is still routed, never stored
    const append = vi.spyOn(r.relay.runtime.store, 'appendEvent')
    await r.bridgeSend(bridge!, frame('error', { ref: first.id, code: 'sig_invalid', message: 'refused' }))
    expect(append).not.toHaveBeenCalled()
  })

  it('a full set never blocks the owner closing a view: the close is forwarded, remembered, and its refusal is routed, not stored', async () => {
    const { r, bridge, app } = await setup()
    const id = termId()
    await r.appSend(app, await open(r, id))
    await accepted(r, bridge!, id)
    for (let i = 1; i < TERM_FORWARDED_MAX; i++) {
      r.clock.advance(100)
      await r.appSend(app, await r.signed(frame('term.resume', { term_id: id, from: i })))
    }
    const close = await r.signed(frame('term.close', { term_id: id }))
    r.clock.advance(100)
    const at = r.log.length
    await r.appSend(app, close)
    expect(sent(r, 'app', at).filter((f) => f.type === 'error')).toEqual([])
    expect(ofType(r, 'bridge', 'term.close').map((f) => f.id)).toEqual([close.id])
    const append = vi.spyOn(r.relay.runtime.store, 'appendEvent')
    await r.bridgeSend(bridge!, frame('error', { ref: close.id, code: 'sig_invalid', message: 'refused' }))
    expect(append).not.toHaveBeenCalled()
  })
})

describe('a resize while the window is full is not a lag', () => {
  it('a second term.opened resets the window, so the keyframe that follows is forwarded', async () => {
    const { r, bridge, app } = await setup()
    const id = termId()
    await r.appSend(app, await open(r, id))
    await accepted(r, bridge!, id)
    let at = 0
    for (let i = 0; i < TERM_WINDOW_FRAMES; i++) {
      await r.bridgeSend(bridge!, frame('term.out', { term_id: id, at, bytes_b64: text(10) }))
      at += 10
    }
    const mark = r.log.length
    // the Mac's pane changed size: it says so, and sends a fresh picture
    await r.bridgeSend(
      bridge!,
      frame('term.opened', { term_id: id, tier: 'view', cols: 90, rows: 25, idle_s: 600, max_s: 3600 }),
    )
    await r.bridgeSend(bridge!, frame('term.key', { term_id: id, at, bytes_b64: text(10) }))
    expect(ofType(r, 'app', 'term.key', mark)).toHaveLength(1)
    expect(ofType(r, 'app', 'term.closed', mark)).toEqual([])
  })
})

describe('the Mac away, an older Mac, and the limit', () => {
  it('with the Mac away the answer is mac_offline at once, and nothing is kept', async () => {
    const { r, app } = await setup({ bridge: false })
    const append = vi.spyOn(r.relay.runtime.store, 'appendEvent')
    const o = await open(r, termId())
    await r.appSend(app, o)
    const errs = sent(r, 'app').filter((f) => f.type === 'error')
    expect(errs.map((f) => [f.code, f.ref])).toEqual([['mac_offline', o.id]])
    expect(r.relay.runtime.hub.term.count()).toBe(0)
    expect(append).not.toHaveBeenCalled()
    expect(r.relay.runtime.store.outboxDepth()).toBe(0)
  })

  it('a Mac that does not list term-view/1 is not sent the open: the app is told it is unsupported', async () => {
    const { r, app } = await setup({ features: [] })
    const id = termId()
    await r.appSend(app, await open(r, id))
    expect(ofType(r, 'bridge', 'term.open')).toEqual([])
    expect(ofType(r, 'app', 'term.closed').map((f) => [f.term_id, f.why])).toEqual([[id, 'unsupported']])
  })

  it('an error the Mac sends about an open reaches the asker and is never stored as a message', async () => {
    const { r, bridge, app } = await setup()
    const o = await open(r, termId())
    await r.appSend(app, o)
    const seq = r.relay.runtime.store.maxSeq()
    await r.bridgeSend(bridge!, frame('error', { ref: o.id, code: 'sig_invalid', message: 'refused' }))
    expect(sent(r, 'app').filter((f) => f.type === 'error' && f.ref === o.id)).toHaveLength(1)
    expect(r.relay.runtime.store.maxSeq()).toBe(seq)
    expect(r.relay.runtime.hub.term.count()).toBe(0)
  })

  it(`at most ${TERM_MAX_OPEN} views are open; a closed one frees its place`, async () => {
    const { r, bridge, app } = await setup()
    const ids: string[] = []
    for (let i = 0; i < TERM_MAX_OPEN; i++) {
      ids.push(termId())
      await r.appSend(app, await open(r, ids[i] as string))
    }
    expect(ofType(r, 'bridge', 'term.open')).toHaveLength(TERM_MAX_OPEN)
    const extra = await open(r, termId())
    const at = r.log.length
    await r.appSend(app, extra)
    expect(
      sent(r, 'app', at)
        .filter((f) => f.type === 'error')
        .map((f) => [f.code, f.ref]),
    ).toEqual([['rate_limited', extra.id]])
    expect(ofType(r, 'bridge', 'term.open')).toHaveLength(TERM_MAX_OPEN)
    // the Mac ends one: the next open goes through
    await r.bridgeSend(bridge!, frame('term.closed', { term_id: ids[0], why: 'closed' }))
    await r.appSend(app, await open(r, termId()))
    expect(ofType(r, 'bridge', 'term.open')).toHaveLength(TERM_MAX_OPEN + 1)
  })
})

describe('a slow viewer: the lag drop', () => {
  it(`a socket with more than ${TERM_SOCKET_BUFFER_MAX} bytes waiting gets term.closed{lag}, no output, and only that socket`, async () => {
    const { r, bridge, app } = await setup()
    const other = r.app('other')
    await r.hello(other)
    const id = termId()
    await r.appSend(app, await open(r, id))
    await accepted(r, bridge!, id)
    app.conn.buffered = TERM_SOCKET_BUFFER_MAX + 1
    const mark = r.log.length
    await r.bridgeSend(bridge!, frame('term.out', { term_id: id, at: 10, bytes_b64: text(50) }))
    await r.bridgeSend(bridge!, frame('term.out', { term_id: id, at: 60, bytes_b64: text(50) }))
    expect(ofType(r, 'app', 'term.out', mark)).toEqual([])
    expect(ofType(r, 'app', 'term.closed', mark).map((f) => f.why)).toEqual(['lag']) // said once, not per frame
    expect(sent(r, 'other', mark)).toEqual([])
    expect(app.conn.closed).toBeNull()
    // the Mac was not told to close: the view is still open and the page resumes by offset
    expect(ofType(r, 'bridge', 'term.close')).toEqual([])
    expect(ofType(r, 'bridge', 'term.closed')).toEqual([])
    app.conn.buffered = 0
    const resume = await r.signed(frame('term.resume', { term_id: id, from: 10 }))
    await r.appSend(app, resume)
    expect(ofType(r, 'bridge', 'term.resume')).toEqual([resume])
    const after = r.log.length
    await r.bridgeSend(bridge!, frame('term.out', { term_id: id, at: 10, bytes_b64: text(50) }))
    expect(ofType(r, 'app', 'term.out', after)).toHaveLength(1)
  })

  it(`a Mac that sends past ${TERM_WINDOW_FRAMES} unacked frames is dropped the same way`, async () => {
    const { r, bridge, app } = await setup()
    const id = termId()
    await r.appSend(app, await open(r, id))
    await accepted(r, bridge!, id)
    const mark = r.log.length
    let at = 0
    // the keyframe counts as the first unacked frame; seven small outputs fill the window; the next is over it
    for (let i = 0; i < TERM_WINDOW_FRAMES; i++) {
      await r.bridgeSend(bridge!, frame('term.out', { term_id: id, at, bytes_b64: text(10) }))
      at += 10
    }
    expect(ofType(r, 'app', 'term.out', mark)).toHaveLength(TERM_WINDOW_FRAMES - 1)
    expect(ofType(r, 'app', 'term.closed', mark).map((f) => f.why)).toEqual(['lag'])
    // credit reopens it after a resume
    await r.appSend(app, await r.signed(frame('term.resume', { term_id: id, from: 70 })))
    const later = r.log.length
    await r.bridgeSend(bridge!, frame('term.out', { term_id: id, at: 70, bytes_b64: text(10) }))
    expect(ofType(r, 'app', 'term.out', later)).toHaveLength(1)
  })

  it('a keyframe at a far offset moves the credit to it: the output after it is not read as 5 MB unacked', async () => {
    const { r, bridge, app } = await setup()
    const id = termId()
    await r.appSend(app, await open(r, id))
    await r.bridgeSend(
      bridge!,
      frame('term.opened', { term_id: id, tier: 'view', cols: 120, rows: 40, idle_s: 600, max_s: 3600 }),
    )
    const mark = r.log.length
    await r.bridgeSend(bridge!, frame('term.key', { term_id: id, at: 5_000_000, bytes_b64: text(10) }))
    await r.bridgeSend(bridge!, frame('term.out', { term_id: id, at: 5_000_000, bytes_b64: text(1000) }))
    expect(ofType(r, 'app', 'term.out', mark)).toHaveLength(1)
    expect(ofType(r, 'app', 'term.closed', mark)).toEqual([])
  })

  it(`more than ${TERM_WINDOW_BYTES} bytes unacked is over the window, and an ack makes room`, async () => {
    const { r, bridge, app } = await setup()
    const id = termId()
    await r.appSend(app, await open(r, id))
    await accepted(r, bridge!, id)
    const mark = r.log.length
    await r.bridgeSend(bridge!, frame('term.out', { term_id: id, at: 0, bytes_b64: text(16 * 1024) }))
    await r.bridgeSend(bridge!, frame('term.out', { term_id: id, at: 16384, bytes_b64: text(16 * 1024) }))
    await r.appSend(app, frame('term.ack', { term_id: id, upto: 32768 }))
    for (let i = 0; i < 4; i++) {
      await r.bridgeSend(bridge!, frame('term.out', { term_id: id, at: 32768 + i * 16384, bytes_b64: text(16 * 1024) }))
    }
    expect(ofType(r, 'app', 'term.out', mark)).toHaveLength(6)
    expect(ofType(r, 'app', 'term.closed', mark)).toEqual([])
    await r.bridgeSend(bridge!, frame('term.out', { term_id: id, at: 98304, bytes_b64: text(16 * 1024) }))
    expect(ofType(r, 'app', 'term.closed', mark).map((f) => f.why)).toEqual(['lag'])
  })
})
