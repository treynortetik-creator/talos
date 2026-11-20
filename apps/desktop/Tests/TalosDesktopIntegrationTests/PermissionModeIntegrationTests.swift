import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// The permission mode: the picker's change and the agent's request, each against a real start (real pty, the fake claude, which dumps
/// its argv, `FAKE_ARGV_DUMP`).
@Suite("Permission mode (real pty)", .serialized)
struct PermissionModeIntegrationTests {
  private func rig(_ args: [String], scenario: String = "idle.sh") throws -> (Rig, String) {
    let dump = TestTemp.base + "/talos-d1-\("pmargv")-\(UUID().uuidString.prefix(8))"
    let r = try Rig(.direct, scenario: scenario, env: ["FAKE_ARGV_DUMP": dump]) { $0.args = args }
    return (r, dump)
  }

  private func argv(_ dump: String, _ n: Int) -> [String] {
    ((try? String(contentsOfFile: "\(dump).\(n)", encoding: .utf8)) ?? "").split(separator: "\n").map { String($0.dropFirst().dropLast()) }
  }

  private func cleanup(_ dump: String) { for n in 1...3 { try? FileManager.default.removeItem(atPath: "\(dump).\(n)") } }

  private func runningFirstStart(_ r: Rig) {
    r.start()
    #expect(r.wait(20) { r.sup.tickNow(); return isRunning(r.phase()) && r.starts.count == 1 }, "\(r.phase()), audit: \(r.audit)")
  }

