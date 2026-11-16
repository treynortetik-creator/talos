import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// Main's supervisor keeps Main up, and says so when it cannot (review of 2026-11-10). Real ptys, a private tmux server and the fake
/// claude; nothing here reads the owner's own setup.
///   1. A desktop.json that is there and cannot be read is not "no setup": nothing starts and nothing is saved, by any door.
///   2. A restart after a crash that cannot launch (channels held, no folder) is tried again, and the phone hears when the Mac gives up.
///   3. (in NoNoticeRunningTests and SupervisorIntegrationTests) a warning offered to the owner is never stopped under him.
///   4. The CLI's resume error on the screen of a session that ran is conversation: the crash is restarted.
///   5. An exit with code 0 is not a crash: no crash loop, no restore. (The auto-confirm cap: DevChannelsReviewTests.)
///   6. A pane still on the development-channels warning is attached as starting, and offered; the Mac presses nothing by itself.
private func timings(_ edit: (inout Supervisor.Timings) -> Void = { _ in }) -> Supervisor.Timings {
  var t = Supervisor.Timings()
  t.tick = 0.2
  t.agentsPoll = 0.5
  t.backoff = Backoff(steps: [0.3, 0.5, 0.5, 0.5, 0.5], jitter: 0)
  t.dialogStall = 600
  t.stopGrace = 3
  edit(&t)
  return t
}

private let noDialogArgs = ["--dangerously-skip-permissions"]

private extension Rig {
  func count(_ event: String) -> Int { audit.components(separatedBy: " \(event)").count - 1 }
  var restoreCalls: [String] { posts.filter { $0.hasPrefix("restore-last-good") } }
  var gaveUpPosts: [String] { phonePosts.filter { $0.contains("could not start it again") } }
  var cleanExitPosts: [String] { phonePosts.filter { $0.contains("keeps exiting cleanly") } }
  func tickUntil(_ timeout: Double = 30, _ cond: () -> Bool) -> Bool { wait(timeout) { sup.tickNow(); return cond() } }
  /// A fixed window in which something must NOT happen, with the supervisor ticking through it.
  func tickFor(_ seconds: Double) {
    let until = Date().addingTimeInterval(seconds)
    while Date() < until {
      sup.tickNow()
      usleep(100_000)
    }
  }
  /// How many tries of a restart that could not launch were logged for this reason (`restart_not_possible tries=<n> why=<reason>`).
  func notPossible(_ why: String) -> Int { audit.split(separator: "\n").filter { $0.contains(" restart_not_possible ") && $0.hasSuffix(" why=\(why)") }.count }
  func crashNow() { FileManager.default.createFile(atPath: stateDir + "/crash-now", contents: nil) }
}

// MARK: 1. desktop.json is there and cannot be read

@Suite("Main resilience: an unreadable desktop.json", .serialized)
struct UnreadableConfigTests {
  static let broken = ["{ \"agent_dir\": \"/home/alex/agent\", ", "{\"agent_dir\": 5}", ""]

  /// Every door that starts or saves is tried: the launch's attach-or-start, Start, Restart, a new conversation, Start anyway, a
  /// settings change, a setup that may create the file, and the phone's restart request. Nothing runs and the file keeps its bytes.
  @Test(arguments: broken)
  func nothingStartsAndNothingIsSavedByAnyDoor(text: String) throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let good = r.config
    try Data(text.utf8).write(to: URL(fileURLWithPath: r.configPath))
    let before = try #require(FileManager.default.contents(atPath: r.configPath))
    let s = r.makeSupervisor()  // the app is opened on the broken file
    #expect(s.status.configUnreadable)
    #expect(r.audit.contains(" config_unreadable\n"), "audit: \(r.audit)")

    s.startTicking()
    s.attachOrStart(allowColdStart: true)
    s.drain()
    #expect(stopReason(s.status.phase) == .startFailed(SupervisorNotice.configUnreadableShort), "the reason is shown, not 'not started': \(s.status.phase)")
    s.start()
    s.restartCold()
    s.startNewConversation()
    s.startAnyway()
    s.updateConfig(good, createFile: true)
    s.mutateConfig { $0.autoRestart = false }
    s.mutateConfig(createFile: true) { $0.agentDir = "/home/alex/elsewhere" }
    s.drain()
    try #"{"v":1,"control_id":"ctl_restart_1","action":"restart","ts":\#(Int(r.clock.wallMs()))}"#.write(
      toFile: r.talosHome + "/" + AgentRequest.fileName, atomically: true, encoding: .utf8)
    r.tickFor(1.5)

    #expect(r.starts.isEmpty, "nothing was launched: \(r.starts)")
    #expect(s.status.childPid == nil && stopReason(s.status.phase) != nil, "\(s.status.phase)")
    #expect(FileManager.default.contents(atPath: r.configPath) == before, "the file keeps every byte")
    let files = (try? FileManager.default.contentsOfDirectory(atPath: r.root)) ?? []
    #expect(!files.contains { $0.hasPrefix(".desktop.json.") && $0.hasSuffix(".tmp") }, "no half-written copy either: \(files)")
    #expect(r.allEvents.contains(.configUnreadable), "the app is told, so the menu can say why")
    for what in ["start", "new_conversation", "settings"] {
      #expect(r.audit.contains("config_unreadable_refused what=\(what)"), "\(what): \(r.audit)")
    }
    #expect(s.currentConfig().agentDir != "/home/alex/elsewhere" && s.currentConfig().autoRestart, "not kept in memory either")
  }

  /// The control: with no file at all the supervisor is simply not set up, and a setup may create the file as before.
  @Test func aMissingFileIsNotUnreadableAndCanStillBeSetUp() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let good = r.config
    try FileManager.default.removeItem(atPath: r.configPath)
    let s = r.makeSupervisor()
    #expect(!s.status.configUnreadable)
    s.mutateConfig { $0.autoRestart = false }  // a tweak before setup stays in memory
    s.drain()
    #expect(!FileManager.default.fileExists(atPath: r.configPath))
    s.updateConfig(good, createFile: true)
    s.drain()
    #expect(r.config.agentDir == good.agentDir && r.config.args == good.args)
    #expect(!r.allEvents.contains(.configUnreadable) && !r.audit.contains("config_unreadable"))
  }

  /// The app says the file is unreadable (it read it a moment before the supervisor did): that stands even when the file reads
  /// fine by the time the supervisor looks, because the app already chose its host and workers from the defaults.
  @Test func theAppsOwnFindingStandsEvenIfTheFileReadsFineAMomentLater() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let before = try #require(FileManager.default.contents(atPath: r.configPath))
    var o = Supervisor.Options(name: "agent", configPath: r.configPath, home: r.home, talosAppHome: r.talosHome, auditLogPath: r.auditPath)
    o.configKnownUnreadable = true
    let env = r.loginEnv
    let s = Supervisor(options: o, host: SwiftTermPtyHost(), probe: LiveSystem(loginEnv: { env }), timings: r.timings)
    #expect(s.status.configUnreadable)
    s.start()
    s.mutateConfig { $0.autoRestart = false }
    s.drain()
    usleep(500_000)
    #expect(r.starts.isEmpty && FileManager.default.contents(atPath: r.configPath) == before)
  }

  /// A live pane from before the file broke is left alone: not attached (a crash would be restarted from the defaults), not
  /// stopped, not typed at.
  @Test(.enabled(if: Rig.hasTmux))
  func aLivePaneIsNeitherAttachedNorTouched() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let pid = try #require(r.sup.status.childPid)
    r.sup.detach()
    let screen = r.host.visibleRows() ?? []
    try Data("{\"agent_dir\": 5}".utf8).write(to: URL(fileURLWithPath: r.configPath))
    let s2 = r.makeSupervisor()
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    r.tickFor(1.5)
    #expect(s2.status.configUnreadable && s2.status.childPid == nil && s2.status.startKind == nil, "\(s2.status)")
    #expect(ProcessInspect.alive(pid), "the agent that was running keeps running")
    #expect(r.starts.count == 1, "nothing new was started")
    #expect((r.host.visibleRows() ?? []).isEmpty, "the new host never took the pane")
    #expect(!r.allEvents.contains(.attached(pid: pid)))
    _ = screen
  }
}

