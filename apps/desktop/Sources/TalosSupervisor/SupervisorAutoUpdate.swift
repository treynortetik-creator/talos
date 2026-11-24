import CryptoKit
import Foundation
import TalosDesktopCore

/// Main's half of the app updater's quiet rule (`AutoUpdater`), and its line to the owner.
extension Supervisor {
  /// Why Main is not quiet now (empty: quiet), and its pane's process to look under for background work (nil: no Main running).
  /// Quiet: running and idle as the last `claude agents` poll says it (or, with no answer from it, no output on the pane for the busy
  /// window), nothing asking the owner, nothing typed in its box, and no key in an attached client for `keysQuiet`. Anything that cannot
  /// be read is not quiet. Not running at all (stopped, or never started) is quiet: nothing there can be cut.
  public func autoUpdateLook(keysQuiet: Double = AutoUpdate.keysQuiet, busyWindow: Double = 15) -> (notQuiet: [String], pane: Int32?) {
    q.sync { quietLookLocked(keysQuiet: keysQuiet, busyWindow: busyWindow) }
  }

  /// `autoUpdateLook` for a caller already on the queue (the permission change that waits for Main to finish).
  func quietLookLocked(keysQuiet: Double = AutoUpdate.keysQuiet, busyWindow: Double = 15) -> (notQuiet: [String], pane: Int32?) {
    do {
      switch phase {
      case .idle, .blocked, .stopped: return ([], nil)
      case .starting, .cleaningUp, .waitingToRestart, .stopping: return (["main \(Self.phaseWord(phase))"], status.childPid)
      case .running: break
      }
      let pane = status.childPid
      var why: [String] = []
      if needsYou != nil || status.devDialog != nil || launch?.promptWatch.current != nil { why.append("main needs the owner") }
      let wall = options.wallClock() / 1000
      switch status.agentActivity {
      case "idle": break
      case nil:
        guard let out = host.lastOutputAt()?.timeIntervalSince1970 else {
          why.append("main unreadable")
          break
        }
        if wall - out < busyWindow { why.append("main busy") }
      default: why.append("main \(status.agentActivity ?? "busy")")
      }
      if let rows = host.visibleRows() {
        if PointerTyper.draftPresent(rows: rows) { why.append(AutoUpdate.mainDraftReason) }
      } else {
        why.append("main unreadable")
      }
      if let keys = host.clientActivities() {
        if keys.contains(where: { wall - $0 < keysQuiet }) { why.append("main keys") }
      } else {
        why.append("main unreadable")
      }
      return (why, pane)
    }
  }

  private static func phaseWord(_ p: Phase) -> String {
    switch p {
    case .starting: return "starting"
    case .cleaningUp: return "cleaning up"
    case .waitingToRestart: return "waiting to restart"
    case .stopping: return "stopping"
    default: return "busy"
    }
  }

  /// After an update: Main still runs the old bridge (a tmux Main lives on across the app swap), so the new app restarts it onto the
  /// release's code, the same cold restart the menu's Restart and the guard refresh use. Once per commit, only while Main runs and
  /// this app holds its lock, nobody is typing in an attached client, and the restart check says Main would come back.
  public func restartForUpdate(commit: String) { _ = restartMain(onto: commit) }

  /// Main cold-restarted onto the code now in the checkout (`commit`), as the menu's Restart does: after an update, and after the
  /// health gate rolled the app back while Main still runs the release's bridge. Once per commit. `notYet`: Main is starting or
  /// somebody is typing (ask again later); `refused`: the restart check says Main would not come back; `notNeeded`: no Main runs
  /// (the next start takes the checkout as it is) or this app does not hold its lock.
  public func restartMain(onto commit: String) -> AutoUpdate.MainRestart {
    q.sync {
      if updateRestartedFor == commit { return .started }
      switch phase {
      case .idle, .blocked, .stopped: return .notNeeded
      case .starting, .cleaningUp, .waitingToRestart, .stopping: return .notYet
      case .running: break
      }
      guard holdsSessionLock, !ownerStopped else { return .notNeeded }
      guard !clientsMayBeTyping() else { return .notYet }
      guard restartCheckVerdict(clock.now()).willReturn else { return .refused }
      updateRestartedFor = commit
      audit("update_restart_main", ["commit": String(commit.prefix(12))])
      restartCold()
      return .started
    }
  }

