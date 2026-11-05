import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// What the owner is told when the session needs them, and that a warning is neither lost nor said twice as the screen changes
/// under it. Real pty or real private tmux, the fake `claude`; every wait only caps a hang. A deadline is passed by moving the
/// supervisor's clock on, never by waiting for it.
@Suite("Supervisor stall warnings (real pty, real tmux)", .serialized)
struct SupervisorStallTests {
  private static func timings() -> Supervisor.Timings {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.backoff = Backoff(steps: [0.3, 0.5, 0.5, 0.5, 0.5], jitter: 0)
    t.dialogStall = 0  // the dialog has been up long enough as soon as it is up
    t.stopGrace = 3
    return t
  }

  private let login = Supervisor.NeedsYou.dialog("login expired")
  private let loginKey = "needs_you why=stall:login expired"

  private func count(_ needle: String, in text: String) -> Int { text.components(separatedBy: needle).count - 1 }

  /// Passes the start deadline: each poll moves the clock on, until the supervisor says it has waited too long.
  private func startStalls(_ r: Rig) -> Bool {
    r.wait(60) { r.clock.advance(60); r.sup.tickNow(); return r.sup.status.needsYou == .startStalled }
  }

  @Test(arguments: bothHosts)
  func aStuckWarningTheLoginDialogTookIsBackWhenTheDialogIsAnswered(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "stuck-then-login.sh", timings: Self.timings())
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(
      r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == .stuck },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    r.humanEnter()  // a login dialog over the stuck session
    #expect(
      r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == login },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    r.humanEnter()  // answered: the session screen again, and the agent is still missing from the list
    #expect(
      r.wait(10) { r.sup.tickNow(); return r.sup.status.needsYou == .stuck },
      "the session is still stuck, so the owner is still told: \(String(describing: r.sup.status.needsYou))")
    #expect(count("needs_you why=stuck", in: r.audit) == 1, "told once, shown again, not told twice")
  }

  @Test(arguments: bothHosts)
  func aStartStalledWarningTheLoginDialogTookIsBackWhenTheDialogIsAnswered(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "silent-then-login.sh", timings: Self.timings())
    defer { r.teardown() }
    r.start()
    #expect(startStalls(r), "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    r.humanEnter()  // the CLI shows a login dialog
    #expect(
      r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == login },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    r.humanEnter()  // answered; it still has not finished starting
    #expect(
      r.wait(10) { r.sup.tickNow(); return r.sup.status.needsYou == .startStalled },
      "the start is still stalled, so the owner is still told: \(String(describing: r.sup.status.needsYou))")
    #expect(r.phase() == .starting)
    #expect(count("needs_you why=start", in: r.audit) == 1, "told once, shown again, not told twice")
  }

  @Test(arguments: bothHosts)
  func eachDialogThatReplacesAnotherIsToldAndTheFirstIsToldAgainWhenItComesBack(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "login-trust-login.sh", timings: Self.timings())
    defer { r.teardown() }
    try coldStartConfirmed(r)
    r.humanEnter()
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == login }, "audit: \(r.audit)")
    r.humanEnter()  // folder trust replaces it on the screen, with no empty screen between
    #expect(
      r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == .dialog("folder trust") },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    r.humanEnter()  // and the login dialog replaces that
    #expect(
      r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == login },
      "the login dialog is a new question: needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    #expect(count(loginKey, in: r.audit) == 2)
    #expect(count("needs_you why=stall:folder trust", in: r.audit) == 1)
  }

  /// tmux, except that `capture-pane` fails while the returned flag file exists. Takes effect at once for this rig's supervisor.
  private func captureFailsWhileFlagged(_ r: Rig) throws -> String {
    let flag = r.root + "/capture-fails"
    let shim = r.root + "/tmux-capture-shim"
    try """
    #!/bin/bash
    for a in "$@"; do
      if [ "$a" = capture-pane ] && [ -e '\(flag)' ]; then echo 'capture failed' >&2; exit 1; fi
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeSupervisor()
    return flag
  }

  @Test(.enabled(if: Rig.hasTmux))
  func aScreenReadThatFailsIsNotTakenForNoDialog() throws {
    let r = try Rig(.tmux, scenario: "login-once.sh", timings: Self.timings())
    defer { r.teardown() }
    let flag = try captureFailsWhileFlagged(r)
    try coldStartConfirmed(r)
    r.humanEnter()
    #expect(r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == login }, "audit: \(r.audit)")
    #expect(count(loginKey, in: r.audit) == 1)

    FileManager.default.createFile(atPath: flag, contents: Data())
    for _ in 0..<5 { r.sup.tickNow() }  // five passes that cannot read the screen
    #expect(r.sup.status.needsYou == login, "a screen that could not be read does not end the warning")
    try FileManager.default.removeItem(atPath: flag)
    r.sup.tickNow()
    r.sup.tickNow()
    #expect(r.sup.status.needsYou == login)
    #expect(count(loginKey, in: r.audit) == 1, "and the owner is not told a second time when it can be read again")
  }

  @Test(.enabled(if: Rig.hasTmux))
  func aStartThatNeverSettlesIsStillCalledStalledWhenTheScreenCanNeverBeRead() throws {
    let r = try Rig(.tmux, scenario: "silent-then-login.sh", timings: Self.timings())
    defer { r.teardown() }
    let flag = try captureFailsWhileFlagged(r)
    FileManager.default.createFile(atPath: flag, contents: Data())  // from before the first start: no pass ever reads the screen
    r.start()
    #expect(
      startStalls(r),
      "no screen was ever read, and the deadline still passed: needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    #expect(r.phase() == .starting)
    #expect(count("needs_you why=start", in: r.audit) == 1)
  }

  @Test(.enabled(if: Rig.hasTmux))
  func aSessionThatDropsOutOfTheAgentListIsStillCalledStuckWhenTheScreenCanNoLongerBeRead() throws {
    let r = try Rig(.tmux, scenario: "late-stuck.sh", timings: Self.timings())
    defer { r.teardown() }
    let flag = try captureFailsWhileFlagged(r)
    try coldStartConfirmed(r)  // running, screen read fine so far
    FileManager.default.createFile(atPath: flag, contents: Data())
    r.humanEnter()  // the fake leaves the agent list now
    #expect(
      r.wait(60) { r.clock.advance(30); r.sup.tickNow(); return r.sup.status.needsYou == .stuck },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
  }

  @Test(.enabled(if: Rig.hasTmux))
  func aScreenReadOutagePastTheNoticeDeadlineLeavesAHealthyRestartRunning() throws {
    var t = Self.timings()
    t.dialogStall = 60  // the dialog stays up until the test's second Enter; it is not what this test is about
    let r = try Rig(.tmux, scenario: "restart-late-notice.sh", timings: t)
    defer { r.teardown() }
    let flag = try captureFailsWhileFlagged(r)
    try coldStartConfirmed(r)  // start 1 confirmed by the owner; it crashes; the restart shows the dialog
    #expect(r.wait(30) { r.sup.tickNow(); return r.audit.contains(" auto_confirm ") }, "audit: \(r.audit)")
    FileManager.default.createFile(atPath: flag, contents: Data())  // the Enter is sent; now the screen cannot be read
    let pid = try #require(r.sup.status.childPid)
    r.clock.advance(20)  // past the notice deadline (15 s), well short of the start deadline (120 s)
    for _ in 0..<5 { r.sup.tickNow() }
    #expect(r.phase() == .starting, "an unreadable screen is no evidence the notice is missing: \(r.phase())")
    #expect(!r.audit.contains("auto_confirm_no_notice"), "audit: \(r.audit)")
    #expect(!r.allEvents.contains(.confirmFailed))
    #expect(ProcessInspect.alive(pid), "the agent was not stopped")
    // it warns instead, once the start deadline passes
    #expect(
      r.wait(30) { r.clock.advance(60); r.sup.tickNow(); return r.sup.status.needsYou == .startStalled },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    // the screen can be read again, and the notice is honoured
    try FileManager.default.removeItem(atPath: flag)
    r.humanEnter()  // the fake prints the registration notice
    #expect(
      r.wait(30) { r.sup.tickNow(); return isRunning(r.phase()) && r.sup.status.needsYou == nil },
      "phase \(r.phase()), needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    #expect(ProcessInspect.alive(pid))
  }

  @Test(.enabled(if: Rig.hasTmux))
  func aHeldQuestionIsNotReplacedByStartStalledWhileTheScreenCannotBeRead() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh", timings: Self.timings())
    defer { r.teardown() }
    let flag = try captureFailsWhileFlagged(r)
    r.start()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart })
    FileManager.default.createFile(atPath: flag, contents: Data())  // the dialog may well be up still; we cannot see
    for _ in 0..<5 { r.clock.advance(60); r.sup.tickNow() }  // far past the start deadline
    #expect(
      r.sup.status.needsYou == .confirmColdStart,
      "the question about the dialog stays: \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    #expect(count("needs_you why=start", in: r.audit) == 0)
  }

  @Test(arguments: bothHosts)
  func aLaterClearReadingReplacesTheRefusalReasonWithoutAnotherAlarm(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "ambiguous-then-wrong-highlight.sh", timings: Self.timings())
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(r.wait(30) { r.starts.count >= 2 }, "restarted")
    // the first screen shows the title twice: refused as ambiguous
    #expect(
      r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == .restartNotConfirmed(.ambiguousDialog) },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    r.humanEnter()  // the dialog is redrawn with the cursor on "Exit": a clear reading
    #expect(
      r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == .restartNotConfirmed(.wrongHighlight) },
      "the reason follows the clear reading: \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    for _ in 0..<5 { r.sup.tickNow() }
    #expect(r.sup.status.needsYou == .restartNotConfirmed(.wrongHighlight))
    let told = r.allEvents.filter { if case .needsYou(.restartNotConfirmed) = $0 { return true } else { return false } }
    #expect(told.count == 1, "told once, the reason replaced quietly: \(told)")
    #expect(count("needs_you why=refuse", in: r.audit) == 1)
    #expect(!r.audit.contains(" auto_confirm "), "nothing was pressed")
    #expect(r.phase() == .starting)
  }

  /// The cold-start question is the one `needsYou` slot's answer for the dev-channel dialog. Another dialog takes the slot (the
  /// folder-trust stall), and when the dev-channel dialog is up again the question must be back before the stall check can say
  /// the vaguer "a dialog needs you" for it (the stall limit is already due, so the order of the two checks decides it).
  @Test(arguments: bothHosts)
  func theColdStartQuestionComesBackWhenTheDevChannelDialogReturnsAfterAnotherDialog(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-trust-dev-dialog.sh", timings: Self.timings())
    defer { r.teardown() }
    r.start()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart }, "cold-start question")
    r.humanEnter()
    #expect(r.wait(10) { r.screenContains("Yes, I trust this folder") }, "the second dialog is up")
    #expect(
      r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .dialog("folder trust") },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    r.humanEnter()
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) }, "the dev-channel dialog is up again")
    #expect(
      r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    for _ in 0..<5 { r.sup.tickNow() }
    #expect(r.sup.status.needsYou == .confirmColdStart, "later passes: \(String(describing: r.sup.status.needsYou))")
    #expect(count("why=stall:", in: r.audit) == 1, "only the folder-trust stall was raised, never one for the dev-channel dialog: \(r.audit)")
    #expect(r.phase() == .starting)
  }

  /// The same question must come back when the slot holds the start-stalled warning instead of another dialog's: the start stalled
  /// while the screen was plain, then the dev-channel dialog is up again. It is the question for that dialog, not the vaguer
  /// "a dialog needs you" the stall check would say.
  @Test(arguments: bothHosts)
  func theColdStartQuestionComesBackWhenTheDevChannelDialogReturnsAfterAStartStall(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-plain-dev-dialog.sh", timings: Self.timings())
    defer { r.teardown() }
    r.start()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart }, "cold-start question")
    r.humanEnter()
    #expect(r.wait(10) { r.screenContains("Setting up the workspace") }, "the plain screen is up")
    #expect(startStalls(r), "no dialog on screen: the start stalls, needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    r.humanEnter()
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) }, "the dev-channel dialog is up again")
    #expect(
      r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    for _ in 0..<5 { r.sup.tickNow() }
    #expect(r.sup.status.needsYou == .confirmColdStart, "later passes: \(String(describing: r.sup.status.needsYou))")
    #expect(count("why=stall:", in: r.audit) == 0, "no dialog stall was raised for the dev-channel dialog: \(r.audit)")
    #expect(r.phase() == .starting)
  }

  /// The question is only ever about the dialog on screen. When the owner has answered it and the screen is plain again with no
  /// notice, a start that already stalled once is still stalled: the alarm is back, told no second time.
  @Test(arguments: bothHosts)
  func theStartStalledAlarmReplacesAQuestionWhoseDialogIsGoneAfterAnEarlierStall(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-plain-dev-dialog-plain.sh", timings: Self.timings())
    defer { r.teardown() }
    r.start()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart }, "cold-start question")
    r.humanEnter()
    #expect(r.wait(10) { r.screenContains("Setting up the workspace") }, "the plain screen is up")
    #expect(startStalls(r), "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    r.humanEnter()
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) }, "the dev-channel dialog is up again")
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart }, "the question is back: \(r.audit)")
    r.humanEnter()
    #expect(r.wait(10) { r.screenContains("Still setting up") }, "plain again, no notice")
    #expect(
      r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .startStalled },
      "the question is about a dialog that is gone: \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    for _ in 0..<5 { r.sup.tickNow() }
    #expect(r.sup.status.needsYou == .startStalled, "later passes: \(String(describing: r.sup.status.needsYou))")
    #expect(count("needs_you why=", in: r.audit) == 2, "told the question and the stall once each, nothing again: \(r.audit)")
    #expect(r.phase() == .starting)
  }

  /// The same when another dialog's warning stood between the stall and the dev-channel dialog's return.
  @Test(arguments: bothHosts)
  func theStartStalledAlarmReplacesAQuestionWhoseDialogIsGoneAfterAStallAndAnotherDialog(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-plain-trust-dev-dialog-plain.sh", timings: Self.timings())
    defer { r.teardown() }
    r.start()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart }, "cold-start question")
    r.humanEnter()
    #expect(r.wait(10) { r.screenContains("Setting up the workspace") }, "the plain screen is up")
    #expect(startStalls(r), "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    r.humanEnter()
    #expect(
      r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .dialog("folder trust") },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    r.humanEnter()
    #expect(r.wait(10) { r.screenContains(DialogMatcher.Strings.devTitle) }, "the dev-channel dialog is up again")
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart }, "the question is back: \(r.audit)")
    r.humanEnter()
    #expect(r.wait(10) { r.screenContains("Still setting up") }, "plain again, no notice")
    #expect(
      r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .startStalled },
      "the question is about a dialog that is gone: \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    for _ in 0..<5 { r.sup.tickNow() }
    #expect(r.sup.status.needsYou == .startStalled, "later passes: \(String(describing: r.sup.status.needsYou))")
    #expect(count("needs_you why=", in: r.audit) == 3, "the question, the stall and the folder-trust dialog, once each: \(r.audit)")
    #expect(r.phase() == .starting)
  }
}