// MARK: 2. a restart that cannot launch is a failed attempt, not the end

@Suite("Main resilience: a crash restart that cannot launch", .serialized)
struct RestartCannotLaunchTests {
  /// The folder is not there when the restart comes (a volume not mounted yet): it waits and tries again, and starts once it is back.
  @Test(arguments: bothHosts)
  func aMissingFolderIsTriedAgainAndStartsOnceItIsBack(kind: HostKind) throws {
    let r = try Rig(
      kind, scenario: "crash-after.sh", env: ["FAKE_CRASH_ON_FILE": "1", "FAKE_CRASHES": "1"], timings: timings { $0.cannotLaunchTries = 200; $0.restartCap = 2 })
    defer { r.teardown() }
    try coldStartConfirmed(r)
    try FileManager.default.moveItem(atPath: r.agentDir, toPath: r.agentDir + ".away")
    r.crashNow()
    #expect(r.tickUntil { r.notPossible("folder_missing") >= 2 }, "tried more than once: \(r.phase()), audit: \(r.audit)")
    #expect(stopReason(r.phase()) == nil, "not the end: \(r.phase())")
    #expect(r.allEvents.contains { if case .restarting = $0 { return true } else { return false } })
    #expect(r.sup.status.restartsInWindow <= 1 && !r.audit.contains(" crash_loop"), "the tries are not the crash loop's (its cap here is 2): \(r.sup.status.restartsInWindow)")
    #expect(r.starts.count == 1)
    try FileManager.default.moveItem(atPath: r.agentDir + ".away", toPath: r.agentDir)
    #expect(r.tickUntil(60) { r.starts.count == 2 && isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.starts.last?.contains("--resume=") == true, "the same conversation")
    usleep(500_000)
    #expect(r.gaveUpPosts.isEmpty && r.count("restart_gave_up") == 0, "nothing to tell the phone: \(r.posts)")
  }

  /// It never comes back: the Mac gives up at the crash loop's cap, ends where it used to end at once (could not start, with the
  /// reason), and the phone gets exactly one line. No crash-loop line and no restore: nothing kept crashing.
  @Test(arguments: bothHosts)
  func itGivesUpAtTheCapAndTellsThePhoneOnce(kind: HostKind) throws {
    let r = try Rig(
      kind, scenario: "crash-after.sh", env: ["FAKE_CRASH_ON_FILE": "1", "FAKE_CRASHES": "1"], timings: timings { $0.cannotLaunchTries = 3; $0.restartCap = 50 })
    defer { r.teardown() }
    try coldStartConfirmed(r)
    try FileManager.default.moveItem(atPath: r.agentDir, toPath: r.agentDir + ".away")
    defer { try? FileManager.default.moveItem(atPath: r.agentDir + ".away", toPath: r.agentDir) }
    r.crashNow()
    #expect(
      r.tickUntil(60) { if case .startFailed(let why)? = stopReason(r.phase()) { return why.contains("does not exist") } else { return false } },
      "\(r.phase()), audit: \(r.audit)")
    #expect(r.notPossible("folder_missing") == 3, "the first try and two more: \(r.audit)")
    #expect(r.audit.contains("restart_not_possible tries=3 why=folder_missing"), "audit: \(r.audit)")
    #expect(r.wait(10) { r.gaveUpPosts.count == 1 }, "the phone is told: \(r.posts)")
    #expect(r.gaveUpPosts.first?.hasPrefix("post general Testagent's session crashed and the Mac could not start it again (its folder is missing).") == true, "\(r.gaveUpPosts)")
    r.tickFor(2)
    #expect(r.gaveUpPosts.count == 1 && r.count("restart_gave_up") == 1, "once: \(r.posts)")
    #expect(r.crashPosts.isEmpty && r.restoreCalls.isEmpty && !r.audit.contains(" crash_loop"), "not a crash loop: \(r.posts)")
    #expect(r.starts.count == 1)
  }

  /// Another session holds the channels when the restart comes: tried again, and it starts once that session is gone. It used to
  /// end at Blocked with nobody told.
  @Test(arguments: bothHosts)
  func heldChannelsAreTriedAgainAndItStartsOnceTheyAreFree(kind: HostKind) throws {
    let r = try Rig(
      kind, scenario: "crash-after.sh", env: ["FAKE_CRASH_ON_FILE": "1", "FAKE_CRASHES": "1"], timings: timings { $0.cannotLaunchTries = 200; $0.restartCap = 2 })
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let other = try r.spawn([Rig.fixtures + "/other-session.sh", "--channels", "plugin:talos-app@example"])
    try r.registerAgent(pid: other, cwd: "/tmp/elsewhere")
    r.crashNow()
    #expect(r.tickUntil { r.notPossible("channels_held") >= 2 }, "\(r.phase()), audit: \(r.audit)")
    #expect(blockers(r.phase()) == nil && stopReason(r.phase()) == nil, "not the end: \(r.phase())")
    #expect(ProcessInspect.alive(other), "the other session is never touched")
    kill(other, SIGKILL)
    #expect(r.tickUntil(60) { r.starts.count == 2 && isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.gaveUpPosts.isEmpty)
  }

  /// ... and when they stay held it ends at Blocked as before, with the one line to the phone.
  @Test func heldChannelsThatStayHeldEndBlockedAndTellThePhoneOnce() throws {
    let r = try Rig(
      .direct, scenario: "crash-after.sh", env: ["FAKE_CRASH_ON_FILE": "1", "FAKE_CRASHES": "1"], timings: timings { $0.cannotLaunchTries = 2; $0.restartCap = 50 })
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let other = try r.spawn([Rig.fixtures + "/other-session.sh", "--channels", "plugin:talos-app@example"])
    try r.registerAgent(pid: other, cwd: "/tmp/elsewhere")
    r.crashNow()
    #expect(r.tickUntil(60) { blockers(r.phase()) != nil }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.wait(10) { r.gaveUpPosts.count == 1 }, "\(r.posts)")
    #expect(r.gaveUpPosts.first?.contains("(another session holds its channels)") == true, "\(r.gaveUpPosts)")
    r.tickFor(1.5)
    #expect(r.gaveUpPosts.count == 1 && r.starts.count == 1 && ProcessInspect.alive(other))
  }

  /// The owner's own Start is not a crash restart: blocked or failed, it ends at once with its reason and posts nothing.
  @Test func theOwnersOwnStartStillEndsAtOnce() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh", timings: timings())
    defer { r.teardown() }
    try FileManager.default.moveItem(atPath: r.agentDir, toPath: r.agentDir + ".away")
    defer { try? FileManager.default.moveItem(atPath: r.agentDir + ".away", toPath: r.agentDir) }
    r.start()
    #expect(r.wait(10) { stopReason(r.phase()) != nil }, "\(r.phase())")
    r.tickFor(1.5)
    #expect(r.count("restart_not_possible") == 0 && r.phonePosts.isEmpty && r.starts.isEmpty, "audit: \(r.audit)")
  }
}

