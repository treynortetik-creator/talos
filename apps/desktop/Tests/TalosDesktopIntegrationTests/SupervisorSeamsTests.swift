import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// The seams of the supervisor that decide what the owner sees: a start that never settles, the two off switches, following the
/// session id the CLI reports, the menu's Restart session, and a second login-expired dialog. Real pty or real private tmux,
/// the fake `claude`; every wait only caps a hang.
@Suite("Supervisor seams (real pty, real tmux)", .serialized)
struct SupervisorSeamsTests {
  private static func timings() -> Supervisor.Timings {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.backoff = Backoff(steps: [0.3, 0.5, 0.5, 0.5, 0.5], jitter: 0)
    t.dialogStall = 2
    t.stopGrace = 3
    return t
  }

  private func count(_ needle: String, in text: String) -> Int { text.components(separatedBy: needle).count - 1 }

  /// Passes the start deadline without waiting for it: each poll moves the supervisor's clock on, until it says it has waited too long.
  private func startStalls(_ r: Rig) -> Bool {
    r.wait(60) { r.clock.advance(60); r.sup.tickNow(); return r.sup.status.needsYou == .startStalled }
  }

  // MARK: a start that never settles

  @Test(arguments: bothHosts)
  func aRestartThatShowsNeitherDialogNorNoticeStopsWaitingAndTellsTheOwner(kind: HostKind) throws {
    // Start 1 crashes 6 s after the notice, not the fake's 1 s: the restart shows nothing, so a start 1 that dies before the
    // test or the supervisor has seen it running (a starved poll, a slow `tmux send-keys`) leaves the phase `.starting` for good.
    let r = try Rig(kind, scenario: "restart-silent.sh", env: ["FAKE_CRASH_AFTER": "6"], timings: Self.timings())
    defer { r.teardown() }
    try coldStartConfirmed(r)  // start 1 crashes some seconds after the Enter; the restart then shows nothing recognisable
    #expect(r.wait(60) { r.starts.count >= 2 }, "restarted")
    #expect(startStalls(r), "needsYou \(String(describing: r.sup.status.needsYou)), phase \(r.phase()), audit: \(r.audit)")
    #expect(r.phase() == .starting, "it is not called running: nothing confirmed it")
    #expect(r.allEvents.contains(.needsYou(.startStalled)))
    #expect(r.audit.contains("needs_you why=start"))
    #expect(count("needs_you why=start", in: r.audit) == 1, "told once, not every tick")
    // The first start was waiting on the human for far less than the limit; nothing was raised for it.
    #expect(r.starts.count == 2)
  }

