// Whether a session that can write in an undo point's folder is doing something right now. An undo rewrites that
// folder, so it is refused while any such session is busy, starting, parking or stopping, or has a message routed to it
// that it has not picked up yet: the owner stops it first (Talos never stops it for them). The sessions are found by
// folder, not by thread: main when the point is of main's agent folder (a dedicated thread's message that fell back to
// main included), and every thread worker whose folder is inside the point's root or holds it. A state Talos cannot
// read (no mod connected, a workers.json that is stale or unreadable) is "unknown": the card says so instead of refusing.

import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { leadThreadFor, supervisorFresh, threadSessionMode, type WorkerEntryT } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { WorkersReader } from '../worker/files.ts'
import { WorkerStore } from '../worker/store.ts'
import { workerFolder } from './route-point.ts'
import { inside } from './snapshot.ts'

export type SessionActivity = { state: 'busy'; why: string } | { state: 'idle' } | { state: 'unknown' }

/** Worker states in which its session is doing something, or about to. */
const WORKER_BUSY = new Set(['busy', 'starting', 'parking', 'stopping'])

export const STOP_FIRST = 'Stop the session first'

// for folders only: a file's real path goes through realFileSync (real-file.ts), as realpath can name a hard-linked file by another of its names
/** A folder as the file system names it (links resolved), so folders given different ways compare equal. */
export function realFolder(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    const up = dirname(p)
    return up === p ? resolve(p) : join(realFolder(up), basename(p)) // not there (yet): its nearest real parent
  }
}

/** True when one folder is the other or holds it: a session working in either can write in both. Links resolved. */
export const overlaps = (a: string, b: string) => {
  const ra = realFolder(a)
  const rb = realFolder(b)
  return inside(ra, rb) || inside(rb, ra)
}

/** The sessions that can write in `root`: main, and the thread leads whose folder overlaps it. */
export function sessionsInFolder(ctx: BridgeContext, root: string, thread: string): { main: boolean; leads: string[] } {
  const cfg = ctx.config.config
  const file = new WorkersReader(ctx.paths.home).read()
  const mainFolder = ctx.undo?.mainFolder()
  const main = mainFolder !== undefined && overlaps(mainFolder, root)
  const leads: string[] = []
  for (const t of cfg.threads) {
    if (threadSessionMode(cfg, t.id) !== 'dedicated') continue
    const f = workerFolder(ctx, file, t.id)
    if (f && !(mainFolder && realFolder(f) === realFolder(mainFolder)) && overlaps(f, root)) leads.push(t.id)
  }
  if (main || leads.length) return { main, leads }
  // no folder known to match: the session that answers the point's thread
  const lead = leadThreadFor(cfg, thread)
  return lead ? { main: false, leads: [lead] } : { main: true, leads: [] }
}

export function sessionActivity(ctx: BridgeContext, root: string, thread: string): SessionActivity {
  const { main, leads } = sessionsInFolder(ctx, root, thread)
  const all = [...(main ? [mainActivity(ctx), backgroundJobs(ctx)] : []), ...leads.map((l) => workerActivity(ctx, l))]
  return all.find((a) => a.state === 'busy') ?? all.find((a) => a.state === 'unknown') ?? { state: 'idle' }
}

function mainActivity(ctx: BridgeContext): SessionActivity {
  const st = ctx.mod.liveState()
  // a message handed over a moment ago: busy until a turn has started since and the session is idle again (a message
  // queued behind a running turn is not released by that turn's end, which started before it)
  const handed = ctx.undo?.handOvers.recent(ctx.undo.mainFolder(), ctx.clock.now())
  if (handed && !(st && !st.busy && ctx.mod.turnStarts() > handed.turns))
    return { state: 'busy', why: `${STOP_FIRST}: a message was just handed to the session.` }
  if (!st) return { state: 'unknown' }
  if (st.busy || st.compacting) return { state: 'busy', why: `${STOP_FIRST}: the session is working right now.` }
  return { state: 'idle' }
}

/**
 * Background (headless) scheduled jobs run in the Chronos workspace, main's agent folder, outside any session: read
 * from the schedules state the bridge already keeps, never written. Not known yet: unknown. The one gap left: Chronos
 * can start a new background job while a restore runs (it starts jobs itself, not through the bridge). A restore is
 * short, so this is accepted rather than blocked.
 */
