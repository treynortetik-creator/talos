// @vitest-environment node
// A frame type or card kind this build does not know shows one plain "update the app" note instead of vanishing. A
// malformed frame of a KNOWN kind is still refused with no note. Runs on the replay harness: scripted socket, fake clock.
import { buildCard } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createUnknownNotes, UPDATE_NOTE } from '../src/lib/unknownFrames.ts'
import { type Run, readyFrame, START_ISO, srv, startRun, uid } from './replay/replay-harness.ts'

let run: Run | null = null
afterEach(() => {
  run?.stop()
  run = null
})

const card = (over: Record<string, unknown> = {}) =>
  buildCard(
    { id: uid('c_'), thread_id: 'general', title: 'Send the invoice to alex@example.com', ...over },
    new Date(START_ISO),
  )
/** What a newer peer sends: a well-formed card whose kind this build has never heard of. */
const futureCard = (kind = 'hologram', over: Record<string, unknown> = {}) => ({ ...card(over), kind })

/** A real agent reply except that its message kind is one a newer build added. */
const futureReply = (kind: string) =>
  srv('reply', {
    message: {
      id: uid('m_'),
      thread_id: 'general',
      seq: 2,
      author: 'agent',
      kind,
      text: 'hi',
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: START_ISO,
    },
  })

async function online(r: Run, extra: Record<string, unknown> = {}) {
  r.sock().receive(readyFrame(extra))
  await r.settle()
}
const notes = (r: Run, thread = 'general') =>
  (r.client.store.getState().messages[thread] ?? []).filter((m) => m.author === 'system' && m.text === UPDATE_NOTE)
const cards = (r: Run) => r.client.store.getState().cards
const thread = (id: string) => ({ id, name: id, kind: 'fixed', order: 0, created_at: START_ISO })
const lastSeq = (r: Run) => r.client.store.getState().lastSeq

describe('an unknown card kind', () => {
  it('on the live path shows one note and no card', async () => {
    run = await startRun()
    await online(run)
    run.sock().receive(srv('card.create', { card: futureCard() }))
    await run.settle()
    expect(notes(run)).toHaveLength(1)
    expect(cards(run)).toHaveLength(0)
  })

  it('in catchup.batch shows one note', async () => {
    run = await startRun()
    await online(run)
    const stored = { ...srv('card.create', { card: futureCard() }), relay: { seq: 2, received_at: START_ISO } }
    run.sock().receive(srv('catchup.batch', { from_seq: 1, to_seq: 2, frames: [stored], more: false }))
    await run.settle()
    expect(notes(run)).toHaveLength(1)
    expect(cards(run)).toHaveLength(0)
  })

  it('in ready.open_cards shows one note and keeps the known cards', async () => {
    run = await startRun()
    const known = card({ kind: 'email' })
    await online(run, { open_cards: [known, futureCard()] })
    expect(notes(run)).toHaveLength(1)
    expect(cards(run).map((c) => c.id)).toEqual([known.id])
  })

  it('is told apart from a malformed card of a known kind, which is refused with no note', async () => {
    run = await startRun()
    await online(run)
    const { title: _t, ...noTitle } = card({ kind: 'email' })
    run.sock().receive(srv('card.create', { card: noTitle }))
    const { title: _u, ...futureNoTitle } = futureCard()
    run.sock().receive(srv('card.create', { card: futureNoTitle }))
    run
      .sock()
      .receive(
        srv('catchup.batch', { from_seq: 1, to_seq: 2, frames: [srv('card.create', { card: noTitle })], more: false }),
      )
    await online(run, { open_cards: [noTitle] })
    expect(notes(run)).toHaveLength(0)
    expect(cards(run)).toHaveLength(0)
  })

  it('shows the note in the card’s own thread when this client knows that thread', async () => {
    run = await startRun()
    await online(run, { threads: [thread('general'), thread('work')] })
    run.sock().receive(srv('card.create', { card: futureCard('hologram', { thread_id: 'work' }) }))
    await run.settle()
    expect(notes(run, 'work')).toHaveLength(1)
    expect(notes(run, 'general')).toHaveLength(0)
  })
})

