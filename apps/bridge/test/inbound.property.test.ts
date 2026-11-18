// Property: exactly-once delivery of owner messages to the agent session under a shuffled, duplicated delivery and a bridge
// restart. N distinct owner messages (1..6) reach the relay in a generated order, each 1..3 times (a repeat is the same frame
// again, or the same owner message re-signed under a FRESH frame id), some with a relay time over 15 minutes old (the backlog
// path), some sent while the bridge is down (the replay burst), and the bridge is stopped and started again on the same home after the first k frames, with the relay replaying whatever it still holds (the fake relay keeps
// a frame until the bridge acks it `consumed`). Every message must reach the session exactly once (no loss, no double), and
// the first delivery of each must follow the order in which the frames first arrived at the relay (relay.seq order, which the
// existing replay-order test pins). A restart is not a history reset (history-recover.ts): a double here is a bug.
import { afterEach, expect, test } from 'bun:test'
import fc from 'fast-check'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { nullLogger } from '../src/log.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
let b2: Bridge | undefined
afterEach(async () => {
  await b2?.stop()
  b2 = undefined
  await h?.stop()
  h = undefined
})

const STALE_MS = 20 * 60_000 // past BACKLOG_AFTER_MS (15 minutes): a replayed message this old is folded into a backlog note

/**
 * Every owner message the session was told about, once per mention, as the id the owner message carries (meta.message_id, the
 * client message id), whatever kind of note carried it: a plain `text` note names it in its meta; a `backlog` note names only its
 * newest in meta, so its other rows are read from their lines and matched to the id by their (unique) text.
 */
function told(x: Harness, idOfText: Map<string, string>): string[] {
  const out: string[] = []
  for (const n of x.notes) {
    if (n.meta.kind === 'text') {
      const text = n.content.split('\n').at(-1) as string
      // the note's own id and its text must agree: the right message, not only some message
      if (idOfText.get(text) !== n.meta.message_id) throw new Error(`note ${n.meta.message_id} carries ${text}`)
      out.push(n.meta.message_id as string)
    } else if (n.meta.kind === 'backlog') {
      for (const m of n.content.matchAll(/\] (m\d+)(?: \(|$)/gm)) out.push(idOfText.get(m[1] as string) as string)
      if (n.meta.message_id !== idOfText.get(n.content.match(/\] (m\d+)(?: \(|$)(?![\s\S]*\] m\d+)/m)?.[1] as string))
        throw new Error('a backlog note names a different newest message in its meta')
    } else if (
      n.meta.kind === 'system' &&
      / may not have been answered: the session on your Mac stopped/.test(n.content)
    ) {
      // the one expected non-delivery note: a stop in the middle of a message tells the owner to send it again (the replay still
      // delivers it once; the exactly-once count below is what judges that)
    } else throw new Error(`an unexpected ${n.meta.kind} note reached the session: ${n.content.slice(0, 80)}`)
  }
  return out
}

/** One copy of a message in the delivery sequence: the original frame again, or the same owner message in a FRESH frame. */
type Copy = { id: number; fresh: boolean }

/** Ids 0..n-1, every id 1..3 times, each copy original or fresh, in any order; the first-occurrence order is the arrival order. */
const scenario = fc.integer({ min: 1, max: 6 }).chain((n) =>
  fc.array(fc.integer({ min: 1, max: 3 }), { minLength: n, maxLength: n }).chain((times) => {
    const copies = times.flatMap((t, id) => Array.from({ length: t }, (_, c) => ({ id, c })))
    const len = copies.length
    return fc.tuple(
      fc.constant(n),
      fc
        .shuffledSubarray(copies, { minLength: len, maxLength: len })
        .chain((seq) => fc.tuple(fc.constant(seq), fc.array(fc.boolean(), { minLength: len, maxLength: len })))
        .map(([seq, fresh]) => seq.map((c, i): Copy => ({ id: c.id, fresh: c.c > 0 && (fresh[i] as boolean) }))),
      fc.integer({ min: 0, max: len }), // the restart point k
      fc.integer({ min: 0, max: len }), // how many of the rest are sent while the bridge is down (the replay burst)
      // after frame i: wait until the bridge has consumed it (true) or keep sending at once (false)
      fc.array(fc.boolean(), { minLength: len, maxLength: len }),
      // message i was received by the relay long ago (its replay goes through the backlog path)
      fc.array(fc.boolean(), { minLength: n, maxLength: n }),
    )
  }),
)

