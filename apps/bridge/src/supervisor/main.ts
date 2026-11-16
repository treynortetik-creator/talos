// Main's lifecycle on Linux and WSL: the core of the Mac's Supervisor.swift (start, adopt, exit, clean-up, backoff restart, crash
// loop, the resume error, stop), on the contract's types (MainPhase, MainStopReason, MainNeedsYou, MainStatus, MAIN_RESTART,
// MAIN_START). Driven by `tick()` (once a second in production) and the host's exit callback; every outside effect is a
// dependency, so tests run it on a fake host and clock.
//
// ONE AT A TIME: every entry point (tick, the exit callback, start, stop, attach) runs on one serial queue, as the Swift's run
// on its dispatch queue. Their awaits (tmux calls) never let another one in between: an exit during a start, a stop during an
// exit being handled or a restart in flight are each handled after it, on the state it left.
//
// Also from today's review of the Mac supervisor (Delphi fixes the Mac side), not carried over:
// - settings that cannot be read start nothing and save nothing;
// - a restart that cannot launch (no claude, no folder, no settings) backs off like a crash, and gives up at the crash loop;
// - the resume error counts only on an exit right after the spawn;
// - an adopted Main is read for a live warning at once;
// - a start that finds Main already running adopts it, never fails;
// - the login environment is built again at every start.
// Not here yet (P3c2, P3c3): the auto-confirm of the development-channels warning (today the start waits for the owner's Enter,
// as `confirm_cold_start`), the bridge-live check, the takeover check, the `claude agents` stuck poll, notices.

import { resolve } from 'node:path'
import {
  AUTO_CONFIRM,
  MAIN_RESTART,
  MAIN_START,
  type MainLaunchConfig,
  type MainNeedsYou,
  type MainPhase,
  type MainStatus,
  type MainStopReason,
  type PtyExit,
  type PtyHost,
} from '@talos-app/protocol'
import { type FirstStartState, firstStartExtras, firstStartStep, newFirstStart, noteSignin } from './first-start.ts'
import { adoptedMainEnv, buildMainEnv } from './launch-env.ts'
import type { MainDeps } from './main-deps.ts'
import type { MainEvent } from './notices.ts'
import { notLoggedIn, tokenRefused } from './oauth-token.ts'
import { groupAlive, type ProcIdentity, signalOwnGroup } from './proc.ts'
import { backoffDelay, CrashLoop, nextAttempt, type SessionMode, withSession } from './restart-rules.ts'
import { channelsInArgv, claudeIsReady, liveDevChannels, liveDialog, resumeMissing, sessionInUse } from './screen.ts'
import { type AgentEntry, type Blocker, interactiveEntry } from './takeover.ts'
import { PtyHostError } from './tmux-host.ts'
import { type UsageLimitInfo, UsageLimitWatch, usageNeedsYou } from './usage-limit.ts'
import { mainArgsWithGuards } from './worker-policy.ts'

export type StartKind = 'cold' | 'crash_restart' | 'attached'

/** The bridge_not_live reason for a bridge that was live and is now off the relay. */
export const RELAY_DOWN_REASON = 'not connected to the relay'

/** The resume error counts only on an exit this soon after the spawn (the contract's one number for every platform). */
export const RESUME_ERROR_WITHIN_S = MAIN_RESTART.resume_error_within_s

export type { MainDeps }

type Launch = {
  kind: StartKind
  pid: number
  started: string
  sessionId: string
  resumeId: string | null
  startedAt: number
  /** Wall ms of the spawn: this start's bridge stamps its status after it. 0 for an adopted Main (its bridge started before). */
  startedWallMs: number
  expectsWarning: boolean
  agentDir: string
  /** Monotonic s when the warning was last seen leaving the screen (the owner answered it); null before. */
  answeredAt: number | null
  warningSeen: boolean
  bridgeSeenLive: boolean
  /** Main's environment as launched; null for an adopted Main until it is needed (then the login one is built). */
  env: Record<string, string> | null
  /** This launch replaced one that crashed (a cold restart after a lost host included). */
  afterCrash: boolean
  /** This launch replaced one that exited cleanly (code 0): not told as a crash. */
  afterClean: boolean
  /** The phone was told this start waits for the owner (once per start). */
  phoned: boolean
  /** This session was recorded as having had a turn. */
  turnMarked: boolean
  /** The bridge alarm once raised: put back (not raised anew) when a dialog that took its place is answered. */
  bridgeAlarm: MainNeedsYou | null
  envKnown?: boolean // false: an adopted Main's env could only be guessed (its process unreadable or not Main's any more)
  /** This start's first-start screens (Linux, a start this supervisor made); absent for an adopted Main or none configured. */
  firstStart?: FirstStartState | null
}

type AfterCleanup = { restart: true } | { stop: MainStopReason }

