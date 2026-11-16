// What the app's status line needs from one thread's workers.json entry (the fields the supervisor writes for "status that
// tells the truth"), shaped for `workers.status`. The same entry feeds Main's `thread_session status` tool, so the two agree.
import { join } from 'node:path'
import {
  type Host,
  MAIN_RESTART_CHECK_FILE,
  MAIN_RESTART_CHECK_MAX_BYTES,
  MAIN_RESTART_CHECK_MAX_FUTURE_MS,
  MAIN_RESTART_CHECK_STALE_MS,
  MainRestartCheckFile,
  NEEDS_YOU_MAC_PLACE,
  NEEDS_YOU_OTHER_PROMPT,
  needsYouStep,
  type StatusNeedsYouT,
  WORKER_NEEDS_YOU_KINDS,
  type WorkerEntryT,
  type WorkerNeedsYouT,
  type WorkerStatusItemT,
} from '@talos-app/protocol'
import { machineName } from '../owner-words.ts'
import { ownerHost } from '../platform.ts'
import { readRegularFile } from '../safe-open.ts'

const HOUR_MS = 60 * 60_000
const KNOWN: ReadonlySet<string> = new Set(WORKER_NEEDS_YOU_KINDS)

type Line = Pick<WorkerStatusItemT, 'needs_you' | 'stopped_why' | 'started_at' | 'turn_started_at' | 'restarts_1h'>

export function statusLine(e: WorkerEntryT, now: number): Line {
  const out: Line = {}
  if (e.needs_you) out.needs_you = statusNeedsYou(e.needs_you)
  if (e.stopped_why) out.stopped_why = e.stopped_why
  if (e.started_at) out.started_at = e.started_at
  if (e.turn_started_at) out.turn_started_at = e.turn_started_at
  const recent = e.restarts.filter((t) => {
    const at = Date.parse(t)
    return Number.isFinite(at) && at <= now && now - at <= HOUR_MS
  }).length
  if (recent > 0) out.restarts_1h = Math.min(recent, 10)
  return out
}

/**
 * Where the owner does a needs-you step, in this platform's words (needsYouStep's place): the Mac's own on a Mac, this computer's
 * name elsewhere (as the Linux thread notices name it: "attach on <machine>").
 */
export const ownerPlace = (host: Host = ownerHost(), machine: string = machineName()): string =>
  host === 'mac' ? NEEDS_YOU_MAC_PLACE : host === 'windows' ? 'on the PC' : `on ${machine}`

/**
 * What a session waits on, for the phone. Only a known prompt's name goes: any other kind is a screen's own title, which can
 * name a file, so it reads "a prompt" and the title stays here (Main's status tool still says it).
 */
export function statusNeedsYou(n: WorkerNeedsYouT, place: string = ownerPlace()): StatusNeedsYouT {
  const step = needsYouStep(n.kind, place)
  return {
    kind: KNOWN.has(n.kind) ? n.kind : NEEDS_YOU_OTHER_PROMPT,
    since: n.since,
    ...(step ? { step } : {}),
    ...(n.resets_at ? { resets_at: n.resets_at } : {}),
  }
}

/**
 * Main's own wait, from the Mac app's main-restart-check.json: its `needs_you`, only while the file is fresh (a stopped app
 * writes nothing, and an old wait must not read as now). Never throws: any doubt is none.
 */
export function mainNeedsYou(home: string, now: number): StatusNeedsYouT | undefined {
  const buf = readRegularFile(join(home, MAIN_RESTART_CHECK_FILE), MAIN_RESTART_CHECK_MAX_BYTES)
  if (!buf) return undefined
  try {
    const p = MainRestartCheckFile.safeParse(JSON.parse(buf.toString('utf8')))
    if (!p.success || !p.data.needs_you) return undefined
    const at = Date.parse(p.data.at)
    if (!Number.isFinite(at) || at - now > MAIN_RESTART_CHECK_MAX_FUTURE_MS || now - at > MAIN_RESTART_CHECK_STALE_MS)
      return undefined
    return statusNeedsYou(p.data.needs_you)
  } catch {
    return undefined
  }
}
