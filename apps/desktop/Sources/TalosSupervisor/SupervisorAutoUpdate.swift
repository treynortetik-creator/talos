import Foundation
import TalosDesktopCore

/// Main's half of the app updater's quiet rule (`AutoUpdater`), and its line to the owner.
extension Supervisor {
  /// Why Main is not quiet now (empty: quiet), and its pane's process to look under for background work (nil: no Main running).
  /// Quiet: running and idle as the last `claude agents` poll says it (or, with no answer from it, no output on the pane for the busy
  /// window), nothing asking the owner, nothing typed in its box, and no key in an attached client for `keysQuiet`. Anything that cannot
  /// be read is not quiet. Not running at all (stopped, or never started) is quiet: nothing there can be cut.
  public func autoUpdateLook(keysQuiet: Double = AutoUpdate.keysQuiet, busyWindow: Double = 15) -> (notQuiet: [String], pane: Int32?) {
    q.sync {
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
        if PointerTyper.draftPresent(rows: rows) { why.append("main has a draft") }
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
