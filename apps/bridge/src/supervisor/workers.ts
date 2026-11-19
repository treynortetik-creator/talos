// Thread sessions ("workers", docs/OPTION-C.md; the Mac's WorkerManager), the cross-platform core (P3d2). One tmux session per
// dedicated thread, started on request or by the hub's wake file, live once the hub has written its ready file after a verified
// hello, parked when it ends (its session id kept, so the next start resumes it). Every move is one WORKER_TRANSITIONS allows.
// Serial like MainSupervisor: every entry point runs on one queue. What the pane says to the owner (a dialog, a prompt, a held
// pointer) is worker-notices.ts, a dialog offered as a card and answered by a tap is worker-dialogs.ts; this file is the wiring.
// A quiet session is parked after its thread's idle time (worker-idle.ts), at most max_live run at once (worker-cap.ts), and the
// governor's park waits for the turn to end; worker-slots.ts applies those rules here. Its types are worker-types.ts.

import { readFileSync } from 'node:fs'
import type { PtyExit, WakeFileT } from '@talos-app/protocol'
import {
  parseWorkersFile,
  WORKER_LIVE_STATES,
  WORKER_TIMING,
  type WorkerEntryT,
  type WorkerFailureT,
  type WorkerStateT,
} from '@talos-app/protocol'
import { workersJsonPath } from '../worker/files.ts'
import { detectPrompt } from './dialog-reader.ts'
import { auditPointerLook } from './enter-check.ts'
import { NOTHING_OWED, owe, persisted, restored, typeOwedPointer, wakeTooOld } from './owed-pointer.ts'
import { liveDialog, type Screen } from './screen.ts'
import { UpdateRestarts } from './update-restart.ts'
import { USAGE_LIMIT_KIND } from './usage-limit.ts'
import { WakeReader } from './wake-reader.ts'
import { declinedTrustText, newOfferState, type OfferTarget, WorkerDialogs } from './worker-dialogs.ts'
import { activeNow, monoOf, NEW_BUSY_WATCH, noteScreen, seedLastActive } from './worker-idle.ts'
import {
  folderMoved,
  folderOf,
  inOneFamily,
  lastFolder,
  launchCheck,
  launchedRecord,
  NO_CHANGE_PENDING,
  refusedSubCheck,
  stuck,
  subFenceProblem,
  unread,
  wantedFolder,
} from './worker-launch.ts'
import { newNoticeRuntime, promptName, stateAfterSignin, WorkerNotices } from './worker-notices.ts'
import { type CeilingAxis, folderKey, subThreadCheck } from './worker-policy.ts'
import { WorkerSlots } from './worker-slots.ts'
import * as status from './worker-status.ts'
import type { WorkerDeps, WorkerHost, WorkerRuntime, WorkerThread } from './worker-types.ts'
import {
  adoptedEnd,
  buildWorkersFile,
  clearReady,
  crashLooping,
  legalMove,
  newNonce,
  readReady,
  releaseWorkerFiles,
  restartAfter,
  writeNonce,
  writeWorkersFile,
} from './workers-file.ts'

export type { WorkerDeps, WorkerHost, WorkerPlan, WorkerRuntime, WorkerThread } from './worker-types.ts'

const PUBLISH_EVERY_S = 5

export class WorkerManager {
  private queue: Promise<void> = Promise.resolve()
  readonly workers = new Map<string, WorkerRuntime>() // read by update-restart.ts, as are known, d, slots and dirty
  known: WorkerThread[] = []
  dirty = true
  private lastPublish = Number.NEGATIVE_INFINITY
  private halted = false
  /** The last supervisor's workers.json, read once; the sessions it had running, until each is adopted or found gone. */
  private adoptPending: Map<string, WorkerEntryT> | null = null
  private needsPublished = '' // `needs_you` as last published (worker-status.ts needsYouSignature)
  /** This supervisor's own fields per thread, as the last supervisor's workers.json had them (read once, at adoption). */
  private rawPrev: Record<
    string,
    {
      pointer_owed_until?: unknown
      enter_owed?: unknown
      turn_wait_until?: unknown
      turn_wait_end?: unknown
      turn_wait_why?: unknown
      turn_wait_after?: unknown
    }
  > = {}
  /** A good thread list was read at least once: until then nothing is stopped for not being dedicated. */
  private haveList = false
  /** The last workers.json was there but unreadable: nothing starts and nothing is written over it (the owner looks first). */
  private frozen = false

  private readonly notices: WorkerNotices
  private readonly wakes: WakeReader
  readonly slots: WorkerSlots
  private readonly updates = new UpdateRestarts(this) // restart-on-update (update-restart.ts)
  private readonly dialogs: WorkerDialogs

  constructor(readonly d: WorkerDeps) {
    this.slots = new WorkerSlots({
      workers: () => this.workers.values(),
      get: (id) => this.workers.get(id),
      thread: (id) => this.known.find((t) => t.id === id),
      pending: (id) => this.adoptPending?.has(id) === true,
      now: () => d.now(),
      wallMs: () => d.wallMs(),
      audit: (e, f) => d.audit(e, f),
      beginEnd: (id, endAs, why) => this.beginEnd(id, endAs, why),
      startNow: (id, opts) => this.startNow(id, opts),
      move: (w, to) => this.move(w, to),
      lookAt: (w) => this.lookAt(w),
      changed: () => {
        this.dirty = true
      },
      turnCut: (w, why) => this.notices.turnCut(w.id, w.notes, why),
      backgroundCut: (w, text) => this.notices.backgroundCut(w.id, w.notes, text),
      procs: d,
    })
    this.dialogs = new WorkerDialogs({
      home: d.home,
      now: () => d.now(),
      wallMs: () => d.wallMs(),
      audit: (e, f) => d.audit(e, f),
      pinnedKey: (id) => d.pinnedKey?.(id),
      ...(d.sleep ? { sleep: d.sleep } : {}),
    })
    this.wakes = new WakeReader({ home: d.home, audit: d.audit, wallMs: d.wallMs, post: (t, x) => d.post?.(t, x) })
    this.notices = new WorkerNotices({
      lineWaits: (id) => {
        const w = this.workers.get(id)
        return w ? this.dialogs.lineWaits(this.offerTarget(w)) : false
      },
      home: d.home,
      post: d.post ?? (async () => 'sent'),
      threadName: (id) => this.known.find((t) => t.id === id)?.name ?? id,
      where: (id) =>
        d.where?.(id) ?? {
          attach: `talos-app supervise attach ${id}`,
          restart: `talos-app supervise restart-thread ${id}`,
          machine: 'this computer',
        },
      now: () => d.now(),
      wallS: () => d.wallMs() / 1000,
      audit: (e, f) => d.audit(e, f),
    })
  }

