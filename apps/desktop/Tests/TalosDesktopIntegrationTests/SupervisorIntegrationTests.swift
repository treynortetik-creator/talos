import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// DESKTOP-SPEC WP-D1 acceptance, through a real pty and a real private tmux server, against both hosts.
let bothHosts: [HostKind] = Rig.hasTmux ? [.tmux, .direct] : [.direct]

let confirmedSession = DesktopConfig.Session(
  id: Rig.sessionId, previousIds: [], confirmedAt: "2026-10-30T00:00:00Z", confirmedCliVersion: "2.1.312",
  approvedDevChannels: ["server:talos-app"])

func isRunning(_ p: Supervisor.Phase) -> Bool { p == .running }

func stopReason(_ p: Supervisor.Phase) -> Supervisor.StopReason? {
  if case .stopped(let r) = p { return r }
  return nil
}

func blockers(_ p: Supervisor.Phase) -> [TakeoverCheck.Blocker]? {
  if case .blocked(let b) = p { return b }
  return nil
}

/// Brings a fresh rig to "running, confirmed by the human".
func coldStartConfirmed(_ r: Rig) throws {
  r.start()
  // A real tmux costs a subprocess per read, so on a loaded Mac its caps are longer. Every one only caps a hang.
  let cap: Double = r.kind == .tmux ? 30 : 10
  #expect(r.wait(cap) { r.screenContains(DialogMatcher.Strings.devTitle) }, "dialog shown")
  // Bounds are generous on purpose: they only cap a hang. Under CI load (parallel swift builds) the supervisor's tick
  // can be starved for seconds after the dialog is on screen (aSecondSupervisor... failed here once, 2026-10-30).
  // `tickNow()` asks for a supervision pass now instead of waiting for the 0.2 s timer to be scheduled: on a loaded Mac the
  // timer and the tmux reads behind each pass are what run late, and the 20 s only caps a pass that never comes.
  #expect(
    r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart },
    "needsYou \(String(describing: r.sup.status.needsYou)), phase \(r.phase()), audit: \(r.audit)")
  r.humanEnter()
  #expect(r.wait(cap) { r.sup.tickNow(); return isRunning(r.phase()) }, "running after the human Enter: \(r.phase())")
  #expect(r.wait(cap) { r.config.session.confirmedAt != nil })
}