export class MainSupervisor {
  private phase: MainPhase = 'idle'
  private stopReason: MainStopReason | undefined
  private needsYou: MainNeedsYou | undefined
  private launch: Launch | null = null
  private attempt = -1
  private restartAt: number | null = null
  private nextRestartIsCold = false
  private cleanup: { pid: number; started: string; deadline: number; then: AfterCleanup } | null = null
  private stopDeadline: number | null = null
  private readonly loop = new CrashLoop()
  private restartTimes: string[] = []
  /** Clean exits (code 0) in the last hour: their own cap, never the crash loop's. */
  private cleanExits: number[] = []
  /** The restart waiting now follows a clean exit: it is not recorded as a crash restart. */
  private restartIsClean = false
  private queue: Promise<void> = Promise.resolve()
  private lastSessionId: string | null = null
  /** The Main that just exited (its group may still hold something while it ends): ours for the takeover check, while its
   * pid is still that process (a pid reused hours later by another session never is). */
  private previous: { pid: number; started: string } | null = null
  private lastAgentsPollAt = Number.NEGATIVE_INFINITY
  private agentsMisses = 0
  private agentsPollInFlight = false
  /** What the last takeover check found (shown in the status, and what `--anyway` is checked against). */
  private blockers: Blocker[] = []
  /** A restart after a crash the check refused: asked again every minute for half an hour, then left to the owner. */
  private blockedRecheck: { at: number; until: number; kind: 'cold' | 'crash_restart' } | null = null
  /** The supervisor is quitting: queued ticks do nothing (Main must not be touched once the lock is released). */
  private halted = false
  /** Set by doRestart for the launch it makes: that launch follows a clean exit. */
  private launchingAfterClean = false
  /** Set by launchMainOnce for the launch it makes: it replaces one that exited (whatever kind of start it is). */
  private launchingAfterCrash = false
  /** Launches after a crash that could not happen at all, in a row (their own budget, never the crash loop's). */
  private cannotLaunchTries = 0
  /** The restart waiting now is another try of a launch that could not happen: not recorded as a crash restart. */
  private restartIsRetry = false
  /** Session errors already mended once (`inuse:<id>`, `empty:<id>`): never twice, so they cannot loop. */
  private readonly mended = new Set<string>()
  /** The next launch resumes this id: `--session-id` of it was refused as already in use. */
  private forceResume: string | null = null
  /** Since when a bridge that was live has been off the relay (monotonic s); null while it is connected. */
  private relayDownSince: number | null = null
  /** The stuck needs-you came from an unseen owner message (cleared when a tool call or output follows), not from the agents poll. */
  private stuckByUnseen = false
  /** The stop in progress is the supervisor's own, to start again at once: finish tells the owner nothing. */
  private quietStop = false
  /** When the live dialog now on screen was first seen (monotonic s); null when none is. */
  private dialogSince: number | null = null
  private readonly usage = new UsageLimitWatch()

  constructor(private readonly d: MainDeps) {
    d.host.onExit((e) => void this.serial(() => this.handleExit(e)))
  }

  /** Runs `f` after everything already queued; one entry point at a time. */
  private serial(f: () => Promise<void>): Promise<void> {
    const run = this.queue.then(f, f)
    this.queue = run.catch((e) => this.d.audit('supervisor_error', { error: String((e as Error)?.message ?? e) }))
    return run
  }

  status(): MainStatus {
    return {
      phase: this.phase,
      ...(this.stopReason ? { stopReason: this.stopReason } : {}),
      panePid: this.launch?.pid ?? null,
      sessionId: this.launch?.sessionId ?? this.lastSessionId,
      restarts: [...this.restartTimes],
      ...(this.needsYou ? { needsYou: this.needsYou } : {}),
      bridgeLive: this.launch?.bridgeSeenLive ?? false,
      ...(this.phase === 'blocked' && this.blockers.length > 0
        ? { blockers: this.blockers.map((b) => ({ resource: b.resource, sessionPid: b.sessionPid, folder: b.folder })) }
        : {}),
    }
  }

  private publish(): void {
    try {
      const f = this.launch?.firstStart
      this.d.publish(this.status(), f ? firstStartExtras(f) : undefined)
    } catch (e) {
      // a full disk or a folder made read-only must not stop supervision
      this.d.audit('publish_failed', { error: String((e as Error)?.message ?? e) })
    }
  }

  private get live(): boolean {
    return ['starting', 'running', 'cleaning_up', 'waiting_to_restart', 'stopping'].includes(this.phase)
  }

  /** Adopts a Main that outlived the last supervisor; otherwise (and when allowed) starts one. */
  attachOrStart(allowColdStart: boolean): Promise<void> {
    return this.serial(async () => {
      this.launchingAfterCrash = false
      this.cannotLaunchTries = 0
      if (await this.attach()) return
      if (allowColdStart) await this.startCold()
    })
  }

  /**
   * The owner's start. `anyway`: past the takeover check, once, and only for a start the check blocked. Never past Telegram
   * (taking its poller over deafens the other session, the Mac's rule), and never kept for a later start.
   */
  start(opts: { anyway?: boolean } = {}): Promise<void> {
    return this.serial(async () => {
      if (opts.anyway && (this.phase !== 'blocked' || this.blockers.some((b) => b.resource === 'telegram'))) {
        this.d.audit('start_anyway_refused', { phase: this.phase })
        return
      }
      this.blockedRecheck = null
      await this.startCold(Boolean(opts.anyway))
    })
  }

  /** The supervisor quits: nothing queued after this touches Main. */
  halt(): void {
    this.halted = true
  }

  /** `quiet`: a stop the supervisor makes itself to start again at once (a new token): the owner is not told it stopped. */
  stop(opts: { quiet?: boolean } = {}): Promise<void> {
    return this.serial(async () => {
      this.quietStop = opts.quiet === true
      await this.beginStop()
    })
  }

  /** Main shows it is not signed in: a sign-in screen at its start, or its token refused (the tray offers "Sign in"). */
  signedOut(): boolean {
    const f = this.launch?.firstStart
    return f ? firstStartExtras(f).signin === true : false
  }

  tick(): Promise<void> {
    return this.serial(() => this.tickOnce())
  }

  /** Resolves once everything already queued has run, adding no work of its own. */
  idle(): Promise<void> {
    return this.serial(async () => {})
  }

  private async startCold(skipTakeover = false): Promise<void> {
    if (this.live) return
    this.attempt = -1
    this.nextRestartIsCold = false
    this.restartIsClean = false
    await this.launchMain('cold', false, skipTakeover)
  }