  /** Every notice posted so far has been answered (tests). */
  noticesSettled(): Promise<void> {
    return this.notices.settled()
  }

  private serial(f: () => Promise<void>): Promise<void> {
    const run = this.queue.then(f, f)
    this.queue = run.catch((e) => this.d.audit('worker_error', { error: String((e as Error)?.message ?? e) }))
    return run
  }

  /** The state of one thread's session ('off' when it has none). */
  state(threadId: string): WorkerStateT {
    return this.workers.get(threadId)?.entry.state ?? 'off'
  }

  entry(threadId: string): WorkerEntryT | undefined {
    return this.workers.get(threadId)?.entry
  }

  /** Process groups that are ours (the takeover check must not count them as another session). */
  ownedPgids(): number[] {
    // only pids a host started or adopted after checking them, never a value read back from a file
    return [...this.workers.values()]
      .filter((w) => !this.adoptPending?.has(w.id))
      .map((w) => w.host?.childPid() ?? null)
      .filter((p): p is number => p !== null && p > 0)
  }

  start(threadId: string, opts: { fresh?: boolean } = {}): Promise<void> {
    return this.serial(async () => this.startNow(threadId, opts))
  }

  park(threadId: string, why: 'idle' | 'cap' | 'owner' | 'crash' = 'owner'): Promise<void> {
    return this.serial(async () => this.beginEnd(threadId, 'parked', why))
  }

  stop(threadId: string): Promise<void> {
    return this.serial(async () => this.beginEnd(threadId, 'off', 'owner'))
  }

  restart(threadId: string, opts: { fresh?: boolean } = {}): Promise<void> {
    return this.serial(async () => {
      const w = this.workers.get(threadId)
      const s = w?.entry.state ?? 'off'
      if (s === 'live' || s === 'busy' || s === 'starting') {
        if (w) w.afterPark = { fresh: Boolean(opts.fresh) }
        this.beginEnd(threadId, 'parked', 'restart')
      } else if ((s === 'parking' || s === 'stopping') && w) this.slots.queueAfterPark(w, Boolean(opts.fresh))
      else await this.startNow(threadId, opts)
    })
  }

  /** The 1 s heartbeat: config, wakes, each worker's timers, workers.json. */
  tick(): Promise<void> {
    return this.serial(async () => {
      if (this.halted) return
      this.d.loginEnv.refreshIfDue()
      const threads = this.d.threads()
      if (threads) {
        this.known = threads
        this.slots.maxLive = this.d.maxLive?.() ?? this.slots.maxLive
        this.haveList = true
      }
      await this.adopt()
      if (this.frozen) return
      const pending = (id: string) => this.adoptPending?.has(id) === true
      await this.reviveOwed(pending)
      for (const t of this.known) {
        if (pending(t.id)) continue // a wake waits until the session is adopted or found gone
        const act = (w: WakeFileT) => this.onWake(t.id, w.action, Date.parse(w.at), w.reason)
        await this.wakes.take(t.id, () => this.workers.get(t.id), act) // wake-reader.ts decides, has it done, says what was
      }
      // a thread no longer dedicated (or gone from config.json) has its session stopped; never before one good list was read
      if (this.haveList)
        for (const w of this.workers.values())
          if (
            !pending(w.id) &&
            !this.known.some((t) => t.id === w.id) &&
            (w.entry.state === 'live' || w.entry.state === 'busy' || w.turnWait)
          ) {
            // as the Mac: after its turn (an owner's switch: the owner's stop limit), never a running tool killed mid-turn
            if (w.turnWait) {
              w.endAs = 'off'
              this.dirty = true
            } else this.slots.requestPark(w, 'switched_off', true, 'off')
          }
      this.slots.noteClock(this.d.wallMs(), this.d.now()) // a wall clock that jumped never makes a session look idle
      if (this.d.mainNarrowed?.()) this.slots.parkRunning('main_narrowed') // Main narrowed beyond its sessions' reach
      for (const w of this.workers.values()) if (!pending(w.id)) await this.advance(w)
      await this.slots.retryHeld()
      await this.slots.enforceCap()
      this.checkLaunchChanges(pending)
      await this.updates.tick(pending) // after the sessions advanced, before workers.json is written
      this.publishIfDue()
    })
  }

  /** Stops ticking and lets every session run on (the next supervisor adopts them). */
  detach(): Promise<void> {
    return this.serial(async () => {
      this.halted = true
      for (const w of this.workers.values()) w.host?.detach()
    })
  }

  // ---- adoption: the sessions a supervisor before this one left running -----------------------------------------------