// MARK: 4. the resume error counts only at the start

@Suite("Main resilience: the resume error on a session that ran", .serialized)
struct ResumeErrorLaterTests {
  /// A session that ran past the window and then crashed with the CLI's resume error on its screen (a transcript that quotes it)
  /// crashed: it is restarted with the same conversation. It used to be stopped as "can't be resumed".
  @Test(arguments: bothHosts)
  func aCrashLongAfterTheStartIsRestartedWhateverTheScreenQuotes(kind: HostKind) throws {
    let r = try Rig(
      kind, scenario: "quote-then-crash.sh", env: ["FAKE_CRASH_AFTER": "4"], timings: timings { $0.resumeMissingWindow = 1 },
      session: confirmedSession, configure: { $0.args = noDialogArgs })
    defer { r.teardown() }
    r.start()
    #expect(r.wait(15) { r.screenContains("No session found with ID") && isRunning(r.phase()) }, "the words are on a running session's screen: \(r.phase())")
    #expect(r.tickUntil(60) { r.starts.count == 2 && isRunning(r.phase()) }, "restarted: \(r.phase()), audit: \(r.audit)")
    #expect(!r.audit.contains("resume_missing") && !r.allEvents.contains(.resumeFailed(sessionId: Rig.sessionId)), "audit: \(r.audit)")
    #expect(r.starts.last?.contains("--resume=\(Rig.sessionId)") == true && r.config.session.id == Rig.sessionId, "the conversation is kept")
  }

  /// The window bounds a start that is still starting too (the contract's one number): a session that sat on its warning past
  /// the window and then ended with those words on screen crashed.
  @Test func aStartStillStartingPastTheWindowIsACrashToo() throws {
    let r = try Rig(
      .direct, scenario: "dev-dialog-quote-then-crash.sh", env: ["FAKE_CRASH_AFTER": "3"],
      timings: timings { $0.resumeMissingWindow = 1 }, session: confirmedSession, configure: { $0.autoConfirmRestart = false })
    defer { r.teardown() }
    r.start()
    #expect(r.tickUntil(30) { r.phase() == .starting && r.screenContains(DialogMatcher.Strings.devTitle) }, "\(r.phase())")
    #expect(r.tickUntil(60) { r.starts.count >= 2 }, "restarted, not 'can't be resumed': \(r.phase()), audit: \(r.audit)")
    #expect(!r.audit.contains("resume_missing"), "audit: \(r.audit)")
  }

  /// The control: the same screen on an exit inside the window is the failed `--resume` it always was.
  @Test(arguments: bothHosts)
  func theSameWordsOnAnExitAtTheStartAreStillAFailedResume(kind: HostKind) throws {
    let r = try Rig(
      kind, scenario: "quote-then-crash.sh", env: ["FAKE_CRASH_AFTER": "0.5"], timings: timings { $0.resumeMissingWindow = 30 },
      session: confirmedSession, configure: { $0.args = noDialogArgs })
    defer { r.teardown() }
    r.start()
    #expect(r.tickUntil(30) { stopReason(r.phase()) == .resumeMissing(Rig.sessionId) }, "\(r.phase()), audit: \(r.audit)")
    r.tickFor(1)
    #expect(r.starts.count == 1, "never restarted")
  }
}

// MARK: 5. exit code 0 is not a crash

@Suite("Main resilience: a clean exit is not a crash", .serialized)
struct CleanExitTests {
  /// Main ends by itself three times (an `/exit`, a self-update): it is started again each time at the first backoff step, and the
  /// crash loop's count stays empty, even with a crash cap those three would have passed.
  @Test(arguments: bothHosts)
  func cleanExitsRestartAtTheFirstStepWithoutSpendingTheCrashLoop(kind: HostKind) throws {
    let r = try Rig(
      kind, scenario: "clean-exit.sh", env: ["FAKE_CLEAN_EXITS": "3"],
      timings: timings { $0.restartCap = 2; $0.backoff = Backoff(steps: [0.3, 30, 30, 30, 30], jitter: 0) }, configure: { $0.args = noDialogArgs })
    defer { r.teardown() }
    r.start()
    // the later steps are 30 s: only restarts at step 0 get three of them done inside this wait
    #expect(r.tickUntil(20) { r.starts.count == 4 && isRunning(r.phase()) }, "\(r.phase()), starts \(r.starts.count), audit: \(r.audit)")
    #expect(r.audit.contains(" exit ") && r.audit.contains("code=0"), "they were clean exits: \(r.audit)")
    #expect(r.sup.status.restartsInWindow == 0, "none of it is the crash loop's: \(r.sup.status.restartsInWindow)")
    #expect(!r.audit.contains(" crash_loop") && stopReason(r.phase()) == nil)
    let delays = r.allEvents.compactMap { e -> Double? in if case .restarting(let a, let d) = e { return a == 0 ? d : -1 } else { return nil } }
    #expect(delays == [0.3, 0.3, 0.3], "each at the first step: \(delays)")
  }