@Suite("Supervisor (real pty, real tmux)", .serialized)
struct SupervisorIntegrationTests {
  @Test(arguments: bothHosts)
  func coldStartWaitsForTheHumanEnter(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) })
    #expect(r.wait(5) { r.sup.status.needsYou == .confirmColdStart })
    // The app presses nothing: the dialog is still there a while later, and nothing is recorded.
    usleep(1_500_000)
    #expect(r.screenContains(DialogMatcher.Strings.devConfirm))
    #expect(r.phase() == .starting)
    #expect(r.config.session.confirmedAt == nil)
    #expect(r.wait(5) { r.allEvents.contains(.openTerminal) })
    #expect(!r.audit.contains("auto_confirm"))

    r.humanEnter()
    #expect(r.wait(10) { isRunning(r.phase()) })
    let s = r.config.session
    #expect(s.confirmedAt != nil)
    #expect(s.confirmedCliVersion == "2.1.312")
    #expect(s.approvedDevChannels == ["server:talos-app"])
    #expect(s.id != nil && ResumeRewrite.isUUID(s.id ?? ""))
    // A first start with no session id passes --session-id <new uuid>.
    #expect(r.starts.count == 1)
    #expect(r.starts.first?.contains("--session-id \(s.id ?? "-")") == true)
    #expect(r.wait(5) { r.audit.contains("human_confirm") })
  }

  @Test(arguments: bothHosts)
  func crashCleansTheGroupThenResumesAndAutoConfirmsOnce(kind: HostKind) throws {
    var t = Supervisor.Timings()  // real 2 s backoff, real 10 s clean-up cap
    t.tick = 0.2
    t.agentsPoll = 0.5
    let r = try Rig(kind, scenario: "crash-after.sh", env: ["FAKE_CRASH_SECONDS": "1"], timings: t)
    defer { r.teardown() }
    let lookalike = try r.spawn([Rig.fixtures + "/lookalike.sh"], commandLineHas: "server.ts")
    try coldStartConfirmed(r)
    let id = try #require(r.config.session.id)
    #expect(r.wait(10) { !r.holders.isEmpty }, "the crashing child spawned its group member")
    let holder = try #require(r.holders.first)
    #expect(ProcessInspect.basic(holder)?.pgid == r.sup.status.childPid)

    // Real 2 s back-off and real 10 s clean-up cap, so the restart can take a while; the wait only caps a hang. What
    // the clean-up promises is checked below: the group is gone and the restart resumes the same session.
    #expect(r.wait(60) { r.starts.count >= 2 }, "restarted")
    // What bounds the restart is pinned where it is set, not timed: the back-off it announced is the first step (2 s plus
    // at most 20 % jitter), and the clean-up cap is the 10 s of the timings this rig runs with.
    let delays = r.allEvents.compactMap { e -> Double? in
      if case .restarting(_, let d) = e { return d } else { return nil }
    }
    #expect(delays.first.map { $0 <= 2.4 } == true, "the first restart's back-off was \(String(describing: delays.first)) s")
    #expect(t.cleanupWait <= 10)
    #expect(!ProcessInspect.alive(holder), "the dead child's group is gone, including its sleep")
    #expect(ProcessInspect.alive(lookalike), "a lookalike outside the group survives")
    #expect(r.starts[1].contains("--resume \(id)"))
    #expect(!r.starts[1].contains("--session-id"))

    #expect(r.wait(10) { isRunning(r.phase()) }, "auto-confirmed: \(r.phase())")
    #expect(r.wait(5) { r.allEvents.filter { if case .autoConfirmed = $0 { return true } else { return false } }.count == 1 })
    #expect(r.audit.components(separatedBy: " auto_confirm ").count - 1 == 1)
    #expect(r.wait(5) { r.audit.contains("auto_confirm_ok") })
    #expect(r.config.session.id == id)
  }

  /// The stall check and the cold-start check look at the same dialog in the same pass. With a stall limit of zero the
  /// stall is due the moment the dialog is on screen, so both fire in one tick and the outcome does not depend on how
  /// late the test or the machine is: the question the owner was asked ("press Enter") must stay, not be replaced by
  /// the vaguer "a dialog needs you".
  @Test(arguments: bothHosts)
  func aDialogStallNeverReplacesTheColdStartQuestion(kind: HostKind) throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.dialogStall = 0
    let r = try Rig(kind, scenario: "dev-dialog.sh", timings: t)
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) }, "dialog shown")
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou != nil }, "something was raised")
    #expect(r.sup.status.needsYou == .confirmColdStart, "\(String(describing: r.sup.status.needsYou))")
    for _ in 0..<5 { r.sup.tickNow() }
    #expect(r.sup.status.needsYou == .confirmColdStart, "later passes: \(String(describing: r.sup.status.needsYou))")
    #expect(!r.audit.contains("why=stall:"), "no stall raised for a dialog the owner was already told about: \(r.audit)")
    #expect(r.allEvents.filter { if case .needsYou = $0 { return true } else { return false } } == [.needsYou(.confirmColdStart)])
  }

  /// The cold-start question covers the dev-channel dialog only. After the owner's Enter, a different dialog (and no
  /// registration notice) must still get its own banner and terminal, not wait forever behind the first question.
  @Test(arguments: bothHosts)
  func aDifferentDialogAfterTheEnterStillRaisesTheStall(kind: HostKind) throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.dialogStall = 0
    let r = try Rig(kind, scenario: "dev-dialog-then-trust.sh", timings: t)
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) }, "dialog shown")
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart }, "cold-start question")
    r.humanEnter()
    #expect(r.wait(10) { r.screenContains("Yes, I trust this folder") }, "the second dialog is up")
    #expect(
      r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .dialog("folder trust") },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    #expect(r.audit.contains("why=stall:folder trust"))
    #expect(r.wait(5) { r.allEvents.filter { $0 == .openTerminal }.count == 2 }, "a terminal for each dialog")
  }

  /// Same shape for a refused restart: the refusal is the question for the dev dialog, and the stall limit is already
  /// due in the pass that raises it, so the refusal must survive further passes.
  @Test(arguments: bothHosts)
  func aDialogStallNeverReplacesARefusedRestartQuestion(kind: HostKind) throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.backoff = Backoff(steps: [0.3, 0.5, 0.5, 0.5, 0.5], jitter: 0)
    t.dialogStall = 0
    t.stopGrace = 3
    // FAKE_CRASH_SECONDS is read only by crash-after.sh; this scenario's crash delay is FAKE_CRASH_AFTER. Start 1 crashes 6 s
    // after its notice (the fake's default is 1 s), so a late poll still sees it running after the human Enter.
    let r = try Rig(kind, scenario: "extra-channel.sh", env: ["FAKE_CRASH_AFTER": "6"], timings: t)
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(r.wait(30) { r.starts.count >= 2 })
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) })
    let want = Supervisor.NeedsYou.restartNotConfirmed(.channelsMismatch)
    #expect(r.wait(10) { r.sup.tickNow(); return r.sup.status.needsYou == want }, "\(String(describing: r.sup.status.needsYou))")
    for _ in 0..<5 { r.sup.tickNow() }
    #expect(r.sup.status.needsYou == want, "later passes: \(String(describing: r.sup.status.needsYou))")
    #expect(!r.audit.contains("why=stall:"), "\(r.audit)")
  }

  enum Refuse: String, CaseIterable, Sendable { case extraChannel, wrongHighlight, versionChanged }

  @Test(arguments: bothHosts, Refuse.allCases)
  func restartRefusesAnythingButTheExactDialog(kind: HostKind, why: Refuse) throws {
    let scenario: String
    // The two crash_first_then scenarios crash start 1 6 s after its notice (the fake's default is 1 s), so a late poll still
    // sees it running after the human Enter. `.versionChanged` runs crash-after.sh, which has its own FAKE_CRASH_SECONDS.
    var env: [String: String] = ["FAKE_CRASH_AFTER": "6"]
    let versionFile = NSTemporaryDirectory() + "talos-d1-ver-\(UUID().uuidString.prefix(6))"
    switch why {
    case .extraChannel: scenario = "extra-channel.sh"
    case .wrongHighlight: scenario = "wrong-highlight.sh"
    case .versionChanged:
      scenario = "crash-after.sh"
      env = ["FAKE_CLI_VERSION_FILE": versionFile, "FAKE_CRASH_SECONDS": "1"]
    }
    defer { try? FileManager.default.removeItem(atPath: versionFile) }
    let r = try Rig(kind, scenario: scenario, env: env)
    defer { r.teardown() }
    try coldStartConfirmed(r)
    // The native installer moved claude between restarts.
    if why == .versionChanged { try "2.1.313".write(toFile: versionFile, atomically: true, encoding: .utf8) }
    #expect(r.wait(30) { r.starts.count >= 2 })
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) })
    let expected: AutoConfirmGuard.Refusal =
      switch why {
      case .extraChannel: .channelsMismatch
      case .wrongHighlight: .wrongHighlight
      case .versionChanged: .versionChanged
      }
    #expect(
      r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .restartNotConfirmed(expected) },
      "\(String(describing: r.sup.status.needsYou))")
    usleep(1_500_000)
    #expect(r.screenContains(DialogMatcher.Strings.devTitle), "no keypress: the dialog is still up")
    #expect(r.phase() == .starting)
    #expect(!r.audit.contains(" auto_confirm "))
  }

  @Test(arguments: bothHosts)
  func noNoticeAfterTheEnterStopsAfterFifteenSeconds(kind: HostKind) throws {
    // Start 1 crashes 6 s after its notice (the fake's default is 1 s), so a late poll still sees it running after the human Enter.
    let r = try Rig(kind, scenario: "no-notice.sh", env: ["FAKE_CRASH_AFTER": "6"])
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(r.wait(30) { r.starts.count >= 2 })
    #expect(r.wait(30) { r.sup.tickNow(); return r.audit.contains(" auto_confirm ") })
    let sent = Date()
    #expect(r.wait(25) { stopReason(r.phase()) == .noNotice }, "\(r.phase())")
    #expect(Date().timeIntervalSince(sent) >= 13.5)
    #expect(r.wait(5) { r.allEvents.contains(.confirmFailed) })
    #expect(r.starts.count == 2, "no further restart")
  }

  @Test(arguments: bothHosts)
  func badFlagCountsAsCrashesUpToTheCapAndKeepsTheSessionId(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "bad-flag.sh", session: confirmedSession)
    defer { r.teardown() }
    r.start()
    // The loop's stop brings the one automatic restore and its restart; that start crashes too and the loop stops it again.
    // Each poll ticks the supervisor, so a late timer under load cannot hold the loop back.
    #expect(
      r.wait(40) {
        r.sup.tickNow()
        return r.starts.count == 7 && r.loopStopped && r.crashes >= 7
      },
      "\(r.phase()), starts \(r.starts.count)")
    r.sup.tickNow()
    #expect(r.starts.count == 7, "cold start + 5 restarts + the restore's one restart: \(r.starts.count)")
    #expect(r.config.session.id == Rig.sessionId)
    #expect(r.starts.allSatisfy { $0.contains("--resume \(Rig.sessionId)") })
    #expect(r.wait(5) { r.crashPosts.count == 1 })
  }

  @Test(arguments: bothHosts)
  func resumeMissingStopsAndKeepsTheIdUntilTheOwnerChooses(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "resume-missing.sh", session: confirmedSession)
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { stopReason(r.phase()) == .resumeMissing(Rig.sessionId) }, "\(r.phase())")
    usleep(800_000)
    #expect(r.starts.count == 1, "never restarted")
    #expect(r.config.session.id == Rig.sessionId, "never replaced on its own")
    #expect(r.wait(5) { r.allEvents.contains(.resumeFailed(sessionId: Rig.sessionId)) })

    r.sup.startNewConversation()
    #expect(r.wait(10) { r.starts.count == 2 })
    let s = r.config.session
    #expect(s.id != Rig.sessionId)
    #expect(s.previousIds == [Rig.sessionId])
    #expect(s.confirmedAt == nil)
    #expect(r.starts[1].contains("--session-id \(s.id ?? "-")"))
  }

  @Test(arguments: bothHosts)
  func sixCrashesInFifteenMinutesStopAfterTheFifthRestartAndPostOnce(kind: HostKind) throws {
    // Start 1 crashes 6 s after its notice (the fake's default is 1 s), so a late poll still sees it running after the human
    // Enter; the 5 s it adds is no part of what is counted, and the caps below only bound a hang.
    let r = try Rig(kind, scenario: "crash-loop.sh", env: ["FAKE_CRASH_AFTER": "6"])
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(r.wait(60) { r.loopStopped }, "\(r.phase())")
    #expect(r.starts.count >= 6)
    #expect(r.wait(5) { r.allEvents.contains(.stoppedRestarting) })
    #expect(r.wait(5) { r.crashPosts.count == 1 })
    let post = r.crashPosts.first ?? ""
    #expect(post.hasPrefix("post general Testagent's session stopped restarting at "))
    // The loop's stop also brings the one automatic restore and one restart; that start crashes and the loop stops it again. The
    // owner's phone is told about the loop once, not twice.
    #expect(r.wait(30) { r.starts.count == 7 && r.loopStopped && r.crashes >= 7 })
    #expect(r.crashPosts.count == 1)
    // The loop's own stop says so each time; a restore start that dies before its pid is a failed start, which does not.
    let loopStops = stopReason(r.phase()) == .crashLoop ? 2 : 1
    #expect(r.allEvents.filter { $0 == .stoppedRestarting }.count == loopStops, "the Mac says so each time the loop stops it")
  }

  @Test(arguments: bothHosts)
  func signalDeathIsACrashAndResumes(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "signal-death.sh")
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(r.wait(15) { r.starts.count >= 2 })
    let exit = r.poll(10) { r.sup.status.lastExit }
    #expect(exit != nil, "the exit was published")
    #expect(exit?.code == nil)
    if kind == .tmux { #expect(exit?.signal == 9) }
    #expect(r.wait(10) { isRunning(r.phase()) }, "\(r.phase())")
  }

  @Test(arguments: bothHosts)
  func theDialogPrintedTwiceIsAnsweredOnce(kind: HostKind) throws {
    // Start 1 crashes 6 s after its notice (the fake's default is 1 s), so a late poll still sees it running after the human Enter.
    let r = try Rig(kind, scenario: "dialog-twice.sh", env: ["FAKE_CRASH_AFTER": "6"])
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(r.wait(30) { r.starts.count >= 2 })
    #expect(
      r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == .restartNotConfirmed(.alreadyConfirmedThisStart) },
      "\(String(describing: r.sup.status.needsYou))")
    usleep(1_000_000)
    #expect(r.screenContains(DialogMatcher.Strings.devTitle))
    #expect(r.audit.components(separatedBy: " auto_confirm ").count - 1 == 1)
  }

  @Test(arguments: bothHosts)
  func anExitDuringTheNoticeWaitIsACrash(kind: HostKind) throws {
    // Start 1 crashes 6 s after its notice (the fake's default is 1 s), so a late poll still sees it running after the human Enter.
    let r = try Rig(kind, scenario: "exit-in-notice-wait.sh", env: ["FAKE_CRASH_AFTER": "6"])
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(r.wait(40) { r.starts.count >= 3 }, "the exit after the Enter was counted and restarted: \(r.starts.count)")
    // `starts` is the fake agent's own log; the supervisor publishes its status a beat later. Same bound, polled, so a
    // loaded machine cannot read the snapshot between the two (seen red on 2026-10-30, restartsInWindow was 1).
    #expect(r.wait(10) { r.sup.status.restartsInWindow >= 2 }, "restartsInWindow: \(r.sup.status.restartsInWindow)")
  }

  @Test(arguments: bothHosts)
  func missingFromAgentsListWhileAliveIsStuck(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "hang.sh")
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(r.wait(10) { r.sup.status.needsYou == .stuck })
    #expect(r.phase() == .running, "no automatic kill")
  }

  @Test(arguments: bothHosts)
  func anUnknownDialogStallIsNeverAnswered(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "trust-dialog.sh") { c in c.args = ["--dangerously-skip-permissions"] }
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.sup.status.needsYou == .dialog("folder trust") }, "\(String(describing: r.sup.status.needsYou))")
    #expect(r.wait(5) { r.allEvents.contains(.openTerminal) })
    #expect(r.screenContains("Yes, I trust this folder"))
  }
}

