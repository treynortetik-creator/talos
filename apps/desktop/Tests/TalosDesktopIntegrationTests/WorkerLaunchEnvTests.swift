import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// A worker is launched the same way as Main (`LaunchFile`): tmux runs only `/usr/bin/env -i /bin/sh <launch file>`, and the
/// worker's variables, its nonce among them, are never in an argv.
@Suite("Worker launch: the environment stays out of every argv", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerLaunchEnvTests {
  @Test func aWorkersNonceIsInNoArgvAndItsLaunchFileIsPrivateAndGone() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let s = try PaneLaunchEnvTests.loggingShim(root: r.root)
    r.tmuxBin = s.shim
    r.makeManager()
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" || r.state("trip") == "busy" }, "live: \(r.why("trip"))")
    let d = r.talosHome + "/workers/trip"
    let nonce = try String(contentsOfFile: d + "/nonce", encoding: .utf8)
    #expect(!nonce.isEmpty)
    #expect(r.lines(r.envLog + ".trip").contains("TALOS_APP_WORKER_NONCE=\(nonce)"), "the worker got its nonce")
    let log = (try? String(contentsOfFile: s.argvLog, encoding: .utf8)) ?? ""
    #expect(!log.contains(nonce), "the nonce was in a tmux argv")
    let panes = PaneLaunchEnvTests.paneCommands(s.argvLog)
    #expect(panes.count == 1, "\(panes)")
    for argv in panes {
      #expect(Array(argv.drop { $0 != "--" }.dropFirst()) == ["/usr/bin/env", "-i", "/bin/sh", d + "/launch.sh"], "\(argv)")
    }
    let seen = (try? String(contentsOfFile: s.fileLog, encoding: .utf8)) ?? ""
    #expect(seen == "seen 600 700 rm -f -- \"$0\"\n", "\(seen)")
    #expect(!FileManager.default.fileExists(atPath: d + "/launch.sh"))
  }

  /// A worker whose start is the first on the socket starts the shared tmux server, which takes its global environment from that
  /// tmux client. The client runs with the plain basics only, so the owner's login environment never becomes the server's.
  @Test func aWorkerThatStartsTheServerGivesItOnlyThePlainBasics() throws {
    let r = try WorkerRig(extraEnv: ["TALOS_TEST_LOGIN_ONLY": "login-only-value"])
    defer { r.teardown() }
    let none = ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "has-session"], env: r.env)
    #expect(!none.ok, "precondition: no server on the socket yet")
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" || r.state("trip") == "busy" }, "live: \(r.why("trip"))")
    let g = ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "-f", Rig.tmuxConf, "show-environment", "-g"], env: r.env)
    #expect(g.ok, "\(g.err)")
    for name in ["TALOS_TEST_LOGIN_ONLY", "TELEGRAM_BOT_TOKEN", "FAKE_LOG", "MCP_PROTOCOL_NEGOTIATION"] {
      #expect(!g.out.contains(name), "\(name) is in the tmux server's global environment: \(g.out)")
    }
    #expect(g.out.contains("PATH="), "the basics are kept: \(g.out)")
  }
}
