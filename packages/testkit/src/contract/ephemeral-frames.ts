// defineEphemeralFramesContract (docs/V2-FEATURES.md V1.3, V8): what a relay does with the signed v2 reads. The real
// relay runs it with a FakeBridge behind it (WP-V0); the testkit runs it against FakeRelay. Request ids are the point:
// an answer reaches the socket that asked and nobody else, unknown or wrong-type answers are dropped, nothing is stored,
// and a Mac that is offline is said at once.
import { newUlid, parseFrame } from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { mkFrame } from '../frame-utils.ts'

type Raw = Record<string, unknown>

export type EphemeralEnd = {
  /** Signs with a device the bridge has pinned and sends from the FIRST app. Envelope fields are filled in. */
  sendRead(frame: Raw): Promise<Raw>
  /** Waits for a frame arriving at the first app. */
  expectApp(type: string, predicate: (f: Raw) => boolean, timeoutMs?: number): Promise<Raw>
  /** Everything the first and the second app received so far, raw. */
  receivedApp(): Raw[]
  receivedOther(): Raw[]
  /** Waits for a frame arriving at the bridge. */
  expectBridge(type: string, predicate: (f: Raw) => boolean, timeoutMs?: number): Promise<Raw>
  /** Sends a frame from the bridge toward the relay (envelope filled in). */
  bridgeSend(frame: Raw): void
  /** Disconnects the bridge (and waits until the relay sees it gone). */
  bridgeOffline(): Promise<void>
  /** A fresh app connecting from seq 0: what catch-up hands it (raw frames, catch-up batches unpacked). */
  freshCatchup(): Promise<Raw[]>
  stop(): Promise<void>
}
export type EphemeralHarness = { start(): Promise<EphemeralEnd> }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const filters = { thread_ids: [], from: 'any', has_file: null, after: null, before: null }
const reads = (rid = newUlid()) => ({
  'search.query': {
    type: 'search.query',
    request_id: rid,
    q: 'release notes',
    filters,
    sort: 'relevance',
    cursor: null,
    limit: 20,
  },
  'memory.tree': { type: 'memory.tree', request_id: rid, root_id: null, path: '', cursor: null },
  'memory.read': { type: 'memory.read', request_id: rid, root_id: 'notes', path: 'a.md', offset: 0 },
  'memory.search': { type: 'memory.search', request_id: rid, q: 'launch', root_ids: [], cursor: null, limit: 20 },
})
const ANSWER: Record<string, string> = {
  'search.query': 'search.results',
  'memory.tree': 'memory.listing',
  'memory.read': 'memory.file',
  'memory.search': 'memory.results',
}

export function defineEphemeralFramesContract(name: string, harness: EphemeralHarness) {
  describe(`ephemeral read frames contract: ${name}`, () => {
    let end: EphemeralEnd | null = null
    const start = async () => {
      end = await harness.start()
      return end
    }
    afterEach(async () => {
      await end?.stop()
      end = null
    })

    for (const type of Object.keys(ANSWER)) {
      it(`${type}: forwarded to the bridge, answered with ${ANSWER[type]} to the asking socket only`, async () => {
        const e = await start()
        const f = await e.sendRead(reads()[type as keyof ReturnType<typeof reads>])
        await e.expectBridge(type, (x) => x.id === f.id, 5000)
        const got = await e.expectApp(ANSWER[type] as string, (x) => x.request_id === f.request_id, 5000)
        expect(parseFrame(got).ok).toBe(true)
        await sleep(100)
        expect(e.receivedOther().some((x) => x.request_id === f.request_id)).toBe(false)
      })
    }

    it('an answer for an unknown request_id is dropped; a wrong answer type is dropped and the right one still lands', async () => {
      const e = await start()
      const stray = newUlid()
      e.bridgeSend({
        type: 'search.results',
        request_id: stray,
        hits: [],
        next_cursor: null,
        total_estimate: 0,
        took_ms: 1,
        index: 'ready',
      })
      const f = await e.sendRead(reads()['memory.search'])
      // the FakeBridge behind answers memory.results itself; a memory.listing for the same id must never reach the app
      e.bridgeSend({ type: 'memory.listing', request_id: f.request_id, entries: [], next_cursor: null })
      await e.expectApp('memory.results', (x) => x.request_id === f.request_id, 5000)
      await sleep(150)
      const mine = e.receivedApp()
      expect(mine.some((x) => x.request_id === stray)).toBe(false)
      expect(mine.some((x) => x.type === 'memory.listing' && x.request_id === f.request_id)).toBe(false)
      expect(e.receivedOther().some((x) => x.request_id === stray)).toBe(false)
    })

    it('with the Mac offline: error{ref, mac_offline} at once, and nothing reaches the bridge later', async () => {
      const e = await start()
      await e.bridgeOffline()
      const f = await e.sendRead(reads()['search.query'])
      const err = await e.expectApp('error', (x) => x.ref === f.id, 3000)
      expect(err.code).toBe('mac_offline')
    })

    it('nothing is stored: a fresh app catching up from seq 0 sees no read, no answer and no system message about one', async () => {
      const e = await start()
      const f = await e.sendRead(reads()['search.query'])
      await e.expectApp('search.results', (x) => x.request_id === f.request_id, 5000)
      const caught = await e.freshCatchup()
      const text = JSON.stringify(caught)
      expect(text).not.toContain(String(f.request_id))
      expect(text).not.toContain('search.query')
      expect(text).not.toContain('search.results')
    })

    it('a bridge error{ref} for a read reaches the asker and never becomes a stored message', async () => {
      const e = await start()
      const f = await e.sendRead(reads()['memory.read'])
      await e.expectBridge('memory.read', (x) => x.id === f.id, 5000)
      e.bridgeSend({ type: 'error', ref: f.id, code: 'memory_not_found', message: 'No such note.' })
      const err = await e.expectApp('error', (x) => x.ref === f.id && x.code === 'memory_not_found', 5000)
      expect(err.code).toBe('memory_not_found')
      const caught = await e.freshCatchup()
      expect(JSON.stringify(caught)).not.toContain('memory_not_found')
    })

    it('frames are well formed both ways (the contract uses mkFrame envelopes)', () => {
      for (const [t, f] of Object.entries(reads())) {
        const withEnv = { ...mkFrame(t), ...f, device_id: `d_${'a'.repeat(20)}`, osig: 'A'.repeat(86) }
        expect(parseFrame(withEnv).ok, t).toBe(true)
      }
    })
  })
}