  private async attach(): Promise<boolean> {
    const pid = await this.d.host.attachIfRunning(this.d.session)
    if (pid === null) return false
    const started = this.d.identity.processStartTime(pid)
    if (started === null) return false
    const cfg = this.d.config()
    const configured = 'error' in cfg ? null : cfg.session.id
    // recorded before any further await: an exit from here on is this launch's
    this.launch = {
      kind: 'attached',
      pid,
      started,
      sessionId: configured ?? '',
      resumeId: configured,
      startedAt: this.d.now(),
      startedWallMs: 0,
      env: null,
      expectsWarning: false,
      agentDir: 'error' in cfg ? '' : cfg.agentDir,
      answeredAt: null,
      warningSeen: false,
      bridgeSeenLive: false,
      bridgeAlarm: null,
      afterClean: this.launchingAfterClean,
      afterCrash: this.launchingAfterCrash,
      phoned: false,
      turnMarked: false,
      // an adopted Main is past its first start: nothing is answered for it, but its sign-in is still watched
      firstStart:
        this.d.firstStart && !('error' in cfg)
          ? newFirstStart({ approved: () => false, talosFolder: () => false }, cfg, [])
          : null,
    }
    this.phase = 'running'
    this.needsYou = undefined
    this.stuckByUnseen = false
    this.relayDownSince = null
    this.stopReason = undefined
    const markerSession = await this.d.host.marker('session')
    if (this.launch?.pid === pid && markerSession !== null) this.launch.sessionId = markerSession
    // a pane launched with another conversation keeps running, but its next restart is cold
    if (markerSession === null || markerSession !== configured) this.nextRestartIsCold = true
    this.d.audit('attach', { pid: String(pid) })
    // the warning may be on its screen right now (a supervisor that died mid-start): read it at once
    const rows = await this.d.host.visibleRows()
    if (this.launch?.pid === pid && rows !== null && liveDevChannels(rows)) this.phase = 'starting'
    await this.superviseLive(this.d.now())
    this.publish()
    return true
  }

  /** `afterCrash`: this launch replaces one that exited; anything that keeps it from running backs off like a crash. */
  private async launchMain(
    kind: 'cold' | 'crash_restart',
    afterCrash = kind === 'crash_restart',
    skipTakeover = false,
  ): Promise<void> {
    try {
      await this.launchMainOnce(kind, afterCrash, skipTakeover)
    } catch (e) {
      // a throw on the way (the settings could not be written, the login shell could not run) is a launch that did not
      // happen: said and backed off, never a supervisor that dies with Main half started
      this.cannotLaunch(afterCrash, String((e as Error)?.message ?? e))
    }
  }

  private async launchMainOnce(
    kind: 'cold' | 'crash_restart',
    afterCrash: boolean,
    skipTakeover = false,
  ): Promise<void> {
    this.launchingAfterCrash = afterCrash
    const cfg = this.d.config()
    // settings that cannot be read start nothing and save nothing; a restart backs off and tries again
    if ('error' in cfg) return this.cannotLaunch(afterCrash, cfg.error)
    const env = buildMainEnv(this.d.loginEnv(), cfg.env)
    const claude = this.d.resolveClaude(cfg.claudePath, env)
    if (!claude) return this.cannotLaunch(afterCrash, `claude was not found (claude_path ${cfg.claudePath})`)
    if (!this.d.isDir(cfg.agentDir))
      return this.cannotLaunch(afterCrash, `the agent folder ${cfg.agentDir} does not exist`)
    // another session holding Telegram, the bridge or the channel would be silently deafened by this start: refuse it
    // (before a session id is chosen or saved)
    if (this.d.takeover && !skipTakeover) {
      const blockers = await this.d.takeover(this.ourPgids(), env)
      if (blockers.length > 0) {
        // our own Main, adopted after a read that failed earlier, is never "another session"
        if (await this.attach()) return
        this.block(blockers, kind, afterCrash)
        return
      }
    }
    this.blockers = []
    let mode: SessionMode
    let sessionId: string
    // a session Claude Code refused as "already in use" is resumed, whatever the transcript check said
    const forceResume = this.forceResume !== null && this.forceResume === cfg.session.id
    this.forceResume = null
    const saved = cfg.session.id !== null && this.d.sessionSaved(cfg.agentDir, cfg.session.id, env)
    if (saved && cfg.session.id && !cfg.session.conversationSeen) this.d.markConversationSeen?.(cfg.session.id)
    // a session that had a turn is resumed even when its transcript is gone (a changed config folder, a retention delete):
    // the resume error then tells the owner, who decides; starting it anew would be an empty conversation, said nowhere
    if (cfg.session.id && (forceResume || saved || cfg.session.conversationSeen)) {
      sessionId = cfg.session.id
      mode = { resume: sessionId }
    } else if (cfg.session.id) {
      // no transcript yet (nobody typed before the crash): `--resume` would fail with the resume error and stop Main
      sessionId = cfg.session.id
      mode = { newSession: sessionId }
      this.d.audit('session_not_saved', { session: sessionId })
    } else {
      sessionId = this.d.newSessionId()
      this.d.saveSessionId(sessionId) // the cold start owns it
      mode = { newSession: sessionId }
    }
    this.lastSessionId = sessionId
    // the optional guards (talos-app install-guards) ride as Main's --settings, unless the owner's args carry their own
    const guarded = env.TALOS_APP_HOME
      ? mainArgsWithGuards(withSession(cfg.args, mode), resolve(cfg.agentDir, env.TALOS_APP_HOME), cfg.agentDir)
      : { args: withSession(cfg.args, mode), warning: null }
    if (guarded.warning) this.d.audit('guards_not_applied', { why: guarded.warning })
    const args = guarded.args
    const ptyLaunch = { session: this.d.session, argv: [claude, ...args], cwd: cfg.agentDir, env }
    let pid: number
    try {
      // a cold start refuses a live pane; a restart replaces the dead one in place
      pid = kind === 'cold' ? await this.d.host.start(ptyLaunch) : await this.d.host.restart(ptyLaunch)
    } catch (e) {
      if (e instanceof PtyHostError && e.code === 'already_running') {
        // a Main is already running (a read that failed earlier said nothing): adopt it, never fail and never start another
        if (await this.attach()) return
      }
      const rows = e instanceof PtyHostError ? e.rows : []
      if (this.sessionTrouble(mode, sessionId, cfg.agentDir, env, rows))
        return this.launchMainOnce(kind, afterCrash, skipTakeover)
      if ('resume' in mode && resumeMissing(rows)) return this.finish('resume_missing')
      // a restart whose child dies before its pid can be read is a crash like any other: it counts toward the cap
      if (afterCrash) return this.crashedWithoutChild(String((e as Error).message))
      return this.fail(String((e as Error).message))
    }
    const started = this.d.identity.processStartTime(pid)
    if (started === null) return afterCrash ? this.crashedWithoutChild('no start time') : this.fail('no start time')
    // recorded before any further await: an exit from here on is this launch's
    this.launch = {
      kind,
      pid,
      started,
      sessionId,
      resumeId: 'resume' in mode ? mode.resume : null,
      startedAt: this.d.now(),
      startedWallMs: this.d.wallMs(),
      env,
      expectsWarning: channelsInArgv(args).length > 0,
      agentDir: cfg.agentDir,
      answeredAt: null,
      warningSeen: false,
      bridgeSeenLive: false,
      bridgeAlarm: null,
      afterClean: this.launchingAfterClean,
      afterCrash: this.launchingAfterCrash,
      phoned: false,
      turnMarked: false,
      firstStart: this.d.firstStart ? newFirstStart(this.d.firstStart, cfg, channelsInArgv(args)) : null,
    }
    // a session whose transcript was seen at this launch is already recorded as having had a turn
    if (saved || cfg.session.conversationSeen) this.launch.turnMarked = true
    this.needsYou = undefined
    this.stuckByUnseen = false
    this.relayDownSince = null
    this.stopReason = undefined
    this.phase = 'starting'
    this.cannotLaunchTries = 0
    this.agentsMisses = 0
    this.lastAgentsPollAt = Number.NEGATIVE_INFINITY
    this.blockers = []
    this.d.audit('start', { kind, pid: String(pid), session: sessionId, resume: 'resume' in mode ? 'yes' : 'no' })
    await this.d.host.setMarker('session', sessionId)
    this.publish()
  }

