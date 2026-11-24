// The bridge's side of the deaf-thread alarm (packages/protocol/src/deaf-thread.ts): it writes what it gave Main because a thread's
// session did not take it (main-handled.json), and it reads which threads the supervisor says cannot be typed into
// (deaf-threads.json) for `workers.status` and `talos-app doctor`. One writer per file; a bad file is no information, never a throw.
import { join } from 'node:path'
import {
  DEAF_FILE_MAX_BYTES,
  DEAF_FILE_MAX_FUTURE_MS,
  DEAF_FILE_STALE_MS,
  DEAF_THREADS_FILE,
  DeafThreadsFile,
  deafMinutes,
  MAIN_HANDLED_FILE,
  MAIN_HANDLED_KEEP_MS,
  MAIN_HANDLED_MAX_BYTES,
  MAIN_HANDLED_MAX_PER_THREAD,
  MainHandledFile,
  type MainHandledFileT,
  type MainHandledKindT,
} from '@talos-app/protocol'
import { type BridgeContext, threadRef } from '../context.ts'
import { writeFileAtomic } from '../fsutil.ts'
import type { Notification } from '../notify.ts'
import { readRegularFile } from '../safe-open.ts'

/** What kind of thing Main was given, by the notification's own kind; undefined for what is not the owner's work (a wake, a handoff). */
export function mainHandledKind(metaKind: string | undefined): MainHandledKindT | undefined {
  if (metaKind === 'schedule_run') return 'run'
  if (metaKind === 'card_action') return 'card'
  if (metaKind === 'text' || metaKind === 'file') return 'message'
  return undefined
}

function readHandled(home: string): MainHandledFileT {
  const buf = readRegularFile(join(home, MAIN_HANDLED_FILE), MAIN_HANDLED_MAX_BYTES)
  if (!buf) return { v: 1, threads: {} }
  try {
    const p = MainHandledFile.safeParse(JSON.parse(buf.toString('utf8')))
    return p.success ? p.data : { v: 1, threads: {} }
  } catch {
    return { v: 1, threads: {} }
  }
}

/**
 * Notes that Main was given something of `thread`'s because its session did not take it. Appended in one synchronous read-write (the
 * bridge is the only writer), so two at once cannot lose one. Returns false when it could not be written: the caller logs it, and the
 * fallback itself goes on (the line that says what Main answered is then short, never a failed hand-over).
 */
export function recordMainHandled(home: string, thread: string, kind: MainHandledKindT, nowMs: number): boolean {
  try {
    const f = readHandled(home)
    f.threads[thread] = [...(f.threads[thread] ?? []), { at: nowMs, kind }]
    // every thread ages out on every write (a thread that stopped being deaf must not keep the file growing), each keeps the newest
    // MAIN_HANDLED_MAX_PER_THREAD, and the file is compact: every thread a week can list stays far under the reader's limit (MAIN_HANDLED_MAX_BYTES, 256 KB)
    for (const [id, list] of Object.entries(f.threads)) {
      const kept = list.filter((e) => nowMs - e.at < MAIN_HANDLED_KEEP_MS).slice(-MAIN_HANDLED_MAX_PER_THREAD)
      if (kept.length) f.threads[id] = kept
      else delete f.threads[id]
    }
    writeFileAtomic(join(home, MAIN_HANDLED_FILE), JSON.stringify(f))
    return true
  } catch {
    return false
  }
}

/** How many of each kind Main handled for `thread` from `sinceMs` on. */
export function mainHandledSince(home: string, thread: string, sinceMs: number): Record<MainHandledKindT, number> {
  const out: Record<MainHandledKindT, number> = { message: 0, run: 0, card: 0 }
  for (const e of readHandled(home).threads[thread] ?? []) if (e.at >= sinceMs) out[e.kind]++
  return out
}

export type DeafThread = { thread: string; since: number; minutes: number; refusals_1h: number }

/**
 * The threads the supervisor says cannot be typed into now. Only while the file is fresh (a stopped app writes nothing, and an old
 * wait must not read as now); any doubt is none.
 */
export function readDeafThreads(home: string, nowMs: number): DeafThread[] {
  const buf = readRegularFile(join(home, DEAF_THREADS_FILE), DEAF_FILE_MAX_BYTES)
  if (!buf) return []
  try {
    const p = DeafThreadsFile.safeParse(JSON.parse(buf.toString('utf8')))
    if (!p.success) return []
    if (p.data.at - nowMs > DEAF_FILE_MAX_FUTURE_MS || nowMs - p.data.at > DEAF_FILE_STALE_MS) return []
    return Object.entries(p.data.threads).map(([thread, v]) => ({
      thread,
      since: v.since,
      minutes: deafMinutes(v.since, nowMs),
      refusals_1h: v.refusals_1h,
    }))
  } catch {
    return []
  }
}

/** `workers.status` items' `deaf` field by thread, for the threads the supervisor lists (only while its file is fresh). */
export function deafStatus(
  home: string,
  nowMs: number,
): Map<string, { deaf: { minutes: number; refusals_1h: number } }> {
  return new Map(
    readDeafThreads(home, nowMs).map((d) => [d.thread, { deaf: { minutes: d.minutes, refusals_1h: d.refusals_1h } }]),
  )
}

/**
 * Main answered something that belonged to `lead`'s own session (a sub-thread's message is its lead's: the lead is the session that
 * could not be reached, and the one the supervisor reads the tally for). `thread` is where the run or message lives, for the mark. Two records, so that nothing about it is silent: the tally the
 * supervisor reads to tell the thread what Main handled while it could not be reached (deaf-thread.ts), and, for a scheduled run, a
 * mark on the run itself ("ran in Main, not in <thread>") that the run history shows. Neither can fail the hand-over, which is done.
 */
export function noteMainHandled(ctx: BridgeContext, n: Notification, lead: string, thread: string): void {
  const kind = mainHandledKind(n.meta.kind)
  if (!kind) return
  if (!recordMainHandled(ctx.paths.home, lead, kind, ctx.clock.now()))
    ctx.log.warn('main-handled tally not written', { thread: lead })
  if (kind !== 'run') return
  try {
    ctx.schedules?.markRanInMain(n.meta.run_id, n.meta.schedule_id, n.meta.ds, thread, threadRef(ctx, thread).name)
  } catch (e) {
    ctx.log.warn('run not marked as ran in Main', { thread, error: (e as Error).message })
  }
}
