import Foundation
import TalosDesktopCore

/// What the supervisor remembers for `AgentRecovery`. Queue-confined with the rest of its state.
struct RecoveryState {
  /// Main's computer-use permission dialog: Escape per appearance and per hour (SupervisorComputerUse.swift).
  var computerUse = ComputerUseDismiss()
  /// Main's usage-limit screen: its appearances and the hourly phone line (SupervisorUsageLimit.swift).
  var usageLimit = UsageLimitWatch()
  /// The control_id last acted on. A request with the same one is cleared and ignored.
  var lastHandledId: String?
  /// Set when an automatic restore starts, whatever came of it; reset by a healthy start. Keeps the automatic restore to one.
  var restoredOnce = false
  var restoreInFlight = false
  /// What this supervisor has seen of the bridge in the current start, on the awake clock. See `AgentRecovery.BridgeWatch`.
  var bridge = AgentRecovery.BridgeWatch()
  /// When (awake clock) an OWNER's request (a proof that verified) was last acted on. The owner's next request is held only to this one.
  var lastActedAt: Double?
  /// When (awake clock) a request not the owner's (`restart_main`, or any request without a proof that verifies) was last acted on. An
  /// agent's request is held to both stamps; the owner's never to this one, so the owner can always restart again at once after an agent did.
  var lastAgentActedAt: Double?
  /// The owner's restart proofs already decided on (`RestartProofCheck.usedKey`), newest 64: the authority. Seeded once from the file
  /// (`restartProofsUsedPath`, at most its newest 64) at the first request; those seeded entries are the oldest and are evicted first, and
  /// nothing the file holds later can evict a key this run spent. The file is asked too (`DialogProofsUsed.contains`).
  var proofsUsed: [String] = []
  /// The newest signed time (unix ms) of an owner's proof this app accepted: a proof signed at or before it is a replay. Kept beside the
  /// used list too (`restartProofMarkPath`), and read back at launch no later than the launch itself.
  var proofMarkMs: Double = 0
  /// The two above were read from their files (once, at the first request).
  var proofsSeeded = false

  /// Awake seconds since the last request acted on that a request is held to (`AgentRecovery.requestMinGap`).
  func sinceLastRequest(owner: Bool, awake: Double) -> Double? {
    let mine = lastActedAt.map { awake - $0 }
    guard !owner else { return mine }
    return [mine, lastAgentActedAt.map { awake - $0 }].compactMap { $0 }.min()
  }
  /// When this supervisor started (whole unix ms, the clock a request's `ts` is written on). See `AgentRecovery.decide`.
  var launchedAtMs: Double = 0
  /// Set for the cold start a recovery begins: if it stops at the dev-channel warning, the phone is told once. Cleared when it
  /// has been, or when the start moves on without that warning.
  var postColdStart = false
  /// The crash-loop post goes out once per supervisor.
  var crashLoopPosted = false
  /// `main-restart-check.json` (SupervisorRestartCheck.swift): what came of the newest request, the one still being followed, and
  /// when the file was last written.
  var restartCheck = RestartCheckState()
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

