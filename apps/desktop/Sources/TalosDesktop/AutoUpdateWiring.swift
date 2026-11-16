import Foundation
import TalosDesktopCore
import TalosSupervisor

/// The app's own updater (`AutoUpdater`), hung on the controller: desktop.json's switch and feed, the clone the app uses, the quiet rule
/// (Main and every thread session quiet, and no background work under any of their panes), and the line into the default thread.
extension SupervisorController {
  func startAutoUpdater() {
    guard autoUpdater == nil, !supervisor.status.configUnreadable else { return }
    let sup = supervisor
    let box = workerBox
    let env = launchEnv
    let cfg = sup.currentConfig()
    let home = Self.talosHome(cfg: cfg, env: env)
    var o = AutoUpdater.Options(
      talosHome: home, appPath: Bundle.main.bundlePath,
      appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String, keys: ReleaseTrust.keys)
    o.auditLogPath = Self.auditPath
    o.applyScript = Bundle.main.path(forResource: "auto-update-apply", ofType: "sh")
    var hooks = AutoUpdater.Hooks(
      settings: {
        // a desktop.json that cannot be read is never "on": the defaults stand in for it only so the app can say so
        guard !sup.status.configUnreadable else { return (false, nil) }
        let c = sup.currentConfig()
        return (c.autoUpdate, c.updateFeedUrl)
      },
      checkout: {
        let plist = Bundle.main.object(forInfoDictionaryKey: "TalosCheckout") as? String
        guard let repo = plist ?? AgentFolderSetup.recordedCheckout(supportDir: Self.supportDir) else { return nil }
        if plist == nil {
          let c = sup.currentConfig()
          let unsafe = [home, c.expandedAgentDir(home: NSHomeDirectory()), Self.supportDir, NSTemporaryDirectory(), "/tmp"]
          guard AgentFolderSetup.recordedCloneProblem(repo, recordFile: Self.supportDir + "/checkout", unsafe: unsafe) == nil else {
            return nil
          }
        }
        return repo
      },
      look: {
        var why: [String] = []
        var panes: [Int32] = []
        if let m = box.manager {
          let w = m.autoUpdateLook()
          why += w.notQuiet
          panes += w.panes
        }
        let main = sup.autoUpdateLook()
        why += main.notQuiet
        if let p = main.pane { panes.append(p) }
        if let bg = ProcTable.reason(panes: panes) { why.append(bg) }
        return why
      },
      post: { text in sup.postAutoUpdateLine(text) },
      env: { box.manager?.loginEnvironment() ?? env })
    // the owner's newest message, as the live bridge last wrote it: a change during the 2-minute notice postpones the update
    hooks.ownerActivity = { BridgeStatus.decode(FileManager.default.contents(atPath: home + "/status.json") ?? Data())?.lastOwnerAt }
    // the health gate: this app (the new version, once a pending update names it) reports healthy once Main runs under its supervisor
    // and the live bridge is on the relay
    let status: @Sendable () -> BridgeStatus? = { BridgeStatus.decode(FileManager.default.contents(atPath: home + "/status.json") ?? Data()) }
    // after an update: the bridge must run the release's commit, have started after the swap, and be this app's Main's own (its
    // process the supervisor's child or below it, on a tmux host and a direct one alike)
    hooks.healthyAfterUpdate = { commit, since in
      let b = status()
      let main = sup.status.childPid
      let under = b.map { AutoUpdateWiring.descends($0.pid, from: main) } ?? false
      return AutoUpdate.healthyAfterUpdate(
        mainRunning: sup.status.phase == .running, bridge: b, now: Date(), pidAlive: { kill($0, 0) == 0 || errno == EPERM },
        commit: commit, since: Date(timeIntervalSince1970: since), bridgeUnderMain: under)
    }
    hooks.bridgeNotOn = { head in AutoUpdate.bridgeOnOlderCode(status(), commit: head) }
    hooks.restartMainOnto = { head in sup.restartMain(onto: head) }
    hooks.mainCanRestart = { sup.mainCanRestartForUpdate() }
    hooks.restartMainForUpdate = { commit in
      if AutoUpdate.bridgeOnOlderCode(status(), commit: commit) { sup.restartForUpdate(commit: commit) }
    }
    hooks.healthy = {
      AutoUpdate.healthy(
        mainRunning: sup.status.phase == .running,
        bridge: BridgeStatus.decode(FileManager.default.contents(atPath: home + "/status.json") ?? Data()), now: Date(),
        pidAlive: { kill($0, 0) == 0 || errno == EPERM })
    }
    let u = AutoUpdater(options: o, hooks: hooks)
    autoUpdater = u
    u.start()
  }
}

enum AutoUpdateWiring {
  /// `pid` is `ancestor` or below it (its parents walked, at most 32 levels).
  static func descends(_ pid: Int32, from ancestor: Int32?) -> Bool {
    guard let ancestor, ancestor > 1 else { return false }
    var p = pid
    for _ in 0..<32 {
      if p == ancestor { return true }
      guard p > 1, let next = ProcessInspect.basic(p)?.ppid, next != p else { return false }
      p = next
    }
    return false
  }
}
