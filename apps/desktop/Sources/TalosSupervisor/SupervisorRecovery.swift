import Foundation
import TalosDesktopCore

/// What the supervisor remembers for `AgentRecovery`. Queue-confined with the rest of its state.
struct RecoveryState {
  /// The control_id last acted on. A request with the same one is cleared and ignored.
  var lastHandledId: String?
  /// Set when an automatic restore starts, whatever came of it; reset by a healthy start. Keeps the automatic restore to one.
  var restoredOnce = false
  var restoreInFlight = false
  /// What this supervisor has seen of the bridge in the current start, on the awake clock. See `AgentRecovery.BridgeWatch`.
  var bridge = AgentRecovery.BridgeWatch()
  /// When (awake clock) a phone request was last acted on. The rate limit.
  var lastActedAt: Double?
  /// When this supervisor started (whole unix ms, the clock a request's `ts` is written on). See `AgentRecovery.decide`.
  var launchedAtMs: Double = 0
  /// Set for the cold start a recovery begins: if it stops at the dev-channel warning, the phone is told once. Cleared when it
  /// has been, or when the start moves on without that warning.
  var postColdStart = false
  /// The crash-loop post goes out once per supervisor.
  var crashLoopPosted = false
}

/// The Mac half of "Restart agent" on the phone, and the one automatic restore. The decisions are
/// `AgentRecovery.decide`; this reads the inputs and does the work. Nothing here sleeps: the restore runs off the queue and
/// reports back to it.
extension Supervisor {
  var requestPath: String { talosAppHome + "/" + AgentRequest.fileName }

  func recoveryTick(_ now: Double) {
    if phase != .starting { recovery.postColdStart = false }
    guard !recovery.restoreInFlight else { return }
    let file = AgentRequestFile.read(path: requestPath)
    // Only the copy that holds the session lock acts, so a second copy of the app never restarts or restores behind the first.
    guard holdsSessionLock || (file != .absent && tryLock()) else { return }

    let awake = options.awake()
    let runningFor: Double? = phase == .running ? launch.map { now - $0.startedAt } : nil
    let probe = self.probe
    // The status file's age is wall-clock, so a night's sleep would read as a night of outage: count only the time this
    // supervisor was awake and watching, from the first tick it saw the bridge down.
    let health =
      runningFor == nil
      ? nil
      : AgentRecovery.bridgeHealth(
        probe.readFile(talosAppHome + "/status.json").flatMap(BridgeStatus.decode), nowMs: options.wallClock(),
        pidAlive: { probe.snapshot($0) != nil })
    recovery.bridge.observe(health, running: runningFor != nil, awakeNow: awake)
    if AgentRecovery.isHealthy(
      running: runningFor != nil, runningFor: runningFor ?? 0, healthyFor: timings.backoff.healthyReset,
      bridgeDown: recovery.bridge.downSince != nil)
    {
      recovery.restoredOnce = false
    }

    switch AgentRecovery.decide(
      request: file, nowMs: options.wallClock(), lastHandledId: recovery.lastHandledId,
      crashLoopStopped: phase == .stopped(.crashLoop), bridgeDownFor: recovery.bridge.downFor(awakeNow: awake),
      restoredOnce: recovery.restoredOnce, ownerStopped: ownerStopped,
      sinceLastRequest: recovery.lastActedAt.map { awake - $0 }, launchedAtMs: recovery.launchedAtMs)
    {
    case .none: break
    case .discard:
      if AgentRequestFile.clear(path: requestPath, ifStill: file) { audit("agent_request_ignored", [:]) }
    case .refuse(let why):
      if case .request(let r) = file { recovery.lastHandledId = r.controlId }
      guard AgentRequestFile.clear(path: requestPath, ifStill: file) else { break }
      audit("agent_request_ignored", ["why": why.rawValue])
      switch why {
      case .ownerStopped: emit(.recovered(.ignoredOwnerStopped))
      // One line per refused request. The menu holds one notice, so a burst only repeats it; but while the new start waits for the
      // owner's Enter, the line the owner needs must stay.
      case .tooSoon: if needsYou == nil { emit(.recovered(.ignoredTooSoon)) }
      }
    case .restart(let id):
      recovery.lastHandledId = id
      recovery.lastActedAt = awake
      AgentRequestFile.clear(path: requestPath, ifStill: file)
      audit("agent_request", ["action": "restart"])
      restartThen(.restartedOnRequest)
    case .restore(let why):
      recovery.restoredOnce = true
      startRestore(why)
    }
  }

