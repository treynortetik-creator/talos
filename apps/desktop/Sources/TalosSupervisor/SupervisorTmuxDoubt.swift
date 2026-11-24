import Foundation
import TalosDesktopCore

/// Everything the supervisor keeps while tmux does not answer. tmux that does not answer says nothing about the agent: it is never read as
/// gone, so nothing is killed, started or counted as a crash on it. The start waits for the pane (`pendingAdopt`), the attach at launch waits
/// to learn whether anything runs (`attachRetry`), and each tick looks again until tmux answers. After `unreachableReads` unanswered looks
/// over `unreachableAfter` seconds the owner is told once, in plain words, and told again when tmux answers.
struct TmuxDoubt {
  /// A start or restart whose pane tmux could not read (`PtyHostError.paneUnreadable`): the agent may be running.
  struct PendingAdopt {
    let finish: (Int32) -> Void
    let crashRestart: Bool
    /// true: the launch command ran or may have (`finish` when the pane is found). false: nothing was created: `relaunch` when nothing runs.
    let launched: Bool
    let relaunch: () -> Void
    /// The pane turned out to be dead: what an exit at the start means, with the rows the dead pane left (a resume that is gone says so there).
    let exited: ([String]) -> Void
    /// When the start went pending (the supervisor's clock): the dead pane's rows speak for it only inside `resumeMissingWindow`.
    let startedAt: Double
  }
  struct Unreachable {
    var reads = 0
    var since: Double?
    var told = false
    /// The owner pressed Start (or restart) while tmux did not answer: the status says so at once.
    var ownerAsked = false
  }
  /// A Stop that could not finish because tmux did not answer (no agent to signal, or kill-session unconfirmed): retried on ticks.
  struct StopRequest {
    let reason: Supervisor.StopReason
    let closeHost: Bool
  }
  var stopRequest: StopRequest?

  var pendingAdopt: PendingAdopt?
  /// An attach at launch tmux did not answer; the value is whether a cold start was allowed once it is known that nothing runs.
  var attachRetry: Bool?
  /// Set by `attachLocked` when tmux gave no answer about whether the agent runs.
  var attachUnknown = false
  var unreachable = Unreachable()
}

extension Supervisor {
  static let unreachableReads = 5

  func attachLocked() -> Bool {
    guard !configUnreadable else { return false }  // not even watched: a crash would be restarted from the defaults
    doubt.attachUnknown = false
    switch host.attachState() {
    case .unknown:
      doubt.attachUnknown = true
      return false
    case .notRunning: return false
    case .running: break
    }
    guard let pid = host.childPid else { return false }
    passiveReattach = false
    let snap = probe.snapshot(pid)
    // Without the lock this supervisor only watches (passive): it owns no group, so it can never signal one.
    let owner = tryLock()
    if owner { signaller.own(pid, leaderStart: snap?.startTime ?? 0) }
    previousChild = nil
    let claude = resolveClaude(env: launchEnv())
    let fp = launchFingerprint(config, claude ?? config.claudePath)
    let markerFp = host.marker("talos_launch")
    let markerSession = host.marker("talos_session")
    // A pane launched with another command or conversation keeps running, but its next restart is cold.
    if markerFp != fp || markerSession == nil || markerSession != config.session.id { nextRestartIsCold = true }
    // The pane may still be sitting on the development-channels warning (the app quit, crashed or was updated while Main was
    // starting). It is not running then: the start goes on from here, so the owner gets the card and the popup. Only the live warning
    // counts (its shape at the bottom of the screen, not the words in a transcript), only for the copy that holds the lock (a
    // passive one never types), and a screen that could not be read says nothing. The Mac never presses the Enter for an attached
    // start by itself: an earlier copy of the app may already have pressed it, and the rule is never twice (`awakeStartedAt`
    // puts this start outside the auto-accept's window whatever else matches).
    let waiting = owner && DialogMatcher.liveDevChannels(host.visibleRows() ?? [])
    // What the pane was launched with is known only when its marker is the launch the config names now.
    let sameLaunch = markerFp == fp
    launch = Launch(
      kind: .attached, resumeId: config.session.id, sessionId: markerSession ?? config.session.id ?? "",
      startedAt: clock.now(), childPid: pid, leaderStart: snap?.startTime ?? 0, fingerprint: markerFp ?? "",
      parts: sameLaunch ? launchParts(config, claude ?? config.claudePath) : [:], launchedArgs: sameLaunch ? config.args : nil, cliVersion: nil,
      expectsDevDialog: waiting, launchedChannels: sameLaunch ? AutoConfirmGuard.channels(inArgv: config.args) : [],
      awakeStartedAt: -.infinity, devDialogSeen: nil, dialogAnswered: !waiting, agentDir: config.expandedAgentDir(home: options.home))
    launch?.narrowed = MainNarrowed.found(
      argv: snap?.argv, env: snap?.env, sameLaunch: sameLaunch, configured: MainNarrowed.mode(args: config.args, env: launchEnv()))
    phase = waiting ? .starting : .running
    needsYou = nil
    audit("attach", ["pid": "\(pid)", "warning": waiting ? "live" : "no"])
    emit(.attached(pid: pid))
    publish()
    return true
  }