  /**
   * On the first tick the last supervisor's workers.json is read back. A resting entry is kept as it was (its session id is
   * the next resume). A running one is probed: the same pid still running in its pane is adopted, a pane that is gone or dead
   * is parked, and a probe that could not tell stays pending and is asked again next tick (never acted on a guess).
   */
  private async adopt(): Promise<void> {
    if (this.adoptPending === null) {
      this.adoptPending = new Map()
      let prev: ReturnType<typeof parseWorkersFile> = null
      let text: string | null = null
      try {
        text = readFileSync(workersJsonPath(this.d.home), 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') text = ''
      }
      if (text !== null) {
        prev = parseWorkersFile(text)
        if (!prev) {
          // there but unreadable (torn, a newer schema): its session ids and running panes are not lost by a guess
          this.frozen = true
          this.d.audit('workers_file_unreadable', { path: workersJsonPath(this.d.home) })
          return
        }
      }
      let rawThreads: typeof this.rawPrev = {}
      try {
        rawThreads = (JSON.parse(text ?? '{}') as { threads?: typeof rawThreads }).threads ?? {}
      } catch {
        rawThreads = {}
      }
      this.rawPrev = rawThreads
      for (const [id, e] of Object.entries(prev?.threads ?? {})) {
        if (this.workers.has(id)) continue
        const resting = e.state === 'off' || e.state === 'parked' || e.state === 'failed'
        this.workers.set(id, this.blank(id, resting ? { ...e, pane_pid: 0 } : e))
        // this supervisor's own fields (the owed pointer) are not in the shared schema: read from the raw file
        const w0 = this.workers.get(id)
        if (w0) w0.owed = restored(rawThreads[id] ?? {})
        if (!resting) this.adoptPending.set(id, e)
      }
    }
    for (const [id, e] of [...this.adoptPending]) {
      const w = this.workers.get(id)
      if (!w) {
        this.adoptPending.delete(id)
        continue
      }
      const host = w.host ?? this.d.hostFor(id)
      w.host = host
      const p = await host.probe()
      if (p.kind === 'unknown') continue
      this.adoptPending.delete(id)
      if (p.kind === 'running' && p.pid === e.pane_pid && (await host.attachIfRunning(e.tmux)) === p.pid) {
        host.onExit((exit) => void this.serial(async () => this.onExit(w, p.pid, exit)))
        w.startedAt = this.d.now() // a start still waiting for its ready gets a full ready_s from here
        // the idle clock carries on from the file (a restart buys no idle time); the pane's output time as it is now is seen, not
        // a change, so a worker quiet before the restart is not busy for a window after it
        const seeded = seedLastActive({
          saved: e.last_active_at,
          lastTurn: e.last_turn_at,
          started: e.started_at,
          nowMs: this.d.wallMs(),
        })
        w.idle = { lastActiveMs: seeded, activeMono: monoOf(seeded, this.d.wallMs(), this.d.now()), body: null }
        w.busyWatch = { seen: await host.lastOutputAt(), changedAt: null }
        w.turnSeenBusy = Boolean(e.turn_started_at) // a turn the last supervisor saw begin: quiet now ends it
        this.d.audit('worker_adopted', { thread: id, pid: String(p.pid), state: e.state })
        const s = w.entry.state
        if (s === 'stopping') {
          // a wait for the turn to end that the last supervisor left: carried on to its own deadline (from the file, never later
          // than turn_wait_cap_s from now), then the turn is cut. Never TERM at once, and never without a limit.
          const raw = this.rawPrev[id] ?? {}
          const until = typeof raw.turn_wait_until === 'string' ? Date.parse(raw.turn_wait_until) : Number.NaN
          if (Number.isFinite(until)) {
            const left = (until - this.d.wallMs()) / 1000
            const why = typeof raw.turn_wait_why === 'string' ? raw.turn_wait_why.slice(0, 40) : 'adopted'
            w.turnWait = { why, deadline: this.d.now() + Math.max(0, Math.min(left, WORKER_TIMING.turn_wait_cap_s)) }
            w.endAs = raw.turn_wait_end === 'parked' ? 'parked' : 'off'
            w.afterPark = restartAfter(raw) // a restart waiting on this turn still runs once it is parked
          } else {
            // a stop with no wait for a turn (the owner's own): as it was, TERM, then KILL after park_grace_s
            w.endAs = 'off'
            w.parkAt = this.d.now()
            if (!host.signal('SIGTERM')) w.killed = true
          }
        } else if (s === 'parking') {
          w.endAs = adoptedEnd(s, this.rawPrev[id] ?? {}) // the owner's stop during the park ends off, as here
          w.afterPark = restartAfter(this.rawPrev[id] ?? {}) // a restart waiting on this park runs once parked
          w.parkAt = this.d.now()
          if (!host.signal('SIGTERM')) w.killed = true
        }
        continue
      }
      // not there (or another process in its pane): what it was doing is over; its session id is kept for a resume
      releaseWorkerFiles(this.d.home, id)
      if (p.kind === 'running') await host.close() // a pane whose pid is not the one recorded is not ours to keep
      // by the state machine's own moves: starting/live/busy -> parking -> parked, stopping -> parked
      if (!legalMove(w.entry.state, 'parked')) this.move(w, 'parking')
      this.move(w, 'parked')
      // a session the owner was stopping ends off, not parked: parked, the next message would start it again
      const ownerStop =
        (e.state === 'stopping' || e.state === 'parking') && adoptedEnd(e.state, this.rawPrev[id] ?? {}) === 'off'
      w.entry = { ...w.entry, pane_pid: 0, parked_at: new Date(this.d.wallMs()).toISOString() }
      w.entry = status.adoptedGone(w.entry, e) // mid-turn or on its way out: interrupted (the Mac's WorkerAdopt)
      this.paneGone(w)
      this.dirty = true
      if (ownerStop) this.move(w, 'off')
      this.d.audit('worker_adopt_parked', { thread: id, found: p.kind })
      // a restart the last supervisor was waiting to run once this session ended: the session has ended, so it is asked for now,
      // as a held start (retryHeld asks again each tick: a supervisor just started may not have its login environment yet)
      const raw = this.rawPrev[id] ?? {}
      const ending = e.state === 'stopping' || e.state === 'parking'
      const after = ending && raw.turn_wait_end !== 'off' ? restartAfter(raw) : null
      if (after) w.held = { since: this.d.now(), fresh: after.fresh, victim: null, forPointer: false }
    }
  }

  // ---- the moves -------------------------------------------------------------------------------------------------------

  private move(w: WorkerRuntime, to: WorkerStateT): boolean {
    if (w.entry.state === to) return true
    if (!legalMove(w.entry.state, to)) {
      this.d.audit('worker_bug', { thread: w.id, from: w.entry.state, to })
      return false
    }
    w.entry = { ...w.entry, state: to }
    if (to === 'live') w.offer.declinedTrust = false // a session that runs was not ended by a "No"
    this.dirty = true
    return true
  }

  private blank(id: string, entry: WorkerEntryT): WorkerRuntime {
    return {
      id,
      entry,
      host: null,
      startedAt: null,
      parkAt: null,
      killed: false,
      afterPark: null,
      endAs: null,
      baseEnv: null,
      owed: NOTHING_OWED,
      notes: newNoticeRuntime(),
      offer: newOfferState(),
      idle: { lastActiveMs: 0, activeMono: 0, body: null },
      busyWatch: NEW_BUSY_WATCH,
      rows: null,
      held: null,
      turnWait: null,
      launchChange: NO_CHANGE_PENDING,
    }
  }

  private worker(t: WorkerThread): WorkerRuntime {
    let w = this.workers.get(t.id)
    if (!w) {
      w = this.blank(t.id, {
        state: 'off',
        session_id: null,
        previous_ids: [],
        tmux: `t-${t.id}`,
        pane_pid: 0,
        cwd: t.cwd,
        model: t.model,
        started_at: null,
        last_turn_at: null,
        parked_at: null,
        restarts: [],
        error: null,
      })
      this.workers.set(t.id, w)
    }
    return w
  }

  private fail(w: WorkerRuntime, code: WorkerFailureT, detail: string, axis?: CeilingAxis): void {
    // a start refused before anything ran is still a start that failed: off/parked -> starting -> failed, as the state machine
    // has it; a worker that is failed already only gets the new reason
    if (w.entry.state !== 'failed' && !legalMove(w.entry.state, 'failed') && legalMove(w.entry.state, 'starting'))
      this.move(w, 'starting')
    w.held = null
    if (w.entry.state !== 'failed' && !this.move(w, 'failed')) return
    w.entry = {
      ...w.entry,
      pane_pid: 0,
      error: {
        code,
        detail: detail.slice(0, 300),
        at: new Date(this.d.wallMs()).toISOString(),
        ...(code === 'mode_escalation_denied' && axis ? { axis } : {}),
      },
    }
    this.d.audit('worker_failed', { thread: w.id, code, ...(axis ? { axis } : {}) })
  }

  /** `forPointer`: asked for only to type an owed pointer (a hold for it goes with the pointer). */
  private async startNow(threadId: string, opts: { fresh?: boolean; forPointer?: boolean }): Promise<void> {
    if (this.frozen)
      return this.d.audit('worker_start_refused', { thread: threadId, why: 'workers.json is unreadable' })
    if (this.adoptPending?.has(threadId)) return // its old session is still being looked for
    const t = this.known.find((x) => x.id === threadId)
    if (!t) return this.d.audit('worker_start_refused', { thread: threadId, why: 'not a dedicated thread' })
    const w = this.worker(t)
    const s = w.entry.state
    if (s !== 'off' && s !== 'parked' && s !== 'failed') return // starting, live or on its way down: nothing to do
    // a sub-thread that cannot start says so before it is asked about folders (it never shares its parent's, and the parent's
    // own folder is not a subfolder: never a wait for it), as the Mac's requestStart
    if (t.sub?.refusal) return this.fail(w, 'start_failed', t.sub.refusal)
    if (t.sub?.ownCwd && t.parentCwd !== null) {
      const why = subThreadCheck(t.cwd, t.parentCwd)
      if (why) return this.fail(w, 'start_failed', `sub-thread folder: ${why}`)
    }
    // never a launch on a bare PATH: with no login environment read yet, the start waits for the next ask
    const baseEnv = this.d.loginEnv.current()
    if (!baseEnv) return this.d.audit('worker_start_held', { thread: threadId, why: 'no login environment yet' })
    // a conversation is resumed only in the folder it was in: a folder changed since its launch starts a fresh one (worker-launch.ts)
    const last = lastFolder(w.entry)
    const moved = folderMoved(last, folderOf(t, this.d.realFolder))
    // session options that cannot be read give the default folder: neither a resume there (its transcript is not there) nor a
    // fresh conversation for a setting the owner never made; the start fails with the reason and the conversation is kept
    // (a thread with no conversation yet is held to it too: its first session would work in the wrong folder)
    if (unread(t, 'cwd') && (moved || last === null)) {
      const what = t.optsUnread?.includes('session_opts') ? 'session_opts' : 'session_opts.cwd'
      return this.fail(
        w,
        'start_failed',
        `the thread's ${what} cannot be read, so its folder is not known; fix it in config.json`,
      )
    }
    // one session per folder: another worker there would edit the same files; except the agent folder (Main's own: sessions
    // there do not touch git, OPTION-C 7.2), as on the Mac
    const agentDir = this.d.agentDir?.() ?? null
    const shared = agentDir !== null && folderKey(t.cwd) === folderKey(agentDir)
    const other = shared
      ? undefined
      : [...this.workers.values()].find(
          (o) =>
            o.id !== w.id &&
            folderKey(o.entry.cwd) === folderKey(t.cwd) &&
            ['starting', 'live', 'busy', 'parking', 'stopping'].includes(o.entry.state) &&
            !inOneFamily(t, this.known, o.id), // a parent and its folder-sharing sub-threads are one family
        )
    if (other) return this.fail(w, 'folder_claimed', `the session of ${other.id} works in ${t.cwd}`)
    // a fresh start someone asked for and the cap held stays fresh, whoever asks for the start that finally runs (the pointer's)
    const asked = Boolean(opts.fresh) || w.held?.fresh === true
    const fresh = asked || moved
    // a start that is going to be refused whatever happens takes no slot (it would park another session for nothing)
    const pre = this.d.preflight?.(w.id, baseEnv) ?? null
    if (pre) {
      this.notices.startRefused(w.id, w.notes, pre)
      return this.fail(w, pre.code, pre.detail)
    }
    // the live cap: a free slot, or the quietest worker parked first (the start waits for it to go), or a hold. The hold keeps
    // only a fresh start someone asked for: a moved folder is looked at again at each try
    if (!(await this.slots.mayStart(w, asked, opts.forPointer === true))) return
    const retire = fresh ? w.entry.session_id : null
    const sessionId = (fresh ? null : w.entry.session_id) ?? this.d.newSessionId()
    // resume only a session that had a turn: one that never did has no transcript, and --resume of it fails
    let resume = !fresh && w.entry.session_id !== null
    if (resume && w.entry.turn_session !== sessionId && !this.d.sessionSaved(t.cwd, sessionId, baseEnv)) {
      resume = false
      this.d.audit('session_not_saved', { thread: w.id, session: sessionId })
    }
    // a model or effort the sub-thread set that is not valid was read as not set (its parent's is used): said once per start
    for (const [key, value] of Object.entries(t.sub?.unreadable ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)))
      this.d.audit('thread_session_sub', { thread: w.id, setting: key, unreadable: value, taken: 'not set' })
    const nonce = newNonce()
    const plan = this.d.plan({ thread: t, sessionId, resume, nonce, baseEnv })
    if ('refused' in plan) {
      this.notices.startRefused(w.id, w.notes, plan.refused)
      return this.fail(w, plan.refused.code, plan.refused.detail, plan.refused.axis)
    }
    // the old conversation is retired only now: a start refused before anything ran keeps it for the next try
    if (retire) {
      w.entry = {
        ...w.entry,
        previous_ids: [retire, ...w.entry.previous_ids].slice(0, 5),
        session_id: null,
        turn_session: undefined,
        restarts: [],
      }
    }
    clearReady(this.d.home, w.id) // a ready left by an earlier start must not pass for this one
    this.notices.newStart(w.id, w.notes) // a new start has no dialog open
    writeNonce(this.d.home, w.id, nonce)
    if (!this.move(w, 'starting')) return
    const host = w.host ?? this.d.hostFor(w.id)
    w.host = host
    let pid: number
    try {
      pid = await host.start(plan.launch)
    } catch (e) {
      releaseWorkerFiles(this.d.home, w.id)
      return this.fail(w, 'start_failed', (e as Error).message)
    }
    host.onExit((exit) => void this.serial(async () => this.onExit(w, pid, exit)))
    w.startedAt = this.d.now()
    w.parkAt = null
    w.killed = false
    w.endAs = null
    w.baseEnv = baseEnv
    // a new pane starts a new watch of the screen: the last pane's text is not what this one is compared with
    w.idle = { lastActiveMs: this.d.wallMs(), activeMono: this.d.now(), body: null }
    w.busyWatch = NEW_BUSY_WATCH
    // what this start was launched with, so a later change to the thread's settings is seen (worker-launch.ts)
    const { launched: was, ...rest } = w.entry
    const launched = launchedRecord(t, plan.cwd, plan, was?.update_tried_hash) // a spec tried stays tried
    w.entry = {
      ...status.withoutStatus(rest as WorkerEntryT),
      ...(launched ? { launched } : {}),
      session_id: sessionId,
      pane_pid: pid,
      cwd: plan.cwd,
      model: t.model,
      started_at: new Date(this.d.wallMs()).toISOString(),
      error: null,
    }
    this.d.audit('worker_start', { thread: w.id, pid: String(pid), session: sessionId, resume: resume ? 'yes' : 'no' })
    // a server the owner listed that the session started without is said, never a silent difference
    if (plan.mcpLeftOut) this.notices.mcpLeftOut(w.id, w.notes, plan.mcpLeftOut.missing, plan.mcpLeftOut.refused)
    if (plan.settingsIgnored) this.notices.settingsIgnored(w.id, w.notes, plan.settingsIgnored)
    // told only of a new conversation in a folder other than the last launch's (a change back to the same folder is none)
    if (retire && last !== null && last !== plan.cwd) this.notices.folderChanged(w.id, w.notes, plan.cwd)
    this.dirty = true
    this.publish() // at once: the hub matches the hello's process group against pane_pid
  }

