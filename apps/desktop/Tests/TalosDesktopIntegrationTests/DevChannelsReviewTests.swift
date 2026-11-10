import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Review fixes for Main's auto-accept of the development-channels warning (2026-11-08): cold starts do not spend the crash loop's
/// budget; the last look is the last thing before the Enter; a refusal that may clear by itself does not page the phone; a stall
/// is still raised for a later dev-channel dialog; a refusal for a screen reason pages the phone exactly once.
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

private extension Rig {
  /// The phone's restart request (what `AgentRecoveryTests` writes with its own file-private helper).
  func askForRestart(_ action: String, id: String) throws {
    let ts = Int(clock.wallMs())
    try #"{"v":1,"control_id":"\#(id)","action":"\#(action)","ts":\#(ts)}"#.write(
      toFile: talosHome + "/" + AgentRequest.fileName, atomically: true, encoding: .utf8)
  }
  /// What the phone was told about the dev-channel warning.
  var devChannelPosts: [String] { phonePosts.filter { $0.contains(NeedsYouPopupContent.devWaitingPhone) } }
  func tickThrough(_ timeout: Double = 30, _ cond: () -> Bool) -> Bool { wait(timeout) { sup.tickNow(); return cond() } }
}

/// Where the Enter (`if-shell`) stands among the verbs logged: after the last look at the clients, with only screen reads between them
/// and at least one (the fresh read). The tmux host's own poll also takes a capture now and then, from its own thread, so a read more
/// than one is fine; any other verb there, or no read at all, means the order was broken. nil when it holds.
private func whatIsWrongWithTheEnterOrder(_ verbs: [String]) -> String? {
  guard let send = verbs.firstIndex(of: "if-shell") else { return "no Enter was sent" }
  guard let lastClients = verbs[..<send].lastIndex(of: "list-clients") else { return "the clients were never looked at before the Enter" }
  let between = verbs[(lastClients + 1)..<send]
  if between.isEmpty { return "no fresh read between the last look at the clients and the Enter" }
  if let other = between.first(where: { $0 != "capture-pane" }) { return "\(other) sits between the last look at the clients and the Enter" }
  return nil
}

private func answers(_ r: Rig) -> [String] {
  r.audit.split(separator: "\n").filter { $0.contains(" auto_confirm ") }.map(String.init)
}

@Suite("Main accepts the development-channels warning: review fixes", .serialized)
struct DevChannelsReviewTests {
  // MARK: cold starts and the crash loop's budget

  /// Three owner resets in an hour, then one real crash: the cold starts spent nothing of the crash loop's cap, so the fourth reset is
  /// answered, and the crash restarts (and is answered) instead of being stopped as a crash loop.
  @Test(arguments: bothHosts)
  func threeColdResetsThenACrashStillRestarts(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-crash-fourth.sh", env: ["FAKE_CRASH_START": "4", "FAKE_CRASH_AFTER": "5"], timings: timings())
    defer { r.teardown() }
    r.start()
    for n in 1...4 {
      if n > 1 { r.sup.restartCold() }
      #expect(
        r.wait(60) { r.sup.tickNow(); return r.starts.count == n && isRunning(r.phase()) },
        "start \(n): phase \(r.phase()), needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    }
    #expect(r.wait(60) { r.sup.tickNow(); return r.starts.count >= 5 && isRunning(r.phase()) }, "after the crash: \(r.phase()), audit: \(r.audit)")
    #expect(answers(r).count == 5, "four cold starts and the restart: \(answers(r))")
    #expect(answers(r).last?.contains(" kind=supervisorRestart") == true)
    #expect(!r.audit.contains(" crash_loop"), "\(r.audit)")
    #expect(stopReason(r.phase()) == nil)
    #expect(!r.allEvents.contains { if case .needsYou = $0 { return true } else { return false } })
  }

  /// Cold starts have a cap of their own (`coldConfirmCap`): past it the warning waits for the owner.
  @Test func coldStartsHaveACapOfTheirOwn() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh", timings: timings { $0.coldConfirmCap = 2 })
    defer { r.teardown() }
    r.start()
    for n in 1...2 {
      if n > 1 { r.sup.restartCold() }
      #expect(r.wait(30) { r.sup.tickNow(); return r.starts.count == n && isRunning(r.phase()) }, "start \(n): \(r.phase()), audit: \(r.audit)")
    }
    r.sup.restartCold()
    #expect(r.wait(30) { r.starts.count == 3 })
    r.expectHeldAtNeedsYou("rateLimited", answeredBefore: 2)
  }