  /// One look per tick at an attach tmux did not answer, then the same decision `attachOrStart` makes.
  func attachRetryTick(_ allowColdStart: Bool, _ now: Double) {
    if attachLocked() {
      doubt.attachRetry = nil
      clearUnreachable()
      return
    }
    if doubt.attachUnknown { return noteUnreachable(now) }
    doubt.attachRetry = nil
    clearUnreachable()
    if allowColdStart { startColdLocked() }
  }

  /// One unanswered look. Only after `unreachableReads` of them over `unreachableAfter` seconds is anything said.
  func noteUnreachable(_ now: Double) {
    doubt.unreachable.reads += 1
    if doubt.unreachable.since == nil { doubt.unreachable.since = now }
    guard !doubt.unreachable.told, doubt.unreachable.reads >= Self.unreachableReads, now - (doubt.unreachable.since ?? now) >= timings.unreachableAfter else { return }
    doubt.unreachable.told = true
    audit("agent_unreachable", ["reads": "\(doubt.unreachable.reads)"])
    _ = postToPhone { SupervisorNotice.agentUnreachable(name: $0) }
    publish()
  }

  func clearUnreachable() {
    if doubt.unreachable.told {
      audit("agent_reachable", [:])
      _ = postToPhone { SupervisorNotice.agentReachable(name: $0) }
    }
    doubt.unreachable = TmuxDoubt.Unreachable()
    publish()
  }

  /// The pending start, looked at once more. Not launched: attach if something runs, launch again if nothing does. Launched: the pane it made is
  /// adopted and the start's own tail runs; gone ends as an exit at the start always did; an agent older than the launch is attached to.
  func adoptPendingTick(_ now: Double) {
    guard let p = doubt.pendingAdopt else { return }
    if !p.launched {
      switch host.attachState() {
      case .unknown: noteUnreachable(now)
      case .running:
        audit("start_found_running", [:])
        attachOrKeepWaiting(now)
      case .notRunning:
        doubt.pendingAdopt = nil
        clearUnreachable()
        audit("start_relaunch", [:])
        p.relaunch()
      }
      return
    }
    switch host.adoptPending() {
    case .unknown:
      noteUnreachable(now)
    case .olderAgent(let pid):
      audit("start_older_agent", ["pid": "\(pid)"])
      attachOrKeepWaiting(now)
    case .adopted(let pid):
      doubt.pendingAdopt = nil
      clearUnreachable()
      audit("start_adopted", ["pid": "\(pid)"])
      p.finish(pid)
    case .notLaunched:
      doubt.pendingAdopt = nil
      clearUnreachable()
      audit("start_relaunch", ["why": "never_ran"])
      p.relaunch()
    case .gone(let rows):
      // tmux ANSWERED that the pane is dead (or the session is not there) after our launch command ran: an exit at the start. Its screen
      // speaks for a missing resume only inside the window, and only when the host saw output after the launch (it hands the rows over
      // only then); otherwise it is a plain crash or failed start.
      doubt.pendingAdopt = nil
      clearUnreachable()
      audit("start_pane_gone", [:])
      p.exited(now - p.startedAt <= timings.resumeMissingWindow ? rows : [])
    }
  }

  /// Looks at what tmux says while a retry stands, before a Stop acts. True: the stop has to wait (tmux does not answer, nothing to signal).
  func resolveDoubtBeforeStop(_ reason: StopReason, _ closeHost: Bool) -> Bool {
    guard doubt.pendingAdopt != nil || doubt.attachRetry != nil else { return false }
    if attachLocked() {  // found: a normal stop of the attached agent follows
      doubt.pendingAdopt = nil
      doubt.attachRetry = nil
      clearUnreachable()
      return false
    }
    if doubt.attachUnknown {
      doubt.stopRequest = TmuxDoubt.StopRequest(reason: reason, closeHost: closeHost)
      phase = .stopping
      audit("stop_waiting_unanswered", [:])
      publish()
      return true
    }
    doubt.pendingAdopt = nil
    doubt.attachRetry = nil
    clearUnreachable()
    return false
  }

  /// A stop that waited for tmux: asked again each tick.
  func stopRequestTick() {
    guard let req = doubt.stopRequest else { return }
    doubt.stopRequest = nil
    beginStop(reason: req.reason, closeHost: req.closeHost)
  }

  /// The looks the poll and the supervisor's own reads make while the agent runs: unanswered ones count toward the same line.
  func noteHostReads(_ now: Double) {
    if host.unansweredStreak > 0 {
      noteUnreachable(now)
    } else if doubt.unreachable.reads > 0 || doubt.unreachable.told {
      clearUnreachable()
    }
  }