describe('an unknown frame type', () => {
  it('shows one note', async () => {
    run = await startRun()
    await online(run)
    run.sock().receive(srv('no.such.frame', { x: 1 }))
    await run.settle()
    expect(notes(run)).toHaveLength(1)
  })

  it('a known type with an enum value this build does not list (a newer peer) shows one note, once for the type', async () => {
    run = await startRun()
    await online(run)
    run.sock().receive(futureReply('hologram'))
    run.sock().receive(futureReply('telepathy'))
    await run.settle()
    expect(notes(run)).toHaveLength(1)
    // and nothing from it reached the timeline as a message
    expect((run.client.store.getState().messages.general ?? []).filter((m) => m.author === 'agent')).toHaveLength(0)
  })

  it('in catchup.batch too, and a frame that is only broken is still silent', async () => {
    run = await startRun()
    await online(run)
    const stored = futureReply('hologram')
    run.sock().receive(srv('catchup.batch', { from_seq: 1, to_seq: 2, frames: [stored], more: false }))
    await run.settle()
    expect(notes(run)).toHaveLength(1)
  })

  it('does not turn text that is not a frame, or a malformed known frame, into a note', async () => {
    run = await startRun()
    await online(run)
    run.sock().receive('this is not json')
    run.sock().receive(srv('reply', { message: { id: 'nope' } }))
    run.sock().receive(srv('ping', { nonce: 'abcd1234' }))
    await run.settle()
    expect(notes(run)).toHaveLength(0)
  })
})

describe('the note appears once', () => {
  it('for the same frame id sent twice', async () => {
    run = await startRun()
    await online(run)
    const f = srv('card.create', { card: futureCard() })
    run.sock().receive(f)
    run.sock().receive(f)
    await run.settle()
    expect(notes(run)).toHaveLength(1)
  })

  it('per thread and kind, however many cards of that kind arrive', async () => {
    run = await startRun()
    await online(run, { threads: [thread('general'), thread('work')] })
    run.sock().receive(srv('card.create', { card: futureCard('hologram') }))
    run.sock().receive(srv('card.create', { card: futureCard('hologram') }))
    run.sock().receive(srv('no.such.frame', {}))
    run.sock().receive(srv('no.such.frame', {}))
    await run.settle()
    // one for the card kind, one for the frame type: different kinds
    expect(notes(run)).toHaveLength(2)
    run.sock().receive(srv('card.create', { card: futureCard('telepathy') }))
    run.sock().receive(srv('card.create', { card: futureCard('hologram', { thread_id: 'work' }) }))
    await run.settle()
    expect(notes(run)).toHaveLength(3)
    expect(notes(run, 'work')).toHaveLength(1)
  })

  it('a frame type once per session: other ids, other threads and a reconnect add nothing', async () => {
    run = await startRun()
    await online(run, { threads: [thread('general'), thread('work')] })
    for (let i = 0; i < 5; i++) run.sock().receive(srv('no.such.frame', { thread_id: i % 2 ? 'work' : 'general' }))
    await run.settle()
    expect(notes(run)).toHaveLength(1)
    expect(notes(run, 'work')).toHaveLength(0)
    run.sock().drop(1006)
    await run.settle()
    await run.advance(5000)
    await online(run, { threads: [thread('general'), thread('work')] })
    run.sock().receive(srv('no.such.frame', {}))
    await run.settle()
    expect(notes(run)).toHaveLength(1)
    // a second, different type is a second note
    run.sock().receive(srv('another.new.frame', {}))
    await run.settle()
    expect(notes(run)).toHaveLength(2)
  })

  it('not again on every reconnect, though the relay lists the card as open each time', async () => {
    run = await startRun()
    const open = futureCard()
    await online(run, { open_cards: [open] })
    expect(notes(run)).toHaveLength(1)
    for (let i = 0; i < 3; i++) {
      run.sock().drop(1006)
      await run.settle()
      await run.advance(5000)
      await online(run, { open_cards: [open] })
    }
    expect(run.sockets.all.length).toBeGreaterThan(3)
    expect(notes(run)).toHaveLength(1)
  })
})

