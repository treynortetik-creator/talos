import Foundation
import OSLog
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
        let c = sup.currentConfig()
        let unsafe = [home, c.expandedAgentDir(home: NSHomeDirectory()), Self.supportDir, NSTemporaryDirectory(), "/tmp"]
        // a recorded clone is used only when its path was accepted (the owner's yes, or this app's own after making it)
        return AgentFolderSetup.updaterCheckout(
          stamped: plist, record: AgentFolderSetup.recordedCheckout(in: AutoSetup.recordFolders(home: NSHomeDirectory())),
          accepted: KeychainCloneAcceptance().accepted(), unsafe: unsafe)
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
    // a recorded clone nobody accepted (an install.sh run, or an install from before): the owner is asked, never assumed. Not asked when
    // automatic updates are off, nor when the Keychain could not be read (that is not a "no": it is said in the update window).
    let log = Logger(subsystem: "app.talos.desktop", category: "allow-updates")
    let look: @Sendable () -> AllowUpdatesLook = {
      guard !sup.status.configUnreadable else { return .nothing }
      let c = sup.currentConfig()
      guard c.autoUpdate else { return .nothing }
      let unsafe = [home, c.expandedAgentDir(home: NSHomeDirectory()), Self.supportDir, NSTemporaryDirectory(), "/tmp"]
      return AllowUpdatesLook.make(
        record: AgentFolderSetup.recordedCheckout(in: AutoSetup.recordFolders(home: NSHomeDirectory())), read: KeychainCloneAcceptance().read(),
        unsafe: unsafe)
    }
    hooks.unacceptedClone = {
      if case .ask(let clone) = look() { return clone }
      return nil
    }
    hooks.keychainProblem = {
      if case .keychainUnreadable(let s) = look() { return AllowUpdatesCopy.keychainUnreadable(s) }
      return nil
    }
    hooks.offerClone = { clone, version in Task { @MainActor in CloneConfirmCenter.shared.request(clone, version: version) } }
    Task { @MainActor in
      let c = sup.currentConfig()
      CloneConfirmCenter.shared.unsafe = { [home, c] in
        [home, c.expandedAgentDir(home: NSHomeDirectory()), Self.supportDir, NSTemporaryDirectory(), "/tmp"]
      }
      CloneConfirmCenter.shared.onAccepted = { UpdateController.shared.checkAgain() }
    }
    AllowUpdatesWatch.start {
      let l = look()
      if case .keychainUnreadable(let s) = l { log.error("keychain unreadable for the accepted clone (status \(s, privacy: .public)); not asking") }
      if case .ask(let clone) = l { return clone }
      return nil
    }
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
    // what the update window and the menu show: every step the updater takes
    hooks.onStatus = { s in Task { @MainActor in UpdateController.shared.apply(s) } }
    // the build the relay serves now (its /healthz `version`), for "the relay is behind"; nothing is claimed when it cannot be read
    hooks.relayBuild = {
      let c = sup.currentConfig()
      guard
        let relay = RelayConfig.resolve(
          configured: c.relayUrl, configEnv: c.env, processEnv: ProcessInfo.processInfo.environment, userHome: NSHomeDirectory(),
          read: { try? String(contentsOfFile: $0, encoding: .utf8) })
      else { return nil }
      guard let d = CappedFetch.data(relay.url.appending(path: "healthz"), 16_384, 8) else { return nil }
      return AutoUpdateWiring.relayVersion(d)
    }
    let u = AutoUpdater(options: o, hooks: hooks)
    autoUpdater = u
    Task { @MainActor in
      UpdateController.shared.updater = u
      UpdateController.shared.apply(u.status)
    }
    u.start()
  }
}

enum AutoUpdateWiring {
  /// `version` from a relay's /healthz answer (`{"ok": true, "version": "..."}`); nil for anything else. One line, at most 80 characters.
  static func relayVersion(_ body: Data) -> String? {
    guard let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], o["ok"] as? Bool == true,
      let v = o["version"] as? String
    else { return nil }
    let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty || t.count > 80 || t.contains(where: \.isNewline) ? nil : t
  }

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
