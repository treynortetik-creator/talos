// The read-only terminal view's session (src/features/terminal/remote/session.ts) against the fake client's made-up pane and a
// fake terminal: what it sends, what it draws and in what order, the credit, the resume after a lag, how a view ends. No timers
// of the wall clock: vitest's fake ones. The screen itself, with the real xterm under the real CSP, is test/terminal/remote-terminal.spec.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { b64urlEncode } from '@talos-app/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEARTBEAT_MS, secondsLeft, TermSession, type TermView } from '../../src/features/terminal/remote/session.ts'
import { endedWords, TERM_WORDS, timeLeft } from '../../src/features/terminal/remote/words.ts'
import { createFakeClient, type FakeClient } from '../../src/lib/fakeClient.ts'

const dec = new TextDecoder()
let client: FakeClient
let session: TermSession
let views: TermView[]
let ops: Array<['reset'] | ['write', string] | ['resize', number, number]>
let visible = true
const view = () => views[views.length - 1] as TermView

beforeEach(() => {
  vi.useFakeTimers()
  client = createFakeClient({})
  views = []
  ops = []
  visible = true
  session = new TermSession({
    client,
    sink: {
      write: (bytes, done) => {
        ops.push(['write', dec.decode(bytes)])
        done()
      },
      reset: () => void ops.push(['reset']),
      resize: (c, r) => void ops.push(['resize', c, r]),
    },
    onView: (v) => void views.push(v),
    visible: () => visible,
  })
})
afterEach(() => {
  session.dispose()
  client.close()
  vi.useRealTimers()
})

const sentOf = (type: string) => client.fakeTerm.sent.filter((f) => f.type === type)
const writes = () => ops.filter((o) => o[0] === 'write').map((o) => o[1] as string)
/** Opens a view and lets the Mac's first frames arrive. */
async function watching(target = 'main') {
  await session.start(target)
  await vi.advanceTimersByTimeAsync(0)
  expect(view().phase).toBe('watching')
}
const out = (at: number, text: string, id = session.id) =>
  client.emit('term.out', { term_id: id as string, at, bytes_b64: b64urlEncode(new TextEncoder().encode(text)) })