  /** Ends a session: park (kept for a resume) or stop (off). SIGTERM now, SIGKILL after park_grace_s (advance()). */
  beginEnd(threadId: string, endAs: 'parked' | 'off', why: string): void {
    const w = this.workers.get(threadId)
    if (!w) return
    const s = w.entry.state
    // the owner's stop always wins, whatever was asked before (Fable R1-2): Main is told to wake an off session
    if (endAs === 'off' && why === 'owner' && s !== 'off') [w.entry, this.dirty] = [status.ownerStopped(w.entry), true]
    if (s === 'parked' || s === 'off' || s === 'failed') {
      if (endAs === 'off' && s !== 'off') this.move(w, 'off')
      return
    }
    if (w.turnWait) {
      // the owner (or the cap, or the wait's own end) does not wait for the turn: a stop stays stopping, a park moves on
      w.turnWait = null
      if (endAs === 'parked' && !this.move(w, 'parking')) return
    } else if (s === 'parking' || s === 'stopping') {
      if (endAs === 'off') w.endAs = 'off'
      return
    } else if (!this.move(w, endAs === 'off' ? 'stopping' : 'parking')) return
    w.endAs = endAs
    w.parkAt = this.d.now()
    w.entry = status.withStopped(w.entry, why, w.afterPark !== null && endAs !== 'off')
    this.dirty = true
    this.slots.notePark(w, endAs, why) // its log line, the background work it cuts read before the signal
    if (!w.host?.signal('SIGTERM')) w.killed = true // nothing to signal: the exit (or the probe) settles it
  }