  /// A `--resume` whose agent was gone before the host could read its pid (the CLI prints its resume error and exits at once)
  /// ends as `.resumeMissing`, exactly as the same exit seen by `handleExit` does: same audit, same event, same stop, never a
  /// restart. The host only reports the dead pane's rows (`PtyHostError.exitedImmediately`); the matcher is the exit path's own.
  /// False for any other launch or error, which the caller handles as before.
  func resumeMissingAtStart(_ error: Error, _ mode: ResumeRewrite.Mode) -> Bool {
    guard case .resume(let rid) = mode, case PtyHostError.exitedImmediately(let rows) = error,
      DialogMatcher.resumeMissing(rows)
    else { return false }
    audit("resume_missing", ["session": rid])
    finishStop(.resumeMissing(rid), closeHost: false, announcing: .resumeFailed(sessionId: rid))
    return true
  }

  /// The exit path of the same stop: the group is cleared first, and `resumeFailed` goes out once the stop is published, so the
  /// menu never says the conversation can't be resumed while the status still says starting.
  func resumeMissingStop(_ rid: String, pgid: Int32, holders: [Holder], now: Double) {
    audit("resume_missing", ["session": rid])
    beginCleanup(
      pgid: pgid, holders: holders, now: now,
      then: .stop(.resumeMissing(rid), closeHost: false, announcing: .resumeFailed(sessionId: rid)))
  }

  /// `talos-app restore-last-good --yes --newest-start --agent-dir <folder>`, then a cold restart. The command is not terminal-only
  /// (`--yes` skips its question), so it runs as a plain child; `--newest-start` makes it use only the newest saved start version or
  /// do nothing, and `--agent-dir` (one argv element) makes it refuse a version saved from another folder: exit 1, nothing written.
  /// A non-zero exit, a timeout or no `talos-app` at all means nothing is restarted and nothing is retried. `talos-app` is the
  /// owner's own (`talos_app_command` or the login PATH), never the agent folder's `.mcp.json`, which the agent can write.
  private func startRestore(_ why: AgentRecovery.Reason) {
    var env = launchEnv()
    env["TALOS_APP_HOME"] = talosAppHome
    let found = resolveTalosApp(env: env, fromAgentFolder: false)
    guard let cmd = found.command else {
      audit("restore_skipped", ["why": found.why])
      return emit(.recovered(.restoreFailed))
    }
    let agentDir = config.expandedAgentDir(home: options.home)
    let childEnv = env
    recovery.restoreInFlight = true
    audit("restore_start", ["why": Self.name(of: why)])
    let queue = q
    let me = WeakRef(self)
    // `options.background` (a thread of its own, not one from the shared dispatch pool, which gives none while every thread in it is
    // blocked) and back to the queue with `sync`, which needs no pool thread either.
    options.background {
      let r = ProcessRunner.run(cmd + ["restore-last-good", "--yes", "--newest-start", "--agent-dir", agentDir], env: childEnv, timeout: 60)
      queue.sync { me.value?.restoreFinished(why, r) }
    }
  }

  private func restoreFinished(_ why: AgentRecovery.Reason, _ r: RunResult) {
    recovery.restoreInFlight = false
    audit("restore", ["ok": r.ok ? "1" : "0", "code": "\(r.status)"])
    guard r.ok else {
      tellPhone(.restoreFailed)
      return emit(.recovered(.restoreFailed))
    }
    let result = AgentRecovery.RestoreResult.parse(String(decoding: r.stdout.prefix(65536), as: UTF8.self))
    // Stop wins over the restart: the owner pressed Stop while it ran (even if the agent is still in its SIGTERM grace), or the app
    // detached or quit and let go of the lock. The restore is done and is said so; nothing restarts,
    // and the lock is not taken back.
    let restart = holdsSessionLock && !ownerStopped
    let outcome = AgentRecovery.Outcome.restored(why, result, restarted: restart)
    tellPhone(outcome)
    if restart { restartThen(outcome) } else { emit(.recovered(outcome)) }
  }

  /// The owner may be away from the Mac: the phone gets the menu's own line, built from the strictly parsed result and never from
  /// the command's text. Nothing is posted when the restore could not start for want of the owner's `talos-app`: `postToPhone`
  /// would fall back to the agent folder's `.mcp.json`, which the restore refuses to use.
  private func tellPhone(_ o: AgentRecovery.Outcome) {
    guard let line = SupervisorNotice.phoneLine(o) else { return }
    postToPhone { _ in line }
  }

