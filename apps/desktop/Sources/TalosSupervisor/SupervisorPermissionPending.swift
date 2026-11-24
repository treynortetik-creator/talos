import Foundation
import TalosDesktopCore

/// A permission-mode change the agent asked for, already saved, that waits for Main to finish before Talos restarts it.
struct PermissionPending: Equatable {
  var mode: PermissionMode
  /// The supervisor's clock when the change was saved: only an agent list whose look BEGAN after this counts.
  var since: Double
  /// The owner was told once that background work is what holds it.
  var bgTold = false
  /// Quiet looks in a row, each from a different, newer agent-list look, and the newest one counted.
  var quietLooks = 0
  var lastLook: Double = -.infinity
}

extension Supervisor {
  /// Quiet looks in a row before the restart (the updater's rule, `AutoUpdate.quietLooks`).
  static let pendingQuietLooks = AutoUpdate.quietLooks

  /// A test hands in the process list the pending change reads for background work (the real list holds the fake agent's own `sleep`).
  public func useProcessTable(_ table: @escaping @Sendable () -> [BackgroundWork.Proc]?) {
    q.sync { recovery.procTable = table }
  }

  var pendingMarkerPath: String {
    (options.configPath as NSString).deletingLastPathComponent + "/" + PermissionPendingMarker.fileName(session: options.name)
  }

  /// Saved and waiting: in memory, and in the marker file so an app that is closed and opened meanwhile keeps waiting. A marker that
  /// cannot be written is logged; the wait still holds for this run, and the saved mode applies at the next start anyway.
  func armPermissionWait(_ mode: PermissionMode) {
    if recovery.permissionPending?.mode == mode { return }
    recovery.permissionPending = PermissionPending(mode: mode, since: clock.now())
    do {
      try AtomicFile.write(PermissionPendingMarker.encode(mode: mode, savedAtMs: options.wallClock()), to: pendingMarkerPath, mode: 0o600)
    } catch { audit("permission_mode_marker_write_failed", [:]) }
  }

  /// The wait is over or was never needed: memory and file.
  func clearPermissionWait() {
    recovery.permissionPending = nil
    try? FileManager.default.removeItem(atPath: pendingMarkerPath)
  }

  /// Once per launch (an attach included): a marker left by an earlier run of the app arms the wait again when the saved mode is still
  /// the one it names and the running launch does not have it (a launch whose arguments are not known counts as not having it);
  /// otherwise it is stale and removed. A marker that does not read is none.
  private func rearmPermissionWait() {
    guard phase == .running, holdsSessionLock, let l = launch, recovery.markerLookedFor != l.childPid else { return }
    recovery.markerLookedFor = l.childPid
    guard FileManager.default.fileExists(atPath: pendingMarkerPath) else { return }
    guard let mode = PermissionPendingMarker.parse(probe.readFile(pendingMarkerPath)) else {
      try? FileManager.default.removeItem(atPath: pendingMarkerPath)
      return
    }
    let runsIt = l.launchedArgs.map(PermissionModeSetting.read) == .mode(mode)
    guard PermissionModeSetting.read(config.args) == .mode(mode), !runsIt else { return clearPermissionWait() }
    recovery.permissionPending = PermissionPending(mode: mode, since: clock.now())
    audit("permission_mode_pending_rearmed", ["mode": mode.rawValue])
  }

  /// One tick of a saved change that waits (`permissionModeTick` saved it). Restarts Main once it is quiet: no turn, no background work,
  /// no question on screen, nothing typed, whichever way the change goes: nothing it is doing is cut. "Quiet" is judged only by agent-list
  /// looks that BEGAN after the change was saved, and `pendingQuietLooks` different ones in a row: the last look before the request may
  /// say idle for a turn that began since. A change is dropped when it no longer matters: Main stopped or blocked, the owner chose
  /// another mode, or Main already runs in it.
  func permissionPendingTick(_ now: Double) {
    rearmPermissionWait()
    guard let p = recovery.permissionPending else { return }
    func drop(_ why: String) {
      clearPermissionWait()
      audit("permission_mode_pending_dropped", ["why": why])
    }
    switch phase {
    case .idle, .blocked, .stopped: return drop("not_running")  // the saved mode applies at the next start
    case .starting, .cleaningUp, .waitingToRestart, .stopping: return ownerStopped ? drop("owner_stopped") : ()
    case .running: break
    }
    guard holdsSessionLock, !ownerStopped else { return drop("not_ours") }
    guard PermissionModeSetting.read(config.args) == .mode(p.mode) else { return drop("saved_mode_changed") }
    if launch?.launchedArgs.map(PermissionModeSetting.read) == .mode(p.mode) { return drop("already_running") }
    // not quiet, or no look since the save yet: the count starts again
    func notYet() { recovery.permissionPending?.quietLooks = 0 }
    let look = quietLookLocked()
    guard look.notQuiet.isEmpty, status.agentActivity == "idle" else { return notYet() }
    if let pane = look.pane, ProcTable.reason(panes: [pane], table: recovery.procTable()) != nil {
      notYet()
      // the one thing in the way is background work: said once
      if !p.bgTold {
        recovery.permissionPending?.bgTold = true
        if !postToPhone({ _ in PermissionModeSetting.heldByBackgroundLine }) { audit("permission_mode_phone_line_not_sent", ["mode": p.mode.rawValue]) }
      }
      return
    }
    let fresh = recovery.freshPollStart
    guard fresh > p.since else { return }  // the list says idle, but it was asked for before the change: it may be stale
    if fresh != p.lastLook {
      recovery.permissionPending?.lastLook = fresh
      recovery.permissionPending?.quietLooks += 1
    }
    guard (recovery.permissionPending?.quietLooks ?? 0) >= Self.pendingQuietLooks else { return }
    recovery.permissionPending = nil  // the marker stays until a launch that runs the mode has been seen
    audit("permission_mode_restart", ["mode": p.mode.rawValue])
    restartColdIfLive()
  }
}