@Suite("Takeover check (real processes)", .serialized)
struct TakeoverIntegrationTests {
  @Test(arguments: bothHosts)
  func aPollerInAnotherGroupBlocksStart(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let poller = try r.spawn([Rig.fixtures + "/holder.sh"], commandLineHas: "server.ts")
    try "\(poller)".write(toFile: r.botPidPath, atomically: true, encoding: .utf8)
    r.start()
    #expect(r.wait(10) { blockers(r.phase()) != nil }, "\(r.phase())")
    let b = blockers(r.phase()) ?? []
    #expect(b.map(\.resource) == [.telegram])
    #expect(b.first?.holderPid == poller)
    #expect(b.first?.message.contains("Find a running session") == true)
    #expect(r.starts.isEmpty, "nothing started")
    #expect(ProcessInspect.alive(poller), "the check never kills")
  }

  @Test(arguments: bothHosts)
  func aPollerInsideOurOwnChildsGroupDoesNotBlock(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-holder.sh")
    defer { r.teardown() }
    var c = r.config
    c.env["FAKE_BOT_PID_FILE"] = r.botPidPath
    try ConfigFile.save(c, to: r.configPath)
    r.makeSupervisor()
    try coldStartConfirmed(r)
    #expect(r.wait(10) { !r.holders.isEmpty })
    let holder = try #require(r.holders.first)
    #expect(ProcessInspect.basic(holder)?.pgid == r.sup.status.childPid)
    #expect(r.sup.takeoverBlockers().isEmpty, "bot.pid and bridge.pid inside our own group are ours")
  }