  /// `restartCold()`, with the notice posted after the restart's own stop and before the new start. The stop ends with
  /// `.stopped(.user)`, which the menu reads as the owner's own Stop and clears the line; anything the start raises after the notice
  /// (a failure, a dialog) replaces it, as it should.
  private func restartThen(_ outcome: AgentRecovery.Outcome) {
    let me = WeakRef(self)
    restartCold {
      me.value?.emit(.recovered(outcome))
      me.value?.recovery.postColdStart = true
    }
  }

  /// The cold start a recovery began stopped at the dev-channel warning: it waits for Enter at the Mac, and the owner who asked
  /// from the phone is not there. Tell the phone, once. The owner's own start at the Mac is not told.
  func postColdStartToPhone() {
    guard recovery.postColdStart else { return }
    recovery.postColdStart = false
    postToPhone { CrashPost.coldStartText(agentName: $0) }
  }

  func postCrashLoopOnce() {
    guard !recovery.crashLoopPosted else { return }
    recovery.crashLoopPosted = true
    postToPhone { CrashPost.text(agentName: $0, at: CrashPost.clockTime(Date())) }
  }

  /// `talos-app post <default thread> <text>` (headless). `text` is built from the agent's name. Used by the crash-loop post too.
  func postToPhone(_ text: (String?) -> String) {
    let env = launchEnv()
    let found = resolveTalosApp(env: env)
    guard let cmd = found.command else { return audit("post_skipped", ["why": found.why]) }
    let app = CrashPost.readAppConfig(probe.readFile(talosAppHome + "/config.json"))
    guard let thread = config.notifyThread ?? app.defaultThread else {
      return audit("post_skipped", ["why": "no default thread"])
    }
    let text = text(app.agentName)
    let probe = self.probe
    let queue = q
    let me = WeakRef(self)
    options.background {  // as the restore: not the shared dispatch pool
      let ok = probe.post(command: cmd, thread: thread, text: text, env: env)
      queue.sync { me.value?.audit("post", ["ok": ok ? "1" : "0"]) }
    }
  }

  /// `talos-app post <thread> <text>` for a thread session's notice (a worker waiting on a prompt). Blocking, so callers run it
  /// off the main thread and off the worker queue. Returns whether it was sent; a missing `talos-app` is a no, and the audit
  /// log says which.
  public func postToThread(_ thread: String, text: String) -> PostOutcome {
    let (found, env) = q.sync { () -> ((command: [String]?, why: String), [String: String]) in
      let env = launchEnv()
      return (resolveTalosApp(env: env), env)
    }
    guard let cmd = found.command else {
      q.sync { audit("worker_post_skipped", ["why": found.why, "thread": thread]) }
      return .failed
    }
    let outcome = probe.postOutcome(command: cmd, thread: thread, text: text, env: env)
    q.sync { audit("worker_post", ["result": "\(outcome)", "thread": thread]) }
    return outcome
  }

  private static func name(of r: AgentRecovery.Reason) -> String {
    switch r {
    case .crashLoop: return "crash_loop"
    case .bridgeDown: return "bridge_down"
    }
  }

  /// `talos-app` as the owner set it up: `talos_app_command`, else the login PATH, else (when `fromAgentFolder`) the agent folder's
  /// `.mcp.json`. The agent can write that file, so nothing that acts on a trigger the agent can cause (the restore) uses it. When
  /// there is none, `why` says what was missing (for the audit log).
  func resolveTalosApp(env: [String: String], fromAgentFolder: Bool = true) -> (command: [String]?, why: String) {
    if !config.talosAppCommand.isEmpty {
      guard
        let typed = TalosAppLocator.runnable(
          config.talosAppCommand, searchPath: env["PATH"], home: options.home, isExecutable: probe.isExecutable)
      else { return (nil, "talos_app_command not found") }
      return (typed, "")
    }
    if let t = LoginShellEnv.which("talos-app", path: env["PATH"], isExecutable: probe.isExecutable) { return ([t], "") }
    if fromAgentFolder, let f = TalosAppLocator.fromMcpJson(
      probe.readFile(config.expandedAgentDir(home: options.home) + "/.mcp.json"), searchPath: env["PATH"],
      home: options.home, isExecutable: probe.isExecutable, fileExists: { FileManager.default.fileExists(atPath: $0) })
    {
      return (f.command, "")
    }
    return (nil, "talos-app not found")
  }
}