describe('opening', () => {
  it('one tap sends one signed open for a view tier, with a fresh id; a second tap while it opens sends nothing', async () => {
    const first = session.start('main')
    void session.start('main')
    await first
    expect(sentOf('term.open')).toHaveLength(1)
    expect(sentOf('term.open')[0]).toMatchObject({ tier: 'view', target: 'main' })
    expect(String(sentOf('term.open')[0]?.term_id)).toMatch(/^tm_[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('shows the pane: the size from the Mac, a cleared screen, the picture, then the credit up to its offset', async () => {
    await watching()
    expect(ops[0]).toEqual(['resize', 100, 28])
    expect(ops[1]).toEqual(['reset'])
    expect(writes()[0]).toContain('Reading apps/web/src/lib/socket-connection.ts')
    expect(view()).toMatchObject({ phase: 'watching', cols: 100, rows: 28, lagging: false, maxS: 3600 })
    expect(sentOf('term.ack').map((f) => f.upto)).toEqual([client.fakeTerm.total])
  })

  it('every start is a new id, never reused', async () => {
    await watching()
    const a = session.id
    session.close()
    await watching()
    expect(session.id).not.toBe(a)
    expect(sentOf('term.open')).toHaveLength(2)
  })

  it('a Mac that is away ends it at once with the words, and nothing was sent', async () => {
    client.setMacOnline(false)
    await session.start('main')
    expect(view()).toEqual({ phase: 'ended', target: 'main', words: TERM_WORDS.macAway })
    expect(sentOf('term.open')).toEqual([])
  })

  it('a Mac that cannot show that pane (no session running) ends it with the words', async () => {
    client.fakeTerm.refuseNext('no_pane')
    await session.start('release_notes')
    await vi.advanceTimersByTimeAsync(0)
    expect(view()).toEqual({ phase: 'ended', target: 'release_notes', words: endedWords('no_pane') })
  })
})

describe('drawing and the credit', () => {
  it('output is drawn in order, and the credit goes after four frames, or soon after fewer', async () => {
    await watching()
    const at = client.fakeTerm.total
    const acks = () => sentOf('term.ack').length
    const before = acks()
    client.fakeTerm.say('a')
    client.fakeTerm.say('b')
    expect(writes().slice(-2)).toEqual(['a', 'b'])
    expect(acks()).toBe(before) // two frames: not yet
    await vi.advanceTimersByTimeAsync(100)
    expect(acks()).toBe(before + 1)
    expect(sentOf('term.ack').at(-1)?.upto).toBe(at + 2)
    for (const c of 'cdef') client.fakeTerm.say(c)
    expect(acks()).toBe(before + 2) // four frames: at once
    expect(sentOf('term.ack').at(-1)?.upto).toBe(at + 6)
  })

  it('bytes already drawn are skipped, and a frame that skips ahead is not drawn: the Mac is asked to resume from the offset drawn', async () => {
    await watching()
    const at = client.fakeTerm.total
    out(at, 'hello')
    out(at, 'hello world') // an overlap: only the new tail is drawn
    out(at + 5, ' world') // a repeat of the same tail: nothing
    expect(writes().slice(1)).toEqual(['hello', ' world'])
    out(at + 100, 'GAP') // a hole: nothing drawn, one resume
    // the resume is answered with a picture (the fake pane never printed those bytes); it is not the GAP bytes
    expect(writes().slice(1, 3)).toEqual(['hello', ' world'])
    expect(writes().join('')).not.toContain('GAP')
    expect(sentOf('term.resume').map((f) => f.from)).toEqual([at + 11])
  })

  it('a lag: the page resumes from the offset it drew, what the relay dropped arrives once and in order, and the stream goes on', async () => {
    await watching()
    client.fakeTerm.say('one ')
    const drawn = client.fakeTerm.total
    client.fakeTerm.say('two ', true) // printed, but the relay dropped it on the way
    client.fakeTerm.lag()
    expect(sentOf('term.resume').map((f) => f.from)).toEqual([drawn])
    expect(writes().slice(-2)).toEqual(['one ', 'two '])
    client.fakeTerm.say('three')
    expect(writes().at(-1)).toBe('three')
    expect(session.offset).toBe(client.fakeTerm.total)
  })

  it('while it catches up the header says so, and it clears with the next thing drawn', async () => {
    await watching()
    client.fakeTerm.lag() // nothing was dropped: there is nothing to replay yet
    expect(view()).toMatchObject({ phase: 'watching', lagging: true })
    client.fakeTerm.say('x')
    expect(view()).toMatchObject({ phase: 'watching', lagging: false })
  })

  it('a keyframe mid-stream (a skip ahead) clears the screen and the stream goes on from its offset', async () => {
    await watching()
    client.fakeTerm.say('before')
    client.fakeTerm.resizePane(100, 28) // a new picture at the current offset
    await vi.advanceTimersByTimeAsync(0)
    expect(ops.filter((o) => o[0] === 'reset')).toHaveLength(2)
    const at = client.fakeTerm.total
    client.fakeTerm.say('after')
    expect(writes().at(-1)).toBe('after')
    expect(session.offset).toBe(at + 5)
  })
})

describe('the credit is for what the terminal has written', () => {
  it('nothing is acked while xterm has not finished writing; the ack names the offset it reached', async () => {
    const pending: Array<() => void> = []
    const slow = new TermSession({
      client,
      sink: { write: (_b, done) => void pending.push(done), reset() {}, resize() {} },
      onView: (v) => void views.push(v),
    })
    await slow.start('main')
    await vi.advanceTimersByTimeAsync(0)
    const done = () => {
      for (const f of pending.splice(0)) f() // xterm finishes what it was given
    }
    done() // the keyframe
    const base = sentOf('term.ack').length
    const at = client.fakeTerm.total
    for (const c of 'abcd') client.fakeTerm.say(c)
    expect(slow.offset).toBe(at + 4) // handed over...
    expect(sentOf('term.ack').length).toBe(base) // ...but not written: no credit
    pending.shift()?.() // the first two written
    pending.shift()?.()
    await vi.advanceTimersByTimeAsync(100)
    expect(sentOf('term.ack').at(-1)?.upto).toBe(at + 2) // what was written, not what was handed over
    done()
    await vi.advanceTimersByTimeAsync(100)
    expect(sentOf('term.ack').at(-1)?.upto).toBe(at + 4)
    slow.dispose()
  })
})

describe('a view that cannot be drawn ends with words', () => {
  it('abort ends it, tells the Mac, and says why', async () => {
    await watching()
    session.abort(TERM_WORDS.loadFailed)
    expect(view()).toEqual({ phase: 'ended', target: 'main', words: TERM_WORDS.loadFailed })
    expect(sentOf('term.close')).toHaveLength(1)
    expect(session.id).toBeNull()
  })
})

describe('keeping it alive, and ending it', () => {
  it('while the page is visible the credit is said again every 30 s (a quiet pane is not an idle viewer); hidden, it is not', async () => {
    await watching()
    const base = sentOf('term.ack').length
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(sentOf('term.ack').length).toBe(base + 1)
    expect(sentOf('term.ack').at(-1)?.upto).toBe(client.fakeTerm.total)
    visible = false
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3)
    expect(sentOf('term.ack').length).toBe(base + 1)
  })

  it('Close tells the Mac, clears the view, and nothing the pane prints after it is drawn or credited', async () => {
    await watching()
    const id = session.id
    session.close()
    expect(sentOf('term.close').map((f) => f.term_id)).toEqual([id])
    expect(view()).toEqual({ phase: 'idle' })
    const drawn = writes().length
    const acks = sentOf('term.ack').length
    client.fakeTerm.say('after close')
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)
    expect(writes().length).toBe(drawn)
    expect(sentOf('term.ack').length).toBe(acks)
  })

  it('leaving the screen (dispose) closes an open view', async () => {
    await watching()
    session.dispose()
    expect(sentOf('term.close')).toHaveLength(1)
  })

  it.each([
    ['idle', 'The terminal closed after 10 minutes with nobody looking at it.'],
    ['max', 'The terminal closed after an hour, the longest one stays open.'],
    ['pane_gone', "The agent's terminal ended."],
    ['restart', "Your Mac's Talos restarted, so the terminal closed."],
    ['revoked', 'This device was removed, so the terminal closed.'],
    ['keyframe', 'The terminal kept needing a fresh picture, so it closed.'],
    ['too_many', 'Four terminals are already open. Close one first.'],
    ['a_word_from_a_newer_mac', 'The terminal closed.'],
  ])('the Mac ending it with %s says so in words, and the view is over', async (why, words) => {
    await watching()
    client.fakeTerm.end(why)
    expect(view()).toEqual({ phase: 'ended', target: 'main', words })
    expect(session.id).toBeNull()
  })

  it('the connection going away ends it (the relay closed the view with the socket), and watching again is a new view', async () => {
    await watching()
    session.connectionLost()
    expect(view()).toEqual({ phase: 'ended', target: 'main', words: endedWords('socket_closed') })
    const drawn = writes().length
    client.fakeTerm.say('into nothing')
    expect(writes().length).toBe(drawn)
    await watching()
    expect(sentOf('term.open')).toHaveLength(2)
  })

  it('the time left counts down from when the Mac opened it, and is named in minutes', async () => {
    await watching()
    const v = view() as Extract<TermView, { phase: 'watching' }>
    expect(secondsLeft(v, v.openedAt)).toBe(3600)
    expect(secondsLeft(v, v.openedAt + 125_000)).toBe(3475)
    expect(secondsLeft(v, v.openedAt + 4000_000)).toBe(0)
    expect(timeLeft(3475)).toBe('58 min')
    expect(timeLeft(59)).toBe('under 1 min')
    expect(timeLeft(0)).toBe('closing')
  })
})

describe('no typing path in this piece', () => {
  it('everything the page sends about a view is an open, a resume, a close or a credit: no frame carries input', async () => {
    await watching()
    client.fakeTerm.say('x')
    client.fakeTerm.lag()
    session.close()
    expect(new Set(client.fakeTerm.sent.map((f) => f.type))).toEqual(
      new Set(['term.open', 'term.ack', 'term.resume', 'term.close']),
    )
    for (const f of client.fakeTerm.sent) expect(Object.keys(f).sort().join()).not.toMatch(/bytes|data|input|key|text/)
  })

  it('the session and the terminal mount never subscribe to what the terminal would emit (no onData, onKey, input or paste)', () => {
    const dir = join(import.meta.dirname, '../../src/features/terminal/remote')
    for (const f of ['session.ts', 'xtermMount.ts', 'RemoteTerminalScreen.tsx', 'buffered.ts']) {
      const code = readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
        .join('\n')
      for (const bad of [
        'onData',
        'onKey',
        'onBinary',
        '.input(',
        '.paste(',
        'attachCustomKeyEventHandler',
        'disableStdin: false',
      ]) {
        expect(code.includes(bad), `${f} has ${bad}`).toBe(false)
      }
    }
    expect(readFileSync(join(dir, 'xtermMount.ts'), 'utf8')).toContain('disableStdin: true')
  })
})
