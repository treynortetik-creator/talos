import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Row 12 of "every prompt shows up in the app": Main's start that stalls, a resume that fails and a start that cannot be made are a plain
/// line in the thread (`talos-app post <default thread>`), not only a Mac notice, and no line sends the owner to Terminals or a pane.
/// Main's bridge is the thing that is not up in all three, so no button can ride on the line (every restart path from the phone,
/// `agent.recover`, `restart_main` and a card tap, goes through that bridge): the line names the Mac's own menu item instead.
@Suite("A stalled, failed or unresumable Main start is a line in the thread", .serialized, .enabled(if: Rig.hasTmux))
struct StartStallPhoneLineTests {
  private static func timings() -> Supervisor.Timings {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.backoff = Backoff(steps: [0.3, 0.5, 0.5, 0.5, 0.5], jitter: 0)
    t.dialogStall = 0
    t.stopGrace = 3
    return t
  }

  static let stalledLine =
    "Testagent hasn't finished starting after 2 minutes. Talos left it as it is. To try again, choose Restart your agent in the Talos menu bar item on your Mac."
  static let resumeLine =
    "Testagent's last conversation can't be resumed, so Talos stopped it and changed nothing. To begin a new conversation, choose Start a new conversation in the Talos menu bar item on your Mac."
  static let couldNotStartLine =
    "Talos couldn't start Testagent. The reason is in the Talos menu bar item on your Mac."

  @Test func aStalledStartPostsOneLineToTheDefaultThread() throws {
    let r = try Rig(.tmux, scenario: "silent-then-login.sh", timings: Self.timings())
    defer { r.teardown() }
    r.start()
    #expect(
      r.wait(60) { r.clock.advance(60); r.sup.tickNow(); return r.sup.status.needsYou == .startStalled },
      "audit: \(r.audit)")
    #expect(r.wait(10) { r.sup.drain(); return r.phonePosts.count == 1 }, "posts: \(r.posts), audit: \(r.audit)")
    #expect(r.phonePosts == ["post general " + Self.stalledLine], "\(r.phonePosts)")
    // told once: later ticks on the same stalled start say nothing more
    for _ in 0..<5 { r.clock.advance(60); r.sup.tickNow() }
    r.sup.drain()
    #expect(r.phonePosts.count == 1, "\(r.phonePosts)")
  }

  @Test func aResumeThatCannotBeMadePostsOneLine() throws {
    let r = try Rig(.tmux, scenario: "resume-missing.sh", session: confirmedSession)
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { stopReason(r.phase()) == .resumeMissing(Rig.sessionId) }, "\(r.phase())")
    #expect(r.wait(10) { r.sup.drain(); return r.phonePosts.count == 1 }, "posts: \(r.posts), audit: \(r.audit)")
    #expect(r.phonePosts == ["post general " + Self.resumeLine], "\(r.phonePosts)")
  }

  @Test func aStartThatCannotBeMadePostsOneLineAndKeepsTheReasonOffThePhone() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh") { $0.claudePath = "/home/alex/.local/bin/claude" }
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.sup.drain(); return r.phonePosts.count == 1 }, "posts: \(r.posts), audit: \(r.audit)")
    #expect(r.phonePosts == ["post general " + Self.couldNotStartLine], "\(r.phonePosts)")
    #expect(!r.phonePosts.joined().contains("/home/alex"), "the reason (a path from desktop.json) stays on the Mac")
  }

  /// R1-1: desktop.json can't be read, so the start is refused: the phone is told, as well as by the line at the app's opening. With no
  /// readable desktop.json the app has no `talos_app_command`, so `talos-app` is found on the login PATH, and the post log (an env entry
  /// of that file) is not set: the audit log is what shows the two posts went.
  @Test func aStartRefusedForAnUnreadableConfigPostsTheCouldNotStartLine() throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh", loginExtra: ["PATH": Rig.fixtures + ":/usr/bin:/bin"])
    defer { r.teardown() }
    try "{ not json".write(toFile: r.configPath, atomically: true, encoding: .utf8)
    r.makeSupervisor()
    r.start()
    let told = { r.audit.components(separatedBy: " post ok=1").count - 1 }
    #expect(r.wait(10) { r.sup.drain(); return told() >= 2 }, "audit: \(r.audit)")
    #expect(r.audit.contains("start_line_post kind=couldNotStart"), "audit: \(r.audit)")
    #expect(r.audit.contains("config_unreadable_refused what=start") && r.starts.isEmpty, "nothing was started: \(r.audit)")
  }

  /// R1-2: a restart the phone asked for that then stalls already gets the request line; the start line would say it twice, differently.
  @Test func aStallInARestartTheOwnerAskedForPostsOnlyTheRequestLine() throws {
    let r = try Rig(.direct, scenario: "idle-then-silent.sh", timings: Self.timings())
    defer { r.teardown() }
    try coldStartConfirmed(r)
    try r.writeAgentRequest("c1")
    r.sup.tickNow()
    #expect(
      r.wait(60) { r.clock.advance(60); r.sup.tickNow(); return r.starts.count == 2 && r.sup.status.needsYou == .startStalled },
      "\(r.phase()), \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    let request = MainRestartCheck.stallPhoneLine(MainRestartCheck.stallNothingKnown)
    #expect(r.wait(10) { r.sup.drain(); return r.phonePosts.contains { $0.contains(request) } }, "posts: \(r.posts), audit: \(r.audit)")
    for _ in 0..<5 { r.clock.advance(60); r.sup.tickNow() }
    r.sup.drain()
    #expect(!r.phonePosts.contains { $0.contains("hasn't finished starting") }, "one voice: \(r.phonePosts)")
    #expect(r.audit.contains("start_line_skipped"), "the skip is logged: \(r.audit)")
  }

  @Test func noneOfTheLinesSendsTheOwnerToATerminalOrAPane() {
    for line in [Self.stalledLine, Self.resumeLine, Self.couldNotStartLine] {
      #expect(!line.contains("Terminal") && !line.lowercased().contains("pane") && !line.contains("Esc"), "\(line)")
    }
  }
}
