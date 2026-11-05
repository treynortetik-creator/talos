// The Heartbeat test run, as the app sees it (docs/HEARTBEAT.md "In the app"): the frame constants, and a reader for the result
// the Mac sends back. Nothing here runs a source.
//
// The result is READ tolerantly. It comes from a Mac that may be older or newer than this app, so: unknown keys are ignored, a
// source row that does not parse costs that row (and is counted, which means the test cannot pass), and text from outside
// is escaped once for display. Only a result with no usable frame at all (no config hash, no time, no list of sources) is
// refused as a whole, and that is a plain-words problem, never a throw.
//
// A pass is decided HERE, from the rows, not taken from a flag in the frame: every source the config turns on must have
// answered ok with nothing unreadable, and the result must be for the exact config (its hash) the owner is looking at.
import { configHash, type HeartbeatConfigT } from './heartbeat.ts'
import { visibleMetaText } from './schedules.ts'

/** Advertised by a bridge that answers `heartbeat.test`, and by a relay that passes it. The app sends the frame only when both do. */
export const HEARTBEAT_FEATURE = 'heartbeat/1'
/** The windows the sheet offers. The frame accepts any whole number of hours up to HEARTBEAT_TEST_MAX_WINDOW_H. */
export const HEARTBEAT_TEST_WINDOWS_H = [8, 24, 72] as const
export const HEARTBEAT_TEST_MAX_WINDOW_H = 168
/** A test can take 150 s (docs/HEARTBEAT.md): the sheet waits this long for the result, the relay keeps the request this long. */
export const HEARTBEAT_TEST_WAIT_MS = 200_000
/** A pass is good for this long (the bridge keeps `{config_hash, at}`; the sheet forgets it then too). */
export const HEARTBEAT_TEST_VALID_MS = 24 * 3600_000
export const HEARTBEAT_TEST_PER_HOUR = 6
/** The config in a `heartbeat.test` frame: bigger than any real one (meta is 4 KiB), so a runaway frame is refused early. */
export const HEARTBEAT_TEST_CONFIG_MAX_BYTES = 8192

const ESCAPE_TOKEN = /⟦U\+([0-9A-F]{4,6})⟧/g
/** Text that is already escaped stays as it is; anything else is escaped now. */
function shown(s: string, max: number): string {
  const cps = [...s]
  const cut = cps.length > max ? `${cps.slice(0, max).join('')}…` : s
  const rest = cut.replace(ESCAPE_TOKEN, (token, hex: string) => {
    const cp = Number.parseInt(hex, 16)
    return cp <= 0x10ffff && visibleMetaText(String.fromCodePoint(cp)) === token ? '' : token
  })
  return visibleMetaText(rest) === rest ? cut : visibleMetaText(cut)
}

export type HeartbeatTestSource = {
  id: string
  ok: boolean
  ms: number
  /** Items read, and how they sorted. */
  read: number
  act: number
  fyi: number
  dropped: number
  held: number
  /** Items that could not be read. More than 0 means this source did not pass. */
  unreadable: number
  error?: string
}
export type HeartbeatTestLine = { source: string; title: string; why: string }
export type HeartbeatTestResultT = {
  config_hash: string
  at: string
  window_h: number
  with_agent: boolean
  sources: HeartbeatTestSource[]
  /** Source rows this app could not read (a newer Mac, or damage): the test cannot pass while this is above 0. */
  unreadable_rows: number
  would_wake: HeartbeatTestLine[]
  would_post: HeartbeatTestLine[]
  held: number
  est_wakes: number | null
  est_tokens: number | null
  /** The mode the Mac tested. A shadow heartbeat only records, so its would_wake / would_post are empty; null from an older Mac. */
  mode: 'shadow' | 'live' | null
  /** In shadow mode, what live mode WOULD do with what was found; null in live mode and from an older Mac. */
  if_live: {
    would_wake: HeartbeatTestLine[]
    would_post: HeartbeatTestLine[]
    est_wakes: number | null
    est_tokens: number | null
  } | null
  /** The run broke or the pass could not be saved: the test is not a pass whatever the rows say. Null when it ran to the end. */
  error: string | null
}
export type ParsedHeartbeatTest = { ok: true; result: HeartbeatTestResultT } | { ok: false; problem: string }

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x)
const count = (x: unknown): number | null =>
  typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 1_000_000_000 ? x : null