  /// Before a swap: on a tmux host Main lives on across the app swap and the new app must restart it onto the release, so the
  /// restart check must say Main would come back (else every good release would fail its health gate). A direct host's Main ends
  /// with the app, so it starts fresh anyway.
  public func mainCanRestartForUpdate() -> Bool {
    q.sync { host.kind != .tmux || restartCheckVerdict(clock.now()).willReturn }
  }

  /// The updater's one line into the default thread, through the same path as the crash-loop line: `talos-app post`, else the Mac's
  /// own signed system row. The text is the app's own (`AutoUpdate.updatedLine`, `failedLine`), never anything the agent wrote.
  public func postAutoUpdateLine(_ text: String) {
    q.async {
      self.audit("auto_update_line", [:])
      _ = self.postToPhone { _ in text }
    }
  }
}

/// An Update now overrides unsent text in Main's box: a copy is saved right before the swap and, once the update really happened, shown
/// to the owner (`DraftNote`, the notice with Copy and Dismiss). Nothing ever types it back into the box. A box that cannot be read, or
/// a file that cannot be written, is said plainly beforehand (`UpdateStatus.DraftPlan.cannotKeep`) and the update still goes ahead.
extension Supervisor {
  /// Where the copy lives: the update folder (the app's own, beside pending.json).
  public var draftNotePath: String { talosAppHome + "/auto-update/main-draft.json" }

  /// The unsent text in Main's box as the screen shows it, one clean line, and whether it may be only part of it: nil when the box cannot
  /// be read, "" when it is empty. The screen is all there is to read, so this is never promised to be exact.
  func mainDraftRead() -> (text: String, partial: Bool)? {
    guard let rows = host.visibleRows(), let raw = PointerTyper.boxText(rows: rows), let box = PointerTyper.inputBox(rows: rows) else { return nil }
    let text = DraftNote.clean(raw)
    // the box's top rule is the first row of the pane: older lines of a long draft have scrolled out of sight
    return (text, DraftNote.looksPartial(text: text, boxStartsAtTop: box.lowerBound <= 1))
  }

  /// A fingerprint of the unsent text in Main's box (never the text), for telling whether it changed between two looks; nil: unreadable.
  public func draftFingerprintForUpdate() -> String? {
    q.sync {
      guard phase == .running, let d = mainDraftRead() else { return nil }
      return SHA256.hash(data: Data(d.text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
  }

  /// True when the box's text may be only part of the draft (a copy of it would not be whole).
  public func draftIsPartialForUpdate() -> Bool {
    q.sync { phase == .running ? (mainDraftRead()?.partial ?? true) : false }
  }

  /// What an Update now would do with Main's draft; nothing is written.
  public func draftPlanForUpdate() -> UpdateStatus.DraftPlan {
    q.sync {
      guard phase == .running else { return .none }  // no Main running: nothing typed there to lose
      guard let d = mainDraftRead() else { return .cannotKeep }
      if d.text.isEmpty { return .none }
      let dir = (draftNotePath as NSString).deletingLastPathComponent
      guard (try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])) != nil,
        FileManager.default.isWritableFile(atPath: dir)
      else { return .cannotKeep }
      return .keep
    }
  }

  /// Saves a copy of Main's draft for the update to `version` (and reads it back). `.none`: nothing to keep.
  public func keepDraftForUpdate(version: String) -> UpdateStatus.DraftPlan {
    q.sync {
      guard phase == .running else { return .none }
      guard let d = mainDraftRead() else {
        audit("draft_keep", ["result": "unreadable"])
        return .cannotKeep
      }
      if d.text.isEmpty { return .none }
      let note = DraftNote(version: version, text: d.text, partial: d.partial, saved_at: Date().timeIntervalSince1970)
      guard DraftNote.write(note, to: draftNotePath) else {
        audit("draft_keep", ["result": "not_written"])
        return .cannotKeep
      }
      audit("draft_keep", ["result": "kept", "chars": "\(d.text.count)", "partial": d.partial ? "1" : "0"])  // never the text
      return .keep
    }
  }
}