  private async onExit(w: WorkerRuntime, pid: number, exit: PtyExit): Promise<void> {
    if (w.entry.pane_pid !== pid) return // an exit of an earlier start
    releaseWorkerFiles(this.d.home, w.id)
    const wasEnding = w.entry.state === 'parking' || w.entry.state === 'stopping'
    const wall = new Date(this.d.wallMs()).toISOString()
    this.d.audit('worker_exit', {
      thread: w.id,
      pid: String(pid),
      code: exit.code === null ? '-' : String(exit.code),
      signal: exit.signal === null ? '-' : String(exit.signal),
    })
    w.entry = status.withTurnLost({ ...w.entry, pane_pid: 0 })
    if (!wasEnding && w.entry.state !== 'starting')
      w.entry = status.withStopped(w.entry, 'crash', false, { overwrite: true })
    this.paneGone(w)
    // what the session left in its group (MCP servers) ends with it: kill-session alone is a SIGHUP some ignore
    w.host?.signal('SIGKILL')
    await w.host?.close()
    if (wasEnding) {
      // a stop ends off; a park, or a stop asked for while it was parking, ends parked (parked -> off is the stop's last step)
      this.move(w, w.entry.state === 'stopping' && w.endAs !== 'parked' ? 'off' : 'parked')
      w.turnWait = null
      if (w.endAs === 'off' && w.entry.state === 'parked') this.move(w, 'off')
      w.entry = { ...w.entry, parked_at: wall }
      const after = w.afterPark
      w.afterPark = null
      w.endAs = null
      if (after && w.entry.state === 'parked') await this.startNow(w.id, after)
      return
    }
    // an exit during its start is a failed start, not a crash (only unasked exits of a live session count to crash_loop)
    const declined = declinedTrustText(w.offer) // the owner's own "No, exit": said as that, never a crash
    const code = exit.code ?? (exit.signal !== null ? `signal ${exit.signal}` : '?')
    if (w.entry.state === 'starting' || declined)
      return this.fail(w, 'start_failed', declined ?? `it exited during its start (${code})`)
    const restarts = [...w.entry.restarts, wall].slice(-10)
    w.entry = { ...w.entry, restarts }
    if (crashLooping(restarts, this.d.wallMs()))
      return this.fail(w, 'crash_loop', `${restarts.length} exits in a short time`)
    this.slots.notePark(w, 'parked', 'crash', null) // bg=unknown: the CLI's detached Bash shells can no longer be tied to it
    if (this.move(w, 'parked')) w.entry = { ...w.entry, parked_at: wall }
  }