  /**
   * The two session errors the next launch can mend (both seen with Claude Code 2.1.322), each at most once per id:
   * - `--session-id` refused as already in use: the session exists after all (the transcript check missed it): resume it;
   * - `--resume` of a transcript that holds no conversation (an /exit before anything was typed): it can never be resumed,
   *   so a new id is made (the old one goes to previous_ids) and started.
   * Anything else is not mended here.
   */
  private sessionTrouble(
    mode: SessionMode,
    sessionId: string,
    agentDir: string,
    env: Record<string, string>,
    rows: string[],
  ): boolean {
    if ('newSession' in mode && sessionInUse(rows) && !this.mended.has(`inuse:${sessionId}`)) {
      this.mended.add(`inuse:${sessionId}`)
      this.forceResume = sessionId
      this.d.audit('session_in_use_resume', { session: sessionId })
      return true
    }
    if ('resume' in mode && resumeMissing(rows) && !this.mended.has(`empty:${sessionId}`)) {
      if (!this.d.conversationEmpty(agentDir, sessionId, env)) return false
      this.mended.add(`empty:${sessionId}`)
      const fresh = this.d.newSessionId()
      this.d.saveSessionId(fresh)
      this.d.audit('session_empty_new_id', { session: sessionId, new: fresh })
      return true
    }
    return false
  }

  /** Our own process groups: Main now, and the Main that just exited while its pid is still that process. */
  private ourPgids(): Set<number> {
    const ours = new Set<number>()
    if (this.launch) ours.add(this.launch.pid)
    // the Mac's rule: the old group stays ours unless its leader's pid is now ANOTHER process (a gone leader still counts:
    // Linux does not hand out a pid that a live group still uses)
    const p = this.previous
    if (p) {
      const st = this.d.identity.processStartTime(p.pid)
      if (st === null || st === p.started) ours.add(p.pid)
    }
    return ours
  }

  /**
   * A start the takeover check refused: phase blocked, the holders in the status, told once (on the phone too when it was a
   * restart after a crash: nobody may be at this computer). A restart after a crash asks again every minute for half an hour.
   */
  private block(blockers: Blocker[], kind: 'cold' | 'crash_restart', afterCrash: boolean): void {
    const first = this.phase !== 'blocked'
    this.blockers = blockers
    this.launch = null
    this.phase = 'blocked'
    this.restartAt = null
    const now = this.d.now()
    if (afterCrash) {
      const until = this.blockedRecheck?.until ?? now + 30 * 60
      this.blockedRecheck = now + 60 <= until ? { at: now + 60, until, kind } : null
    }
    if (first) {
      this.d.audit('blocked', { holders: blockers.map((b) => `${b.resource}:${b.sessionPid}`).join(',') })
      this.tellOwner({ kind: 'blocked', blockers, afterCrash })
    }
    this.publish()
  }

  /**
   * No settings, claude or folder. A cold start fails and says why. A restart after a crash backs off and tries again, outside
   * the crash loop (nothing crashed), and after MAIN_RESTART.cannot_launch_tries gives up: start_failed and one phone line,
   * nothing restored (the Mac's ending).
   */
  private cannotLaunch(afterCrash: boolean, why: string): void {
    if (!afterCrash) {
      this.fail(why)
      return
    }
    const now = this.d.now()
    this.cannotLaunchTries++
    this.d.audit('restart_cannot_launch', { why, tries: String(this.cannotLaunchTries) })
    if (this.cannotLaunchTries >= MAIN_RESTART.cannot_launch_tries) {
      this.cannotLaunchTries = 0
      this.d.audit('gave_up', { why })
      this.finish('start_failed', { gaveUp: true })
      return
    }
    this.attempt++
    this.restartAt = now + backoffDelay(this.attempt, this.d.random())
    this.restartIsRetry = true
    this.phase = 'waiting_to_restart'
    this.publish()
  }

