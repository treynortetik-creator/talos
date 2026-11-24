import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// The permission mode: the picker's change and the agent's request, each against a real start (real pty, the fake claude, which dumps
/// its argv, `FAKE_ARGV_DUMP`).
@Suite("Permission mode (real pty)", .serialized)
struct PermissionModeIntegrationTests {
  private func rig(_ args: [String], scenario: String = "idle.sh", timings: Supervisor.Timings? = nil) throws -> (Rig, String) {
    let dump = TestTemp.base + "/talos-d1-\("pmargv")-\(UUID().uuidString.prefix(8))"
    let r = try Rig(.direct, scenario: scenario, env: ["FAKE_ARGV_DUMP": dump], timings: timings) { $0.args = args }
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
    try quiet(r)
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

  // MARK: helpers for the change that waits for the agent to finish

  /// What the agent's list says about this start: `busy` (a turn runs) or `idle`, as `claude agents --json` reports it.
  private func setActivity(_ r: Rig, _ status: String) throws {
    try writeAgentStatus(r, pid: try #require(r.sup.status.childPid), status)
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.status.agentActivity == status }, "the list says \(status): \(r.sup.status.agentActivity as Any)")
  }

  /// Running, nothing in the background (the real process list holds the fake agent's own `sleep`) and idle in the agent list.
  private func quiet(_ r: Rig) throws {
    r.sup.useProcessTable { [] }
    try setActivity(r, "idle")
  }

  /// Ticks for a moment: whatever would restart has had its chance.
  private func settle(_ r: Rig) {
    for _ in 0..<5 {
      r.sup.tickNow()
      usleep(100_000)
    }
    r.sup.drain()
  }

  private func waitsFor(_ r: Rig, restarts n: Int) -> Bool {
    r.wait(30) { r.sup.tickNow(); return r.starts.count >= n && isRunning(r.phase()) }
  }

  // MARK: the agent's change waits for the agent to finish