  /// It keeps ending by itself: the exit past the cap (its own) leaves it stopped as `clean_exit_loop`, and the phone gets one line.
  /// It is not called a crash loop, and the last good setup is not put back over a setup that never crashed.
  @Test(arguments: bothHosts)
  func moreCleanExitsThanTheCapStopWithoutACrashLoopOrARestore(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "clean-exit.sh", timings: timings { $0.cleanExitsPerHour = 2 }, configure: { $0.args = noDialogArgs })
    defer { r.teardown() }
    r.start()
    #expect(r.tickUntil(60) { stopReason(r.phase()) == .cleanExitLoop }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.starts.count == 3, "two clean exits restart, the third is over the cap: \(r.starts.count)")
    #expect(r.audit.contains(" clean_exit_loop exits=3"), "audit: \(r.audit)")
    #expect(r.wait(10) { r.cleanExitPosts.count == 1 }, "\(r.posts)")
    #expect(r.cleanExitPosts.first?.hasPrefix("post general Main keeps exiting cleanly") == true, "\(r.cleanExitPosts)")
    r.tickFor(2.5)  // the automatic restore would have come by now (it answers `.crashLoop` on the next tick)
    #expect(stopReason(r.phase()) == .cleanExitLoop && r.starts.count == 3, "it stays stopped: \(r.phase())")
    #expect(r.restoreCalls.isEmpty && !r.audit.contains("restore_start"), "no restore: \(r.posts)")
    #expect(!r.audit.contains(" crash_loop") && r.crashPosts.isEmpty && !r.allEvents.contains(.stoppedRestarting))
    #expect(r.cleanExitPosts.count == 1)
    #expect(Supervisor.StopReason.cleanExitLoop.isFailure && Supervisor.StopReason.cleanExitLoop.plainSentence.contains("exiting cleanly"))
  }

  /// The hour is the supervisor's clock: exits older than it no longer count, so an agent that ends by itself now and then is
  /// never stopped for it.
  @Test func cleanExitsOlderThanAnHourNoLongerCount() throws {
    let r = try Rig(
      .direct, scenario: "clean-exit.sh", env: ["FAKE_CLEAN_EXITS": "4", "FAKE_EXIT_AFTER": "1.5"],
      timings: timings { $0.cleanExitsPerHour = 2 }, configure: { $0.args = noDialogArgs })
    defer { r.teardown() }
    r.start()
    #expect(r.tickUntil(30) { r.starts.count == 3 }, "two exits, two restarts: \(r.phase())")
    r.clock.advance(3601)  // the third and fourth exits come an hour later (the Mac asleep or not: the monotonic clock)
    #expect(r.tickUntil(60) { r.starts.count == 5 && isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(!r.audit.contains("clean_exit_loop") && r.cleanExitPosts.isEmpty)
  }

  /// With auto-restart off no exit restarts Main, a clean one included.
  @Test func withAutoRestartOffACleanExitDoesNotRestart() throws {
    let r = try Rig(.direct, scenario: "clean-exit.sh", timings: timings(), configure: { $0.args = noDialogArgs; $0.autoRestart = false })
    defer { r.teardown() }
    r.start()
    #expect(r.tickUntil(30) { stopReason(r.phase()) == .crashedNoAutoRestart }, "\(r.phase()), audit: \(r.audit)")
    r.tickFor(1.5)
    #expect(r.starts.count == 1 && r.phonePosts.isEmpty, "\(r.starts.count) \(r.posts)")
  }

  /// The restart after a clean exit is no crash restart for the auto-answer either: it does not spend the crash loop's three an hour.
  @Test func theRestartAfterACleanExitDoesNotSpendTheCrashLoopsAutoConfirms() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-clean-exit.sh", env: ["FAKE_CLEAN_EXITS": "2"], timings: timings { $0.confirmCap = 1 })
    defer { r.teardown() }
    r.start()
    #expect(r.tickUntil(60) { r.starts.count == 3 && isRunning(r.phase()) }, "all three answered: \(r.phase()), needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    #expect(r.autoConfirms == 3 && r.sup.status.needsYou == nil, "audit: \(r.audit)")
    #expect(!r.allEvents.contains { if case .autoConfirmed = $0 { return true } else { return false } }, "and nobody is told it 'restarted after a crash'")
  }

  /// The control: real crashes (exit 2) past the crash cap are still the crash loop, with its restore.
  @Test func realCrashesAreStillTheCrashLoop() throws {
    let r = try Rig(.direct, scenario: "bad-flag.sh", timings: timings { $0.restartCap = 2 }, session: confirmedSession)
    defer { r.teardown() }
    r.start()
    #expect(r.tickUntil(60) { r.audit.contains(" crash_loop") && !r.restoreCalls.isEmpty }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.cleanExitPosts.isEmpty && !r.audit.contains("clean_exit_loop"))
  }
}

// MARK: 6. attaching to a pane that is still on the warning

