import Foundation
import TalosDesktopCore

/// What the supervisor keeps for `main-restart-check.json`. Queue-confined with the rest of `RecoveryState`.
struct RestartCheckState {
  /// Monotonic time of the last write; nil before the first.
  var writtenAt: Double?
  /// Something in `last` changed: write at this tick, not at the next 5 s.
  var dirty = false
  /// The last write failed and was logged; the next failure is not logged again (a write is tried every 5 s).
  var writeFailing = false
  /// `last` was read back from the file a previous run of the app wrote (once, at the first write).
  var loaded = false
  var last: MainRestartCheck.Last?
  /// The request whose restart is being followed: from when it was acted on (monotonic) until it came back or the next request.
  var following: Following?
  /// How often the request lines go out, and the one post in flight (`MainRestartCheck.PhoneLines`).
  var lines = MainRestartCheck.PhoneLines()
  /// The dialog Main sits on at the Mac, and since when (unix seconds, first seen by this tick): `needs_you` in the file.
  var needsYou: (kind: String, since: Double)?
  /// The usage-limit screen's reset (unix seconds), worked out when it appeared: `needs_you.resets_at`, written only under that kind.
  var resetsAt: Double?

  struct Following {
    var controlId: String
    var actedAt: Double
    /// The one phone line about a stall (or the dev-channel line `postDevWaitingToPhone` already sent) has gone out.
    var phoneTold = false
  }
}

/// `$TALOS_APP_HOME/main-restart-check.json` (docs/bridge.md; `MainRestartCheck` decides): on the supervisor's own tick, at most every
/// `Timings.restartCheckEvery` (5 s) and at once when a request's outcome changes. Only the copy holding the session lock writes it, as only
/// that copy acts on a request; a second copy of the app writes nothing, so the file goes stale rather than say what the other copy would do.
extension Supervisor {
  var restartCheckPath: String { talosAppHome + "/" + MainRestartCheck.fileName }

  /// The dialog Main waits on the owner for, by name: one Talos never answers, or its startup warning held. The alarms that are not a
  /// dialog (stuck, not reading, no bridge, no relay) are what a restart is for, so they are not "needs you" here.
  static func mainNeedsYouKind(_ n: NeedsYou?) -> String? {
    switch n {
    case .dialog(let label)?: return label
    case .confirmColdStart?, .restartNotConfirmed?: return MainRestartCheck.devWarningLabel
    case .stuck?, .startStalled?, .bridgeNotLive?, .relayUnreachable?, .notReading?, nil: return nil
    }
  }

  func restartCheckTick(_ now: Double) {
    guard holdsSessionLock else { return }
    followRequest(now)
    let kind = Self.mainNeedsYouKind(needsYou)
    if kind != recovery.restartCheck.needsYou?.kind {
      recovery.restartCheck.needsYou = kind.map { ($0, options.wallClock() / 1000) }
      recovery.restartCheck.dirty = true
    }
    let due = recovery.restartCheck.writtenAt.map { abs(now - $0) >= timings.restartCheckEvery } ?? true
    guard due || recovery.restartCheck.dirty else { return }
    writeRestartCheck(now)
  }

  /// The answer, from the same inputs the next start would use: the launch env, `claude` as a start resolves it, the seal over the
  /// fingerprint `launchLocked` would store, the cold-start budget, the typing check `devDialogInputs` uses, Stop and the gap.
  func restartCheckVerdict(_ now: Double) -> MainRestartCheck.Verdict {
    guard !configUnreadable else { return MainRestartCheck.unknownVerdict }
    let env = launchEnv()
    let claude = whichClaude(env: env)
    var isDir: ObjCBool = false
    let folder = config.expandedAgentDir(home: options.home)
    let blocked: Bool = { if case .blocked = phase { return true } else { return false } }()
    let enabled = config.autoConfirmRestart
    let expects = config.args.contains("--dangerously-load-development-channels")
    let inputs = MainRestartCheck.Inputs(
      configReadable: true, claudeFound: claude != nil,
      folderExists: FileManager.default.fileExists(atPath: folder, isDirectory: &isDir) && isDir.boolValue,
      sessionIdValid: config.session.id.map(ResumeRewrite.isUUID) ?? true, expectsDevDialog: expects,
      autoConfirm: enabled, isMain: options.name == TmuxCommands.mainSession,
      launchedChannels: AutoConfirmGuard.channels(inArgv: config.args),
      seal: claude.map { MainRestartCheck.seal(config, resolvedClaude: $0, trust: options.launchTrust) } ?? .launchChanged,
      // read only when it could matter, as the guard's own input is: a tmux call
      clientsMayBeTyping: expects && enabled && clientsMayBeTyping(), coldLoop: coldLoop, now: now, takeoverHeld: blocked,
      ownerStopped: ownerStopped,
      // the file answers for an agent's request, which is held to both stamps
      sinceLastRequest: recovery.sinceLastRequest(owner: false, awake: options.awake()))
    return MainRestartCheck.decide(inputs)
  }