  @Test(arguments: bothHosts)
  func anInteractiveSessionElsewhereWithChannelsBlocksStart(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let other = try r.spawn([Rig.fixtures + "/other-session.sh", "--channels", "plugin:telegram@example"])
    try r.registerAgent(pid: other, cwd: "/tmp/elsewhere")
    let quiet = try r.spawn([Rig.fixtures + "/other-session.sh", "--model", "x"])
    try r.registerAgent(pid: quiet, cwd: "/tmp/quiet", sessionId: "88888888-2222-4333-8444-555555555555")
    r.start()
    #expect(r.wait(10) { blockers(r.phase()) != nil }, "\(r.phase())")
    let b = blockers(r.phase()) ?? []
    #expect(b.count == 1, "only the one with --channels: \(b)")
    #expect(b.first?.resource == .channels)
    #expect(b.first?.sessionPid == other)
    #expect(b.first?.folder == "/tmp/elsewhere")
  }

  @Test func adoptPrefillsFromTheLiveProcess() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let dir = r.root + "/adopt-me"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let id = "aaaaaaaa-2222-4333-8444-555555555555"
    let p = Process()
    p.executableURL = URL(fileURLWithPath: Rig.fixtures + "/other-session.sh")
    p.arguments = ["--dangerously-skip-permissions", "--channels", "plugin:telegram@example", "--resume", id]
    p.environment = r.loginEnv.merging(["TALOS_APP_BRIDGE": "1", "TERM_SESSION_ID": "x"]) { _, b in b }
    p.currentDirectoryURL = URL(fileURLWithPath: dir)
    try p.run()
    defer { p.terminate() }
    usleep(200_000)
    let snap = try #require(ProcessInspect.snapshot(p.processIdentifier))
    #expect(snap.cwd == dir)
    let envReadable = !snap.env.isEmpty
    if envReadable { #expect(snap.env["TALOS_APP_BRIDGE"] == "1") }
    #expect(snap.argv.contains("--resume"))
    // argv[0] is /bin/bash for a script; drop it so the script stands where claude would.
    var asClaude = snap
    asClaude.argv = Array(snap.argv.dropFirst())
    let plan = try #require(AdoptPlan.from(snapshot: asClaude, agentsEntry: nil, loginEnv: r.loginEnv))
    #expect(plan.agentDir == dir)
    #expect(plan.args == ["--dangerously-skip-permissions", "--channels", "plugin:telegram@example"])
    #expect(plan.sessionId == id)
    #expect(plan.envReadable == envReadable)
    #expect(plan.env == (envReadable ? ["TALOS_APP_BRIDGE": "1"] : [:]))
  }
}

