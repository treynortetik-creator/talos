import Foundation
import TalosDesktopCore

/// The permission mode of Main (Mac settings → Session, or the agent's `permission_mode` tool after the owner asked): the saved
/// launch arguments get ONE permission flag (`PermissionModeSetting`) and a running Main is restarted cold, as the menu's Restart
/// session does. The changed launch is not the one the owner confirmed, so the new start waits at the development-channel dialog for
/// his own confirmation (the launch seal); nothing here confirms it.
extension Supervisor {
  var permissionRequestPath: String { talosAppHome + "/" + PermissionModeRequest.fileName }

  /// Saves the mode's flag in place of the saved one(s), then, with `restart`, restarts cold (both on this queue, in that order, so the
  /// start reads the new arguments). `then` runs on the queue once the arguments are saved.
  public func changePermissionMode(_ mode: PermissionMode, restart: Bool, then: (@Sendable () -> Void)? = nil) {
    mutateConfig(
      { $0.args = PermissionModeSetting.applying(mode, to: $0.args) },
      then: then)
    if restart { restartColdIfLive() }
  }

  /// `restartCold` for a change that only applies to an agent that is up: decided on the queue, at the moment it would run, so an
  /// owner's Stop that came in between is never undone and a stopped agent is never started by a settings change.
  public func restartColdIfLive(before: (@Sendable () -> Void)? = nil) {
    q.async {
      // not on a copy that does not hold the session (`beginStop` would refuse and leave `afterStop` set)
      guard self.holdsSessionLock, self.isLive, !self.ownerStopped else { return }
      let me = WeakRef(self)
      let go = { before?(); me.value?.startColdLocked() }
      self.afterStop = go
      self.beginStop(reason: .user, closeHost: false)
    }
  }

  /// The owner has confirmed exactly this launch (the seal in `desktop.json` verifies): thread sessions may carry its flags.
  public func savedLaunchIsConfirmed(_ c: DesktopConfig, claude: String) -> Bool {
    LaunchSeal.isConfirmed(c, fingerprint: launchFingerprint(c, claude), parts: launchParts(c, claude), trust: options.launchTrust)
  }

  /// The mode label of THIS launch's own arguments (set at the spawn), never of what is saved now: a launch that waits at the dialog
  /// keeps the mode it was started with whatever is written to desktop.json meanwhile.
  var launchStartMode: String? {
    guard let a = launch?.launchedArgs, case .mode(let m) = PermissionModeSetting.read(a) else { return nil }
    return m.label
  }

  /// The saved launch is not the one the running agent started with (`LaunchPending`).
  var launchPendingNow: Bool {
    guard phase == .running || phase == .starting, let l = launch else { return false }
    // what Main would launch with now: the saved arguments with the channels flag every launch carries (`MainChannelFlag`)
    var launching = config
    launching.args = withChannelsFlag(config.args)
    return LaunchPending.isPending(running: l.parts, saved: launching)
  }

  /// One tick: the agent's request file, if there is one. Only the copy that holds the session lock acts (as `recoveryTick`).
  func permissionModeTick(_ now: Double) {
    if phase == .running, let a = launch?.launchedArgs { recovery.confirmedArgs = a }
    let file = PermissionModeRequestFile.read(path: permissionRequestPath)
    guard file != .absent else { return }
    guard holdsSessionLock || tryLock() else { return }
    guard case .request(let r) = file else {
      if PermissionModeRequestFile.clear(path: permissionRequestPath, ifStill: file) { audit("permission_mode_request_ignored", [:]) }
      return
    }
    let awake = options.awake()
    let locked = PermissionModeRequest.isLocked(configJson: probe.readFile(talosAppHome + "/config.json"))
    let decision = PermissionModeRequest.decide(
      r, nowMs: options.wallClock(), lastHandledId: recovery.permissionHandledId, launchedAtMs: recovery.launchedAtMs, locked: locked,
      ownerStopped: ownerStopped, sinceLastRequest: recovery.permissionActedAt.map { awake - $0 })
    switch decision {
    case .discard:
      if PermissionModeRequestFile.clear(path: permissionRequestPath, ifStill: file) { audit("permission_mode_request_ignored", [:]) }
    case .refuse(let why):
      recovery.permissionHandledId = r.controlId
      guard PermissionModeRequestFile.clear(path: permissionRequestPath, ifStill: file) else { return }
      audit("permission_mode_request_refused", ["why": why.rawValue])
      postToPhone { _ in PermissionModeSetting.refusedLine(why) }
    case .apply:
      recovery.permissionHandledId = r.controlId
      guard PermissionModeRequestFile.clear(path: permissionRequestPath, ifStill: file) else { return }
      recovery.permissionActedAt = awake
      guard !configUnreadable else { return audit("permission_mode_request_refused", ["why": "config_unreadable"]) }
      // a launch command with its own permission flags is the owner's: only his own choice in the picker replaces it
      if PermissionModeSetting.read(config.args) == .custom {
        audit("permission_mode_request_refused", ["why": "custom"])
        postToPhone { _ in PermissionModeSetting.refusedLine(.custom) }
        return
      }
      let outcome = PermissionModeSetting.evaluate(r.mode, against: config)
      audit("permission_mode_request", ["mode": r.mode.rawValue, "changed": outcome == .unchanged ? "0" : "1"])
      guard case .updated(let args) = outcome else {
        postToPhone { _ in PermissionModeSetting.alreadyLine(r.mode) }
        return
      }
      config = PermissionModeSetting.applied(config, args: args)
      saveConfig()
      let running = isLive && holdsSessionLock
      // posted whatever else happens (a visible row; for Bypass all it is the owner's only sight of it): a post that cannot start is logged
      if !postToPhone({ _ in PermissionModeSetting.changedLine(r.mode, restarting: running) }) { audit("permission_mode_phone_line_not_sent", ["mode": r.mode.rawValue]) }
      if running { restartColdIfLive() }
    }
  }
}
