import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// The remote terminal view (docs/PROTOCOL.md, "The terminal stream") attaches one control-mode client to the agent's session:
/// `tmux -C attach -f ignore-size -t =<session>`. While it is attached, the supervisor's own keys must still reach the pane: a
/// read-only client (`attach -r`) became the session's client and made every plain `send-keys` fail with "client is read-only",
/// silently, the whole time someone watched. And the view is never the owner at the keyboard: `listClientsActivity` skips it.
/// Real tmux, private socket only (never `-L talos`).
@Suite("Keys reach the pane while the remote view is attached", .serialized, .enabled(if: Rig.hasTmux))
struct TmuxViewerAttachedSendTests {
  private final class Pane {
    let socket = "talos-test-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
    let cmd: TmuxCommands
    private let viewer = Process()
    private let viewerInput = Pipe()

    init() throws {
      let c = TmuxCommands(tmux: Rig.tmuxPath!, socket: socket, configPath: Rig.tmuxConf, session: "t-view")
      // `cat -v` with the tty's echo off: what arrives is printed once. READY once the echo is off.
      let made = Self.run(c.newSession(argv: ["/bin/sh", "-c", "stty -echo; echo READY; exec /bin/cat -v"], cwd: "/"))
      let pane = made.out.trimmingCharacters(in: .whitespacesAndNewlines)
      try #require(made.ok && TmuxCommands.isPaneId(pane), "no pane: \(made.err)")
      cmd = c.withPane(pane)
      try #require(wait(15) { screen.contains("READY") }, "the pane never got ready:\n\(screen)")
    }

    /// The view's client, exactly as the bridge attaches it (apps/bridge/src/term/control.ts `attachArgs`). Its stdin stays open,
    /// and nothing is ever written to it here.
    func attachViewer() throws {
      viewer.executableURL = URL(fileURLWithPath: Rig.tmuxPath!)
      viewer.arguments = ["-L", socket, "-f", Rig.tmuxConf, "-C", "attach", "-f", "ignore-size", "-t", "=t-view"]
      viewer.environment = ["PATH": "/usr/bin:/bin"]
      viewer.standardInput = viewerInput
      viewer.standardOutput = FileHandle.nullDevice
      viewer.standardError = FileHandle.nullDevice
      try viewer.run()
      try #require(wait(5) { flags.contains("control-mode") }, "the viewer never attached: \(flags)")
    }

    var flags: String { Self.run([Rig.tmuxPath!, "-L", socket, "-f", Rig.tmuxConf, "list-clients", "-t", "=t-view", "-F", "#{client_flags}"]).out }
    var received: [String] { screen.split(separator: "\n").map(String.init).filter { !$0.isEmpty && $0 != "READY" } }
    var screen: String { Self.run(cmd.capturePane()).out }
    static func run(_ argv: [String]) -> RunResult { ProcessRunner.run(argv, env: ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"], timeout: 10) }
    func wait(_ s: Double, _ cond: () -> Bool) -> Bool {
      let until = Date().addingTimeInterval(s)
      while Date() < until { if cond() { return true }; usleep(50_000) }
      return cond()
    }
    func kill() {
      try? viewerInput.fileHandleForWriting.close()
      if viewer.isRunning { viewer.terminate() }
      _ = Self.run([Rig.tmuxPath!, "-L", socket, "-f", Rig.tmuxConf, "kill-server"])
    }
  }

  @Test func theViewIsAControlClientThatIgnoresSizeAndIsNotReadOnly() throws {
    let p = try Pane()
    defer { p.kill() }
    try p.attachViewer()
    #expect(p.flags.contains("ignore-size"), "the view could resize the pane: \(p.flags)")
    #expect(!p.flags.contains("read-only"), "a read-only client makes every send-keys on the session fail: \(p.flags)")
  }

  @Test func everySendTheSupervisorMakesReachesThePaneWhileTheViewIsAttached() throws {
    let p = try Pane()
    defer { p.kill() }
    try p.attachViewer()
    for (argv, what) in [
      (p.cmd.sendLiteral("plain"), "sendLiteral"), (p.cmd.sendEnter(), "sendEnter"),
      (p.cmd.sendLiteralUnlessInMode("guarded"), "sendLiteralUnlessInMode"), (p.cmd.sendEnterUnlessInMode(), "sendEnterUnlessInMode"),
      (p.cmd.sendBytes(Array("bytes".utf8)), "sendBytes"), (p.cmd.sendEnter(), "sendEnter"),
      (p.cmd.sendBytesLeavingMode(Array("leaving\r".utf8)), "sendBytesLeavingMode"),
    ] {
      let r = Pane.run(argv)
      #expect(r.ok, "\(what) failed with the view attached: \(r.err)")
      #expect(!r.err.contains("read-only"), "\(what): \(r.err)")
    }
    #expect(p.wait(5) { p.received.count >= 4 }, "the keys never arrived:\n\(p.screen)")
    #expect(p.received == ["plain", "guarded", "bytes", "leaving"], "each send, once, in order: \(p.received)")
  }

  @Test func theViewIsNeverTheOwnerAtTheKeyboard() throws {
    let p = try Pane()
    defer { p.kill() }
    try p.attachViewer()
    let out = Pane.run(p.cmd.listClientsActivity())
    #expect(out.ok, "\(out.err)")
    #expect(TmuxCommands.parseClientActivity(out.out) == [], "the view counted as a client that can type: \(out.out)")
  }
}