@Suite("Main resilience: re-attach while the warning is up", .serialized, .enabled(if: Rig.hasTmux))
struct AttachAtTheWarningTests {
  /// The app went away while Main sat on the warning. The new copy does not call that running: the start goes on, the owner gets
  /// the popup, and his click starts Main. The Mac presses nothing before it.
  @Test func aPaneStillOnTheWarningIsStartingAndOfferedNotRunning() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.tmux, scenario: "dev-dialog-keys.sh", env: ["FAKE_DLG_KEYLOG": keys.path], timings: timings(), launchConfirmed: false)
    defer { r.teardown() }
    r.start()
    _ = try #require(r.waitForOffer(), "the first copy offered it: \(r.audit)")
    let pid = try #require(r.sup.status.childPid)
    r.sup.detach()  // the app quits (or is updated) with Main still waiting

    let s2 = r.makeSupervisor()
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(10) { s2.status.childPid == pid && s2.status.startKind == .attached }, "\(s2.status.phase)")
    #expect(s2.status.phase == .starting, "not running: Main is at the warning (\(s2.status.phase))")
    #expect(r.audit.contains("attach pid=\(pid) warning=live"), "audit: \(r.audit)")
    let item = try #require(r.waitForPopup(), "the new copy offers it again: \(r.audit)")
    #expect(r.tickUntil(10) { s2.status.needsYou == .confirmColdStart }, "\(String(describing: s2.status.needsYou))")
    r.tickFor(1.5)
    #expect(keys.presses.isEmpty && r.autoConfirms == 0, "nothing pressed by the Mac: \(keys.keys)")
    #expect(s2.status.phase == .starting && r.starts.count == 1)

    let res = r.popupClick(item, choice: 0)
    #expect(res == .pressed(choice: 0, label: "I am using this for local development"), "\(String(describing: res)), audit: \(r.audit)")
    #expect(r.tickUntil(30) { isRunning(s2.status.phase) }, "\(s2.status.phase), audit: \(r.audit)")
    #expect(keys.presses == ["ENTER"] && r.starts.count == 1, "\(keys.keys)")
    #expect(s2.status.needsYou == nil && r.mainPopup == nil)
    #expect(r.sealed, "his click on the popup is his confirm, as on any start")
  }

  /// Even a launch the Mac would answer by itself on a cold start is not answered on an attach: an earlier copy of the app may
  /// already have pressed the one Enter. It is offered instead.
  @Test func theMacNeverPressesTheEnterForAnAttachedStart() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog-wait.sh", timings: timings())
    defer { r.teardown() }
    r.start()
    #expect(r.wait(15) { r.starts.count == 1 && r.sup.status.childPid != nil }, "\(r.phase())")
    r.sup.detach()
    FileManager.default.createFile(atPath: r.stateDir + "/show", contents: nil)  // the warning comes up with no app watching
    #expect(r.wait(15) { r.screenContains(DialogMatcher.Strings.devConfirm) })

    let s2 = r.makeSupervisor()
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(10) { s2.status.startKind == .attached && s2.status.phase == .starting }, "\(s2.status.phase), audit: \(r.audit)")
    #expect(r.waitForPopup() != nil, "offered: \(r.audit)")
    r.tickFor(2)
    #expect(r.autoConfirms == 0, "no Enter from the Mac: \(r.audit)")
    #expect(r.audit.contains("auto_confirm_refused kind=attached reason=outsideWindow"), "audit: \(r.audit)")
    #expect(r.screenContains(DialogMatcher.Strings.devConfirm) && s2.status.phase == .starting)
  }

  /// A second copy of the app (it does not hold the session's lock) still only watches: it types nothing and offers nothing.
  @Test func aPassiveCopyStillOnlyWatches() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.tmux, scenario: "dev-dialog-keys.sh", env: ["FAKE_DLG_KEYLOG": keys.path], timings: timings(), launchConfirmed: false)
    defer { r.teardown() }
    let s1 = r.sup!
    r.start()
    _ = try #require(r.waitForOffer(), "audit: \(r.audit)")
    let pid = try #require(s1.status.childPid)
    let s2 = r.makeSupervisor()
    defer { s2.detach(); s1.detach() }
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(10) { s2.status.childPid == pid })
    r.tickFor(1.5)
    #expect(!s2.holdsSessionLock && s2.status.phase == .running && s2.mainPopupItem() == nil, "\(s2.status.phase)")
    #expect(keys.presses.isEmpty, "\(keys.keys)")
    #expect(s1.status.phase == .starting && s1.mainPopupItem() != nil, "the copy that holds the lock still has the question")
  }

  /// The control: a pane past its warning is attached as running, with nothing offered (as before).
  @Test func aPanePastItsWarningIsStillAttachedAsRunning() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh", timings: timings())
    defer { r.teardown() }
    try coldStartConfirmed(r)
    r.sup.detach()
    let s2 = r.makeSupervisor()
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(10) { s2.status.startKind == .attached && s2.status.phase == .running }, "\(s2.status.phase)")
    r.tickFor(1)
    #expect(s2.status.phase == .running && r.mainPopup == nil && s2.status.needsYou == nil)
    #expect(r.audit.contains("warning=no"))
  }
}

// MARK: 7. a conversation nobody typed in was never saved

@Suite("Main resilience: a session that was never saved", .serialized)
struct SessionNotSavedTests {
  private static let onFile = ["FAKE_CRASH_ON_FILE": "1"]