  private fail(why: string): void {
    this.d.audit('start_failed', { why })
    this.finish('start_failed')
  }

  private async tickOnce(): Promise<void> {
    if (this.halted) return
    const now = this.d.now()
    switch (this.phase) {
      case 'blocked':
        if (this.blockedRecheck && now >= this.blockedRecheck.at) {
          const { kind } = this.blockedRecheck
          this.blockedRecheck = { ...this.blockedRecheck, at: Number.POSITIVE_INFINITY }
          await this.launchMain(kind, true)
          if (this.phase !== 'blocked') this.blockedRecheck = null
        }
        break
      case 'starting':
      case 'running':
        await this.superviseLive(now)
        break
      case 'cleaning_up':
        await this.continueCleanup(now)
        break
      case 'waiting_to_restart':
        if (this.restartAt !== null && now >= this.restartAt) {
          this.restartAt = null
          await this.doRestart(now)
        }
        break
      case 'stopping':
        await this.continueStop()
        break
      default:
        break
    }
    this.publish()
  }

  private async superviseLive(now: number): Promise<void> {
    const l = this.launch
    if (!l) return
    // a screen that could not be read says nothing: no dialog is raised or cleared from it; the start deadline still runs
    const rows = await this.d.host.visibleRows()
    const since = now - l.startedAt
    // a key went to the pane: the screen is read again on the next tick, never acted on as it was
    if (
      rows !== null &&
      this.phase === 'starting' &&
      l.firstStart &&
      (await firstStartStep(this.d, l, l.firstStart, rows, since))
    )
      return
    if (rows !== null && l.firstStart)
      noteSignin(l.firstStart, rows, (e, f) => this.d.audit(e, f), { claudeIsReady, tokenRefused, notLoggedIn })
    if (rows !== null) {
      const dialog = liveDialog(rows)
      const warning = liveDevChannels(rows)
      if (dialog.kind !== 'none') {
        // a dialog is the owner's when it has not moved for dialog_stall_s (an owner at the pane answers it before that)
        const last = await this.d.host.lastOutputAt()
        if (this.needsYou?.kind === 'confirm_cold_start') this.needsYou = undefined // the warning is not what is on screen now
        this.dialogSince ??= now
        // the pane's last output when tmux reports it, else how long this supervisor has seen the dialog
        const still = last !== null ? (this.d.wallMs() - last) / 1000 : now - this.dialogSince
        if (dialog.kind === 'usage_limit') this.usageSeen(dialog.info, now)
        else if (still >= MAIN_RESTART.dialog_stall_s)
          this.raise({
            kind: 'dialog',
            dialog:
              dialog.kind === 'login_expired' ? 'login' : dialog.kind === 'bypass_disclaimer' ? 'unknown' : dialog.kind,
          } as MainNeedsYou)
      } else if (warning) {
        this.dialogSince = null
        l.warningSeen = true
        l.answeredAt = null // it is (back) on screen: the latest answer counts, never a frame read mid-redraw
        // P3c2 answers it under the guard; until then the owner presses Enter in the pane
        this.raise({ kind: 'confirm_cold_start' })
      } else {
        this.dialogSince = null
        // the warning was there and Claude is ready now: the owner answered it; the bridge's wait starts (a frame without the
        // warning that is not the ready input box, a redraw, starts nothing)
        if (l.warningSeen && l.answeredAt === null && claudeIsReady(rows)) l.answeredAt = now
        if (this.needsYou?.kind === 'dialog' || this.needsYou?.kind === 'confirm_cold_start') this.needsYou = undefined
        this.usageGone(now)
      }
      // running: the input box is up and no dialog or warning is live. With a warning expected, it must also have had its
      // time to appear; with none expected, the box is enough (the Mac's rule; MAIN_START says the same).
      if (this.phase === 'starting' && !warning && dialog.kind === 'none' && claudeIsReady(rows)) {
        if (!l.expectsWarning || since * 1000 >= AUTO_CONFIRM.gone_within_ms) {
          this.phase = 'running'
          // told once Main is running again (not at the spawn, and not after a clean exit); "resumed" only when it did
          if (l.afterCrash && !l.afterClean)
            this.tellOwner({ kind: 'restarted_after_crash', resumed: l.resumeId !== null })
          // a warning that was expected and never came: the bridge's wait starts now (the Mac's "ready without dialog")
          if (l.expectsWarning && !l.warningSeen) l.answeredAt ??= now
          if (this.needsYou?.kind === 'start_stalled') this.needsYou = undefined
          this.d.audit('running', { pid: String(l.pid) })
        }
      }
    }
    if (this.phase === 'starting' && since >= MAIN_START.stall_s && this.needsYou === undefined)
      this.raise({ kind: 'start_stalled' })
    this.checkBridge(l, now)
    if (this.phase === 'running') this.checkUnseen(l, await this.d.host.lastOutputAt())
    await this.pollAgents(l, now)
  }

  /**
   * `claude agents --json` every agents_probe_s while Main runs: Main missing from it hang_polls times in a row is needs-you
   * `stuck` (alive, but not answering); listed again clears it. A list that could not be read says nothing.
   */
  private async pollAgents(l: Launch, now: number): Promise<void> {
    // off the queue, as the Mac's own poll queue: a slow `claude agents` never holds up a stop or an exit
    if (!this.d.listAgents || this.agentsPollInFlight) return
    if (this.phase !== 'running' && this.phase !== 'starting') return
    if (now - this.lastAgentsPollAt < MAIN_RESTART.agents_probe_s) return
    this.lastAgentsPollAt = now
    this.agentsPollInFlight = true
    const pid = l.pid
    void this.d
      .listAgents(this.envOf(l))
      .then((entries) => this.serial(() => this.handleAgents(entries, pid)))
      .catch(() => {})
      .finally(() => {
        this.agentsPollInFlight = false
      })
  }