  private async onWake(
    threadId: string,
    action: 'pointer' | 'park' | 'restart' | 'fresh' | 'resume',
    wakeAtMs = Number.NaN,
    reason: 'message' | 'card_action' | 'control' | 'governor' = 'control',
  ): Promise<void> {
    this.d.audit('worker_wake', { thread: threadId, action, reason })
    const w0 = this.workers.get(threadId)
    const leaving = w0?.entry.state === 'parking' || w0?.entry.state === 'stopping'
    switch (action) {
      case 'park': {
        // after the current turn (the Mac's requestPark); only a tap's park gives up on a turn, at its stop limit
        const s = w0?.entry.state ?? 'off'
        if (w0 && WORKER_LIVE_STATES.includes(s) && !w0.turnWait)
          return this.slots.requestPark(w0, reason === 'governor' ? 'governor' : 'control', reason === 'control')
        if (w0 && s === 'stopping' && reason === 'control') this.slots.armStopLimit(w0) // a tap rescues a governor's park
        return
      }
      case 'resume':
        if (w0 && leaving) return this.slots.queueAfterPark(w0, false)
        return this.startNow(threadId, {})
      case 'restart':
      case 'fresh': {
        const w = w0
        const s = w?.entry.state ?? 'off'
        // stuck (a start not done, a dialog or prompt on screen, a start held for a slot): its turn never ends, so at once; that is
        // when restart-thread is used. Otherwise the turn is let end first, as a park does, up to turn_wait_cap_s.
        if (w && stuck(w) && (s === 'live' || s === 'busy' || s === 'starting')) {
          w.afterPark = { fresh: action === 'fresh' }
          return this.beginEnd(threadId, 'parked', action)
        }
        if (w && (s === 'live' || s === 'busy')) {
          this.slots.requestPark(w, action, true)
          w.afterPark = { fresh: action === 'fresh' }
          return
        }
        if (w && leaving) return this.slots.queueAfterPark(w, action === 'fresh')
        return this.startNow(threadId, { fresh: action === 'fresh' })
      }
      case 'pointer': {
        const t = this.known.find((x) => x.id === threadId)
        if (!t) return
        const w = this.worker(t)
        const s = stateAfterSignin(w.entry, this.d.mainSignedIn, () => this.move(w, 'off'))
        const nowMs = this.d.wallMs()
        // a failed worker answers nothing (Main does); a wake older than the longest claim names messages Main already has
        if (s === 'failed') return
        const at = Number.isFinite(wakeAtMs) ? wakeAtMs : nowMs
        if (wakeTooOld(at, nowMs)) return this.d.audit('worker_wake_stale', { thread: threadId })
        const before = persisted(w.owed).pointer_owed_until
        w.owed = owe(w.owed, { cold: s !== 'live' && s !== 'busy', nowMs, wakeAtMs: at })
        // the wake file is already gone: the file that says a pointer is owed is written now, before the start
        if (persisted(w.owed).pointer_owed_until !== before) this.publish()
        if (s === 'off' || s === 'parked') await this.startNow(threadId, { forPointer: true })
        return
      }
    }
  }