describe('a peer cannot make the notes pile up or land in a thread it invented', () => {
  it('a thread this client has never heard of gets its note in the default thread', async () => {
    run = await startRun()
    await online(run, { threads: [thread('general')] })
    run.sock().receive(srv('no.such.frame', { thread_id: 'invented' }))
    run.sock().receive(srv('card.create', { card: futureCard('hologram', { thread_id: 'madeup' }) }))
    await run.settle()
    expect(notes(run, 'general')).toHaveLength(2)
    expect(notes(run, 'invented')).toHaveLength(0)
    expect(notes(run, 'madeup')).toHaveLength(0)
    expect(Object.keys(run.client.store.getState().messages)).not.toContain('invented')
  })

  it('a thread that only has rows, and is not in the thread list, gets its note in the default thread', async () => {
    run = await startRun()
    await online(run, { threads: [thread('general')] })
    const message = {
      id: `m_${uid().slice(-26)}`,
      thread_id: 'ghost',
      author: 'agent',
      kind: 'text',
      text: 'Hello Alex',
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: START_ISO,
    }
    run.sock().receive(srv('reply', { message }))
    await run.settle()
    expect(run.client.store.getState().messages.ghost).toHaveLength(1)
    run.sock().receive(srv('no.such.frame', { thread_id: 'ghost' }))
    await run.settle()
    expect(notes(run, 'general')).toHaveLength(1)
    expect(notes(run, 'ghost')).toHaveLength(0)
  })

  it('stops after 3 notes in one thread, however many kinds arrive', async () => {
    run = await startRun()
    await online(run)
    for (let i = 0; i < 40; i++) run.sock().receive(srv(`no.such.frame_${i}`, {}))
    await run.settle()
    expect(notes(run)).toHaveLength(3)
  })

  it('frame-type notes are capped too: 30 invented types over 10 threads give 20 notes in all, and none beyond 3 per thread', async () => {
    run = await startRun()
    const ids = Array.from({ length: 10 }, (_, i) => `t${i}`)
    await online(run, { threads: ids.map(thread) })
    for (const t of ids) for (let i = 0; i < 3; i++) run.sock().receive(srv(`future.type_${t}_${i}`, { thread_id: t }))
    for (let i = 0; i < 40; i++) run.sock().receive(srv(`future.more_${i}`, {}))
    await run.settle()
    const per = ids.map((t) => notes(run as Run, t).length)
    expect(Math.max(...per)).toBeLessThanOrEqual(3)
    const all = [...ids, 'general'].reduce((n, t) => n + notes(run as Run, t).length, 0)
    expect(all).toBe(20)
  })

  it('stops after 20 notes in one session, however many threads and kinds arrive', async () => {
    run = await startRun()
    const ids = Array.from({ length: 10 }, (_, i) => `t${i}`)
    await online(run, { threads: ids.map(thread) })
    for (const t of ids)
      for (let i = 0; i < 3; i++)
        run.sock().receive(srv('card.create', { card: futureCard(`hologram_${i}`, { thread_id: t }) }))
    await run.settle()
    const total = ids.reduce((n, t) => n + notes(run as Run, t).length, 0)
    expect(total).toBe(20)
  })

  it('the cap is shared by the live path and ready.open_cards', async () => {
    run = await startRun()
    const ids = Array.from({ length: 10 }, (_, i) => `t${i}`)
    const open = ids.flatMap((t) => [0, 1, 2].map((i) => futureCard(`hologram_${i}`, { thread_id: t })))
    await online(run, { threads: ids.map(thread), open_cards: open })
    const total = ids.reduce((n, t) => n + notes(run as Run, t).length, 0)
    expect(total).toBe(20)
  })
})

