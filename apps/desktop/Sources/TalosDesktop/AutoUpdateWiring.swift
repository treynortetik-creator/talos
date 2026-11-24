import Foundation
import Network
import OSLog
import os
import TalosDesktopCore
import TalosSupervisor

/// The app's own updater (`AutoUpdater`), hung on the controller: desktop.json's switch and feed, the clone the app uses, the quiet rule
/// (Main and every thread session quiet, and no background work under any of their panes), and the line into the default thread.
extension SupervisorController {
  /// Runs the updater's timer (the automatic checks and installs) and asks the "Allow Talos to update itself?" question: only for a set-up
  /// Talos, at launch or the moment setup finishes. Safe to call again; every part is done once.
  func startAutoUpdater() {
    guard !supervisor.status.configUnreadable else { return }
    _ = rebuildUpdaterIfHomeMoved()
    prepareAutoUpdater()
    wireClonePrompts()
    guard !autoUpdaterStarted else { return }
    autoUpdaterStarted = true
    autoUpdater?.start()
  }

  /// The updater was built for the Talos home that was in force then (its update folder, status file and swap record live there). Setup
  /// (Import, Adopt) can change that home; a later check, update and health gate must use the new one. Rebuilt when the home moved,
  /// with its timer started again if it was running; not while an update is waiting, being fetched or going in (its record is in the
  /// old home), in which case the next look tries again. True when it was rebuilt.
  @discardableResult
  func rebuildUpdaterIfHomeMoved() -> Bool {
    guard let old = autoUpdater, !supervisor.status.configUnreadable else { return false }
    let wanted = Self.talosHome(cfg: supervisor.currentConfig(), env: launchEnv)
    guard wanted != autoUpdaterHome else { return false }
    let s = old.status
    guard !s.isBusy, s.pendingVersion == nil, s.allowClone == nil else { return false }
    let wasStarted = autoUpdaterStarted
    old.stop()
    autoUpdater = nil
    autoUpdaterStarted = false
    clonePromptsWired = false  // its folders to refuse were worked out from the old home
    prepareAutoUpdater()
    if wasStarted { startAutoUpdater() }
    return true
  }

  /// The folders no recorded clone may live in, and the watch that asks about a clone nobody accepted. Idempotent, and never skipped by
  /// the updater having been built earlier (`prepareAutoUpdater` runs first): without `unsafe` an unsafe folder could be accepted.
  func wireClonePrompts() {
    guard !clonePromptsWired else { return }
    clonePromptsWired = true
    let sup = supervisor
    let c = sup.currentConfig()
    let home = Self.talosHome(cfg: c, env: launchEnv)
    CloneConfirmCenter.shared.unsafe = { [home, c] in
      [home, c.expandedAgentDir(home: NSHomeDirectory()), Self.supportDir, NSTemporaryDirectory(), "/tmp"]
    }
    CloneConfirmCenter.shared.onAccepted = { UpdateController.shared.recheckAfterAllow() }
    let look = cloneLook()
    let log = Logger(subsystem: "app.talos.desktop", category: "allow-updates")
    AllowUpdatesWatch.start {
      let l = look()
      if case .keychainUnreadable(let s) = l { log.error("keychain unreadable for the accepted clone (status \(s, privacy: .public)); not asking") }
      if case .ask(let clone) = l { return clone }
      return nil
    }
  }

  /// A recorded clone nobody accepted: the owner is asked, never assumed. Not asked when automatic updates are off, nor when the
  /// Keychain could not be read (that is not a "no": it is said in the update window).
  private func cloneLook() -> @Sendable () -> AllowUpdatesLook {
    let sup = supervisor
    let home = Self.talosHome(cfg: sup.currentConfig(), env: launchEnv)
    return {
      guard !sup.status.configUnreadable else { return .nothing }
      let c = sup.currentConfig()
      guard c.autoUpdate else { return .nothing }
      let unsafe = [home, c.expandedAgentDir(home: NSHomeDirectory()), Self.supportDir, NSTemporaryDirectory(), "/tmp"]
      return AllowUpdatesLook.make(
        record: AgentFolderSetup.recordedCheckout(in: AutoSetup.recordFolders(home: NSHomeDirectory())), read: KeychainCloneAcceptance().read(),
        unsafe: unsafe)
    }
  }