    let asker = file.request.map { requestAsker($0) } ?? .agent
    let decision = AgentRecovery.decide(
      request: file, nowMs: options.wallClock(), lastHandledId: recovery.lastHandledId,
      crashLoopStopped: phase == .stopped(.crashLoop), bridgeDownFor: recovery.bridge.downFor(awakeNow: awake),
      restoredOnce: recovery.restoredOnce, ownerStopped: ownerStopped,
      sinceLastRequest: recovery.sinceLastRequest(owner: asker.isOwner, awake: awake), launchedAtMs: recovery.launchedAtMs)
    // A proof that verified is spent the moment its request is decided, whatever the decision: one the owner was told was ignored must
    // never restart Main later. Only an owner's proof that was recorded may skip the restart check.
    var asOwner = false
    if decision != .none, case .request = file { asOwner = consumeProof(asker) && asker.isOwner }
    // the owner's phone in every way but its signed time: said in its own line, whatever comes of it
    let clockLine: String? = { if case .clockOff(_, let why) = asker { return MainRestartCheck.clockPhoneLine(why) } else { return nil } }()
    switch decision {
    case .none: break
    case .discard:
      if AgentRequestFile.clear(path: requestPath, ifStill: file) { audit("agent_request_ignored", [:]) }
    case .refuse(let why):
      if case .request(let r) = file, case .badProof(let step) = asker { return refuseBadProof(r, step: step, file: file) }
      if case .request(let r) = file { recovery.lastHandledId = r.controlId }
      guard AgentRequestFile.clear(path: requestPath, ifStill: file) else { break }
      audit("agent_request_ignored", ["why": why.rawValue])
      if case .request(let r) = file { requestRefused(r.controlId, reason: why.rawValue, lead: clockLine) }
      switch why {
      case .ownerStopped: emit(.recovered(.ignoredOwnerStopped))
      // One line per refused request. The menu holds one notice, so a burst only repeats it; but while the new start waits for the
      // owner's Enter, the line the owner needs must stay.
      case .tooSoon: if needsYou == nil { emit(.recovered(.ignoredTooSoon)) }
      }
    case .restart(let id):
      guard case .request(let r) = file else { break }
      if case .badProof(let step) = asker { return refuseBadProof(r, step: step, file: file) }
      if asker.isOwner, !asOwner { audit("restart_proof_unrecorded", [:]) }
      // A request the owner's proof does not cover (a session's `restart_main`, the phone's through a bridge older than the proof, a proof
      // signed at a time this Mac does not take, or one that could not be recorded) is checked again here, now: the bridge's check was
      // advice, seconds old, and the file is not the owner's word. A no restarts nothing and does NOT count as acted on, so the gap the
      // owner's next phone request is held to is not spent by it (neither stamp moves).
      if !asOwner, let why = restartCheckVerdict(now).reasons.first {
        recovery.lastHandledId = id
        guard AgentRequestFile.clear(path: requestPath, ifStill: file) else { break }
        audit("agent_request_refused", ["why": why.rawValue, "proof": Self.proofWord(asker)])
        // no proof and no thread: what an older bridge writes for the phone's own button, so the line says what to do instead
        requestRefused(id, reason: why.rawValue, mayBeThePhone: r.proof == .none && r.byThread == nil, lead: clockLine)
        break
      }
      recovery.lastHandledId = id
      if asOwner { recovery.lastActedAt = awake } else { recovery.lastAgentActedAt = awake }
      AgentRequestFile.clear(path: requestPath, ifStill: file)
      audit("agent_request", ["action": "restart", "proof": asOwner ? "owner" : Self.proofWord(asker)])
      requestActedOn(id, now: now)
      if let clockLine {
        postRequestLine(.restarting) { _ in clockLine }
      } else if !asOwner {
        announceAgentRestart(r)
      }
      restartThen(.restartedOnRequest)
    case .restore(let why):
      recovery.restoredOnce = true
      startRestore(why)
    }
  }

  /// `$TALOS_APP_HOME/restart-proofs-used.json`: the owner's restart proofs already acted on (`DialogProofsUsed`'s shape and cap).
  var restartProofsUsedPath: String { talosAppHome + "/restart-proofs-used.json" }

  /// `restart-proof-mark.json` beside it: `{"v":1,"signed_ms":<the newest signed time accepted>}`.
  var restartProofMarkPath: String { talosAppHome + "/restart-proof-mark.json" }

  /// Who a request is from, by its proof alone (`AgentRecovery.asker`): devices.json for the key, the wall clock for the frame's time (the
  /// clock the dialog proof is checked on), this app's launch, the replay mark, and the used list in memory and on disk.
  func requestAsker(_ r: AgentRequest) -> AgentRecovery.Asker {
    seedProofs()
    let devices = talosAppHome + "/devices.json"
    let used = recovery.proofsUsed
    let path = restartProofsUsedPath
    return AgentRecovery.asker(
      r, nowMs: options.wallClock(), launchedAtMs: recovery.launchedAtMs, markMs: recovery.proofMarkMs,
      pinnedKey: { DeviceKeys.pinnedKey($0, devicesPath: devices) }, isUsed: { DialogProofsUsed.contains($0, memory: used, path: path) })
  }

  /// The files seed this run once. The mark read back is capped at the launch: a file can only say what came before it, and a session
  /// that writes a far-off mark must not shut the owner's phone out.
  private func seedProofs() {
    guard !recovery.proofsSeeded else { return }
    recovery.proofsSeeded = true
    // the newest 64 at most (the file read itself is capped at 64 KB); they are this list's oldest, so they go first
    recovery.proofsUsed = Array(DialogProofsUsed.read(path: restartProofsUsedPath).suffix(DialogProofsUsed.keep))
    if let n = RestartProofCheck.readMark(probe.readFile(restartProofMarkPath)) {
      recovery.proofMarkMs = max(recovery.proofMarkMs, min(n, recovery.launchedAtMs))
    }
  }

  /// Spends a proof that verified (the owner's, or the owner's with a signed time this Mac does not take): its key into the used list, and
  /// an owner's signed time into the mark. True when the used list was written to disk.
  @discardableResult
  private func consumeProof(_ a: AgentRecovery.Asker) -> Bool {
    let key: String
    var signedMs: Double?
    switch a {
    case .owner(let k, let ms): (key, signedMs) = (k, ms)
    case .clockOff(let k, _): key = k
    case .agent, .badProof: return false
    }
    let home = talosAppHome
    let rec = DialogProofsUsed.record(key, memory: recovery.proofsUsed, path: restartProofsUsedPath) { SafePath.isRealFolder(home) }
    recovery.proofsUsed = rec.memory
    if let ms = signedMs, ms > recovery.proofMarkMs {
      recovery.proofMarkMs = ms
      if SafePath.isRealFolder(home), (try? AtomicFile.write(RestartProofCheck.encodeMark(ms), to: restartProofMarkPath, mode: 0o600)) == nil {
        audit("restart_proof_mark_write_failed", [:])
      }
    }
    return rec.written
  }

  /// For the audit log: what proof a request that was not the owner's carried.
  private static func proofWord(_ a: AgentRecovery.Asker) -> String {
    switch a {
    case .owner: return "unrecorded"
    case .clockOff(_, let why): return why.rawValue
    case .agent, .badProof: return "none"
    }
  }

  /// A request whose proof claims the owner and does not verify: refused whatever the restart check says, audited with the step that
  /// failed (never the proof itself), and the owner told in one fixed line (the refusal lines' own limit).
  private func refuseBadProof(_ r: AgentRequest, step: RestartProofCheck.Step, file: AgentRequestFile) {
    recovery.lastHandledId = r.controlId
    guard AgentRequestFile.clear(path: requestPath, ifStill: file) else { return }
    audit("restart_proof_bad", ["step": step.rawValue])
    requestProofBad(r.controlId)
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

  func postCrashLoopOnce() {
    guard !recovery.crashLoopPosted else { return }
    recovery.crashLoopPosted = true
    postToPhone { CrashPost.text(agentName: $0, at: CrashPost.clockTime(Date())) }
  }

  /// `talos-app post <default thread> <text>` (headless). `text` is built from the agent's name. Used by the crash-loop post too.
  /// With no `talos-app`, no thread (a damaged `config.json` names none), or a post that failed, the Mac posts the line itself
  /// (`postSystemRow`), so the owner is told whatever state `config.json` is in. That row is drawn as Talos's own notice, so
  /// it carries nothing the agent chose: the line is built with no agent name (`config.json` is the agent's to write), and a
  /// line with screen text in it (`asMac: false`) never goes that way. Whether a post was started; the answers arrive in the
  /// audit log (`post ok=`, `system_row result=`).
  @discardableResult
  /// `done` runs on the queue once the post has finished, whichever way (also at once when nothing was started).
  func postToPhone(asMac: Bool = true, _ text: (String?) -> String, done: (@Sendable () -> Void)? = nil) -> Bool {
    let env = launchEnv()
    let found = resolveTalosApp(env: env)
    let app = CrashPost.readAppConfig(probe.readFile(talosAppHome + "/config.json"))
    let line = text(app.agentName)
    let macLine = asMac ? text(nil) : nil
    guard let cmd = found.command, let thread = config.notifyThread ?? app.defaultThread else {
      audit("post_skipped", ["why": found.command == nil ? found.why : "no default thread"])
      defer { done?() }
      guard let macLine else { return false }
      return postSystemRow(macLine, thread: config.notifyThread ?? app.defaultThread, env: env)
    }
    let text = line
    let probe = self.probe
    let queue = q
    let me = WeakRef(self)
    options.background {  // as the restore: not the shared dispatch pool
      let outcome = probe.postOutcome(command: cmd, thread: thread, text: text, env: env)
      queue.sync {
        me.value?.audit("post", ["ok": outcome == .sent ? "1" : "0"])
        // refused (a config.json the CLI can't load, say): the Mac's own row; a timeout may have been sent, so never twice
        if outcome == .failed, let macLine { me.value?.postSystemRow(macLine, thread: thread, env: env) }
        done?()
      }
    }
    return true
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
