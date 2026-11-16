// Plan usage from every session on this Mac (the weekly figure went stale while main sat idle and its thread sessions did the
// work). The plan's limits are one pool, but each Claude Code session only learns the pool's figures from its OWN API responses,
// so an idle session's reading freezes. Every session's latest reading is kept with the time it was taken, and the newest one per
// limit kind is what the app and the usage governor see. A reading whose window has reset (its `resets_at` has passed) is dropped.
//
// A thread session (worker) records its reading through its status line: the worker's own `--settings` file sets `statusLine`
// to USAGE_RECORDER_PY (the same text in the Mac's WorkerSpec.swift; swift-parity.test.ts holds them equal), which writes the
// documented `rate_limits` object of the status-line JSON into `workers/<thread>/usage.json` with the time, and prints a short line.
// The bridge reads that file on its poll. Main's reading comes from the Talos mod (`$.session.usage()`), timed by the bridge.
import { type RateLimitT, sessionStateFromStatusline, toIsoTs } from './session.ts'

/** The file a worker's status line writes, beside its settings file (`workers/<thread>/settings.json`). */
export const USAGE_FILE = 'usage.json'
export const workerUsagePath = (talosHome: string, threadId: string) => `${talosHome}/workers/${threadId}/${USAGE_FILE}`
/** A usage file bigger than this is not read (the recorder writes well under 1 KB). */
export const USAGE_FILE_MAX_BYTES = 16 * 1024
/** A reading stamped further ahead of the Mac's clock than this is refused: nothing real is taken in the future. */
export const USAGE_FUTURE_SKEW_MS = 60_000
/** The usage governor treats a reading older than this as no reading (as it treats a missing one: it never blocks). */
export const GOVERNOR_READING_MAX_AGE_MS = 30 * 60_000

/**
 * The status-line program a worker runs (`python3 -I -c <this> <usage file>`). It reads the status-line JSON on stdin, keeps
 * only `rate_limits` (at most six windows, each `used_percentage` and `resets_at` when they are numbers) and the session id,
 * writes them with `at` (epoch seconds) through a temporary file and a rename, and prints "<model> | 7d: N%". It exits 0 on
 * anything, so a bad input leaves the last good file and an empty line. No backslash and no single quote in it: it travels in
 * a single-quoted shell word and in a Swift string literal unchanged.
 */
export const USAGE_RECORDER_PY = `import json, os, sys, time
def main():
    p = sys.argv[1]
    try:
        d = json.loads(sys.stdin.read(1048576) or "{}")
    except Exception:
        d = {}
    if not isinstance(d, dict):
        d = {}
    r = d.get("rate_limits")
    if isinstance(r, dict) and r:
        keep = {}
        for k, w in list(r.items())[:6]:
            if isinstance(k, str) and len(k) <= 24 and isinstance(w, dict):
                keep[k] = {x: w[x] for x in ("used_percentage", "resets_at") if type(w.get(x)) in (int, float)}
        try:
            t = "%s.%d.tmp" % (p, os.getpid())
            with open(t, "w") as f:
                json.dump({"v": 1, "session_id": str(d.get("session_id") or "")[:64], "at": time.time(), "rate_limits": keep}, f)
            os.replace(t, p)
        except Exception:
            pass
    name = ""
    m = d.get("model")
    if isinstance(m, dict) and isinstance(m.get("display_name"), str):
        kept = "".join(c if c.isascii() and (c.isalnum() or c in ".()+-") else " " for c in m["display_name"][:400])
        kept = " ".join(kept.split())
        while kept and not kept[0].isalnum():
            kept = kept[1:]
        name = kept[:8].rstrip(" .")
    if not name:
        print("Talos")
        return
    out = "Talos: " + name
    try:
        n = min(100, max(0, int(round(float(r["seven_day"]["used_percentage"])))))
        out = out + " | 7d: %d%%" % n
    except Exception:
        pass
    print(out)
try:
    main()
except Exception:
    pass`