  /// Claude Code writes a conversation only after the first message or an /exit. A Main nobody has typed in that crashes has
  /// none, and `--resume <id>` is refused ("No conversation found"): it used to stop there as "can't be resumed". It is started
  /// again as the same id with `--session-id`, and runs.
  @Test(arguments: bothHosts)
  func aCrashBeforeAnythingWasSavedStartsTheSameIdAgainInsteadOfResuming(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "unsaved-session.sh", env: Self.onFile, timings: timings(), configure: { $0.args = noDialogArgs })
    defer { r.teardown() }
    r.start()
    #expect(r.tickUntil { r.starts.count == 1 && isRunning(r.phase()) }, "\(r.phase())")
    let id = try #require(r.config.session.id)
    r.crashNow()
    #expect(r.tickUntil(60) { r.starts.count == 2 && isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.starts.last?.contains("--session-id=\(id)") == true && r.starts.last?.contains("--resume") == false, "\(r.starts)")
    #expect(r.audit.contains(" session_not_saved session=\(id)"), "audit: \(r.audit)")
    #expect(!r.audit.contains("resume_missing") && !r.allEvents.contains(.resumeFailed(sessionId: id)) && r.config.session.id == id)
    r.tickFor(1.5)
    #expect(isRunning(r.phase()) && r.starts.count == 2, "it stays up: \(r.phase())")
  }

  /// The control: once the conversation is saved (the owner typed something), the restart resumes it as before.
  @Test(arguments: bothHosts)
  func aSavedConversationIsStillResumed(kind: HostKind) throws {
    let r = try Rig(
      kind, scenario: "unsaved-session.sh", env: Self.onFile.merging(["FAKE_SAVE_AT_START": "1"]) { a, _ in a }, timings: timings(),
      configure: { $0.args = noDialogArgs })
    defer { r.teardown() }
    r.start()
    #expect(r.tickUntil { r.starts.count == 1 && isRunning(r.phase()) }, "\(r.phase())")
    let id = try #require(r.config.session.id)
    r.crashNow()
    #expect(r.tickUntil(60) { r.starts.count == 2 && isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.starts.last?.contains("--resume=\(id)") == true, "\(r.starts)")
    #expect(!r.audit.contains("session_not_saved"))
  }

  /// A conversation saved where the supervisor did not look: the CLI refuses the id as already in use and exits at once. That is
  /// mended once: the next launch resumes it.
  @Test(arguments: bothHosts)
  func anIdTheCliRefusesAsInUseIsResumedOnce(kind: HostKind) throws {
    let r = try Rig(
      kind, scenario: "unsaved-session.sh", env: Self.onFile.merging(["FAKE_REFUSE_SESSION_ID": "2"]) { a, _ in a }, timings: timings(),
      configure: { $0.args = noDialogArgs })
    defer { r.teardown() }
    r.start()
    #expect(r.tickUntil { r.starts.count == 1 && isRunning(r.phase()) }, "\(r.phase())")
    let id = try #require(r.config.session.id)
    r.crashNow()
    #expect(r.tickUntil(60) { r.starts.count == 3 && isRunning(r.phase()) }, "\(r.phase()), starts \(r.starts), audit: \(r.audit)")
    #expect(r.starts.count == 3 && r.starts[1].contains("--session-id=\(id)") && r.starts[2].contains("--resume=\(id)"), "\(r.starts)")
    #expect(r.count("session_not_saved") == 1 && r.count("session_in_use_resume session=\(id)") == 1, "audit: \(r.audit)")
    #expect(r.config.session.id == id && stopReason(r.phase()) == nil)
  }

  /// Once per id: when the resumed session crashes and the id is refused as in use a second time, that is an ordinary crash (it
  /// counts toward the crash loop's cap), so the two errors can never trade places for ever.
  @Test func theInUseMendIsMadeOncePerId() throws {
    let r = try Rig(
      .direct, scenario: "unsaved-session.sh",
      env: Self.onFile.merging(["FAKE_REFUSE_SESSION_ID": "2", "FAKE_ALSO_CRASH": "3 5 7 9 11"]) { a, _ in a },
      timings: timings { $0.restartCap = 6 }, configure: { $0.args = noDialogArgs })
    defer { r.teardown() }
    r.start()
    #expect(r.tickUntil { r.starts.count == 1 && isRunning(r.phase()) }, "\(r.phase())")
    r.crashNow()
    #expect(r.tickUntil(90) { r.audit.contains(" crash_loop") }, "it ends at the crash loop's cap: \(r.phase()), starts \(r.starts.count), audit: \(r.audit)")
    #expect(r.count("session_in_use_resume") == 1, "mended once: \(r.audit)")
    #expect(r.starts.filter { $0.contains("--resume=") }.count == 1, "\(r.starts)")
  }

  /// The file is looked for anywhere under `projects/` (Claude Code hashes a long folder name, and the folder may have changed):
  /// found under another name, the session is resumed, not started over under the same id.
  @Test func aConversationSavedUnderAnotherFolderNameIsResumed() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh", timings: timings(), session: confirmedSession)
    defer { r.teardown() }
    let exact = SessionTranscript.path(sessionId: Rig.sessionId, folder: r.agentDir, claudeDir: r.home + "/.claude")
    let other = r.home + "/.claude/projects/-a-long-name-a1b2c3"
    try FileManager.default.createDirectory(atPath: other, withIntermediateDirectories: true)
    try FileManager.default.moveItem(atPath: exact, toPath: other + "/\(Rig.sessionId).jsonl")
    r.start()
    #expect(r.tickUntil { r.starts.count == 1 }, "\(r.phase())")
    #expect(r.starts.first?.contains("--resume=\(Rig.sessionId)") == true && !r.audit.contains("session_not_saved"), "\(r.starts)")
  }

  /// Main's own CLAUDE_CONFIG_DIR (desktop.json `env`) is where the file is looked for, not ~/.claude.
  @Test func theFileIsLookedForInMainsOwnConfigFolder() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh", timings: timings(), session: confirmedSession)
    defer { r.teardown() }
    // the rig saved it under ~/.claude; Main is told to use another config folder, where there is none
    r.sup.mutateConfig { $0.env["CLAUDE_CONFIG_DIR"] = r.root + "/other-claude" }
    r.sup.drain()
    r.start()
    #expect(r.tickUntil { r.starts.count == 1 }, "\(r.phase())")
    #expect(r.starts.first?.contains("--session-id=\(Rig.sessionId)") == true && r.audit.contains("session_not_saved"), "\(r.starts)")
  }

  /// The review's hole (R1-1): Main HAD a conversation (the app saw its file), and the file is gone (retention deleted it). It
  /// must not come back quietly empty under the same id: it is resumed, and stops as "can't be resumed" with the owner's choice.
  @Test func aConversationTheAppSawAndThenLostIsResumedNotStartedOver() throws {
    let r = try Rig(
      .direct, scenario: "unsaved-session.sh", env: Self.onFile.merging(["FAKE_SAVE_AT_START": "1"]) { a, _ in a }, timings: timings(),
      configure: { $0.args = noDialogArgs })
    defer { r.teardown() }
    r.start()
    #expect(r.tickUntil { r.starts.count == 1 && isRunning(r.phase()) }, "\(r.phase())")
    let id = try #require(r.config.session.id)
    #expect(r.tickUntil(15) { r.config.session.conversationSeen == id }, "the running session's file is noticed: \(r.config.session)")
    try FileManager.default.removeItem(atPath: SessionTranscript.path(sessionId: id, folder: r.agentDir, claudeDir: r.home + "/.claude"))
    r.crashNow()
    #expect(r.tickUntil(60) { stopReason(r.phase()) == .resumeMissing(id) }, "\(r.phase()), starts \(r.starts), audit: \(r.audit)")
    #expect(r.starts.count == 2 && r.starts.last?.contains("--resume=\(id)") == true, "\(r.starts)")
    #expect(!r.audit.contains("session_not_saved") && r.config.session.id == id, "audit: \(r.audit)")
  }

  /// And with Main's config folder changed under a conversation the app had seen: resumed (the CLI then says what it finds), not
  /// started over. `theFileIsLookedForInMainsOwnConfigFolder` is the same change for a session never seen to have a file.
  @Test func aSeenConversationIsResumedWhenTheConfigFolderChanged() throws {
    var seen = confirmedSession
    seen.conversationSeen = Rig.sessionId
    let r = try Rig(.direct, scenario: "dev-dialog.sh", timings: timings(), session: seen)
    defer { r.teardown() }
    r.sup.mutateConfig { $0.env["CLAUDE_CONFIG_DIR"] = r.root + "/other-claude" }
    r.sup.drain()
    r.start()
    #expect(r.tickUntil { r.starts.count == 1 }, "\(r.phase())")
    #expect(r.starts.first?.contains("--resume=\(Rig.sessionId)") == true && !r.audit.contains("session_not_saved"), "\(r.starts)")
  }

  /// A mark for another id is not this id's: an unsaved session is still started again under its own id.
  @Test func aMarkForAnotherIdDoesNotCount() throws {
    var other = confirmedSession
    other.conversationSeen = "99999999-2222-4333-8444-555555555555"
    let r = try Rig(.direct, scenario: "dev-dialog.sh", timings: timings(), session: other)
    defer { r.teardown() }
    r.sup.mutateConfig { $0.env["CLAUDE_CONFIG_DIR"] = r.root + "/other-claude" }
    r.sup.drain()
    r.start()
    #expect(r.tickUntil { r.starts.count == 1 }, "\(r.phase())")
    #expect(r.starts.first?.contains("--session-id=\(Rig.sessionId)") == true && r.audit.contains("session_not_saved"), "\(r.starts)")
  }

  /// A file that holds only an /exit (meta lines and the command's own markup) can never be resumed: the CLI says no conversation
  /// was found. The id is retired to previous_ids and a new one started, once; Main is not stopped as "can't be resumed".
  @Test(arguments: bothHosts)
  func aFileWithOnlyAnExitInItGetsANewIdOnce(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "unsaved-session.sh", env: ["FAKE_CRASH_AFTER": "600"], timings: timings(), session: confirmedSession, configure: { $0.args = noDialogArgs })
    defer { r.teardown() }
    let file = SessionTranscript.path(sessionId: Rig.sessionId, folder: r.agentDir, claudeDir: r.home + "/.claude")
    try Data(
      """
      {"type":"user","isMeta":true,"message":{"role":"user","content":"Caveat: the messages below were generated by the user while running local commands."}}
      {"type":"user","message":{"role":"user","content":"<command-name>/exit</command-name>\\n<command-message>exit</command-message>\\n<command-args></command-args>"}}
      {"type":"user","message":{"role":"user","content":"<local-command-stdout>Bye!</local-command-stdout>"}}

      """.utf8
    ).write(to: URL(fileURLWithPath: file))
    r.start()
    #expect(r.tickUntil(60) { r.starts.count == 2 && isRunning(r.phase()) }, "\(r.phase()), starts \(r.starts), audit: \(r.audit)")
    let now = r.config.session
    #expect(r.starts.first?.contains("--resume=\(Rig.sessionId)") == true, "the file exists, so the first try resumes: \(r.starts)")
    #expect(now.id != nil && now.id != Rig.sessionId && now.previousIds.contains(Rig.sessionId), "\(now)")
    #expect(r.starts.last?.contains("--session-id=\(now.id ?? "-")") == true, "\(r.starts)")
    #expect(r.count("session_empty_new_id session=\(Rig.sessionId)") == 1 && !r.audit.contains(" resume_missing"), "audit: \(r.audit)")
    #expect(!r.allEvents.contains(.resumeFailed(sessionId: Rig.sessionId)))
  }

  /// The control: a real conversation whose resume fails is still "can't be resumed": stopped, the id kept for the owner's choice.
  @Test func aRealConversationWhoseResumeFailsStillStops() throws {
    let r = try Rig(.direct, scenario: "resume-missing.sh", timings: timings(), session: confirmedSession)
    defer { r.teardown() }
    r.start()
    #expect(r.tickUntil(30) { stopReason(r.phase()) == .resumeMissing(Rig.sessionId) }, "\(r.phase()), audit: \(r.audit)")
    r.tickFor(1)
    #expect(r.starts.count == 1 && r.config.session.id == Rig.sessionId && !r.audit.contains("session_empty_new_id"))
  }

  /// With auto-restart off nothing is mended by a restart: the refused start is the end, as any exit is.
  @Test func withAutoRestartOffNoMendingRestartIsMade() throws {
    let r = try Rig(
      .direct, scenario: "unsaved-session.sh", env: ["FAKE_REFUSE_SESSION_ID": "1", "FAKE_ERROR_HOLD": "2"], timings: timings(),
      session: confirmedSession, configure: { $0.args = noDialogArgs; $0.autoRestart = false })
    defer { r.teardown() }
    try FileManager.default.removeItem(atPath: SessionTranscript.path(sessionId: Rig.sessionId, folder: r.agentDir, claudeDir: r.home + "/.claude"))
    r.start()
    #expect(r.tickUntil(30) { stopReason(r.phase()) == .crashedNoAutoRestart }, "\(r.phase()), audit: \(r.audit)")
    r.tickFor(1.5)
    #expect(r.starts.count == 1 && r.starts.first?.contains("--session-id=\(Rig.sessionId)") == true, "\(r.starts)")
    #expect(!r.audit.contains("session_in_use_resume"), "audit: \(r.audit)")
  }
}