  /// A start's host error that is about tmux not answering, or a pane that already runs. True: handled (nothing is a crash or a failed start).
  /// Launched or not, the pane is neither dead nor to be started again; `adoptPendingTick` decides on later ticks. A pane that runs is never
  /// respawned over (that kills it): it is attached to, or looked at again when tmux stops answering.
  func handleUnreadableStart(_ error: Error, kind: StartKind, finish: @escaping (Int32) -> Void, exited: @escaping ([String]) -> Void) -> Bool {
    if case PtyHostError.paneUnreadable(let launched) = error {
      let afterCrash = restartingAfterCrash
      doubt.pendingAdopt = TmuxDoubt.PendingAdopt(
        finish: finish, crashRestart: afterCrash, launched: launched,
        relaunch: { [weak self] in
          guard let self else { return }
          self.restartingAfterCrash = afterCrash
          self.launchLocked(kind: kind)
          self.restartingAfterCrash = false
        },
        exited: { [weak self] rows in
          guard let self else { return }
          self.restartingAfterCrash = afterCrash
          exited(rows)
          self.restartingAfterCrash = false
        },
        startedAt: clock.now())
      doubt.unreachable = TmuxDoubt.Unreachable()
      phase = .starting
      audit("start_pane_unreadable", ["kind": kind.rawValue, "launched": launched ? "yes" : "no"])
      publish()
      return true
    }
    if case PtyHostError.alreadyRunning = error {
      if attachLocked() { return true }
      if doubt.attachUnknown {
        doubt.attachRetry = false
        doubt.unreachable = TmuxDoubt.Unreachable()
        phase = .idle
        audit("attach_unanswered", [:])
        publish()
        return true
      }
    }
    return false
  }

  /// Start pressed while an attach tmux did not answer stands: look first. True: nothing more to do (attached, or the retry stays and the owner
  /// is told). False: nothing runs, the start goes on.
  func holdsForUnansweredAttach() -> Bool {
    guard doubt.attachRetry != nil else { return false }
    if attachLocked() {
      doubt.attachRetry = nil
      clearUnreachable()
      return true
    }
    if doubt.attachUnknown {
      doubt.unreachable.ownerAsked = true
      audit("start_waiting_unanswered", [:])
      publish()
      return true
    }
    return false
  }

  /// kill-session got no answer: the session may still run. Stay stopping and ask again; never publish stopped over it.
  func waitForKill(_ reason: StopReason, _ closeHost: Bool) {
    doubt.stopRequest = TmuxDoubt.StopRequest(reason: reason, closeHost: closeHost)
    phase = .stopping
    audit("stop_unconfirmed", [:])
    publish()
  }

  /// The pending start found an agent running: attach to it. If tmux stops answering between the two looks the start keeps waiting (never a
  /// failure: "the agent exited immediately" would be false and a retry could start a second one); only a real "not running" is a failed start.
  func attachOrKeepWaiting(_ now: Double) {
    if attachLocked() {
      doubt.pendingAdopt = nil
      clearUnreachable()
    } else if doubt.attachUnknown {
      noteUnreachable(now)
    } else {
      doubt.pendingAdopt = nil
      clearUnreachable()
      fail(.startFailed("\(PtyHostError.exitedImmediately(rows: []))"))
    }
  }

  func crashedWithoutChild(_ why: String) {
    let now = clock.now()
    audit("restart_failed", ["why": String(why.prefix(120)).replacingOccurrences(of: "\n", with: " ")])
    guard loop.mayRestart(now: now) else {
      postCrashLoopOnce()
      emit(.stoppedRestarting)
      return finishStop(.crashLoop, closeHost: false)
    }
    attempt += 1
    let delay = timings.backoff.delay(attempt: attempt, unit: random())
    restartAt = now + delay
    restartAfterCleanExit = false
    phase = .waitingToRestart
    emit(.restarting(attempt: attempt, delay: delay))
    publish()
  }

  /// The longest a start's stall clock may be held for unanswered tmux reads: a tmux that flaps for longer still gets the stall line.
  static let stallPauseCap: Double = 600

  /// The start's stall clock stands still while tmux does not answer: each such tick adds the time since the last one to `Launch.stallPausedTotal`,
  /// up to `stallPauseCap` in all, and the stall check subtracts it. `startedAt` itself is never moved (the real wait stays readable from it). Only
  /// while the phase is `.starting`; the pause is kept in the launch, so it ends with it. True: paused now.
  func pauseStartClockWhileUnanswered(_ l: inout Launch, _ now: Double) -> Bool {
    guard phase == .starting, host.unansweredStreak > 0 else {
      l.stallPauseTick = nil
      return false
    }
    if let last = l.stallPauseTick {
      let moved = min(max(0, now - last), max(0, Self.stallPauseCap - l.stallPausedTotal))
      l.stallPausedTotal += moved
    }
    l.stallPauseTick = now
    return l.stallPausedTotal < Self.stallPauseCap
  }
}