  private async advance(w: WorkerRuntime): Promise<void> {
    const now = this.d.now()
    this.notices.retry(w.id, w.notes)
    switch (w.entry.state) {
      case 'starting': {
        // Workers have no dialog by design; one here (trust, MCP consent, login, a prompt) needs the owner. The pane stays up so
        // the owner can answer it, and the ready timer waits while it is on screen; nobody answering for start_dialog_s ends the
        // start as needs_mac, with its line.
        const seen = await this.lookAt(w)
        const p = w.notes.promptWatch.current
        const waiting = seen && seen.kind !== 'none' ? promptName(seen.kind) : p ? (p.title ?? 'prompt') : null
        if (seen && waiting) {
          // the usage-limit screen is never answered (the owner's Esc ends it): no needs_mac for it (the Mac's 911e7632)
          const answerless = waiting === USAGE_LIMIT_KIND
          if (!answerless && w.notes.dialogSince !== null && now - w.notes.dialogSince > WORKER_TIMING.start_dialog_s) {
            this.d.audit('worker_start_dialog_limit', { thread: w.id })
            await this.endStart(w)
            this.fail(w, 'needs_mac', waiting)
            this.notices.needsMac(w.id, w.notes, waiting)
            return
          }
          w.startedAt = now
          return
        }
        const ready = readReady(this.d.home, w.id)
        if (ready && ready.pid > 0) {
          this.move(w, 'live')
          w.idle = activeNow(w.idle, this.d.wallMs(), this.d.now())
          // seeded: a pane that just said hello is not busy for a window only because this is the first look at its output
          w.busyWatch = { seen: (await w.host?.lastOutputAt()) ?? null, changedAt: null }
          this.d.audit('worker_live', { thread: w.id, pid: String(w.entry.pane_pid) })
          return
        }
        if (w.startedAt !== null && now - w.startedAt >= WORKER_TIMING.ready_s) {
          this.d.audit('worker_not_ready', { thread: w.id })
          await this.endStart(w)
          this.fail(w, 'start_failed', `no verified hello from the hub within ${WORKER_TIMING.ready_s} s`)
        }
        return
      }
      case 'live':
      case 'busy': {
        const seen = await this.lookAt(w)
        const rows = w.rows
        if (rows) w.idle = noteScreen(w.idle, rows, this.d.wallMs(), this.d.now())
        const busy = await this.slots.isBusy(w)
        this.move(w, busy ? 'busy' : 'live')
        if (status.turnLook(w, busy, new Date(this.d.wallMs()).toISOString())) this.dirty = true
        // a transcript seen once means the session had a turn: the next start resumes it (session_not_saved never misfires)
        if (
          w.entry.session_id &&
          w.entry.turn_session !== w.entry.session_id &&
          w.baseEnv &&
          this.d.sessionSaved(w.entry.cwd, w.entry.session_id, w.baseEnv)
        ) {
          w.entry = { ...w.entry, turn_session: w.entry.session_id }
          this.dirty = true
        }
        if (w.owed.pending) {
          if (await this.typePointer(w)) return
        } else this.notices.heldPointer(w.id, w.notes, null, false)
        // no screen, no decision: a failed capture never parks
        if (seen && rows) await this.slots.idleCheck(w, busy || seen.kind !== 'none')
        return
      }
      case 'parking':
      case 'stopping':
        if (w.turnWait) return this.slots.waitTurn(w, w.turnWait)
        if (!w.killed && w.parkAt !== null && now - w.parkAt >= WORKER_TIMING.park_grace_s) {
          w.killed = true
          w.host?.signal('SIGKILL')
        }
        // a session whose exit never comes (the host lost it): what tmux says settles it
        if (w.killed && w.parkAt !== null && now - w.parkAt >= WORKER_TIMING.park_grace_s + 5 && w.host) {
          const p = await w.host.probe()
          if (p.kind === 'running') w.host.signal('SIGKILL') // still there: asked again, by its checked group
          const pid = w.entry.pane_pid
          if (p.kind === 'gone' || p.kind === 'dead')
            await this.onExit(w, pid, { pid, code: null, signal: null, hostLost: true, lastRows: [] })
        }
        return
      default:
        return
    }
  }

  /** No pane, no dialog on it: what it showed is over, and nothing stays on offer. */
  private paneGone(w: WorkerRuntime): void {
    this.notices.release(w.id, w.notes)
    this.dialogs.end(this.offerTarget(w))
  }

  /** Ended, then failed by the caller: the exit sees a session ending on purpose and records it as such. */
  private async endStart(w: WorkerRuntime): Promise<void> {
    w.host?.signal('SIGKILL')
    releaseWorkerFiles(this.d.home, w.id)
    this.paneGone(w)
    await w.host?.close()
  }

  // One look at a worker's pane, for what it says to the owner: the known dialog on a screen still for dialog_settle_s (else
  // none), or null when the screen could not be read (no screen, no decision).
  private async lookAt(w: WorkerRuntime): Promise<Screen | null> {
    const host = w.host
    if (!host) return null
    const rows = await host.visibleRows()
    w.rows = rows
    if (rows === null) return null
    const still = this.notices.still(w.notes, rows)
    const seen: Screen = still ? liveDialog(rows) : { kind: 'none' }
    const target = this.offerTarget(w)
    await this.dialogs.sync(target, host, rows, seen, still)
    await this.notices.look(w.id, w.notes, rows, seen, still, () => this.ownerTyping(host))
    await this.dialogs.answer(target, host) // a tap's answer for the dialog just noted
    return seen
  }

  /** The worker as worker-dialogs.ts sees it: the offer lives in the entry's `dialog`, so workers.json carries it. */
  private offerTarget(w: WorkerRuntime): OfferTarget {
    return {
      id: w.id,
      offer: w.offer,
      dialog: () => w.entry.dialog,
      setDialog: (dialog) => {
        const { dialog: _old, ...rest } = w.entry
        w.entry = dialog ? { ...rest, dialog } : rest
        this.dirty = true
      },
    }
  }

  /** An attached client typed within dialog_client_quiet_s (the owner's own picker, or the owner at the keys). Unread: no. */
  private async ownerTyping(host: WorkerHost): Promise<boolean> {
    const c = await host.clientActivities()
    if (!c || c.length === 0) return false
    return this.d.wallMs() - Math.max(...c) < WORKER_TIMING.dialog_client_quiet_s * 1000
  }

  /**
   * A pointer read back from workers.json for a worker with no pane: asleep, it is started (once) if the message is still wanted;
   * failed, or past its deadline, it is dropped. A worker with a pane is settled by typePointer, which has the screen.
   */
  private async reviveOwed(pending: (id: string) => boolean): Promise<void> {
    const nowMs = this.d.wallMs()
    for (const w of this.workers.values()) {
      // any owed pointer on a worker with no pane: read back from workers.json, or owed by a wake that came while the session
      // was on its way down, or whose start was held (no login environment yet): it is started once, while still wanted
      if (!w.owed.pending || pending(w.id)) continue
      const s = w.entry.state
      if (s === 'starting' || s === 'live' || s === 'busy' || s === 'parking' || s === 'stopping') continue
      if (s === 'failed' || nowMs > (w.owed.until ?? 0) || !this.known.some((t) => t.id === w.id)) {
        w.owed = NOTHING_OWED
        // a start held for a slot only to type this pointer has nothing to do any more; one someone asked for still waits
        if (w.held?.forPointer) w.held = null
        this.dirty = true
        continue
      }
      if ((s === 'off' || s === 'parked') && !w.owed.revived) {
        await this.startNow(w.id, { forPointer: true })
        // only a start that happened counts: a held one is asked again next tick, until the deadline
        if (w.entry.state === 'starting') w.owed = { ...w.owed, revived: true }
      }
    }
  }