  /// The crash loop's own cap still stops a loop of crash restarts, and the cold start before it spent none of it: with a cap of one, the
  /// first restart is answered; the second crash is the loop.
  @Test(arguments: bothHosts)
  func theCrashLoopsCapCountsRestartsOnly(kind: HostKind) throws {
    let r = try Rig(
      kind, scenario: "crash-after.sh", env: ["FAKE_CRASH_SECONDS": "1", "FAKE_CRASHES": "2"], timings: timings { $0.confirmCap = 1 })
    defer { r.teardown() }
    r.start()
    #expect(r.wait(60) { r.sup.tickNow(); return r.starts.count >= 2 && answers(r).count == 2 }, "the restart was answered: \(r.phase()), audit: \(r.audit)")
    #expect(answers(r).last?.contains(" kind=supervisorRestart") == true, "\(answers(r))")
    // The loop is audited when it stops the agent. The phase is not what to look at: a crash loop brings the automatic restore, which
    // restarts the agent a moment later, so a poll can miss `.stopped(.crashLoop)` altogether.
    #expect(r.wait(60) { r.sup.tickNow(); return r.audit.contains(" crash_loop") }, "the second crash is a crash loop: \(r.phase()), audit: \(r.audit)")
  }

  // MARK: the last look is the last thing before the Enter