@Suite("tmux hosting", .serialized, .enabled(if: Rig.hasTmux))
struct TmuxHostingTests {
  @Test func quittingTheAppLeavesTheAgentAndANewSupervisorReattaches() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let pid = try #require(r.sup.status.childPid)
    r.sup.detach()  // the app quits: the supervisor object goes away
    usleep(500_000)
    #expect(ProcessInspect.alive(pid), "the pane is alive after the app quit")

    let before = (r.host.visibleRows() ?? [])  // the old host still knows our pane; a new one learns it on attach
    #expect(!before.isEmpty)
    let s2 = r.makeSupervisor()
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(5) { s2.status.childPid == pid })
    #expect(r.wait(5) { s2.status.startKind == .attached && s2.status.phase == .running }, "\(s2.status.startKind as Any) \(s2.status.phase)")
    usleep(800_000)
    #expect(r.starts.count == 1, "no restart")
    #expect((r.host.visibleRows() ?? []) == before, "no keypress")
    #expect(r.wait(5) { r.allEvents.contains(.attached(pid: pid)) })
  }

  @Test func aSecondSupervisorOfTheSameSessionStaysPassive() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let s1 = r.sup!
    try coldStartConfirmed(r)
    #expect(s1.holdsSessionLock)
    let pid = try #require(s1.status.childPid)
    let s2 = r.makeSupervisor()
    defer { s2.detach(); s1.detach() }
    s2.startTicking()
    s2.attachOrStart(allowColdStart: true)
    #expect(r.wait(5) { s2.status.childPid == pid })
    #expect(!s2.holdsSessionLock, "the second one only watches")
    s2.stop()
    usleep(800_000)
    #expect(ProcessInspect.alive(pid), "a passive supervisor's Stop does nothing")
    #expect(r.wait(5) { r.audit.contains("stop_refused_passive") })
    #expect(r.starts.count == 1)
  }

  @Test func aTmuxServerKilledExternallyMeansAColdStartNotASilentRestart() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    try coldStartConfirmed(r)
    _ = ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "kill-server"], env: r.loginEnv)
    #expect(r.wait(15) { r.starts.count >= 2 }, "started again")
    #expect(r.wait(10) { r.sup.status.needsYou == .confirmColdStart }, "\(String(describing: r.sup.status.needsYou))")
    usleep(1_000_000)
    #expect(!r.audit.contains(" auto_confirm "))
    #expect(r.wait(5) { r.audit.contains("kind=cold") })
    #expect(r.wait(5) { r.sup.status.lastExit?.hostLost == true }, "\(String(describing: r.sup.status.lastExit))")
  }

  @Test func theTerminalCommandIsTheRollback() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh", session: confirmedSession)
    defer { r.teardown() }
    let cmd = r.sup.terminalCommand()
    let back = try LaunchSpec.parse(cmd, home: r.home)
    #expect(back.agentDir == r.agentDir)
    #expect(back.resumeId == Rig.sessionId)
    #expect(back.args == r.config.args)
    #expect(back.env == r.config.env)
  }
}