  /** One tick of the owed pointer on a live session (owed-pointer.ts): typed, held, or settled when late. True: tick used up. */
  private async typePointer(w: WorkerRuntime): Promise<boolean> {
    if (!w.host) return true
    const nowMs = this.d.wallMs()
    // past its deadline the hub has given the message to Main: from here it is settled like one read back late
    if (!w.owed.restored && w.owed.until !== null && nowMs > w.owed.until) w.owed = { ...w.owed, restored: true }
    const before = JSON.stringify(persisted(w.owed))
    const r = await typeOwedPointer({
      pane: w.host,
      state: w.owed,
      nowMs,
      awake: this.d.now(),
      extraDialog: (rows) => detectPrompt(rows) !== null, // an unnamed prompt: do not type (the Mac's guardShape)
      // the file says done (turn begun), or flagged, the moment that is known; a flag keeps the turn, as the Mac does
      onEnter: (s) => {
        w.owed = s
        if (!s.pending) status.pointerEntered(w, new Date(nowMs).toISOString(), this.d.wallMs())
        this.publish()
      },
    })
    w.owed = r.state
    auditPointerLook((e, f) => this.d.audit(e, f), w.id, r.enterCheck, w.host?.unknownShapes?.() ?? [])
    const wasHeld = w.heldFor ?? null
    if (r.looked && wasHeld && !r.delivered && !r.state.pending) this.notices.heldAtDrop(w.id, w.notes, wasHeld)
    else if (r.looked) this.notices.heldPointer(w.id, w.notes, r.held, r.state.leftover)
    if (r.looked && r.held !== wasHeld) {
      w.heldFor = r.held
      if (r.held) {
        const k = r.held === 'refused' ? (w.host.lastKeyRefusal?.() ?? null) : null // the guard's code and the strange row
        this.d.audit('worker_pointer_held', {
          thread: w.id,
          why: r.held,
          ...(k ? { guard: k.why, ...(k.row !== undefined ? { row: k.row } : {}) } : {}),
        })
      }
    }
    if (r.delivered) {
      w.idle = activeNow(w.idle, nowMs, this.d.now()) // a pointer is activity
      this.d.audit('worker_pointer', { thread: w.id })
    }
    if (r.wroteLine)
      this.publish() // our line is in the box: a supervisor started from here on must know it is ours
    else if (JSON.stringify(persisted(w.owed)) !== before || r.delivered) this.dirty = true
    return r.used
  }

  /** Since when (monotonic s) a running sub-thread's settings have said its start would be refused (worker-launch.ts). */
  private subRefusedSince = new Map<string, number>()

  /**
   * A running session whose folder, model, effort or MCP list differs from what it was started with, the difference having stood
   * for launch_change_settle_s, is restarted (the Mac's checkLaunchChanges): after its turn, through `stopping` with the capped wait
   * (not the owner's stop limit: a saved setting is not a tap), or at once when it is stuck. A new folder is a fresh conversation.
   */
  private checkLaunchChanges(pending: (id: string) => boolean): void {
    for (const w of this.workers.values()) {
      const t = this.known.find((x) => x.id === w.id)
      const refused = refusedSubCheck(w, t, {
        pending: pending(w.id),
        now: this.d.now(),
        since: this.subRefusedSince,
        fence: (x, r) => subFenceProblem(x, r, this.d.parentFolderProblem),
      })
      if (refused === 'park') {
        this.d.audit('worker_sub_refused', { thread: w.id })
        w.afterPark = null
        this.slots.requestPark(w, 'sub_refused', false)
        this.dirty = true
      }
      if (refused !== 'none') continue
      const fire = launchCheck(w, t, {
        pending: pending(w.id),
        now: this.d.now(),
        real: (c) => (t && c === t.cwd ? folderOf(t, this.d.realFolder) : (this.d.realFolder ?? wantedFolder)(c)),
      })
      if (!fire) continue
      this.d.audit('worker_launch_changed', {
        thread: w.id,
        changed: fire.kind === 'fresh' ? 'cwd' : fire.changed.join(','),
      })
      // the start after the park decides fresh or resume from the folder as it is then (startNow): a change back resumes
      const after = { fresh: false }
      if (stuck(w)) {
        w.afterPark = after
        this.beginEnd(w.id, 'parked', 'config')
      } else {
        this.slots.requestPark(w, 'config', false)
        // only once it is on its way down: a move refused leaves nothing to start after
        if (w.entry.state === 'stopping') w.afterPark = after
      }
      this.dirty = true
    }
  }

  private publishIfDue(): void {
    const needs = status.needsYouSignature(this.workers.values())
    if (this.dirty || needs !== this.needsPublished || this.d.now() - this.lastPublish >= PUBLISH_EVERY_S)
      this.publish()
  }

  publish(): void {
    const { threads, own } = status.publishedThreads(this.workers.values(), {
      nowS: this.d.now(),
      wallMs: this.d.wallMs(),
      adopting: (id) => this.adoptPending?.has(id) === true,
      before: (id) => this.rawPrev[id] ?? {},
    })
    writeWorkersFile(
      this.d.home,
      buildWorkersFile({
        pid: this.d.supervisorPid,
        nowMs: this.d.wallMs(),
        mainPanePid: this.d.mainPanePid(),
        threads,
        own,
      }),
    )
    this.dirty = false
    this.needsPublished = status.needsYouSignature(this.workers.values())
    this.lastPublish = this.d.now()
  }
}