test('exactly-once inbound under a shuffled duplicated replay, fresh re-wraps, stale replays and a restart', async () => {
  await fc.assert(
    fc.asyncProperty(scenario, async ([n, seq, k, down, settle, stale]) => {
      h = await startHarness()
      const x = h
      const now = Date.now()
      const texts = Array.from({ length: n }, (_, i) => `m${i}`)
      const frames: Array<Record<string, unknown>> = []
      for (const t of texts) frames.push(await x.app.buildMessage('general', t))
      const idOfText = new Map(texts.map((t, i) => [t, frames[i]?.client_msg_id as string]))
      // each copy is a frame: the original, or the same owner message (same client_msg_id) re-signed under a fresh frame id
      const wire: Array<Record<string, unknown>> = []
      for (const c of seq)
        wire.push(
          c.fresh
            ? await x.app.buildMessage('general', texts[c.id] as string, { client_msg_id: frames[c.id]?.client_msg_id })
            : (frames[c.id] as Record<string, unknown>),
        )
      // the relay stamps seq in the order frames first reach it
      const seqOf = new Map<string, number>()
      const send = (i: number) => {
        const f = wire[i] as Record<string, unknown>
        if (!seqOf.has(f.id as string)) seqOf.set(f.id as string, seqOf.size + 1)
        const at = stale[(seq[i] as Copy).id] ? now - STALE_MS : now
        x.relay.sendToBridge({
          ...f,
          relay: { seq: seqOf.get(f.id as string), received_at: new Date(at).toISOString() },
        })
      }
      // waits until the relay holds no unconsumed copy of that frame: the bridge handled it and acked it `consumed`
      const consumed = (i: number) =>
        waitFor(() => !x.relay.buffered().some((e) => e.frame.id === wire[i]?.id), 10_000, `copy ${i} to be consumed`)
      for (let i = 0; i < k; i++) {
        send(i)
        if (settle[i]) await consumed(i)
      }
      // restart on the same home and the same relay, not waiting for what is in flight
      await x.bridge.stop()
      Bun.gc(true)
      for (let i = k; i < Math.min(seq.length, k + down); i++) send(i) // sent while the bridge is down: replayed as a burst
      const env = loadEnv({ TALOS_APP_HOME: x.home, TALOS_APP_RELAY_URL: x.relay.httpUrl, TALOS_APP_BRIDGE: '1' })
      const b = await Bridge.create({ env, logger: nullLogger, inbound: { settleMs: 20, maxSettleMs: 200 } })
      b.setEmit(async (note) => {
        x.notes.push(note)
      })
      b2 = b
      b.start()
      await waitFor(() => b.client?.connected === true, 10_000, 'the second bridge to connect')
      for (let i = k + down; i < seq.length; i++) {
        send(i)
        if (settle[i]) await consumed(i)
      }
      const everyone = (): boolean => new Set(told(x, idOfText)).size >= n
      await waitFor(everyone, 10_000, `all ${n} messages`)
      await waitFor(() => x.relay.buffered().length === 0, 10_000, 'the relay buffer to drain')
      await b.inbound?.idle()
      const got = told(x, idOfText)
      // each owner message exactly once, by its message id, whatever the frame id and whatever kind of note carried it
      expect([...got].sort()).toEqual([...idOfText.values()].sort())
      // in the order the frames arrived, unless a stale replay: a backlog is told first, before the rest of its replay, on purpose
      if (!stale.some(Boolean))
        expect(got).toEqual([...new Set(seq.map((c) => c.id))].map((id) => frames[id]?.client_msg_id as string))
      await b.stop()
      b2 = undefined
      await x.stop()
      h = undefined
    }),
    { seed: 20261120, numRuns: 4 },
  )
}, 120_000)