  /// Builds the updater without starting its timer, so "Check for Updates" can look at the release feed from the first launch on:
  /// before sign-in, with no agent running and with automatic updates off. Nothing is downloaded or installed until the timer runs
  /// (a set-up Talos).
  func prepareAutoUpdater() {
    guard autoUpdater == nil else { return }
    let sup = supervisor
    let box = workerBox
    let env = launchEnv
    let cfg = sup.currentConfig()
    let home = Self.talosHome(cfg: cfg, env: env)
    autoUpdaterHome = home
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
        var threadPanes: [Int32] = []
        if let m = box.manager {
          let w = m.autoUpdateLook()
          why += w.notQuiet
          threadPanes += w.panes
        }
        let main = sup.autoUpdateLook()
        why += main.notQuiet
        // background work is told apart by whose pane it runs under: an Update now waits for both (Main's and a thread's, up to the same 2 hours), and only Update now anyway skips a thread's
        if let p = main.pane, let bg = ProcTable.reason(panes: [p]) { why.append(bg) }
        if let bg = ProcTable.reason(panes: threadPanes) { why.append(AutoUpdate.threadBackgroundReason + bg.dropFirst("background work".count)) }
        return why
      },
      post: { text in sup.postAutoUpdateLine(text) },
      env: { box.manager?.loginEnvironment() ?? env })
    hooks.threadName = { id in box.manager?.displayName(ofThread: id) ?? id }
    let look = cloneLook()
    hooks.unacceptedClone = {
      if case .ask(let clone) = look() { return clone }
      return nil
    }
    hooks.keychainProblem = {
      if case .keychainUnreadable(let s) = look() { return AllowUpdatesCopy.keychainUnreadable(s) }
      return nil
    }
    hooks.offerClone = { clone, version in Task { @MainActor in CloneConfirmCenter.shared.request(clone, version: version) } }
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
    hooks.draftPlan = { sup.draftPlanForUpdate() }
    hooks.draftFingerprint = { sup.draftFingerprintForUpdate() }
    hooks.draftPartial = { sup.draftIsPartialForUpdate() }
    hooks.keepDraft = { version in sup.keepDraftForUpdate(version: version) }
    hooks.draftSettled = { version, outcome in
      Task { @MainActor in DraftNoticeCenter.shared.settled(version: version, outcome: outcome) }
    }
    hooks.offline = { AutoUpdateWiring.isOffline() }
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
      DraftNoticeCenter.shared.path = { sup.draftNotePath }
      DraftNote.expire(path: sup.draftNotePath)
      UpdateController.shared.isSetUp = { [weak self] in self?.configured ?? false }
      UpdateController.shared.probe = { u.probe() }
      UpdateController.shared.updatesAreOn = { !sup.status.configUnreadable && sup.currentConfig().autoUpdate }
      UpdateController.shared.apply(u.status)
    }
  }
}

enum AutoUpdateWiring {
  /// True when the Mac has no network path at all right now (asked only after a fetch failed; at most one second).
  static func isOffline() -> Bool {
    let monitor = NWPathMonitor()
    let got = DispatchSemaphore(value: 0)
    let result = OSAllocatedUnfairLock(initialState: NWPath.Status?.none)
    monitor.pathUpdateHandler = { p in
      result.withLock { $0 = p.status }
      got.signal()
    }
    monitor.start(queue: DispatchQueue(label: "app.talos.update-offline"))
    defer { monitor.cancel() }
    guard got.wait(timeout: .now() + 1) == .success else { return false }
    return result.withLock { $0 } == .unsatisfied
  }

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