  private func writeRestartCheck(_ now: Double) {
    let path = restartCheckPath
    if !recovery.restartCheck.loaded {
      recovery.restartCheck.loaded = true
      // A relaunch keeps what came of the last request: read back strictly, and only when this run has none of its own. The file may
      // have been forged since (the guards stop a session's direct routes to it, not a determined process), so only the outcome, the id
      // and the time come back, and `detail` only when it is one of this app's own labels: no text of anyone else's is served again.
      if recovery.restartCheck.last == nil {
        recovery.restartCheck.last = MainRestartCheck.Last.parse(probe.readFile(path)).map(MainRestartCheck.Last.ownLabelsOnly)
      }
    }
    let data = MainRestartCheck.encode(
      at: options.wallClock() / 1000, verdict: restartCheckVerdict(now), last: recovery.restartCheck.last,
      needsYou: recovery.restartCheck.needsYou, resetsAt: recovery.restartCheck.resetsAt)
    recovery.restartCheck.writtenAt = now
    recovery.restartCheck.dirty = false
    do {
      try AtomicFile.write(data, to: path, mode: 0o600)
      if recovery.restartCheck.writeFailing {
        recovery.restartCheck.writeFailing = false
        audit("restart_check_written", [:])
      }
    } catch {
      // the reader then finds the file stale and says no: never a yes that is not there. Logged once per run of failures.
      if !recovery.restartCheck.writeFailing { audit("restart_check_write_failed", ["error": "\(error)"]) }
      recovery.restartCheck.writeFailing = true
    }
  }

  // MARK: what came of a request

  func requestActedOn(_ controlId: String, now: Double) {
    recovery.restartCheck.following = .init(controlId: controlId, actedAt: now)
  }

  /// A refused request, whoever asked: recorded, and the owner told in one line (the Mac's own words: a reason from the closed list).
  /// `mayBeThePhone`: a request with no proof and no thread, as a bridge older than the proof writes for the phone's button; the line
  /// then also says how to restart anyway. `lead`: a fixed line of the Mac's own that goes first (`MainRestartCheck.clockPhoneLine`).
  func requestRefused(_ controlId: String, reason: String, mayBeThePhone: Bool = false, lead: String? = nil) {
    recovery.restartCheck.following = nil
    recordOutcome(.init(controlId: controlId, at: options.wallClock() / 1000, outcome: .refused, detail: reason))
    postRequestLine(.refused) { _ in
      if let lead { return lead + " " + MainRestartCheck.refusedPhoneLine(reason) }
      return mayBeThePhone ? MainRestartCheck.refusedUnprovedPhoneLine(reason) : MainRestartCheck.refusedPhoneLine(reason)
    }
  }

  /// A request whose owner's proof did not verify: recorded as refused (no detail: no reason from the list fits), and one fixed line.
  func requestProofBad(_ controlId: String) {
    recovery.restartCheck.following = nil
    recordOutcome(.init(controlId: controlId, at: options.wallClock() / 1000, outcome: .refused))
    postRequestLine(.refused) { _ in MainRestartCheck.proofBadPhoneLine }
  }

  /// Whether this Mac knows a thread by `id` (config.json or workers.json): only then is the id named in the owner's line.
  func threadIsKnown(_ id: String) -> Bool {
    MainRestartCheck.knownThreadIds(
      configJson: probe.readFile(talosAppHome + "/config.json"), workersJson: probe.readFile(talosAppHome + "/workers.json")
    ).contains(id)
  }

  /// The one way the three request lines go out: spaced and one at a time (`MainRestartCheck.PhoneLines`: at most 30 an hour of each
  /// kind, one `talos-app post` child at a time). A line that may not go is dropped, and the audit log says so.
  func postRequestLine(_ kind: MainRestartCheck.PhoneLine, asMac: Bool = true, _ text: (String?) -> String) {
    guard recovery.restartCheck.lines.take(kind, awake: options.awake()) else {
      audit("restart_line_dropped", ["kind": kind.rawValue, "why": recovery.restartCheck.lines.inFlight ? "in_flight" : "spaced"])
      return
    }
    audit("restart_line_post", ["kind": kind.rawValue])
    let me = WeakRef(self)
    postToPhone(asMac: asMac, text, done: { me.value?.recovery.restartCheck.lines.finished() })
  }