function backgroundJobs(ctx: BridgeContext): SessionActivity {
  const svc = ctx.schedules
  if (!svc) return { state: 'idle' } // no scheduler in this process: no background jobs it could know of
  if (!svc.disc) return { state: 'unknown' } // not looked for yet
  if (svc.disc.state !== 'ready') return { state: 'idle' } // off, not installed, unsupported: no background jobs run
  const snap = svc.lastGood
  if (!snap || svc.problem) return { state: 'unknown' } // ready, but not read, or the last read failed
  if (snap.schedules.some((j) => j.runner !== 'session' && j.today === 'running'))
    return { state: 'busy', why: 'A scheduled job is running in this folder; wait for it to finish.' }
  return { state: 'idle' }
}

function workerActivity(ctx: BridgeContext, lead: string): SessionActivity {
  const file = new WorkersReader(ctx.paths.home).read()
  if (ctx.undo?.handOvers.recent(workerFolder(ctx, file, lead), ctx.clock.now()))
    return { state: 'busy', why: `${STOP_FIRST}: a message was just handed to the thread's session.` }
  // a supervisor that stopped writing, or an entry this build cannot read: its last state may be long gone
  if (!file || !supervisorFresh(file, ctx.clock.now()) || !file.supervisor.workers_supported)
    return { state: 'unknown' }
  if (file.unavailable.includes(lead)) return { state: 'unknown' }
  const entry: WorkerEntryT | undefined = file.threads[lead]
  if (entry && WORKER_BUSY.has(entry.state))
    return { state: 'busy', why: `${STOP_FIRST}: the thread's session is ${entry.state}.` }
  // a message routed to it and not picked up yet: its turn is about to start
  if (new WorkerStore(ctx.store.db).unclaimed(lead).length)
    return { state: 'busy', why: `${STOP_FIRST}: a message is waiting for the thread's session.` }
  return { state: 'idle' }
}

/** A fresh read of the schedules state, when there is a scheduler to read (the refresh loop runs every 30 s). */
export async function refreshSchedules(ctx: BridgeContext): Promise<void> {
  const svc = ctx.schedules
  if (svc?.disc?.state === 'ready') await svc.safeSnapshot().catch(() => undefined)
}

/** How long after a hand-over a session counts as working, whatever it reports: its turn may not show yet. */
export const HAND_OVER_BUSY_MS = 15_000

/** The last hand-over into each folder, and how many turns the main session had started at that moment. */
export class HandOvers {
  private readonly last = new Map<string, { at: number; turns: number }>()

  /** `turns`: the main session's turn starts so far, at the hand-over. */
  note(folder: string | undefined, at: number, turns: number): void {
    if (folder) this.last.set(realFolder(folder), { at, turns })
  }

  recent(folder: string | undefined, now: number): { at: number; turns: number } | undefined {
    if (!folder) return undefined
    const h = this.last.get(realFolder(folder))
    return h && now - h.at < HAND_OVER_BUSY_MS ? h : undefined
  }
}

/**
 * Folders being restored right now. A turn that would start in one of them (a message, a scheduled run, a hand-off)
 * waits until the restore there ends: the router asks before every hand-over (route-point.ts).
 */
export class RestoringRoots {
  private readonly active = new Map<string, Promise<void>>()

  /** Runs `fn` with `root` marked as being restored; the mark goes in a finally, whatever happens. */
  async hold<T>(folder: string, fn: () => Promise<T>): Promise<T> {
    const root = realFolder(folder)
    let done = () => {}
    const p = new Promise<void>((r) => {
      done = r
    })
    // one restore at a time in any folder that overlaps this one (a repo and a copy point inside it); the last check and
    // the mark happen with no await between them, so two holds can never both pass
    for (;;) {
      const busy = this.overlapping(root)
      if (!busy.length) break
      await Promise.all(busy)
    }
    this.active.set(root, p)
    try {
      return await fn()
    } finally {
      this.active.delete(root)
      done()
    }
  }

  /** Resolves once no restore runs in a folder that overlaps `folder`. */
  async waitFor(folder: string | undefined): Promise<void> {
    if (!folder) return
    for (;;) {
      const busy = this.overlapping(folder)
      if (!busy.length) return
      await Promise.all(busy)
    }
  }

  private overlapping(folder: string): Promise<void>[] {
    return [...this.active].filter(([root]) => overlaps(root, folder)).map(([, p]) => p)
  }
}
