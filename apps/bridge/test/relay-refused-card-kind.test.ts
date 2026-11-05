// An older relay refuses a card kind it has never heard of with error{bad_frame, "invalid card.create frame at card.kind"}.
// The agent is told the relay needs an update; any other refusal keeps its own words.
import { afterEach, describe, expect, test } from 'bun:test'
import { fakeClock } from '@talos-app/testkit'
import { LiveTransport } from '../src/transport.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

const cardArgs = {
  thread_id: 'general',
  kind: 'generic',
  title: 'Refused',
  primary_label: 'Go',
  kill_label: 'Kill it',
  risk: 'low',
  origin: 'chat',
}

async function refusedWith(message: string) {
  // The clock is never advanced, so the tool can only fail because the relay's error{ref} reached it.
  h = await startHarness({
    clock: fakeClock(),
    relay: { rejectBridgeFrame: (f) => (f.type === 'card.create' ? { code: 'bad_frame', message } : undefined) },
  })
  return h.bridge.callTool('card', cardArgs)
}

describe('a card the relay refuses for its kind', () => {
  test('tells the agent the relay does not know the kind and needs an update', async () => {
    const res = await refusedWith('invalid card.create frame at card.kind')
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('bad_frame')
    expect(res.content[0]?.text).toContain('relay does not know the card kind "generic"')
    expect(res.content[0]?.text).toContain('Update the relay')
    expect(h.bridge.ctx.store.outboxCount()).toBe(0)
  })

  test('leaves any other refusal, such as a malformed known card, in the relay’s own words', async () => {
    const res = await refusedWith('invalid card.create frame at card.title')
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toContain('invalid card.create frame at card.title')
    expect(res.content[0]?.text).not.toContain('Update the relay')
  })
})

describe('a queued card an older relay refuses after the link came back', () => {
  const row = {
    id: 'c1',
    type: 'card.create',
    json: JSON.stringify({ id: 'c1', type: 'card.create', card: { kind: 'generic' } }),
  }
  function transport(onDrop: (r: { id: string; type: string; reason: string; cardKind?: string }) => void) {
    const rows = new Map([[row.id, row]])
    const store = { outboxGet: (id: string) => rows.get(id), outboxDelete: (id: string) => rows.delete(id) }
    const log = { warn() {}, info() {}, error() {}, debug() {} }
    // biome-ignore lint/suspicious/noExplicitAny: a minimal stand-in for the store, wire and relay
    const any = (x: unknown) => x as any
    return new LiveTransport(any({}), any(store), any({}), fakeClock(), any(log), onDrop)
  }

  test('hands the dropped row the card kind, so the agent is told to update the relay', () => {
    const dropped: Array<{ reason: string; cardKind?: string }> = []
    transport((r) => dropped.push(r)).onError('c1', 'bad_frame', 'invalid card.create frame at card.kind')
    expect(dropped).toEqual([expect.objectContaining({ reason: 'refused', cardKind: 'generic' })])
  })

  test('leaves a refusal that is not about the kind without one', () => {
    const dropped: Array<{ reason: string; cardKind?: string }> = []
    transport((r) => dropped.push(r)).onError('c1', 'bad_frame', 'invalid card.create frame at card.title')
    expect(dropped[0]?.cardKind).toBeUndefined()
  })
})

describe('what the agent is told when a queued card is refused for its kind', () => {
  test('the drop note says to update the relay; a refusal that is not about the kind keeps the plain wording', async () => {
    for (const [message, wantUpdate] of [
      ['invalid card.create frame at card.kind', true],
      ['invalid card.create frame at card.title', false],
    ] as const) {
      // A real card frame, taken from the first (refused) send; then it is queued again with nobody waiting on it, as after a reconnect.
      let seen: Record<string, unknown> | undefined
      h = await startHarness({
        clock: fakeClock(),
        relay: {
          rejectBridgeFrame: (f) => {
            if (f.type !== 'card.create') return undefined
            seen ??= f
            return { code: 'bad_frame', message }
          },
        },
      })
      await h.bridge.callTool('card', cardArgs)
      const frame = seen as Record<string, unknown>
      expect(frame).toBeDefined()
      h.bridge.ctx.store.outboxAdd(String(frame.id), 'card.create', JSON.stringify(frame), Date.now())
      const before = h.notes.length
      ;(h.bridge.ctx.transport as unknown as { flushOutbox(): void }).flushOutbox()
      await waitFor(() => JSON.stringify(h.notes.slice(before)).includes('never reached the relay'), 3000, 'drop note')
      const note = JSON.stringify(h.notes.slice(before))
      if (wantUpdate) {
        expect(note).toContain('the relay does not know the card kind')
        expect(note).toContain('Update the relay, then send it again if it matters.')
      } else {
        expect(note).toContain('was refused by the relay')
        expect(note).toContain('Send it again if it matters.')
        expect(note).not.toContain('Update the relay')
      }
      await h.stop()
    }
  })
})