  /// tmux, with a log of the verbs that matter. The Enter (`if-shell … send-keys`) comes straight after the fresh screen read, which
  /// comes after the last look at the clients.
  @Test(.enabled(if: Rig.hasTmux))
  func theFreshReadIsTheLastThingBeforeTheEnter() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh", timings: timings())
    defer { r.teardown() }
    let log = r.root + "/verbs"
    let shim = r.root + "/tmux-verbs-shim"
    try """
    #!/bin/bash
    for a in "$@"; do
      case "$a" in list-clients|capture-pane|if-shell) echo "$a" >> '\(log)'; break ;; esac
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.hostPollInterval = 600  // the host's own poll reads the pane too; keep it out of the window being ordered
    r.makeSupervisor()
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    let verbs = ((try? String(contentsOfFile: log, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    let send = try #require(verbs.firstIndex(of: "if-shell"), "no Enter was sent: \(verbs)")
    #expect(send >= 2 && verbs[send - 1] == "capture-pane" && verbs[send - 2] == "list-clients", "the Enter follows the fresh read, which follows the clients: \(verbs)")
    #expect(whatIsWrongWithTheEnterOrder(verbs) == nil, "\(String(describing: whatIsWrongWithTheEnterOrder(verbs))): \(verbs)")
  }

  /// The CI failure: the tmux host's own poll takes a capture of the pane every `pollInterval`, from its own thread, so it can land
  /// between the supervisor's fresh read and its Enter. Here the poll is fast and a capture takes 0.3 s, so it does, every time.
  @Test(.enabled(if: Rig.hasTmux))
  func aPollsReadOfTheScreenBetweenTheFreshReadAndTheEnterIsNotTheFreshReadMovingAway() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh", timings: timings())
    defer { r.teardown() }
    let log = r.root + "/verbs"
    let shim = r.root + "/tmux-verbs-shim"
    try """
    #!/bin/bash
    for a in "$@"; do
      case "$a" in list-clients|capture-pane|if-shell) echo "$a" >> '\(log)'; [ "$a" = capture-pane ] && sleep 0.3; break ;; esac
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.hostPollInterval = 0.05
    r.makeSupervisor()
    r.start()
    #expect(r.wait(60) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    let verbs = ((try? String(contentsOfFile: log, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    #expect(verbs.filter { $0 == "capture-pane" }.count >= 3, "the poll really did read the pane meanwhile: \(verbs)")
    #expect(whatIsWrongWithTheEnterOrder(verbs) == nil, "\(String(describing: whatIsWrongWithTheEnterOrder(verbs))): \(verbs)")
  }

  // MARK: a refusal that may clear by itself does not page the phone

  /// tmux, except that `list-clients` reports a client that typed just now while `typing` exists. The passes are the test's own
  /// (`tick` is far longer than the test), and the second start is the phone's restart, so a held-back refusal would page the phone.
  private func typingRig() throws -> (Rig, String) {
    let r = try Rig(.tmux, scenario: "dev-dialog-late.sh", timings: timings { $0.tick = 600; $0.agentsPoll = 600 })
    let flag = r.root + "/typing"
    let shim = r.root + "/tmux-typing-shim"
    try """
    #!/bin/bash
    for a in "$@"; do
      if [ "$a" = list-clients ]; then if [ -e '\(flag)' ]; then date +%s; fi; exit 0; fi
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeSupervisor()
    return (r, flag)
  }

  @Test(.enabled(if: Rig.hasTmux), arguments: [2, 3])
  func aRefusalThatMayClearIsHeldForThreePasses(passes: Int) throws {
    let (r, flag) = try typingRig()
    defer { r.teardown() }
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return isRunning(r.phase()) }, "the first start: \(r.phase()), audit: \(r.audit)")
    FileManager.default.createFile(atPath: flag, contents: Data())  // a client is typing from here
    try r.askForRestart("restart", id: "c1")  // the phone's restart: a cold start that would page the phone
    #expect(r.wait(30) { r.sup.tickNow(); return r.starts.count == 2 }, "\(r.phase()), audit: \(r.audit)")
    r.showDialog()
    #expect(r.wait(10) { r.screenContains("1. I am using this") }, "the whole warning is on screen")
    for _ in 0..<passes { r.sup.tickNow() }
    #expect(r.audit.contains("auto_confirm_refused kind=cold reason=clientsMayBeTyping"), "audit: \(r.audit)")
    if passes < 3 {
      #expect(r.sup.status.needsYou == nil, "held back: \(String(describing: r.sup.status.needsYou))")
      try FileManager.default.removeItem(atPath: flag)  // the client stops typing
      #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "answered by itself: \(r.phase()), audit: \(r.audit)")
      r.sup.drain()
      usleep(500_000)
      #expect(r.devChannelPosts.isEmpty, "nobody was paged: \(r.posts)")
      #expect(!r.allEvents.contains { if case .needsYou = $0 { return true } else { return false } }, "\(r.allEvents)")
      #expect(answers(r).count == 2)
    } else {
      #expect(r.sup.status.needsYou == .confirmColdStart, "\(String(describing: r.sup.status.needsYou))")
      #expect(r.wait(30) { r.sup.tickNow(); return r.devChannelPosts.count == 1 }, "posts: \(r.posts), audit: \(r.audit)")
      try FileManager.default.removeItem(atPath: flag)
      #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
      r.sup.drain()
      #expect(r.devChannelPosts.count == 1, "once: \(r.posts)")
    }
  }

  /// A refusal that cannot clear by itself (here, an extra channel) with auto-accept ON: the owner is told at once, and the phone is
  /// posted exactly once.
  @Test(arguments: bothHosts)
  func aScreenRefusalOfAPhoneRestartPostsToThePhoneOnce(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-second-extra.sh", timings: timings())
    defer { r.teardown() }
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return isRunning(r.phase()) }, "the first start is answered by the app: \(r.phase()), audit: \(r.audit)")
    #expect(r.devChannelPosts.isEmpty)
    try r.askForRestart("restart", id: "c1")
    #expect(r.tickThrough { r.starts.count == 2 && r.sup.status.needsYou == .confirmColdStart }, "\(r.phase()), \(r.audit)")
    #expect(r.audit.contains("auto_confirm_refused kind=cold reason=channelsMismatch"), "\(r.audit)")
    #expect(r.wait(30) { r.sup.tickNow(); return r.devChannelPosts.count == 1 }, "posts: \(r.posts), audit: \(r.audit)")
    for _ in 0..<5 { r.sup.tickNow() }
    r.sup.drain()
    #expect(r.devChannelPosts.count == 1, "once: \(r.posts)")
    #expect(answers(r).count == 1, "nothing was pressed for the second start: \(r.audit)")
    r.humanEnter()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase())")
  }

  // MARK: the stall exemption ends with the start

  /// Our Enter exempts the dev-channel dialog from the stall warning while the start is starting. A dev-channel dialog that shows up
  /// after the notice, in a running session, is a dialog nobody answered and still stalls.
  @Test func aLaterDevChannelDialogInTheSameSessionStillStalls() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-after-notice.sh", timings: timings { $0.dialogStall = 1 })
    defer { r.teardown() }
    r.start()
    #expect(
      r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == .dialog("dev-channel warning") },
      "needsYou \(String(describing: r.sup.status.needsYou)), phase \(r.phase()), audit: \(r.audit)")
    #expect(answers(r).count == 1, "the first dialog was answered, the second not: \(r.audit)")
    #expect(r.audit.components(separatedBy: "why=stall:dev-channel warning").count - 1 == 1, "\(r.audit)")
  }
}
