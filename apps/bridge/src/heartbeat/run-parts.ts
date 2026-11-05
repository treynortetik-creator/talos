// Small pure parts of a heartbeat run, kept out of runner.ts (which has a size limit).
import {
  HEARTBEAT_ERROR_MAX_CHARS,
  HEARTBEAT_SOURCE_SCHEMA,
  type HeartbeatItemT,
  type HeartbeatResultT,
  type HeartbeatSourceConfigT,
  type HeartbeatSourceItemT,
  type HeartbeatSourceRequestT,
  parseHeartbeatSourceResponse,
} from '@talos-app/protocol'
import type { DigestInput } from './digest.ts'
import type { HeartbeatStore, SourceState } from './store.ts'

/**
 * The run list's one line for a slot that could not start because the earlier wake still holds the claim. It starts "Busy:"
 * because the app reads that word (`/^busy\b/i` in apps/web/src/features/schedules/heartbeat/logic.ts); the run's status is `skipped`.
 */
export const BUSY_SUMMARY = 'Busy: the earlier check-in is still running, so this one did not run'

/** A source failing this many checks in a row is said once, in the thread. */
export const FAIL_STREAK_SAY = 3

export type SrcOut = {
  id: string
  ok: boolean
  ms: number
  unreadable: number
  error?: string
  cursor: Record<string, unknown> | null
  items: HeartbeatSourceItemT[]
}

export const zero = () => ({ silent: 0, fyi: 0, act: 0 })
export const sum = (c: { silent: number; fyi: number; act: number }) => c.silent + c.fyi + c.act

/** Each source's cursor, last good time and failure streak; returns the sources that just hit the "say it once" streak. */
export function updateSources(store: HeartbeatStore, outs: SrcOut[], nowIso: string): DigestInput['failures'] {
  const failures: DigestInput['failures'] = []
  for (const o of outs) {
    const s = store.sources[o.id] ?? { cursor: null, last_ok: null, fail_streak: 0 }
    if (o.ok) {
      s.cursor = o.cursor
      s.last_ok = nowIso
      s.fail_streak = 0
    } else {
      s.fail_streak += 1
      if (s.fail_streak === FAIL_STREAK_SAY)
        failures.push({ id: o.id, error: o.error ?? 'no details', streak: s.fail_streak })
    }
    store.sources[o.id] = s
  }
  return failures
}

export function countsOnly(
  considered: Array<[string, HeartbeatItemT]>,
  outs: SrcOut[],
): Omit<HeartbeatResultT, 'run_key' | 'outcome'> {
  const seenBy = zero()
  for (const [, it] of considered) seenBy[it.level]++
  return {
    items_seen: sum(seenBy),
    items_new: 0,
    seen_by_level: seenBy,
    new_by_level: zero(),
    sources: outs.map((o) => ({
      id: o.id,
      ok: o.ok,
      ms: Math.min(o.ms, 150_000),
      unreadable: o.unreadable,
      ...(o.error !== undefined ? { error: o.error } : {}),
    })),
  }
}

// ---- the owner's test run (docs/HEARTBEAT.md "In the app")

/** What a test run says about one source, beside what the run itself recorded (ok, ms, unreadable, error). */
export type TestSourceCounts = { id: string; read: number; act: number; fyi: number; dropped: number; held: number }
export type TestLine = { source: string; title: string; why: string }
export type TestDetail = { sources: TestSourceCounts[]; would_wake: TestLine[]; would_post: TestLine[]; held: number }
const LINES_MAX = 50

/**
 * `read` = items that parsed; `act` and `fyi` = those that would be offered (not muted, not refused by the work gate);
 * `held` = refused by the work gate; `dropped` = the rest (muted, or silent level). No item words leave except the titles of
 * the offered ones, which are already escaped.
 */
export function testDetail(
  outs: SrcOut[],
  seen: Map<string, HeartbeatItemT>,
  considered: Array<[string, HeartbeatItemT]>,
  heldBy: Record<string, number>,
): TestDetail {
  const line = (t: HeartbeatItemT): TestLine => ({ source: t.source, title: t.title, why: t.why })
  const offered = considered.map(([, t]) => t)
  const sources = outs.map((o) => {
    const read = [...seen.values()].filter((t) => t.source === o.id).length
    const act = offered.filter((t) => t.source === o.id && t.level === 'act').length
    const fyi = offered.filter((t) => t.source === o.id && t.level === 'fyi').length
    const held = heldBy[o.id] ?? 0
    return { id: o.id, read, act, fyi, held, dropped: Math.max(0, read - act - fyi - held) }
  })
  return {
    sources,
    would_wake: offered
      .filter((t) => t.level === 'act')
      .slice(0, LINES_MAX)
      .map(line),
    would_post: offered
      .filter((t) => t.level === 'fyi')
      .slice(0, LINES_MAX)
      .map(line),
    held: sources.reduce((n, s) => n + s.held, 0),
  }
}

/**
 * The cursor a built-in source is given in a test, meaning "from `sinceIso` on" (a saved cursor means "from the last look" and
 * would show a quiet machine nothing). A command source gets `null`, and `since` in its request carries the window.
 */
export function testCursor(cfg: HeartbeatSourceConfigT, sinceIso: string): Record<string, unknown> | null {
  if (cfg.kind === 'github') return { since: sinceIso }
  if (cfg.kind === 'schedule-failures') return { at: Date.parse(sinceIso) }
  if (cfg.kind === 'inbox') return { seen: [] }
  return null
}

/**
 * What a source is asked: its saved cursor and last good time, or (a test, `windowH` set) no cursor and a look-back of that many
 * hours. `cold` = the heartbeat was off too long: every source starts over.
 */
export function sourceRequest(
  cfg: HeartbeatSourceConfigT,
  state: SourceState | undefined,
  nowMs: number,
  dry: boolean,
  cold: boolean,
  windowH?: number,
): HeartbeatSourceRequestT {
  const look = windowH === undefined ? null : new Date(nowMs - windowH * 3600_000).toISOString()
  return {
    schema: HEARTBEAT_SOURCE_SCHEMA,
    now: new Date(nowMs).toISOString(),
    since: look ?? (state?.last_ok && !cold ? state.last_ok : null),
    cursor: look !== null ? testCursor(cfg, look) : cold ? null : (state?.cursor ?? null),
    dry,
  }
}

// ---- moved from runner.ts (its size limit)
export const SUMMARY: Record<HeartbeatResultT['outcome'], (n: number, r: HeartbeatResultT) => string> = {
  silent: () => 'Nothing new',
  fyi: (n) => `${n} ${n === 1 ? 'update' : 'updates'} posted`,
  woke: (n) => `Checked in, ${n} ${n === 1 ? 'item' : 'items'}`,
  capped: () => 'Wake limit reached',
  quiet: () => 'Quiet hours',
  partial: (_n, r) => {
    const bad = r.sources.filter((s) => !s.ok).map((s) => s.id)
    return bad.length ? `Couldn't check ${bad.join(', ')}` : 'Some items could not be read'
  },
  failed: () => 'Check failed',
}

/** An error string, capped and escaped by the same function that reads every source answer. */
export function plainError(s: string): string {
  const r = parseHeartbeatSourceResponse(
    JSON.stringify({
      schema: HEARTBEAT_SOURCE_SCHEMA,
      status: 'error',
      error: s.slice(0, HEARTBEAT_ERROR_MAX_CHARS * 2),
    }),
  )
  return r.ok ? 'the source failed' : r.error
}