@Suite("Start anyway (real processes)", .serialized)
struct StartAnywayIntegrationTests {
  /// Another interactive session holding the channels blocks Start; "Start anyway" starts exactly once and the next cold
  /// start is checked again.
  @Test(arguments: bothHosts)
  func startAnywayIsOneShot(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let other = try r.spawn([Rig.fixtures + "/other-session.sh", "--channels", "plugin:talos-app@example"])
    try r.registerAgent(pid: other, cwd: "/tmp/elsewhere")
    r.start()
    #expect(r.wait(10) { blockers(r.phase()) != nil }, "\(r.phase())")
    #expect(r.starts.isEmpty, "a plain Start launched nothing")
    #expect(BlockedText.offersStartAnyway(blockers(r.phase()) ?? []))

    r.sup.startAnyway()
    // the phase moves before the launch is recorded, so wait on the launch itself
    #expect(r.wait(10) { r.starts.count == 1 }, "started: \(r.phase())")
    #expect(r.audit.contains("start_anyway"))

    // stop it, then a plain Start is blocked again: the pass was one use
    r.sup.stop()
    #expect(r.wait(15) { stopReason(r.phase()) == .user }, "\(r.phase())")
    r.sup.start()
    #expect(r.wait(10) { blockers(r.phase()) != nil }, "the second start is checked again: \(r.phase())")
    #expect(r.starts.count == 1)
  }

  @Test func startAnywayWithoutABlockDoesNothing() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.sup.startAnyway()
    usleep(500_000)
    #expect(r.starts.isEmpty)
    #expect(r.phase() == .idle)
  }

  @Test func startAnywayIsRefusedWhileTelegramIsAHolder() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let poller = try r.spawn([Rig.fixtures + "/holder.sh"], commandLineHas: "server.ts")
    try "\(poller)".write(toFile: r.botPidPath, atomically: true, encoding: .utf8)
    r.start()
    #expect(r.wait(10) { blockers(r.phase()) != nil }, "\(r.phase())")
    #expect(!BlockedText.offersStartAnyway(blockers(r.phase()) ?? []))
    r.sup.startAnyway()
    usleep(500_000)
    #expect(r.starts.isEmpty, "the Telegram ban stands")
    #expect(blockers(r.phase()) != nil)
    #expect(r.audit.contains("start_anyway_refused"))
  }
}
