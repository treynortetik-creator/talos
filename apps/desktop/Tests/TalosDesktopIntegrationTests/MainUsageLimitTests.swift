import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// Claude Code's usage-limit screen on MAIN's pane (`main-usage-limit.sh`, the SYNTHETIC screen of Fixtures/synthetic/usage-limit.txt, every
/// key logged): Main is needs-you on it (`needs_you.kind` "usage limit" in main-restart-check.json), the phone gets one line naming the model,
/// the reset and the way on, Terminals is not brought forward, and NO key goes to it, the start's dev-warning auto-accept included. Real
/// private tmux server; the fake `talos-app`.
@Suite("Usage-limit screen on Main", .serialized, .enabled(if: Rig.hasTmux))
struct MainUsageLimitTests {
  private func check(_ r: Rig) -> [String: Any]? {
    guard let d = FileManager.default.contents(atPath: r.talosHome + "/" + MainRestartCheck.fileName) else { return nil }
    return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
  }

  @Test func needsYouOneLineNoTerminalsAndNoKey() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.tmux, scenario: "main-usage-limit.sh", env: ["FAKE_DLG_KEYLOG": keys.path])
    defer { r.teardown() }
    #expect(r.config.openTerminalOnDialog, "the setting is on, so only the kind can keep Terminals back")
    r.start()
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase()) audit: \(r.audit)")
    let shownAt = Date(timeIntervalSince1970: r.clock.wallMs() / 1000)
    FileManager.default.createFile(atPath: r.stateDir + "/ul", contents: nil)
    #expect(r.wait(15) { r.sup.status.needsYou == .dialog("usage limit") }, "\(String(describing: r.sup.status.needsYou)) audit: \(r.audit)")
    let line =
      "Main hit the usage limit for Fable. It resets 4pm (Europe/Paris). Talos pressed nothing on that screen: one of its options spends usage credits. To go on now, press Esc in Main's pane, then /model <another model>."
    #expect(r.wait(10) { r.posts.contains { $0.contains(line) } }, "posts: \(r.posts)")
    #expect(r.wait(15) { (check(r)?["needs_you"] as? [String: Any])?["kind"] as? String == "usage limit" }, "\(String(describing: check(r)))")
    // the reset as an instant, beside the kind: the next 4pm in the zone the screen names
    expectParisFourPm(
      (check(r)?["needs_you"] as? [String: Any])?["resets_at"] as? String, readAfter: shownAt,
      readBy: Date(timeIntervalSince1970: r.clock.wallMs() / 1000))
    #expect(r.audit.contains("usage_limit_seen"), "\(r.audit)")
    Thread.sleep(forTimeInterval: 3)
    #expect(keys.keys.isEmpty, "no Enter, no digit, no arrow, no Escape: \(keys.keys)")
    #expect(!r.allEvents.contains(.openTerminal), "Terminals is never raised onto it: \(r.allEvents)")
    #expect(r.posts.filter { $0.contains(line) }.count == 1, "one line: \(r.posts)")
    #expect(isRunning(r.phase()), "Main was not stopped for it: \(r.phase())")
  }

  /// Main on the screen drops out of `agents --json`: it is not called stuck (the alarm would raise Terminals and take the usage limit's
  /// place in the needs-you slot), the slot keeps "usage limit", and still no key goes to it.
  @Test func droppingOutOfTheAgentListOnItIsNotStuck() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    var t = Rig.defaultTimings()
    t.hangPolls = 2
    let r = try Rig(.tmux, scenario: "main-usage-limit.sh", env: ["FAKE_DLG_KEYLOG": keys.path, "FAKE_UL_UNLISTED": "1"], timings: t)
    defer { r.teardown() }
    r.start()
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase()) audit: \(r.audit)")
    FileManager.default.createFile(atPath: r.stateDir + "/ul", contents: nil)
    #expect(r.wait(15) { r.sup.status.needsYou == .dialog("usage limit") }, "\(String(describing: r.sup.status.needsYou)) audit: \(r.audit)")
    // many agents polls that miss Main: each pass moves the clock past the poll gate
    for _ in 0..<12 {
      r.clock.advance(30)
      r.sup.tickNow()
      Thread.sleep(forTimeInterval: 0.4)
    }
    #expect(!r.agentsSummary.isEmpty, "the polls ran: \(r.agentsSummary)")
    #expect(r.sup.status.needsYou == .dialog("usage limit"), "\(String(describing: r.sup.status.needsYou)) audit: \(r.audit)")
    #expect(!r.audit.contains("why=stuck"), "\(r.audit)")
    #expect(!r.allEvents.contains(.openTerminal), "\(r.allEvents)")
    #expect(!r.allEvents.contains(.needsYou(.stuck)))
    #expect(keys.keys.isEmpty, "\(keys.keys)")
    #expect(Supervisor.holdsAnswerless(.dialog("usage limit")) && Supervisor.holdsAnswerless(.dialog("computer-use permissions")))
    #expect(!Supervisor.holdsAnswerless(.dialog("folder trust")) && !Supervisor.holdsAnswerless(.stuck) && !Supervisor.holdsAnswerless(nil))
  }

  /// The start shows the dev-channel warning's words with the usage-limit screen at the bottom: the auto-accept (on, with a sealed launch)
  /// must not send its Enter, which would land on the usage-limit screen's cursor.
  @Test func theDevWarningAutoAcceptSendsNothingOntoIt() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    var t = Rig.defaultTimings()
    t.dialogStall = 0
    let r = try Rig(.tmux, scenario: "main-usage-limit.sh", env: ["FAKE_DLG_KEYLOG": keys.path, "FAKE_UL_AT_START": "mixed"], timings: t)
    defer { r.teardown() }
    #expect(r.config.autoConfirmRestart, "the auto-accept is on")
    r.start()
    #expect(r.wait(15) { r.screenContains("Switch to usage credits") }, "drawn")
    #expect(r.wait(15) { r.sup.tickNow(); return r.sup.status.needsYou == .dialog("usage limit") }, "\(String(describing: r.sup.status.needsYou)) audit: \(r.audit)")
    for _ in 0..<10 {
      r.sup.tickNow()
      Thread.sleep(forTimeInterval: 0.3)
    }
    #expect(keys.keys.isEmpty, "no key at all: \(keys.keys) audit: \(r.audit)")
    #expect(!r.audit.contains(" auto_confirm "), "\(r.audit)")
    #expect(!r.allEvents.contains(.openTerminal), "\(r.allEvents)")
  }
}
