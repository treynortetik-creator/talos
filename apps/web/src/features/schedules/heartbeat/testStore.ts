// What the app knows about Heartbeat tests, per client and per config hash. A test is bound to the exact config it ran for:
// "Turn on" asks `passed()`, which re-checks the hash and the age every time it is read. Kept in memory, per client, so a
// signed-out or replaced client starts with nothing passed.
import {
  type HeartbeatConfigT,
  type HeartbeatTestResultT,
  heartbeatTestPassed,
  parseHeartbeatTestResult,
} from '@talos-app/protocol'
import { useSyncExternalStore } from 'react'
import { type TalosClient, TalosClientError, useTalosClient } from '../../../lib/client.ts'

/**
 * What is known for one config hash. `result` is the last REAL result the Mac sent for it; a test that could not run or came
 * back unreadable (`failure` with no result, or `retest` beside one) never replaces it, so a good pass survives a dropped
 * connection, a rate limit or a silent Mac. Only a real result, passing or not, takes its place.
 */
export type TestEntry = {
  running: boolean
  windowH: number
  result?: HeartbeatTestResultT
  /** The test could not run and there is no result at all. */
  failure?: string
  /** A later test could not run; `result` is still the one before it. */
  retest?: string
}

class Store {
  private entries = new Map<string, TestEntry>()
  private subs = new Set<() => void>()
  /** Hashes with a test in flight: a second tap while one runs is ignored (one winner). */
  private flight = new Set<string>()
  get = (hash: string) => this.entries.get(hash)
  subscribe = (cb: () => void) => {
    this.subs.add(cb)
    return () => this.subs.delete(cb)
  }
  set(hash: string, e: TestEntry | null) {
    // a new Map identity is not needed: the snapshot is the entry itself
    if (e) this.entries.set(hash, e)
    else this.entries.delete(hash)
    for (const s of this.subs) s()
  }
  begin(hash: string): boolean {
    if (this.flight.has(hash)) return false
    this.flight.add(hash)
    return true
  }
  end(hash: string) {
    this.flight.delete(hash)
  }
}

const stores = new WeakMap<TalosClient, Store>()
const storeOf = (c: TalosClient) => {
  const have = stores.get(c)
  if (have) return have
  const s = new Store()
  stores.set(c, s)
  return s
}

/** Words for a test that did not come back. */
export function testFailureWords(e: unknown): string {
  const code = (e as { code?: string } | null)?.code
  const msg = (e as Error | null)?.message
  if (code === 'mac_offline') return 'Your Mac is offline. Try again when it is back.'
  if (code === 'rate_limited') return msg || 'Too many tests. Try again later.'
  if (code === 'internal' || msg === 'no_answer')
    return "Your Mac didn't answer. The test may still be running; try again in a minute."
  if (e instanceof TalosClientError && msg) return msg
  return 'The test could not run.'
}

export function useHeartbeatTest(hash: string | null) {
  const client = useTalosClient()
  const store = storeOf(client)
  const entry = useSyncExternalStore(
    store.subscribe,
    () => (hash ? store.get(hash) : undefined),
    () => undefined,
  )
  const run = async (config: HeartbeatConfigT, opts: { windowH: number; withAgent: boolean }) => {
    if (!hash || !store.begin(hash)) return
    const prev = store.get(hash)?.result
    const running: TestEntry = { running: true, windowH: opts.windowH, ...(prev ? { result: prev } : {}) }
    store.set(hash, running)
    const couldNot = (message: string): TestEntry =>
      prev
        ? { running: false, windowH: opts.windowH, result: prev, retest: message }
        : { running: false, windowH: opts.windowH, failure: message }
    try {
      const raw = await client.schedules.testHeartbeat(config, opts)
      const parsed = parseHeartbeatTestResult(raw)
      store.set(
        hash,
        parsed.ok ? { running: false, windowH: opts.windowH, result: parsed.result } : couldNot(parsed.problem),
      )
    } catch (e) {
      store.set(hash, couldNot(testFailureWords(e)))
    } finally {
      store.end(hash)
    }
  }
  /** True only for a result that is for this exact config, fresh, with every enabled source ok. */
  const passed = (config: HeartbeatConfigT, nowMs: number) =>
    entry?.result !== undefined && heartbeatTestPassed(entry.result, config, nowMs)
  return { entry, run, passed }
}