  /// Old code restarted at once, mid-turn (the audit's T11). Now the mode is saved, the owner is told it takes effect when the agent
  /// finishes, and the restart comes when the turn ends. A rise (Ask me to Auto) never times out.
  @Test func aChangeThatLetsTheAgentDoMoreWaitsForTheTurnAndThenRestartsOnce() throws {
    let (r, dump) = try rig(["--permission-mode", "default"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    r.sup.useProcessTable { [] }
    try setActivity(r, "busy")
    try writeRequest(r, "auto", id: "w1")
    r.sup.tickNow()
    #expect(r.wait(10) { r.config.args == ["--permission-mode", "auto"] }, "saved first: \(r.config.args)")
    #expect(r.wait(10) { r.phonePosts.contains { $0.contains("when the agent finishes what it is doing") } }, "\(r.posts)")
    #expect(!r.phonePosts.contains { $0.contains("restarting") || $0.contains("within") }, "no claim of a restart now, no time limit on a rise: \(r.posts)")
    r.clock.advance(3 * 3600)  // hours later and still on the turn: a rise does not time out
    settle(r)
    #expect(r.starts.count == 1, "the turn was not cut: \(r.starts)")
    try setActivity(r, "idle")
    #expect(waitsFor(r, restarts: 2), "\(r.starts), audit: \(r.audit)")
    #expect(argv(dump, 2).contains("auto"), "\(argv(dump, 2))")
    settle(r)
    #expect(r.starts.count == 2, "once: \(r.starts)")
  }

  /// A change that lets the agent do LESS waits for the turn too: nothing the agent is doing is cut, however long the turn runs. The
  /// owner is told the way to apply it right away (the menu's "Restart your agent").
  @Test func aChangeThatLetsTheAgentDoLessAlsoWaitsAndCutsNothing() throws {
    let (r, dump) = try rig(["--dangerously-skip-permissions"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    r.sup.useProcessTable { [] }
    try setActivity(r, "busy")
    try writeRequest(r, "ask", id: "w2")
    r.sup.tickNow()
    #expect(r.wait(10) { r.config.args == ["--permission-mode", "default"] }, "saved: \(r.config.args)")
    #expect(
      r.wait(10) { r.phonePosts.contains { $0.contains("when the agent finishes what it is doing") && $0.contains("\"Restart your agent\"") } },
      "\(r.posts)")
    r.clock.advance(3 * 3600)  // a turn that runs for hours is still not cut
    settle(r)
    #expect(r.starts.count == 1, "the turn was not cut: \(r.starts)")
    try setActivity(r, "idle")
    #expect(waitsFor(r, restarts: 2), "\(r.starts), audit: \(r.audit)")
    #expect(argv(dump, 2).contains("default") && !argv(dump, 2).contains("--dangerously-skip-permissions"), "\(argv(dump, 2))")
  }

  /// A save that fails is said in one line, nothing changes and nothing restarts, not even when the agent goes idle.
  /// R1-1: the last agent list said idle, then a turn began and no new list has been read when the request lands. The old status is
  /// not evidence about the turn: nothing restarts until lists asked for AFTER the save say quiet, two in a row. Lists are read only
  /// when the test moves the clock a long way, so each one here is counted.
  @Test func aTurnThatBeganAfterTheLastListIsNotCutAndTwoFreshLooksAreNeeded() throws {
    var t = Rig.defaultTimings()
    t.agentsPoll = 3600  // after the first list, only a jump of the clock makes another
    let (r, dump) = try rig(["--permission-mode", "default"], timings: t)
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    r.clock.advance(3601)  // a list is read now, whatever the first one's timing was
    r.sup.useProcessTable { [] }
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.status.agentActivity == "idle" }, "the list says idle")
    try writeAgentStatus(r, pid: try #require(r.sup.status.childPid), "busy")  // a turn begins; nothing has looked yet
    try writeRequest(r, "auto", id: "w11")
    r.sup.tickNow()
    #expect(r.wait(10) { r.config.args == ["--permission-mode", "auto"] })
    settle(r)
    #expect(r.starts.count == 1, "the status still says idle, but it is older than the request: \(r.starts)")
    // the list is read again: it says busy, so the turn is seen and still not cut
    r.clock.advance(3601)
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.status.agentActivity == "busy" }, "\(r.sup.status.agentActivity as Any)")
    settle(r)
    #expect(r.starts.count == 1)
    // the turn ends: ONE fresh quiet list is not enough, a second one is
    try writeAgentStatus(r, pid: try #require(r.sup.status.childPid), "idle")
    r.clock.advance(3601)
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.status.agentActivity == "idle" })
    settle(r)
    #expect(r.starts.count == 1, "one quiet look: \(r.starts), audit: \(r.audit)")
    r.clock.advance(3601)
    #expect(waitsFor(r, restarts: 2), "two quiet looks in a row: \(r.starts), audit: \(r.audit)")
    settle(r)
    #expect(r.starts.count == 2)
  }

  /// A request for the mode that is saved but not running (the owner saved it without restarting) is not "already active": the wait is
  /// armed, the owner is told, and the agent restarts when it is quiet.
  @Test func aSavedButNotRunningModeAskedForArmsTheWait() throws {
    let (r, dump) = try rig(["--permission-mode", "default"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    r.sup.useProcessTable { [] }
    r.sup.mutateConfig { $0.args = ["--permission-mode", "auto"] }  // saved by hand, no restart
    r.sup.drain()
    try setActivity(r, "busy")
    try writeRequest(r, "auto", id: "w12")
    r.sup.tickNow()
    #expect(r.wait(10) { r.phonePosts.contains { $0.contains("not running in it yet") && $0.contains("when the agent finishes") } }, "\(r.posts)")
    #expect(FileManager.default.fileExists(atPath: r.root + "/permission-pending.agent.json"), "the wait is kept in a file too")
    settle(r)
    #expect(r.starts.count == 1)
    try setActivity(r, "idle")
    #expect(waitsFor(r, restarts: 2), "\(r.starts), audit: \(r.audit)")
    #expect(argv(dump, 2).contains("auto"), "\(argv(dump, 2))")
  }

  /// R1-7: the running agent already has the mode asked for: nothing is armed, nothing restarts, and the owner is told it keeps running in it.
  @Test func aModeTheAgentAlreadyRunsArmsNothingAndSaysSo() throws {
    let (r, dump) = try rig(["--permission-mode", "default"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    r.sup.useProcessTable { [] }
    r.sup.mutateConfig { $0.args = ["--dangerously-skip-permissions"] }  // saved Bypass by hand; the agent runs Ask me
    r.sup.drain()
    try setActivity(r, "idle")
    try writeRequest(r, "ask", id: "w13")  // back to what it runs: the file changes, the agent does not need a restart
    r.sup.tickNow()
    #expect(r.wait(10) { r.phonePosts.contains { $0.contains("keeps running in that mode") } }, "\(r.posts)")
    #expect(!FileManager.default.fileExists(atPath: r.root + "/permission-pending.agent.json"), "nothing armed")
    settle(r)
    #expect(r.starts.count == 1, "\(r.starts)")
    r.clock.advance(130)  // past the gap between an agent's requests, before the file's own time is stamped
    try writeRequest(r, "ask", id: "w14")  // asked again: already in force
    r.sup.tickNow()
    #expect(r.wait(10) { r.phonePosts.contains { $0.contains("already Ask me, and your agent keeps running in that mode") } }, "\(r.posts)")
  }

  /// A marker that does not read is none, and one that names the mode the agent already runs is stale: both are removed, nothing waits.
  @Test(arguments: [("{", "garbage"), (#"{"v":1,"mode":"ask","saved_at":1}"#, "stale")])
  func aMarkerThatDoesNotReadOrIsStaleIsRemovedAndWaitsForNothing(content: String, why: String) throws {
    let (r, dump) = try rig(["--permission-mode", "default"])
    defer { r.teardown(); cleanup(dump) }
    let marker = r.root + "/permission-pending.agent.json"
    try content.write(toFile: marker, atomically: true, encoding: .utf8)
    runningFirstStart(r)
    r.sup.useProcessTable { [] }
    try setActivity(r, "idle")
    settle(r)
    #expect(!FileManager.default.fileExists(atPath: marker), "\(why): removed")
    #expect(r.starts.count == 1, "\(why): no restart: \(r.starts)")
  }

  /// The save fails for certain: `AtomicFile.write` opens its temp file in the config's folder with `O_CREAT | O_EXCL`, which a folder
  /// without write permission refuses with EACCES (DesktopConfig.swift, `AtomicFile.write`). Root ignores folder permissions, so the
  /// test is skipped when run as root.
  @Test(.enabled(if: geteuid() != 0)) func aFailedSaveIsSaidAndNothingRestarts() throws {
    let (r, dump) = try rig(["--permission-mode", "default"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    try quiet(r)
    FileManager.default.createFile(atPath: r.postLog, contents: nil)  // the fake talos-app only appends to it
    #expect(chmod(r.root, 0o555) == 0)
    defer { _ = chmod(r.root, 0o755) }  // before the teardown removes the folder
    try writeRequest(r, "auto", id: "w3")
    r.sup.tickNow()
    r.sup.drain()
    #expect(r.wait(10) { r.phonePosts.contains { $0.contains("could not save the setting. Nothing changed.") } }, "\(r.posts), audit: \(r.audit)")
    #expect(!r.phonePosts.contains { $0.contains("restart") || $0.contains("takes effect") }, "\(r.posts)")
    settle(r)
    _ = chmod(r.root, 0o755)
    #expect(r.config.args == ["--permission-mode", "default"], "the file is as it was: \(r.config.args)")
    #expect(r.starts.count == 1, "no restart: \(r.starts)")
    #expect(r.audit.contains("permission_mode_request_refused why=save_failed"), "\(r.audit)")
  }

  /// Last one wins: a second change before the agent is idle replaces the first, and there is one restart, onto the second.
  @Test func aSecondChangeBeforeIdleReplacesTheFirst() throws {
    let (r, dump) = try rig(["--permission-mode", "default"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    r.sup.useProcessTable { [] }
    try setActivity(r, "busy")
    try writeRequest(r, "auto", id: "w4")
    r.sup.tickNow()
    #expect(r.wait(10) { r.config.args == ["--permission-mode", "auto"] })
    r.clock.advance(130)  // past the two-minute gap between an agent's requests
    try writeRequest(r, "bypass", id: "w5")
    r.sup.tickNow()
    #expect(r.wait(10) { r.config.args == ["--dangerously-skip-permissions"] }, "\(r.config.args)")
    try setActivity(r, "idle")
    #expect(waitsFor(r, restarts: 2), "\(r.starts), audit: \(r.audit)")
    #expect(argv(dump, 2).contains("--dangerously-skip-permissions") && !argv(dump, 2).contains("auto"), "\(argv(dump, 2))")
    settle(r)
    #expect(r.starts.count == 2, "one restart for the two requests: \(r.starts)")
  }

  /// The same mode asked for again while it waits: the owner is told it is saved and not active yet (never "already active"), and
  /// there is no second restart.
  @Test func theSameModeAskedAgainWhileItWaitsNeitherClaimsItIsActiveNorRestartsTwice() throws {
    let (r, dump) = try rig(["--permission-mode", "default"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    r.sup.useProcessTable { [] }
    try setActivity(r, "busy")
    try writeRequest(r, "auto", id: "w6")
    r.sup.tickNow()
    #expect(r.wait(10) { r.config.args == ["--permission-mode", "auto"] })
    r.clock.advance(130)
    try writeRequest(r, "auto", id: "w7")
    r.sup.tickNow()
    #expect(
      r.wait(10) { r.phonePosts.contains { $0.contains("already saved as Auto (recommended), but the agent is not running in it yet") } },
      "\(r.posts)")
    #expect(!r.phonePosts.contains { $0.contains("is already Auto") }, "\(r.posts)")
    try setActivity(r, "idle")
    #expect(waitsFor(r, restarts: 2), "\(r.starts)")
    settle(r)
    #expect(r.starts.count == 2, "\(r.starts)")
  }

  /// A change the owner makes by hand applies at once, whatever the agent's own is waiting on, and ends that wait.
  @Test func theOwnersOwnChangeAppliesAtOnceAndEndsTheAgentsWait() throws {
    let (r, dump) = try rig(["--permission-mode", "default"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    r.sup.useProcessTable { [] }
    try setActivity(r, "busy")
    try writeRequest(r, "auto", id: "w8")
    r.sup.tickNow()
    #expect(r.wait(10) { r.config.args == ["--permission-mode", "auto"] })
    r.sup.changePermissionMode(.bypass, restart: true)  // the owner's tap (he was asked about the busy turn first)
    #expect(waitsFor(r, restarts: 2), "at once, on the turn: \(r.starts), audit: \(r.audit)")
    #expect(argv(dump, 2).contains("--dangerously-skip-permissions"), "\(argv(dump, 2))")
    try setActivity(r, "idle")
    settle(r)
    #expect(r.starts.count == 2, "the agent's change did not restart it again: \(r.starts)")
  }

  /// The owner stops Main while a change waits: it is dropped, nothing is started, and the saved mode is what the next start uses.
  @Test func aStoppedAgentDropsTheWaitingChangeAndIsNotStarted() throws {
    let (r, dump) = try rig(["--permission-mode", "default"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    r.sup.useProcessTable { [] }
    try setActivity(r, "busy")
    try writeRequest(r, "auto", id: "w9")
    r.sup.tickNow()
    #expect(r.wait(10) { r.config.args == ["--permission-mode", "auto"] })
    r.sup.stop()
    #expect(r.wait(20) { r.sup.tickNow(); if case .stopped(.user) = r.phase() { return true } else { return false } }, "\(r.phase())")
    settle(r)
    #expect(r.starts.count == 1, "\(r.starts)")
    #expect(r.audit.contains("permission_mode_pending_dropped"), "\(r.audit)")
    #expect(r.config.args == ["--permission-mode", "auto"], "the saved mode stays for the next start")
  }

  /// Idle means more than "no turn": a background command under the agent holds the restart until it is gone.
  @Test func backgroundWorkHoldsTheRestart() throws {
    let (r, dump) = try rig(["--permission-mode", "default"])
    defer { r.teardown(); cleanup(dump) }
    runningFirstStart(r)
    let pane = try #require(r.sup.status.childPid)
    let work = TableSwitch()
    r.sup.useProcessTable {
      var t = [BackgroundWork.Proc(pid: pane, ppid: 1, name: "bash")]
      if work.on { t.append(BackgroundWork.Proc(pid: 4_242_424, ppid: pane, name: "sleep")) }
      return t
    }
    try setActivity(r, "idle")  // no turn
    work.on = true
    try writeRequest(r, "auto", id: "w10")
    r.sup.tickNow()
    #expect(r.wait(10) { r.config.args == ["--permission-mode", "auto"] })
    settle(r)
    #expect(r.starts.count == 1, "a background command is running: \(r.starts)")
    #expect(r.wait(20) { r.sup.tickNow(); return r.phonePosts.contains { $0.contains("waits for the background work") } }, "told: \(r.posts)")
    settle(r)
    #expect(r.phonePosts.filter { $0.contains("waits for the background work") }.count == 1, "said once: \(r.posts)")
    work.on = false
    #expect(waitsFor(r, restarts: 2), "\(r.starts), audit: \(r.audit)")
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

  /// R1-5: the change was saved and waits for the agent to finish; the app is closed and opened again. The new copy keeps waiting
  /// (from the marker beside desktop.json) and restarts the agent when it is quiet.
  @Test func aWaitingChangeSurvivesTheAppBeingReopened() throws {
    let dump = TestTemp.base + "/talos-d1-\("pmwait")-\(UUID().uuidString.prefix(8))"
    let r = try Rig(.tmux, scenario: "dev-dialog.sh", env: ["FAKE_ARGV_DUMP": dump], session: DesktopConfig.Session(id: Rig.sessionId))
    defer {
      r.teardown()
      for n in 1...3 { try? FileManager.default.removeItem(atPath: "\(dump).\(n)") }
    }
    try coldStartConfirmed(r)
    let pid = try #require(r.sup.status.childPid)
    r.sup.useProcessTable { [] }
    try writeAgentStatus(r, pid: pid, "busy")
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.status.agentActivity == "busy" })
    let ts = Int(r.clock.wallMs())
    try #"{"v":1,"action":"set_permission_mode","mode":"ask","control_id":"re1","ts":\#(ts)}"#.write(
      toFile: r.talosHome + "/" + PermissionModeRequest.fileName, atomically: true, encoding: .utf8)
    r.sup.tickNow()
    #expect(r.wait(10) { PermissionModeSetting.read(r.config.args) == .mode(.ask) }, "saved: \(r.config.args)")
    #expect(FileManager.default.fileExists(atPath: r.root + "/permission-pending.agent.json"))
    r.sup.detach()  // the app quits; the agent stays up, busy
    usleep(500_000)
    let s2 = r.makeSupervisor()
    s2.startTicking()
    s2.useProcessTable { [] }
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(10) { s2.status.startKind == .attached && s2.status.phase == .running }, "\(s2.status.phase)")
    for _ in 0..<5 {
      s2.tickNow()
      usleep(200_000)
    }
    #expect(r.starts.count == 1, "still on its turn: not cut: \(r.starts)")
    try writeAgentStatus(r, pid: pid, "idle")
    #expect(r.wait(60) { s2.tickNow(); return r.starts.count >= 2 }, "restarted when quiet: \(r.starts), audit: \(r.audit)")
    let a = ((try? String(contentsOfFile: "\(dump).2", encoding: .utf8)) ?? "").split(separator: "\n").map { String($0.dropFirst().dropLast()) }
    #expect(a.contains("default") && !a.contains("--dangerously-skip-permissions"), "\(a)")
    s2.detach()
  }
}

/// A process list that a test changes while it runs.
private final class TableSwitch: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false
  var on: Bool {
    get { lock.withLock { value } }
    set { lock.withLock { value = newValue } }
  }
}

/// The agent list's entry for this start, rewritten: `busy` (a turn runs) or `idle`, as `claude agents --json` reports it.
fileprivate func writeAgentStatus(_ r: Rig, pid: Int32, _ status: String) throws {
  let path = r.agentsDir + "/\(pid).json"
  var o = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any])
  o["status"] = status
  try JSONSerialization.data(withJSONObject: o).write(to: URL(fileURLWithPath: path))
}