  @Test(arguments: bothHosts)
  func theStalledAlarmClearsWhenAnUnrecognisedPromptIsAnsweredAndTheSessionRuns(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "unknown-dialog.sh", timings: Self.timings())
    defer { r.teardown() }
    r.start()
    #expect(startStalls(r), "needsYou \(String(describing: r.sup.status.needsYou)), phase \(r.phase()), audit: \(r.audit)")
    r.humanEnter()
    #expect(r.wait(60) { r.sup.tickNow(); return isRunning(r.phase()) }, "running: \(r.phase()), audit: \(r.audit)")
    #expect(r.audit.contains("notice_without_dialog"))
    #expect(r.sup.status.needsYou == nil, "a healthy running session must not keep the start alarm: \(String(describing: r.sup.status.needsYou))")
  }

  @Test(arguments: bothHosts)
  func aColdStartWhoseDialogIsGoneAndNoticeNeverComesStopsWaitingAndSaysSo(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dialog-then-silent.sh", timings: Self.timings(), configure: { $0.autoConfirmRestart = false })
    defer { r.teardown() }
    r.start()
    #expect(r.wait(20) { r.screenContains(DialogMatcher.Strings.devTitle) }, "dialog shown")
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart })
    r.humanEnter()
    #expect(
      startStalls(r),
      "the held cold-start question must not hide the stall: needsYou \(String(describing: r.sup.status.needsYou)), phase \(r.phase()), audit: \(r.audit)")
    #expect(r.phase() == .starting)
    #expect(r.audit.contains("needs_you why=start"))
  }

  // MARK: the off switches

  @Test(arguments: bothHosts)
  func withAutoRestartOffACrashStopsTheSessionAndNothingStartsAgain(kind: HostKind) throws {
    let r = try Rig(
      kind, scenario: "crash-after.sh", env: ["FAKE_CRASH_SECONDS": "1"], timings: Self.timings(),
      configure: { $0.autoRestart = false })
    defer { r.teardown() }
    let lookalike = try r.spawn([Rig.fixtures + "/lookalike.sh"], commandLineHas: "server.ts")
    try coldStartConfirmed(r)
    #expect(r.wait(30) { stopReason(r.phase()) == .crashedNoAutoRestart }, "phase \(r.phase()), audit: \(r.audit)")
    #expect(r.allEvents.contains(.stopped(.crashedNoAutoRestart)))
    #expect(!r.allEvents.contains { if case .restarting = $0 { return true } else { return false } })
    // Give a wrongly scheduled restart time to happen: its back-off here is 0.3 s.
    usleep(2_000_000)
    #expect(r.starts.count == 1, "no second start: \(r.starts)")
    #expect(stopReason(r.phase()) == .crashedNoAutoRestart)
    #expect(ProcessInspect.alive(lookalike), "only the dead child's own group is cleared")
  }

  @Test(arguments: bothHosts)
  func withAutoEnterOffARestartWaitsForTheOwnerAndPressesNothing(kind: HostKind) throws {
    let r = try Rig(
      kind, scenario: "crash-after.sh", env: ["FAKE_CRASH_SECONDS": "1"], timings: Self.timings(),
      configure: { $0.autoConfirmRestart = false })
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(r.wait(30) { r.starts.count >= 2 }, "restarted")
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) })
    #expect(
      r.wait(10) { r.sup.tickNow(); return r.sup.status.needsYou == .restartNotConfirmed(.disabled) },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    usleep(2_000_000)
    #expect(r.screenContains(DialogMatcher.Strings.devConfirm), "no keypress: the dialog is still up")
    #expect(r.phase() == .starting)
    #expect(!r.audit.contains(" auto_confirm "))
    #expect(!r.allEvents.contains { if case .autoConfirmed = $0 { return true } else { return false } })
    // The owner's own Enter still gets it going.
    r.humanEnter()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "running after the owner's Enter: \(r.phase())")
  }

  // MARK: following the id the CLI reports

  @Test(arguments: bothHosts)
  func theSessionIdTheCliReportsIsFollowedAndTheConfirmationMovesWithIt(kind: HostKind) throws {
    let reported = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    let r = try Rig(kind, scenario: "dev-dialog.sh", env: ["FAKE_REPORT_SESSION_ID": reported], timings: Self.timings(), configure: { $0.autoConfirmRestart = false })
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(
      r.wait(30) { r.sup.tickNow(); return r.config.session.id == reported },
      "id \(String(describing: r.config.session.id)), audit: \(r.audit)")
    let s = r.config.session
    let launchedWith = s.previousIds.first ?? "-"
    #expect(s.previousIds.count == 1 && launchedWith != reported, "the id we launched with is remembered")
    #expect(s.confirmedAt != nil, "this start was confirmed by the owner, so the confirmation moves to the new id")
    #expect(s.confirmedCliVersion == nil, "no longer written")
    #expect(r.host.marker("talos_session") == reported, "a relaunch of the app sees the id we follow")
    #expect(r.audit.contains("session_id_changed from=\(launchedWith) to=\(reported)"))
    #expect(count("session_id_changed", in: r.audit) == 1, "followed once, not on every poll")
  }

  /// Choose into another folder restarts nothing: the old session keeps running in the old folder, and what it reports is
  /// the old folder's. It must not land in the config of the new one.
  @Test(arguments: bothHosts)
  func anIdReportedByASessionInAnotherFolderThanTheConfiguredOneIsNotFollowed(kind: HostKind) throws {
    let reported = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    // The owner's Enter is the point here: the app's own is off, or it would answer the dialog before the folder moves.
    let r = try Rig(
      kind, scenario: "dev-dialog.sh", env: ["FAKE_REPORT_SESSION_ID": reported], timings: Self.timings(),
      configure: { $0.autoConfirmRestart = false })
    defer { r.teardown() }
    r.start()
    usleep(1_000_000)  // a slow test thread (a loaded Mac): with the app's Enter on, the dialog is answered and gone by now
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) }, "dialog shown")
    let other = r.root + "/other-folder"
    r.sup.mutateConfig { $0.agentDir = other }  // Choose into B while A's session runs
    r.sup.drain()
    #expect(r.config.session.id == nil, "the new folder starts with no id")
    r.humanEnter()  // the old session goes on, and its list entry now carries a new id
    #expect(r.wait(20) { r.sup.tickNow(); return isRunning(r.phase()) })
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.status.agentActivity != nil }, "a poll of the CLI's agent list has been read")
    usleep(1_500_000)
    #expect(r.config.session.id == nil, "A's id is not B's: \(String(describing: r.config.session.id))")
    #expect(r.config.session.confirmedAt == nil)
    #expect(!r.audit.contains("session_id_changed"))
    let onDisk = try #require(try ConfigFile.load(r.configPath))
    #expect(onDisk.session.id == nil, "and the file never held it, so no restart resumes it")
  }

  @Test(arguments: bothHosts)
  func anIdThatIsNotAUuidIsNotFollowed(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog.sh", env: ["FAKE_REPORT_SESSION_ID": "not-a-uuid"], timings: Self.timings())
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let launchedWith = try #require(r.config.session.id)
    #expect(r.wait(30) { r.sup.status.agentActivity != nil }, "a poll of the CLI's agent list has been read")
    usleep(1_500_000)
    #expect(r.config.session.id == launchedWith)
    #expect(r.config.session.previousIds.isEmpty)
    #expect(!r.audit.contains("session_id_changed"))
  }

  /// A list the CLI would not give is not "still busy": the last activity must go, or the menu says busy for good.
  @Test(arguments: bothHosts)
  func aFailedAgentsPollDoesNotKeepTheLastActivity(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog.sh", timings: Self.timings())
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(r.wait(30) { r.sup.status.agentActivity != nil }, "a poll of the CLI's agent list has been read")
    FileManager.default.createFile(atPath: r.agentsDir + "/fail", contents: nil)  // `claude agents` now fails
    #expect(
      r.wait(30) { r.sup.status.agentActivity == nil },
      "the list could not be read, but the activity is still \(String(describing: r.sup.status.agentActivity))")
  }

  // MARK: menu Restart session

  @Test(arguments: bothHosts)
  func restartSessionStopsTheOldChildThenStartsAColdResumeThatWaitsForTheOwner(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog.sh", timings: Self.timings(), configure: { $0.autoConfirmRestart = false })
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let id = try #require(r.config.session.id)
    let oldPid = try #require(r.sup.status.childPid)

    r.sup.restartCold()

    #expect(r.wait(30) { r.starts.count >= 2 }, "a second start: \(r.starts), audit: \(r.audit)")
    #expect(r.wait(10) { !ProcessInspect.alive(oldPid) }, "the old child is gone")
    #expect((r.starts.dropFirst().first ?? "").contains("--resume \(id)"), "the same conversation resumes")
    #expect(
      r.wait(15) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart },
      "a menu restart is a cold start: the owner presses Enter. needsYou \(String(describing: r.sup.status.needsYou)), phase \(r.phase())")
    #expect(r.sup.status.startKind == .cold)
    #expect(!r.audit.contains(" auto_confirm "), "the app pressed nothing")
    // Asked for by the owner: not a crash, so no back-off, no restart count, no crash banner.
    #expect(!r.allEvents.contains { if case .restarting = $0 { return true } else { return false } })
    #expect(!r.allEvents.contains(.stoppedRestarting))
    r.humanEnter()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "running after the owner's Enter: \(r.phase())")
    #expect(r.starts.count == 2)
  }

  // MARK: a second login-expired dialog

  @Test(arguments: bothHosts)
  func aSecondLoginExpiredDialogAsksTheOwnerAgain(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "login-twice.sh", timings: Self.timings())
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let login = Supervisor.NeedsYou.dialog("login expired")
    let key = "needs_you why=stall:login expired"

    r.humanEnter()  // the fake's login dialog, first time
    #expect(
      r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == login },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    #expect(count(key, in: r.audit) == 1)

    r.humanEnter()  // the owner logged in: the session is back
    #expect(
      r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == nil },
      "the resolved dialog no longer asks for the owner: \(String(describing: r.sup.status.needsYou))")

    r.humanEnter()  // the login expires again
    #expect(
      r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == login },
      "the second dialog asks again. needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    #expect(count(key, in: r.audit) == 2, "two needs_you records, one per dialog")
    #expect(count(".needsYou(", in: "\(r.allEvents)") >= 2)
  }

  // MARK: the phone post after a crash loop

  /// A crash loop stops the session and the Mac says so; the post to the owner's phone is best effort. When it cannot be
  /// made, the reason is written to the audit log (event names only), the session still stops, and the Mac banner still fires.
  private func crashLoopWithoutAPost(
    _ why: String, env: [String: String] = [:], configure: @escaping (inout DesktopConfig) -> Void,
    prepare: (Rig) throws -> Void = { _ in }
  ) throws {
    let r = try Rig(.direct, scenario: "bad-flag.sh", env: env, session: confirmedSession, configure: configure)
    defer { r.teardown() }
    try prepare(r)
    r.start()
    #expect(r.wait(60) { stopReason(r.phase()) == .crashLoop }, "\(r.phase())")
    #expect(r.wait(10) { r.audit.contains("post_skipped why=\(why)") }, "audit: \(r.audit)")
    // The crash loop also runs the one automatic restore (K12b), which calls talos-app restore-last-good and lands in the same
    // log; only a phone post counts here.
    #expect(r.phonePosts.isEmpty, "nothing was posted: \(r.posts)")
    #expect(!r.audit.contains(" post ok="), "no post is claimed")
    #expect(r.allEvents.contains(.stoppedRestarting), "the Mac still tells the owner")
    // The restore finishes after the loop's own post was decided; count only once it is over (a restore that changed something posts too).
    #expect(r.wait(30) { r.audit.contains(" restore code=") || r.audit.contains(" restore_skipped") }, "audit: \(r.audit)")
    r.sup.drain()
    #expect(count("post_skipped", in: r.audit) == 1, "decided once: \(r.audit)")
  }

  @Test func aTypedTalosAppCommandThatIsMissingSkipsThePostAndSaysWhy() throws {
    try crashLoopWithoutAPost("talos_app_command not found") { $0.talosAppCommand = ["/home/alex/missing/talos-app"] }
  }

  @Test func noTalosAppAnywhereSkipsThePostAndSaysWhy() throws {
    try crashLoopWithoutAPost("talos-app not found") { $0.talosAppCommand = [] }
  }

  @Test func noThreadToPostInSkipsThePostAndSaysWhy() throws {
    // The restore that follows the loop would post too (and be skipped for the same reason) unless it changed nothing.
    try crashLoopWithoutAPost(
      "no default thread",
      env: ["FAKE_RESTORE_OUTPUT": "restore-last-good: the agent folder already matches that version. Nothing to do."],
      configure: { _ in },
      prepare: { r in
        try "{\"agent\":{\"name\":\"Testagent\"}}".write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
      })
  }

  @Test func aPostThatFailsIsRecordedAsFailedNeverAsSent() throws {
    let r = try Rig(
      .direct, scenario: "bad-flag.sh", session: confirmedSession,
      configure: { $0.talosAppCommand = [Rig.fixtures + "/talos-app-fails"] })
    defer { r.teardown() }
    r.start()
    #expect(r.wait(60) { stopReason(r.phase()) == .crashLoop }, "\(r.phase())")
    #expect(r.wait(10) { r.audit.contains(" post ok=0") }, "audit: \(r.audit)")
    #expect(r.crashPosts.count == 1, "it was tried")
    #expect(!r.audit.contains(" post ok=1"))
  }
}