  /// The owner's line for a restart a session asked for and this app is acting on. `why` is the session's text (made plain when read,
  /// `AgentRequest.plainText`), so it never goes out as the Mac's own row (`asMac: false`): only through `talos-app post`.
  func announceAgentRestart(_ r: AgentRequest) {
    let known = r.byThread.map { threadIsKnown($0) }
    postRequestLine(.restarting, asMac: false) { _ in
      MainRestartCheck.restartingPhoneLine(byThread: r.byThread, known: known ?? false, why: r.why, noProof: r.proof == .none)
    }
  }

  private func recordOutcome(_ last: MainRestartCheck.Last) {
    let was = recovery.restartCheck.last
    // the same outcome again is not news (its time stays the first sighting's)
    if let was, was.controlId == last.controlId, was.outcome == last.outcome, was.detail == last.detail { return }
    recovery.restartCheck.last = last
    recovery.restartCheck.dirty = true
    audit("restart_outcome", ["id": last.controlId, "outcome": last.outcome.rawValue, "detail": last.detail ?? ""])
  }

  /// Each tick while a request's restart is followed: `came_back` once its start is running (the warning answered, or none expected),
  /// `stalled` while it waits for the owner (a dialog Talos does not answer, its warning held, a start that shows nothing known, a start
  /// that could not be made). A stall that the owner then answers ends as `came_back`. The first stall of any kind also sends the phone
  /// one line naming it (`postToPhone`: `talos-app post`, run by this app, so no bridge of Main's is needed), unless the dev-channel line
  /// already went.
  private func followRequest(_ now: Double) {
    guard var f = recovery.restartCheck.following else { return }
    defer { if recovery.restartCheck.following != nil { recovery.restartCheck.following = f } }
    // every stall is recorded; the first one of a request also tells the owner in one line (unless the dev-channel line already went)
    let stall = { (detail: String) in
      self.recordOutcome(.init(controlId: f.controlId, at: self.options.wallClock() / 1000, outcome: .stalled, detail: detail))
      if self.launch?.devCard.phonePosted == true, f.actedAt <= (self.launch?.startedAt ?? -.infinity) { f.phoneTold = true }
      guard !f.phoneTold else { return }
      f.phoneTold = true
      self.postRequestLine(.stalled) { _ in MainRestartCheck.stallPhoneLine(detail) }
    }
    guard let l = launch, l.startedAt >= f.actedAt else {
      // no start of its own yet: the restart's stop is still running, or the start could not be made
      switch phase {
      case .blocked: stall(MainRestartCheck.stallBlocked)
      case .stopped(let r) where r != .user: stall(MainRestartCheck.stallNotStarted)
      default: break
      }
      return
    }
    if phase == .running, cameBack(l, now) {
      recordOutcome(.init(controlId: f.controlId, at: options.wallClock() / 1000, outcome: .cameBack))
      recovery.restartCheck.following = nil
      return
    }
    switch needsYou {
    case .dialog(let label)?: stall(label)
    case .confirmColdStart?, .restartNotConfirmed?: stall(MainRestartCheck.devWarningLabel)
    case .startStalled?: stall(MainRestartCheck.stallNothingKnown)
    default: break
    }
  }

  /// Ready, as the start itself judges it: `.running` alone is not (a launch with no dev-channel flag is `.running` from its spawn, with
  /// folder trust possibly still to come). A readable screen with no dialog on it, and Claude's input box up (`claudeIsReady`), or, for a
  /// pane that draws no box Talos knows, nothing for `noticeWait` since the spawn (the start's own "ready without the dialog" rule).
  private func cameBack(_ l: Launch, _ now: Double) -> Bool {
    if l.expectsDevDialog, !l.dialogAnswered { return false }
    guard let rows = host.visibleRows() else { return false }
    let live = DialogMatcher.liveDialog(rows)
    if DialogMatcher.classify(rows).isDialog || live != .none { return false }
    return Self.claudeIsReady(rows: rows, live: live, warningLive: DialogMatcher.liveDevChannels(rows))
      || now - l.startedAt >= timings.noticeWait
  }
}