const shq = (v: string) => `'${v.replaceAll("'", "'\\''")}'`

/**
 * The worker's `statusLine.command`: the recorder run by the python3 its permission hook uses (absolute), in an emptied
 * environment and isolated with -I, so nothing of the session's environment picks what runs. WorkerSpec.swift builds the same.
 */
export const usageRecorderCommand = (python: string, usageFile: string) =>
  `exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=en_US.UTF-8 ${shq(python)} -I -c ${shq(USAGE_RECORDER_PY)} ${shq(usageFile)}`

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export type UsageFileResult = { ok: true; readings: RateLimitT[] } | { ok: false; reason: string }

/**
 * The readings in a worker's usage file. They count only for the session the bridge launched in that thread (`sessionId`, from
 * workers.json): a file left by an earlier session, or naming another, gives none. The time is the earlier of the file's own
 * `at` and its modification time, and one ahead of the clock is refused. The windows are read by the status-line parser, so an
 * odd window loses itself (or its percent), never the others.
 */
export function readingsFromUsageFile(
  raw: unknown,
  o: { sessionId: string; nowMs: number; mtimeMs?: number },
): UsageFileResult {
  if (!isObj(raw)) return { ok: false, reason: 'not an object' }
  const sid = typeof raw.session_id === 'string' ? raw.session_id.toLowerCase() : ''
  if (!sid || sid !== o.sessionId.toLowerCase()) return { ok: false, reason: 'another session' }
  const atIso = toIsoTs(raw.at)
  if (!atIso) return { ok: false, reason: 'no time' }
  let at = Date.parse(atIso)
  if (o.mtimeMs !== undefined && Number.isFinite(o.mtimeMs)) at = Math.min(at, o.mtimeMs)
  if (!Number.isFinite(at) || at > o.nowMs + USAGE_FUTURE_SKEW_MS)
    return { ok: false, reason: 'time ahead of the clock' }
  const asOf = new Date(at).toISOString()
  const parsed = sessionStateFromStatusline({ session_id: sid, rate_limits: raw.rate_limits }, { at: asOf })
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  return { ok: true, readings: parsed.state.rate_limits.map((r) => ({ ...r, as_of: asOf })) }
}

const asOfMs = (r: RateLimitT) => {
  const t = r.as_of === undefined ? Number.NaN : Date.parse(r.as_of)
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY
}

/**
 * The newest reading per limit kind across `sources` (a reading with no time loses to any with one; of two equally new, the
 * higher percent stays, so a duplicate can never lower a figure). A reading whose `resets_at` has passed is dropped first: its window rolled over. With `maxAgeMs`, a timed reading older
 * than that is dropped too (one with no time is kept: its age is not known). At most six kinds, in the order first seen.
 */
export function newestReadings(
  sources: ReadonlyArray<readonly RateLimitT[]>,
  nowMs: number,
  opts: { maxAgeMs?: number } = {},
): RateLimitT[] {
  const best = new Map<string, RateLimitT>()
  for (const list of sources)
    for (const r of list) {
      if (r.resets_at !== undefined) {
        const reset = Date.parse(r.resets_at)
        if (Number.isFinite(reset) && reset <= nowMs) continue
      }
      const t = asOfMs(r)
      if (opts.maxAgeMs !== undefined && t !== Number.NEGATIVE_INFINITY && nowMs - t > opts.maxAgeMs) continue
      const had = best.get(r.kind)
      const ht = had ? asOfMs(had) : Number.NEGATIVE_INFINITY
      if (!had || t > ht || (t === ht && (r.percent ?? -1) > (had.percent ?? -1))) best.set(r.kind, r)
    }
  return [...best.values()].slice(0, 6)
}

/** `readings` without `as_of`, for a relay that does not list USAGE_AS_OF_FEATURE (its app refuses the field). */
export const withoutAsOf = (readings: readonly RateLimitT[]): RateLimitT[] => readings.map(({ as_of: _a, ...r }) => r)