// MARK: 8. the one writer of desktop.json

@Suite("Main resilience: the launch-trust migration saves through the supervisor's own writer", .serialized)
struct MigrationSaveTests {
  private func needsMigration(_ r: Rig) throws {
    var c = r.config
    c.launchTrust = 0
    c.confirmedLaunch = "an-old-plain-fingerprint"
    try ConfigFile.save(c, to: r.configPath)
  }

  /// The step still runs and is still saved at launch, now by the supervisor.
  @Test func aMigratedConfigIsSavedAtLaunch() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    try needsMigration(r)
    r.makeSupervisor()
    #expect(r.config.launchTrust == LaunchTrustMigration.version && r.config.confirmedLaunch == nil)
    #expect(r.audit.contains(" launch_trust_migrated") && !r.audit.contains("config_save_failed"))
  }

  /// A write that fails is in the log (it used to be swallowed), and the supervisor goes on with the migrated config in memory.
  @Test func aFailedSaveOfTheMigrationIsLogged() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer {
      chmod(r.root, 0o700)
      r.teardown()
    }
    try needsMigration(r)
    let before = FileManager.default.contents(atPath: r.configPath)
    if !FileManager.default.fileExists(atPath: r.auditPath) { FileManager.default.createFile(atPath: r.auditPath, contents: nil) }
    chmod(r.root, 0o500)  // the folder takes no new file: the atomic write cannot make its temp file
    let s = r.makeSupervisor()
    chmod(r.root, 0o700)
    #expect(r.audit.contains(" config_save_failed"), "audit: \(r.audit)")
    #expect(FileManager.default.contents(atPath: r.configPath) == before && s.currentConfig().launchTrust == LaunchTrustMigration.version)
  }

  /// The refusal sits in the writer itself: with the file known unreadable, a migration that ran writes nothing.
  @Test func theWriterItselfRefusesWhileTheFileIsUnreadable() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    try needsMigration(r)
    let before = FileManager.default.contents(atPath: r.configPath)
    var o = Supervisor.Options(name: "agent", configPath: r.configPath, home: r.home, talosAppHome: r.talosHome, auditLogPath: r.auditPath)
    o.configKnownUnreadable = true
    let env = r.loginEnv
    let s = Supervisor(options: o, host: SwiftTermPtyHost(), probe: LiveSystem(loginEnv: { env }), timings: r.timings)
    #expect(s.status.configUnreadable)
    #expect(r.audit.contains("config_unreadable_refused what=save"), "audit: \(r.audit)")
    #expect(FileManager.default.contents(atPath: r.configPath) == before, "not a byte")
  }
}