  /**
   * The answer of one poll (the Mac's handleAgents): Main listed clears stuck and follows a session id it reports (a /clear or
   * /resume in its pane); Main missing hang_polls times in a row while running is stuck, over whatever else is held. A list
   * that could not be read says nothing.
   */
  private async handleAgents(entries: AgentEntry[] | null, pid: number): Promise<void> {
    const l = this.launch
    if (this.halted || !l || l.pid !== pid || entries === null) return
    if (this.phase !== 'running' && this.phase !== 'starting') return
    const e = interactiveEntry(entries, pid)
    if (e) {
      this.markTurnIfSaved(l)
      this.agentsMisses = 0
      // listed is alive for the poll's own stuck; a hang the unseen check found is still listed (#5), and only it clears that
      if (this.needsYou?.kind === 'stuck' && !this.stuckByUnseen) this.needsYou = undefined
      if (e.sessionId && e.sessionId !== l.sessionId) await this.adoptReportedId(l, e.sessionId)
    } else if (this.phase === 'running') {
      this.agentsMisses++
      // on the usage-limit screen Main drops out of the list because of it: that is what it waits on (the Mac's b401c31d)
      if (this.agentsMisses >= MAIN_RESTART.hang_polls && this.needsYou?.kind !== 'usage_limit')
        this.raise({ kind: 'stuck' })
    }
    this.publish()
  }

  /** Once this session's transcript exists, it had a turn: recorded once, so a later loss of it is never read as "never typed". */
  private markTurnIfSaved(l: Launch): void {
    if (l.turnMarked || !this.d.markConversationSeen) return
    if (!this.d.sessionSaved(l.agentDir, l.sessionId, this.envOf(l))) return
    l.turnMarked = true
    this.d.markConversationSeen(l.sessionId)
  }