const str = (x: unknown): string | null => (typeof x === 'string' ? x : null)
const SOURCE_ID = /^[a-z0-9-]{2,24}$/
const HASH = /^sha256:[0-9a-f]{64}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function sourceRow(x: unknown): HeartbeatTestSource | null {
  if (!isObj(x)) return null
  const id = str(x.id)
  const ms = count(x.ms)
  const unreadable = count(x.unreadable ?? 0)
  if (id === null || !SOURCE_ID.test(id) || typeof x.ok !== 'boolean' || ms === null || unreadable === null) return null
  const read = count(x.read ?? 0)
  const act = count(x.act ?? 0)
  const fyi = count(x.fyi ?? 0)
  const dropped = count(x.dropped ?? 0)
  const held = count(x.held ?? 0)
  if (read === null || act === null || fyi === null || dropped === null || held === null) return null
  const err = x.error === undefined || x.error === null ? undefined : str(x.error)
  // a failed source without a reason is still a failed source: say so rather than drop the row
  const error = x.ok ? undefined : err ? shown(err, 200) : 'no reason was given'
  return { id, ok: x.ok, ms, read, act, fyi, dropped, held, unreadable, ...(error !== undefined ? { error } : {}) }
}
function lines(x: unknown): HeartbeatTestLine[] {
  if (!Array.isArray(x)) return []
  const out: HeartbeatTestLine[] = []
  for (const l of x.slice(0, 50)) {
    if (!isObj(l)) continue
    const source = str(l.source)
    const title = str(l.title)
    if (source === null || title === null) continue
    out.push({ source: shown(source, 24), title: shown(title, 120), why: shown(str(l.why) ?? '', 60) })
  }
  return out
}

/** The Mac's `result` of a `heartbeat.test_result`, read tolerantly (see the top of this file). Never throws. */
export function parseHeartbeatTestResult(raw: unknown): ParsedHeartbeatTest {
  if (!isObj(raw)) return { ok: false, problem: 'The test result was not readable.' }
  const hash = str(raw.config_hash)
  const at = str(raw.at)
  const windowH = count(raw.window_h)
  if (
    hash === null ||
    !HASH.test(hash) ||
    at === null ||
    !ISO.test(at) ||
    Number.isNaN(Date.parse(at)) ||
    windowH === null
  )
    return { ok: false, problem: 'The test result was not readable. Update Talos on your Mac, then try again.' }
  if (!Array.isArray(raw.sources)) return { ok: false, problem: 'The test result had no sources in it.' }
  const sources: HeartbeatTestSource[] = []
  let unreadable_rows = 0
  const seen = new Set<string>()
  for (const r of raw.sources.slice(0, 24)) {
    const row = sourceRow(r)
    // a row that does not parse, or names a source twice, is counted: the test cannot pass on it
    if (row && !seen.has(row.id)) {
      seen.add(row.id)
      sources.push(row)
    } else unreadable_rows++
  }
  if (raw.sources.length > 24) unreadable_rows += raw.sources.length - 24
  const live = isObj(raw.if_live)
    ? {
        would_wake: lines(raw.if_live.would_wake),
        would_post: lines(raw.if_live.would_post),
        est_wakes: count(raw.if_live.est_wakes),
        est_tokens: count(raw.if_live.est_tokens),
      }
    : null
  return {
    ok: true,
    result: {
      mode: raw.mode === 'shadow' || raw.mode === 'live' ? raw.mode : null,
      if_live: live,
      error: typeof raw.error === 'string' && raw.error !== '' ? shown(raw.error, 200) : null,
      config_hash: hash,
      at,
      window_h: windowH,
      with_agent: raw.with_agent === true,
      sources,
      unreadable_rows,
      would_wake: lines(raw.would_wake),
      would_post: lines(raw.would_post),
      held: count(raw.held) ?? 0,
      est_wakes: count(raw.est_wakes),
      est_tokens: count(raw.est_tokens),
    },
  }
}

/**
 * True only when `result` is for exactly this config, no row was unreadable, and every source the config turns on answered ok
 * with nothing unreadable. Zero items is a pass. A source the result does not mention is not a pass. A result older than 24 h
 * (by `nowMs`) is not a pass.
 */
export function heartbeatTestPassed(result: HeartbeatTestResultT, config: HeartbeatConfigT, nowMs: number): boolean {
  if (result.config_hash !== configHash(config)) return false
  const age = nowMs - Date.parse(result.at)
  if (!Number.isFinite(age) || age > HEARTBEAT_TEST_VALID_MS || age < -5 * 60_000) return false
  if (result.unreadable_rows > 0 || result.error) return false
  const on = config.sources.filter((s) => s.enabled)
  if (on.length === 0) return false
  return on.every((s) => {
    const row = result.sources.find((r) => r.id === s.id)
    return row?.ok === true && row.unreadable === 0 && row.error === undefined
  })
}
