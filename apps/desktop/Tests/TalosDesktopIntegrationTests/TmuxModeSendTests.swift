import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// `TmuxCommands.unlessInMode` against the real tmux, on a private socket (never `-L talos`). The send is one string that tmux's own
/// command parser reads back, so the quoting is only proven by tmux itself: text with every character that means something to that
/// parser, to a format or to a shell must reach the pane exactly, once, and never run as anything. And the two answers are tmux's own
/// words: `talos-sent` after the keys went, `talos-in-mode` (and nothing sent, the mode not left) when the pane was scrolled back.
@Suite("A send that is conditional on the pane's mode, through the real tmux", .serialized, .enabled(if: Rig.hasTmux))
struct TmuxModeSendTests {
  private final class Pane {
    let socket = "talos-test-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
    let cmd: TmuxCommands
    init() throws {
      let c = TmuxCommands(tmux: Rig.tmuxPath!, socket: socket, configPath: Rig.tmuxConf, session: "t-quote")
      // `cat -v` with the tty's echo off: what arrives is printed once, control characters made visible. READY is printed once the
      // echo is off, so nothing is sent while the tty would still echo it (the text would show twice).
      let made = Self.run(c.newSession(argv: ["/bin/sh", "-c", "stty -echo; echo READY; exec /bin/cat -v"], cwd: "/"))
      let pane = made.out.trimmingCharacters(in: .whitespacesAndNewlines)
      try #require(made.ok && TmuxCommands.isPaneId(pane), "no pane: \(made.err)")
      cmd = c.withPane(pane)
      try #require(wait(15) { screen.contains("READY") }, "the pane never got ready:\n\(screen)")
    }
    /// The rows after READY that hold anything.
    var received: [String] { screen.split(separator: "\n").map(String.init).filter { !$0.isEmpty && $0 != "READY" } }
    static func run(_ argv: [String]) -> RunResult { ProcessRunner.run(argv, env: ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"], timeout: 10) }
    var screen: String { Self.run(cmd.capturePane()).out }
    var inMode: Bool { Self.run(cmd.paneInMode()).out.hasPrefix("1") }
    func wait(_ s: Double, _ cond: () -> Bool) -> Bool {
      let until = Date().addingTimeInterval(s)
      while Date() < until { if cond() { return true }; usleep(50_000) }
      return cond()
    }
    func kill() { _ = Self.run([Rig.tmuxPath!, "-L", socket, "-f", Rig.tmuxConf, "kill-server"]) }
  }

  /// Quotes of both kinds, a `'\''` run, `;` inside and at the end, a format, a `%1` template, a variable, a backslash, a `#`.
  static let hostile = [
    "it's; a 'q' and \"dq\" #{pane_id} #(true) %1 %% $HOME ${PATH} \\ `id` ~ end;",
    "';kill-server;'", "' ; display-message -p talos-sent ; '", "-X cancel", "#{pane_in_mode}", "a  two  spaces", "trailing backslash\\",
  ]

  @Test(arguments: hostile)
  func textOfAnyKindReachesThePaneExactlyAndRunsNothing(text: String) throws {
    let p = try Pane()
    defer { p.kill() }
    let sent = Pane.run(p.cmd.sendLiteralUnlessInMode(text))
    #expect(sent.ok && TmuxCommands.parseModeSend(sent.out) == true, "\(sent.out) \(sent.err)")
    let enter = Pane.run(p.cmd.sendEnterUnlessInMode())
    #expect(enter.ok && TmuxCommands.parseModeSend(enter.out) == true, "\(enter.out) \(enter.err)")
    #expect(p.wait(5) { p.screen.contains(text) }, "the pane got something else:\n\(p.screen)")
    #expect(p.received == [text], "exactly the text, once: \(p.received)")
    #expect(Pane.run(p.cmd.hasSession()).ok, "the text ran as a command")
  }

  @Test func inCopyModeNothingIsSentTheModeIsNotLeftAndTmuxSaysSo() throws {
    let p = try Pane()
    defer { p.kill() }
    #expect(Pane.run([Rig.tmuxPath!, "-L", p.socket, "-f", Rig.tmuxConf, "copy-mode", "-t", p.cmd.paneTarget]).ok)
    #expect(p.wait(5) { p.inMode }, "control: the pane never entered copy mode")
    for argv in [p.cmd.sendLiteralUnlessInMode("q"), p.cmd.sendEnterUnlessInMode(), p.cmd.sendBackspacesUnlessInMode(3)] {
      let r = Pane.run(argv)
      #expect(r.ok && TmuxCommands.parseModeSend(r.out) == false, "\(r.out) \(r.err)")
      #expect(p.inMode, "the send left copy mode (a `q` typed into the mode does)")
    }
    #expect(Pane.run(p.cmd.cancelMode()).ok)
    #expect(p.wait(5) { !p.inMode })
    usleep(300_000)
    #expect(p.received.isEmpty, "something reached the pane:\n\(p.screen)")
    // and out of the mode the same sends go
    let r = Pane.run(p.cmd.sendLiteralUnlessInMode("abc"))
    #expect(TmuxCommands.parseModeSend(r.out) == true)
    #expect(TmuxCommands.parseModeSend(Pane.run(p.cmd.sendBackspacesUnlessInMode(1)).out) == true)
    #expect(TmuxCommands.parseModeSend(Pane.run(p.cmd.sendEnterUnlessInMode()).out) == true)
    #expect(p.wait(5) { p.screen.contains("ab") }, "\(p.screen)")
  }

  /// A send that fails (the pane is gone) prints neither marker: it is a failure, never keys that went.
  @Test func aSendToAPaneThatIsGoneIsNeitherSentNorHeld() throws {
    let p = try Pane()
    defer { p.kill() }
    let gone = p.cmd.withPane("%999")
    let r = Pane.run(gone.sendEnterUnlessInMode())
    #expect(!r.ok || TmuxCommands.parseModeSend(r.out) == nil, "\(r.out)")
  }
}