  private func writeRequest(_ r: Rig, _ mode: String, id: String, ageMs: Double = 0) throws {
    let ts = Int(r.clock.wallMs() - ageMs)
    try #"{"v":1,"action":"set_permission_mode","mode":"\#(mode)","control_id":"\#(id)","ts":\#(ts)}"#.write(
      toFile: r.talosHome + "/" + PermissionModeRequest.fileName, atomically: true, encoding: .utf8)
  }

  private func requestIsThere(_ r: Rig) -> Bool { FileManager.default.fileExists(atPath: r.talosHome + "/" + PermissionModeRequest.fileName) }

  // MARK: the picker

  @Test func theChoiceIsSavedAndTheRunningAgentIsRestartedWithTheNewFlagOnly() throws {
    let (r, dump) = try rig(["--dangerously-skip-permissions", "--name", "main"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    r.sup.changePermissionMode(.ask, restart: true)
    #expect(r.wait(30) { r.sup.tickNow(); return r.starts.count == 2 && isRunning(r.phase()) }, "restart requested: \(r.starts), audit: \(r.audit)")
    #expect(r.config.args == ["--permission-mode", "default", "--name", "main"], "\(r.config.args)")
    let a = argv(dump, 2)
    #expect(a.contains("--permission-mode") && a.contains("default") && !a.contains("--dangerously-skip-permissions"), "\(a)")
    #expect(a.filter { $0 == "--permission-mode" }.count == 1)
  }

  /// A saved Bypass is not what thread sessions are held to while Main waits at the development-channel dialog of its new start (nor
  /// in the stop before it): only once Main runs in it.
  @Test func threadSessionsAreNotGivenASavedBypassWhileTheNewStartWaitsAtTheDialog() throws {
    let (r, dump) = try rig(["--permission-mode", "default", "--dangerously-load-development-channels", "server:talos-app"], scenario: "dev-dialog.sh")
    defer { r.teardown(); cleanup(dump) }
    try coldStartConfirmed(r)
    let old = ["--permission-mode", "default", "--dangerously-load-development-channels", "server:talos-app"]
    #expect(r.wait(10) { r.sup.tickNow(); return r.sup.status.runningArgs == old }, "\(r.sup.status.runningArgs as Any)")
    r.sup.changePermissionMode(.bypass, restart: true)
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart }, "the changed launch waits for the owner: \(r.phase())")
    let saved = r.config.args
    #expect(PermissionModeSetting.read(saved) == .mode(.bypass))
    let running = r.sup.status.runningArgs
    #expect(running == old, "while it waits, Main still counts as running with the old arguments")
    #expect(LaunchPending.holdsThreads(saved: saved, running: running, confirmedSaved: r.sup.savedLaunchIsConfirmed(r.config, claude: Rig.fixtures + "/claude")))
    #expect(!r.sup.savedLaunchIsConfirmed(r.config, claude: Rig.fixtures + "/claude"), "the changed launch is not the one the owner confirmed")
    #expect(MainArgs.bypassFlag(LaunchPending.argsForThreads(saved: saved, running: running, pending: true)) == nil, "no bypass flag for a thread session")
    #expect(r.wait(15) { r.screenContains(DialogMatcher.Strings.devTitle) })
    r.humanEnter()
    #expect(r.wait(20) { r.sup.tickNow(); return isRunning(r.phase()) && r.sup.status.runningArgs == saved }, "confirmed: now held to the new ones")
  }

  /// The app opens with Main stopped and a launch the owner confirmed (Bypass): thread sessions keep that flag, and the update round is
  /// not held back (the seal says this exact launch is the owner's).
  @Test func aSealedLaunchIsNotHeldBackWhenNothingHasRunYet() throws {
    let (r, dump) = try rig(["--dangerously-skip-permissions"])
    defer { r.teardown(); cleanup(dump) }
    #expect(r.sup.status.runningArgs == nil)
    #expect(r.sup.savedLaunchIsConfirmed(r.config, claude: Rig.fixtures + "/claude"), "the rig seeds a confirmed launch")
    #expect(!LaunchPending.holdsThreads(saved: r.config.args, running: nil, confirmedSaved: true))
  }

  /// The popup names the mode of the launch that WAITS, not of whatever is saved later: a program that rewrites desktop.json while Main
  /// waits at the dialog cannot make the Enter read as another mode.
  @Test func thePopupNamesTheWaitingLaunchsModeEvenIfDesktopJsonIsRewrittenMeanwhile() throws {
    let (r, dump) = try rig(["--permission-mode", "default", "--dangerously-load-development-channels", "server:talos-app"], scenario: "dev-dialog.sh")
    defer { r.teardown(); cleanup(dump) }
    try coldStartConfirmed(r)
    r.sup.changePermissionMode(.bypass, restart: true)
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.mainPopupItem() != nil }, "the changed launch is offered: \(r.phase())")
    #expect(r.sup.mainPopupItem()?.startMode == "Bypass all", "\(String(describing: r.sup.mainPopupItem()?.startMode))")
    r.sup.mutateConfig { $0.args = ["--permission-mode", "auto", "--dangerously-load-development-channels", "server:talos-app"] }
    r.sup.drain()
    r.sup.tickNow()
    #expect(PermissionModeSetting.read(r.config.args) == .mode(.auto), "the saved file now says Auto")
    #expect(r.sup.mainPopupItem()?.startMode == "Bypass all", "the popup still names what is waiting")
  }

  @Test func savingWithoutRestartLeavesTheRunningAgentAlone() throws {
    let (r, dump) = try rig(["--dangerously-skip-permissions"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    r.sup.changePermissionMode(.auto, restart: false)
    #expect(r.wait(10) { r.config.args == ["--permission-mode", "auto"] }, "\(r.config.args)")
    usleep(500_000)
    #expect(r.starts.count == 1, "no restart: \(r.starts)")
    // saved but not applied is never silent: the status says so until the agent has been restarted onto it
    #expect(r.wait(10) { r.sup.tickNow(); return r.sup.status.launchPending }, "pending after a save without a restart")
    r.sup.restartCold()
    #expect(r.wait(30) { r.sup.tickNow(); return r.starts.count == 2 && isRunning(r.phase()) }, "\(r.starts), audit: \(r.audit)")
    #expect(r.wait(10) { r.sup.tickNow(); return !r.sup.status.launchPending }, "applied: no longer pending")
    #expect(argv(dump, 2).contains("auto") && argv(dump, 2).contains("--permission-mode"), "\(argv(dump, 2))")
  }

  // MARK: the agent's request

  @Test func anAgentRequestChangesTheModeRestartsOnceAndIsClearedAndNotRepeated() throws {
    let (r, dump) = try rig(["--dangerously-skip-permissions"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    try writeRequest(r, "ask", id: "pm1")
    r.sup.tickNow()
    #expect(!requestIsThere(r), "deleted once acted on")
    #expect(r.wait(30) { r.sup.tickNow(); return r.starts.count == 2 && isRunning(r.phase()) }, "restart requested: \(r.starts), audit: \(r.audit)")
    #expect(r.config.args == ["--permission-mode", "default"])
    #expect(argv(dump, 2).contains("default"))
    #expect(r.wait(10) { r.phonePosts.contains { $0.contains("Ask me") } }, "the owner is told: \(r.posts)")

    try writeRequest(r, "ask", id: "pm1")  // the same id again
    r.sup.tickNow()
    r.sup.drain()
    #expect(!requestIsThere(r))
    #expect(r.starts.count == 2, "nothing more")
  }

  @Test func theLockRefusesTheRequestAndNothingChanges() throws {
    let (r, dump) = try rig(["--dangerously-skip-permissions"])
    defer { r.teardown(); cleanup(dump) }
    try #"{"v":1,"settings_lock":true}"#.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    runningFirstStart(r)
    try writeRequest(r, "ask", id: "pm2")
    r.sup.tickNow()
    r.sup.drain()
    #expect(!requestIsThere(r))
    usleep(500_000)
    #expect(r.config.args == ["--dangerously-skip-permissions"], "unchanged: \(r.config.args)")
    #expect(r.starts.count == 1)
    #expect(r.audit.contains("permission_mode_request_refused why=locked"), "audit: \(r.audit)")
  }

  @Test func aLaunchCommandWithItsOwnPermissionFlagsIsNotRewrittenByTheAgent() throws {
    let (r, dump) = try rig(["--permission-mode", "plan"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    try writeRequest(r, "ask", id: "pm4")
    r.sup.tickNow()
    r.sup.drain()
    #expect(!requestIsThere(r))
    usleep(500_000)
    #expect(r.config.args == ["--permission-mode", "plan"], "unchanged: \(r.config.args)")
    #expect(r.starts.count == 1)
    #expect(r.audit.contains("permission_mode_request_refused why=custom"), "audit: \(r.audit)")
  }

  @Test func aStoppedAgentIsNeitherStartedNorChangedByARequestOrTheRestartChoice() throws {
    let (r, dump) = try rig(["--dangerously-skip-permissions"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    r.sup.stop()
    #expect(r.wait(20) { r.sup.tickNow(); if case .stopped(.user) = r.phase() { return true } else { return false } }, "\(r.phase())")
    try writeRequest(r, "ask", id: "pm5")
    r.sup.tickNow()
    r.sup.drain()
    #expect(r.config.args == ["--dangerously-skip-permissions"], "the owner's Stop stands: nothing is changed for the agent")
    // the owner's own choice in the picker saves, and does not start what he stopped
    r.sup.changePermissionMode(.ask, restart: true)
    #expect(r.wait(10) { r.config.args == ["--permission-mode", "default"] }, "\(r.config.args)")
    usleep(800_000)
    r.sup.tickNow()
    #expect(r.starts.count == 1, "still just the first start: \(r.starts)")
    if case .stopped(.user) = r.phase() {} else { Issue.record("phase \(r.phase())") }
  }

  @Test func anOldOrDamagedRequestIsDiscardedAndDoesNothing() throws {
    let (r, dump) = try rig(["--dangerously-skip-permissions"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    try writeRequest(r, "ask", id: "old", ageMs: 600_000)
    r.sup.tickNow()
    #expect(!requestIsThere(r))
    try writeRequest(r, "plan", id: "bad")  // a mode the picker does not have
    r.sup.tickNow()
    #expect(!requestIsThere(r))
    usleep(500_000)
    #expect(r.config.args == ["--dangerously-skip-permissions"])
    #expect(r.starts.count == 1)
  }

  @Test func theModeAlreadyInForceChangesNothing() throws {
    let (r, dump) = try rig(["--dangerously-skip-permissions"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    try writeRequest(r, "bypass", id: "pm3")
    r.sup.tickNow()
    r.sup.drain()
    usleep(500_000)
    #expect(r.starts.count == 1 && r.config.args == ["--dangerously-skip-permissions"])
    #expect(r.wait(10) { r.phonePosts.contains { $0.contains("already") } }, "\(r.posts)")
  }
}

/// The app was quit and opened again: the agent kept running (by design) with the old command. The picker's restart must end that
/// process and start the saved command with the same conversation.
@Suite("Permission mode after the app is reopened (tmux)", .serialized, .enabled(if: Rig.hasTmux))
struct PermissionModeReattachTests {
  @Test func theRestartEndsTheOldProcessAndStartsWithTheNewFlagAndTheSameConversation() throws {
    let dump = TestTemp.base + "/talos-d1-\("pmreattach")-\(UUID().uuidString.prefix(8))"
    let r = try Rig(.tmux, scenario: "dev-dialog.sh", env: ["FAKE_ARGV_DUMP": dump], session: DesktopConfig.Session(id: Rig.sessionId))
    defer {
      r.teardown()
      for n in 1...3 { try? FileManager.default.removeItem(atPath: "\(dump).\(n)") }
    }
    try coldStartConfirmed(r)
    let old = try #require(r.sup.status.childPid)
    r.sup.detach()  // the app quits; the agent stays up
    usleep(500_000)
    #expect(ProcessInspect.alive(old))
    let s2 = r.makeSupervisor()  // the app is opened again
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(10) { s2.status.startKind == .attached && s2.status.phase == .running }, "\(s2.status.phase)")
    #expect(r.starts.count == 1, "reattached, not restarted")

    // the owner saves a mode without restarting: said, not silent
    s2.changePermissionMode(.ask, restart: false)
    #expect(r.wait(10) { s2.tickNow(); return s2.status.launchPending }, "pending")
    #expect(ProcessInspect.alive(old), "saving alone leaves the old process")

    // "Restart to apply"
    s2.restartCold()
    #expect(r.wait(30) { s2.tickNow(); return r.starts.count == 2 }, "second start: \(r.starts), audit: \(r.audit)")
    #expect(r.wait(10) { !ProcessInspect.alive(old) }, "the old claude process is gone")
    let a = ((try? String(contentsOfFile: "\(dump).2", encoding: .utf8)) ?? "").split(separator: "\n").map { String($0.dropFirst().dropLast()) }
    #expect(a.contains("--permission-mode") && a.contains("default") && !a.contains("--dangerously-skip-permissions"), "\(a)")
    #expect(a.last == "--resume=\(Rig.sessionId)", "the same conversation: \(a)")
    // the new start waits at the development-channel dialog: Main still counts as running with the old arguments (thread sessions are
    // held to those), and the banner is gone because the agent is being started onto the saved command
    let orig = ["--dangerously-skip-permissions", "--dangerously-load-development-channels", "server:talos-app"]
    #expect(r.wait(20) { s2.tickNow(); return s2.status.needsYou == .confirmColdStart }, "the changed launch waits for the owner: \(s2.status.phase)")
    #expect(s2.status.runningArgs == orig, "\(s2.status.runningArgs as Any)")
    #expect(!s2.status.launchPending)
    #expect(r.wait(15) { r.screenContains(DialogMatcher.Strings.devTitle) })
    r.humanEnter()
    #expect(r.wait(20) { s2.tickNow(); return isRunning(s2.status.phase) && s2.status.runningArgs == r.config.args }, "confirmed: \(s2.status.runningArgs as Any)")
    #expect(PermissionModeSetting.read(r.config.args) == .mode(.ask))
    s2.detach()
  }
}