  /**
   * Claude Code moved Main to another session (the owner's /clear or /resume in the pane): the next restart resumes that one.
   * Only a UUID, only for the configured folder, and only once the warning is answered (before it, the id is the launch's).
   * The old id goes to previous_ids.
   */
  private async adoptReportedId(l: Launch, reported: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reported)) return
    const cfg = this.d.config()
    if ('error' in cfg || cfg.agentDir !== l.agentDir) return
    if (l.expectsWarning && l.answeredAt === null) return
    this.d.saveSessionId(reported)
    l.turnMarked = false // a new id starts without a turn; the poll records it once its transcript is there
    this.d.audit('session_followed', { from: l.sessionId, to: reported })
    l.sessionId = reported
    l.resumeId = reported
    this.lastSessionId = reported
    await this.d.host.setMarker('session', reported)
  }

  /**
   * MAIN_START's last rule: this start's bridge writes a live status.json, from a pid in Main's process group, stamped after the
   * spawn and fresh. Seen once, the check ends. Not seen within bridge_alive_s of the warning's answer (of the spawn when none
   * was expected): needs you `bridge_not_live`, with the reason from Claude Code's MCP log. Never a stop or a restart.
   */
  private checkBridge(l: Launch, now: number): void {
    if (l.bridgeSeenLive) {
      this.watchRelay(l, now)
      return
    }
    if (this.bridgeIsLive(l)) {
      l.bridgeSeenLive = true
      this.relayDownSince = null // an outage of an earlier launch's bridge is not this one's
      if (this.needsYou?.kind === 'bridge_not_live') this.needsYou = undefined
      this.d.audit('bridge_live', { pid: String(l.pid) })
      return
    }
    const from = l.answeredAt ?? (l.expectsWarning ? null : l.startedAt)
    if (this.phase !== 'running' || from === null || now - from < MAIN_RESTART.bridge_alive_s) return
    if (this.needsYou === undefined || this.needsYou.kind === 'start_stalled') {
      if (l.bridgeAlarm) {
        this.needsYou = l.bridgeAlarm // a dialog took the slot and is answered: the same alarm comes back, told no second time
        return
      }
      l.bridgeAlarm = {
        kind: 'bridge_not_live',
        reason: l.agentDir ? this.d.mcpLogReason(l.agentDir, this.envOf(l)) : null,
      }
      this.raise(l.bridgeAlarm)
    }
  }

  /** The environment the running Main was started with (null when none is running): what its thread sessions are held to. */
  launchEnv(): { env: Record<string, string>; known: boolean } | null {
    return this.launch ? { env: { ...this.envOf(this.launch) }, known: this.launch.envKnown !== false } : null
  }

  /** Main's environment: as launched, or for an adopted Main the one it would be launched with (built once, when needed). */
  private envOf(l: Launch): Record<string, string> {
    const stillMain = () => this.d.identity.processStartTime(l.pid) === l.started
    if (l.env === null || l.envKnown === false)
      ({ env: l.env, known: l.envKnown } = adoptedMainEnv(l.pid, this.d, stillMain, l.env)) // a guess is looked at again
    return l.env
  }

  /**
   * After the bridge was live: off the relay for relay_down_s is needs-you (the phone cannot reach Main, whatever the
   * supervisor's own view), back on the relay clears it. A short outage is the bridge's own to ride out. On the relay is
   * the same test as live: a status.json that stopped being written (a dead or hung bridge) or is another bridge's is off.
   */
  private watchRelay(l: Launch, now: number): void {
    if (this.bridgeIsLive(l)) {
      this.relayDownSince = null
      if (this.needsYou?.kind === 'bridge_not_live' && this.needsYou.reason === RELAY_DOWN_REASON)
        this.needsYou = undefined
      return
    }
    this.relayDownSince ??= now
    if (now - this.relayDownSince >= MAIN_RESTART.relay_down_s && this.needsYou === undefined)
      this.raise({ kind: 'bridge_not_live', reason: RELAY_DOWN_REASON })
  }

  /**
   * A session hung on a call is still listed by `claude agents`, so the agents poll cannot see it. The bridge can: an owner
   * message no bridge tool call has followed for unseen_s, while the screen has printed nothing for unseen_quiet_s and
   * nothing since that message, is stuck (MAIN_RESTART). A tool call (or the screen printing again) clears it.
   */
  private checkUnseen(l: Launch, lastOutMs: number | null): void {
    if (this.needsYou?.kind !== 'stuck') this.stuckByUnseen = false // another kind took the slot, or it was cleared
    const st = this.d.readBridgeStatus(l.env?.TALOS_APP_HOME)
    const since = st?.unseen_oldest_at ? Date.parse(st.unseen_oldest_at) : Number.NaN
    const wall = this.d.wallMs()
    const quiet = lastOutMs === null || wall - lastOutMs >= MAIN_RESTART.unseen_quiet_s * 1000
    // and nothing printed since the message came: a healthy Main shows it and its turn, even one that calls no bridge tool
    // (tmux keeps whole seconds, so output in the message's own second counts as after it)
    const silentSince = lastOutMs === null || lastOutMs < Math.floor(since / 1000) * 1000
    const hung = Number.isFinite(since) && wall - since >= MAIN_RESTART.unseen_s * 1000 && quiet && silentSince
    if (hung) {
      if (this.needsYou === undefined || this.needsYou.kind === 'stuck') {
        this.stuckByUnseen = true
        this.raise({ kind: 'stuck' })
      }
    } else if (this.stuckByUnseen && this.needsYou?.kind === 'stuck') {
      this.stuckByUnseen = false
      // the agents poll still finds no Main: the stuck stays, now the poll's to clear (never told a second time)
      if (this.agentsMisses < MAIN_RESTART.hang_polls) this.needsYou = undefined
    }
  }

  private bridgeIsLive(l: Launch): boolean {
    // the Talos home Main's bridge writes to: Main's own (an override in the settings included), else the supervisor's
    const st = this.d.readBridgeStatus(l.env?.TALOS_APP_HOME)
    // live means reachable: up AND connected to the relay (a bridge that says "bridge up" with a broken bridge.env is not)
    if (!st || st.mode !== 'live' || st.relay?.connected !== true) return false
    const stamp = Date.parse(st.updated_at)
    if (!Number.isFinite(stamp)) return false
    // the bridge is Main's child: a process of Main's group, so an old bridge still running elsewhere does not count
    return (
      stamp >= l.startedWallMs &&
      this.d.wallMs() - stamp < MAIN_RESTART.bridge_status_max_age_s * 1000 &&
      this.d.identity.processGroup(st.pid) === l.pid
    )
  }

  // the usage-limit menu (usage-limit.ts): a new appearance tells the owner at most once an hour, else it is only what Main waits
  // on; a frame without it (torn, mid-redraw) keeps it until it has been gone for the watch's settle time
  private usageSeen(i: UsageLimitInfo, now: number): void {
    const n = usageNeedsYou(i, this.d.wallMs())
    if (this.usage.look(true, now) === 'appeared' && this.usage.mayTellOwner(now)) this.raise(n)
    else if (JSON.stringify(this.needsYou) !== JSON.stringify(n)) this.needsYou = n
  }
  private usageGone(now: number): void {
    if (this.usage.look(false, now) === 'gone' && this.needsYou?.kind === 'usage_limit') this.needsYou = undefined
  }

  private raise(n: MainNeedsYou): void {
    if (JSON.stringify(this.needsYou) === JSON.stringify(n)) return
    this.needsYou = n
    this.d.audit('needs_you', { kind: n.kind })
    // a restart after a crash that waits for the owner: nobody may be at the computer, so the phone hears it too, once a start
    const l = this.launch
    const waits = n.kind === 'confirm_cold_start' || n.kind === 'dialog' || n.kind === 'usage_limit'
    const unattended = Boolean(l?.afterCrash && !l.afterClean && waits && !l.phoned)
    if (unattended && l) l.phoned = true
    this.tellOwner({ kind: 'needs_you', needs: n, ...(unattended ? { unattended: true } : {}) })
  }

  private tellOwner(e: MainEvent): void {
    try {
      this.d.tell?.(e)
    } catch (err) {
      this.d.audit('tell_failed', { error: String((err as Error)?.message ?? err) })
    }
  }

  private async handleExit(exit: PtyExit): Promise<void> {
    const l = this.launch
    if (!l || exit.pid !== l.pid) return
    const now = this.d.now()
    this.d.audit('exit', {
      pid: String(exit.pid),
      code: exit.code === null ? '-' : String(exit.code),
      signal: exit.signal === null ? '-' : String(exit.signal),
      host_lost: exit.hostLost ? '1' : '0',
    })
    this.previous = { pid: l.pid, started: l.started }
    if (this.phase === 'stopping') return this.continueStop()
    if (this.phase === 'cleaning_up' || this.phase === 'waiting_to_restart') return
    if (exit.hostLost) this.nextRestartIsCold = true
    const rows = exit.lastRows.length > 0 ? exit.lastRows : ((await this.d.host.visibleRows()) ?? [])
    // only right after the spawn: later, the error's words on screen are a conversation that quotes them
    if (now - l.startedAt <= RESUME_ERROR_WITHIN_S) {
      const mode: SessionMode = l.resumeId !== null ? { resume: l.resumeId } : { newSession: l.sessionId }
      const cfgNow = this.d.config()
      const restarts = 'error' in cfgNow || cfgNow.autoRestart
      // a failed start mended once, unless the owner turned restarts off
      if (restarts && this.sessionTrouble(mode, l.sessionId, l.agentDir, this.envOf(l), rows)) {
        this.restartAt = now
        return this.beginCleanup(l, now, { restart: true })
      }
      if (l.resumeId !== null && resumeMissing(rows)) return this.beginCleanup(l, now, { stop: 'resume_missing' })
    }
    const cfg = this.d.config()
    // the owner turned restarts off: no exit restarts Main, a clean one included
    if (!('error' in cfg) && !cfg.autoRestart) return this.beginCleanup(l, now, { stop: 'crashed_no_auto_restart' })
    // code 0 is not a crash (claude exits 0 after a self-update too): it restarts at the first step, outside the crash loop,
    // with its own looser cap
    if (exit.code === 0 && exit.signal === null && !exit.hostLost) {
      this.cleanExits = [...this.cleanExits, now].filter((t) => now - t < 3600)
      if (this.cleanExits.length > MAIN_RESTART.clean_exits_per_hour) {
        this.d.audit('clean_exit_loop', { exits: String(this.cleanExits.length) })
        return this.beginCleanup(l, now, { stop: 'clean_exit_loop' })
      }
      this.restartIsClean = true
      this.attempt = -1 // a crash after it starts the steps over too (at the first one)
      this.restartAt = now + backoffDelay(0, this.d.random())
      return this.beginCleanup(l, now, { restart: true })
    }
    if (!this.loop.mayRestart(now)) {
      this.d.audit('crash_loop', { restarts: String(this.loop.restartsInWindow(now)) })
      return this.beginCleanup(l, now, { stop: 'crash_loop' })
    }
    this.attempt = nextAttempt(this.attempt, l.startedAt, now)
    this.restartAt = now + backoffDelay(this.attempt, this.d.random())
    await this.beginCleanup(l, now, { restart: true })
  }

  private crashedWithoutChild(why: string): void {
    const now = this.d.now()
    this.d.audit('restart_failed', { why })
    if (!this.loop.mayRestart(now)) {
      this.d.audit('gave_up', { why })
      this.finish('crash_loop')
      return
    }
    this.attempt++
    this.restartAt = now + backoffDelay(this.attempt, this.d.random())
    this.phase = 'waiting_to_restart'
    this.publish()
  }

  /** The old group is ended before anything else: SIGTERM now, SIGKILL at the deadline if anything is left. */
  private async beginCleanup(l: Launch, now: number, then: AfterCleanup): Promise<void> {
    this.signal(l, 'SIGTERM')
    this.cleanup = { pid: l.pid, started: l.started, deadline: now + MAIN_RESTART.cleanup_grace_s, then }
    this.phase = 'cleaning_up'
    await this.continueCleanup(now)
    this.publish()
  }

  private async continueCleanup(now: number): Promise<void> {
    const c = this.cleanup
    if (!c) return
    const gone = !groupAlive(c.pid)
    if (!gone && now < c.deadline) return
    if (!gone) {
      signalOwnGroup(this.d.identity, c.pid, c.started, 'SIGKILL')
      this.d.audit('cleanup_kill', { pgid: String(c.pid) })
    }
    this.cleanup = null
    if ('restart' in c.then) {
      this.phase = 'waiting_to_restart'
      if (this.restartAt !== null && now >= this.restartAt) {
        this.restartAt = null
        await this.doRestart(now)
      }
      return
    }
    this.finish(c.then.stop)
  }

  private async doRestart(now: number): Promise<void> {
    const clean = this.restartIsClean
    const retry = this.restartIsRetry
    if (!clean && !retry) this.loop.recordRestart(now)
    this.restartIsClean = false
    this.restartIsRetry = false
    this.restartTimes = [...this.restartTimes, new Date(this.d.wallMs()).toISOString()].slice(
      -MAIN_RESTART.crash_loop.count * 2,
    )
    const kind = this.nextRestartIsCold ? 'cold' : 'crash_restart'
    this.nextRestartIsCold = false
    this.d.audit('restart', { attempt: String(this.attempt), kind, ...(clean ? { after: 'clean_exit' } : {}) })
    // a cold restart (a lost host, another conversation's pane) makes a new session or respawns a dead pane; failures in it
    // still back off like a crash's
    this.launchingAfterClean = clean
    try {
      await this.launchMain(kind, true)
    } finally {
      this.launchingAfterClean = false
    }
  }

  private async beginStop(): Promise<void> {
    if (!this.launch || !this.live) {
      await this.d.host.close()
      this.finish('user')
      return
    }
    this.restartAt = null
    this.cleanup = null
    this.stopDeadline = this.d.now() + MAIN_RESTART.stop_grace_s
    this.phase = 'stopping'
    this.signal(this.launch, 'SIGTERM')
    this.d.audit('stop')
    await this.continueStop()
    this.publish()
  }

  private async continueStop(): Promise<void> {
    const l = this.launch
    if (!l || this.stopDeadline === null) return
    const gone = !groupAlive(l.pid)
    if (!gone && this.d.now() < this.stopDeadline) return
    if (!gone) this.signal(l, 'SIGKILL')
    this.stopDeadline = null
    await this.d.host.close()
    this.finish('user')
  }

  private signal(l: Launch, sig: NodeJS.Signals): void {
    signalOwnGroup(this.d.identity, l.pid, l.started, sig)
  }

  private finish(reason: MainStopReason, opts: { gaveUp?: boolean } = {}): void {
    this.blockedRecheck = null
    this.restartIsClean = false
    this.restartIsRetry = false
    this.cannotLaunchTries = 0
    this.launch = null
    this.cleanup = null
    this.restartAt = null
    this.phase = 'stopped'
    this.stopReason = reason
    this.d.audit('stopped', { reason, ...(this.quietStop ? { quiet: 'yes' } : {}) })
    this.publish()
    if (!this.quietStop) this.tellOwner({ kind: 'stopped', reason, ...(opts.gaveUp ? { gaveUp: true } : {}) })
    this.quietStop = false
  }

  /** The supervisor quits; Main keeps running and the next supervisor adopts it. */
  detach(): void {
    this.d.host.detach()
  }
}