// MARK: review follow-ups

/// The real host with one fault in front of it: from the `failFrom`th start or restart on, the agent "was gone before its pid could
/// be read" (what a loaded Mac does). Every other call goes to the real host.
final class DiesBeforeItsPidHost: PtyHost, @unchecked Sendable {
  private let base: PtyHost
  private let failFrom: Int
  private let lock = NSLock()
  private var launches = 0
  init(_ base: PtyHost, failFrom: Int) {
    self.base = base
    self.failFrom = failFrom
  }
  private func nextFails() -> Bool { lock.withLock { launches += 1; return launches >= failFrom } }
  var kind: HostKind { base.kind }
  func start(executable: String, args: [String], env: [String: String], cwd: String) throws {
    if nextFails() { throw PtyHostError.exitedImmediately(rows: []) }
    try base.start(executable: executable, args: args, env: env, cwd: cwd)
  }
  func restart(executable: String, args: [String], env: [String: String], cwd: String) throws {
    if nextFails() { throw PtyHostError.exitedImmediately(rows: []) }
    try base.restart(executable: executable, args: args, env: env, cwd: cwd)
  }
  func attachIfRunning() -> Bool { base.attachIfRunning() }
  func send(keys: [UInt8]) -> SendOutcome { base.send(keys: keys) }
  func sendDialogKey(_ key: DialogKey) -> SendOutcome { base.sendDialogKey(key) }
  func visibleRows() -> [String]? { base.visibleRows() }
  func lastOutputAt() -> Date? { base.lastOutputAt() }
  func terminate(graceSeconds: Double) { base.terminate(graceSeconds: graceSeconds) }
  func close() { base.close() }
  func detach() { base.detach() }
  func clientActivity() -> Double? { base.clientActivity() }
  func clientActivities() -> [Double]? { base.clientActivities() }
  var childPid: Int32? { base.childPid }
  var onExit: (@Sendable (ExitInfo) -> Void)? {
    get { base.onExit }
    set { base.onExit = newValue }
  }
  func setMarker(_ key: String, _ value: String) { base.setMarker(key, value) }
  func marker(_ key: String) -> String? { base.marker(key) }
}

@Suite("Main resilience: review follow-ups", .serialized)
struct ReviewFollowUpTests {
  /// R1-2. A restart after a crash that is a COLD one (the launch changed while Main ran) and whose child dies before its pid is
  /// read is a failed attempt like any other restart's: tried again, and at the cap the crash loop's stop and its phone line. It
  /// used to end at the first try as "couldn't start", with nobody told.
  @Test(arguments: bothHosts)
  func aColdRestartAfterACrashThatDiesBeforeItsPidIsTriedAgain(kind: HostKind) throws {
    let r = try Rig(
      kind, scenario: "unsaved-session.sh", env: ["FAKE_CRASH_ON_FILE": "1", "FAKE_SAVE_AT_START": "1"], timings: timings { $0.restartCap = 3 },
      configure: { $0.args = noDialogArgs })
    defer { r.teardown() }
    r.sup.detach()
    r.wrapHost = { DiesBeforeItsPidHost($0, failFrom: 2) }
    r.makeSupervisor()
    r.start()
    #expect(r.tickUntil { r.starts.count == 1 && isRunning(r.phase()) }, "\(r.phase())")
    r.sup.mutateConfig { $0.env["A_NEW_VARIABLE"] = "1" }  // the launch changed: the next restart is a cold one
    r.sup.drain()
    r.crashNow()
    #expect(r.tickUntil(60) { r.audit.contains(" restart attempt=0 kind=cold") }, "the restart is cold: \(r.audit)")
    #expect(r.tickUntil(60) { r.count("restart_failed") >= 3 }, "tried again up to the cap: \(r.phase()), audit: \(r.audit)")
    #expect(r.wait(10) { r.crashPosts.count == 1 }, "and the phone is told when it gives up: \(r.posts)")
    #expect(r.allEvents.contains(.stoppedRestarting))
    #expect(r.starts.count == 1)
  }

  /// R1-1. Opening the app on an unreadable desktop.json tells the phone, once: nobody may be at the Mac to see the menu. It needs
  /// only `talos-app` on the login PATH and the default thread of the bridge's config.json (desktop.json itself says nothing now).
  @Test func anUnreadableConfigIsToldToThePhoneOnce() throws {
    let scratch = (TestTemp.base as NSString).appendingPathComponent("talos-posts-\(UUID().uuidString.prefix(8)).log")
    defer { unlink(scratch) }
    let r = try Rig(
      .direct, scenario: "dev-dialog.sh", timings: timings(),
      loginExtra: ["PATH": Rig.fixtures + ":/usr/bin:/bin:/usr/sbin:/sbin", "FAKE_POST_LOG": scratch])
    defer { r.teardown() }
    let told = { completeLines(scratch).filter { $0.contains("can't read desktop.json") } }
    #expect(told().isEmpty)
    try Data("{\"agent_dir\": 5}".utf8).write(to: URL(fileURLWithPath: r.configPath))
    let s = r.makeSupervisor()
    #expect(r.wait(15) { told().count == 1 }, "posts: \(completeLines(scratch)), audit: \(r.audit)")
    #expect(told().first == "post general Talos can't read desktop.json; Main isn't started. Fix the file or open the menu", "\(told())")
    s.startTicking()
    s.attachOrStart(allowColdStart: true)
    s.start()
    s.mutateConfig { $0.autoRestart = false }
    r.tickFor(1.5)
    #expect(told().count == 1, "once, whatever is tried after: \(told())")
  }

  /// The control: a missing file (not set up) and a healthy one post nothing of the kind.
  @Test func aMissingOrHealthyConfigPostsNoSuchLine() throws {
    let scratch = (TestTemp.base as NSString).appendingPathComponent("talos-posts-\(UUID().uuidString.prefix(8)).log")
    defer { unlink(scratch) }
    let r = try Rig(
      .direct, scenario: "dev-dialog.sh", timings: timings(),
      loginExtra: ["PATH": Rig.fixtures + ":/usr/bin:/bin:/usr/sbin:/sbin", "FAKE_POST_LOG": scratch])
    defer { r.teardown() }
    r.makeSupervisor().drain()
    try FileManager.default.removeItem(atPath: r.configPath)
    r.makeSupervisor().drain()
    usleep(800_000)
    #expect(completeLines(scratch).isEmpty && r.phonePosts.isEmpty, "\(completeLines(scratch)) \(r.posts)")
  }
}