describe('a thread id that is an Object.prototype name', () => {
  it('on an unknown frame does not throw, and the note goes to the default thread', async () => {
    run = await startRun()
    await online(run)
    run.sock().receive(srv('no.such.frame', { thread_id: '__proto__' }))
    run.sock().receive(srv('no.such.other', { thread_id: 'constructor' }))
    await run.settle()
    expect(notes(run, 'general')).toHaveLength(2)
  })

  it('in a catch-up batch keeps lastSeq moving, for a known frame and an unknown one', async () => {
    run = await startRun()
    await online(run)
    const msg = (id: string, thread: string) => ({
      id,
      thread_id: thread,
      author: 'agent',
      kind: 'text',
      text: 'Hello Alex',
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: START_ISO,
    })
    const stored = (f: Record<string, unknown>, seq: number) => ({ ...f, relay: { seq, received_at: START_ISO } })
    const frames = [
      stored(srv('reply', { message: msg(`m_${uid().slice(-26)}`, 'constructor') }), 2),
      stored(srv('no.such.frame', { thread_id: '__proto__' }), 3),
      stored(srv('card.create', { card: futureCard('hologram', { thread_id: 'constructor' }) }), 4),
    ]
    run.sock().receive(srv('catchup.batch', { from_seq: 1, to_seq: 4, frames, more: false }))
    await run.settle()
    expect(lastSeq(run)).toBe(4)
    expect(notes(run, 'general').length).toBeGreaterThan(0)
  })
})

describe('the note is keyed on the card', () => {
  it('a live card and the same card in ready.open_cards share one note id', () => {
    const ids: string[] = []
    const add = createUnknownNotes((_t, id) => ids.push(id))
    add({ kind: 'card:hologram', id: 'frame-1', cardId: 'c_card1', threadId: undefined })
    const reloaded = createUnknownNotes((_t, id) => ids.push(id))
    reloaded({ kind: 'card:hologram', id: 'c_card1', cardId: 'c_card1', threadId: undefined })
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
  })

  it('a reload that lists the card as open adds no second row', async () => {
    run = await startRun()
    const open = futureCard()
    await online(run)
    run.sock().receive(srv('card.create', { card: open }))
    await run.settle()
    const before = (run.client.store.getState().messages.general ?? []).map((m) => m.id)
    run.sock().drop(1006)
    await run.settle()
    await run.advance(5000)
    await online(run, { open_cards: [open] })
    const after = (run.client.store.getState().messages.general ?? []).filter((m) => m.text === UPDATE_NOTE)
    expect(before.filter((id) => id.includes(open.id))).toHaveLength(1)
    expect(after).toHaveLength(1)
  })
})

describe('a card in a thread the ready frame introduces', () => {
  it('first connect puts the note in the card thread; a reload adds no second note', async () => {
    run = await startRun()
    const open = { ...futureCard(), thread_id: 'work' }
    await online(run, { threads: [thread('general'), thread('work')], open_cards: [open] })
    expect(notes(run, 'work')).toHaveLength(1)
    expect(notes(run, 'general')).toHaveLength(0)
    run.sock().drop(1006)
    await run.settle()
    await run.advance(5000)
    await online(run, { threads: [thread('general'), thread('work')], open_cards: [open] })
    expect(notes(run, 'work')).toHaveLength(1)
    expect(notes(run, 'general')).toHaveLength(0)
  })
})

describe('the note rules in detail', () => {
  it('one frame id gets one note even when its kind or thread differs', async () => {
    run = await startRun()
    await online(run, { threads: [thread('general'), thread('work')] })
    run.sock().receive({ ...srv('no.such.frame', {}), id: 'shared-frame-id' })
    run.sock().receive({ ...srv('no.such.other', { thread_id: 'work' }), id: 'shared-frame-id' })
    await run.settle()
    expect(notes(run, 'general').length + notes(run, 'work').length).toBe(1)
  })

  it('an unknown live frame leaves lastSeq where it was', async () => {
    run = await startRun()
    await online(run)
    const before = lastSeq(run)
    run
      .sock()
      .receive({ ...srv('card.create', { card: futureCard() }), relay: { seq: before + 40, received_at: START_ISO } })
    run.sock().receive({ ...srv('no.such.frame', {}), relay: { seq: before + 41, received_at: START_ISO } })
    await run.settle()
    expect(notes(run).length).toBeGreaterThan(0)
    expect(lastSeq(run)).toBe(before)
  })
})
