import Foundation
import Testing
import TalosTestSupport
@testable import TalosSupervisor

/// The helper every attaching test calls (`Rig.pinWindowSize`), against a real private tmux server and a real attached client. Without the pin a
/// client of another size shrinks the window at once, which is what cropped the fake Mains' dialogs under the app's feet (2026-11-21).
@Suite("A test client attaching does not resize the window", .serialized, .enabled(if: Rig.hasTmux))
struct TmuxPinWindowTests {
  private final class Server {
    let socket = "talos-test-\(getpid())-pin\(UInt32.random(in: 0..<UInt32.max))"
    var client: Process?
    func tmux(_ args: [String]) -> RunResult {
      ProcessRunner.run([Rig.tmuxPath!, "-L", socket, "-f", "/dev/null"] + args, env: ["PATH": "/usr/bin:/bin"])
    }
    func start() { _ = tmux(["new-session", "-d", "-s", "agent", "-x", "120", "-y", "40", "sleep 60"]) }
    func size() -> String { tmux(["display-message", "-p", "-t", "=agent:", "#{window_width}x#{window_height}"]).out.trimmingCharacters(in: .whitespacesAndNewlines) }
    func attach() throws {
      let c = Process()
      c.executableURL = URL(fileURLWithPath: "/usr/bin/script")
      c.arguments = ["-q", "/dev/null", Rig.tmuxPath!, "-L", socket, "-f", "/dev/null", "attach-session", "-t", "=agent"]
      c.environment = ["TERM": "xterm-256color", "PATH": "/usr/bin:/bin"]
      c.standardInput = Pipe()
      c.standardOutput = FileHandle.nullDevice
      c.standardError = FileHandle.nullDevice
      try c.run()
      client = c
      let attached = waitUntil(timeout: 10) { !self.tmux(["list-clients", "-F", "#{client_width}"]).out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
      #expect(attached, "control: the client attached")
    }
    func stop() {
      if let c = client, c.isRunning { c.terminate() }
      client?.waitUntilExit()
      _ = tmux(["kill-server"])
    }
  }

  @Test func withoutThePinAnAttachShrinksTheWindow() throws {
    let s = Server()
    defer { s.stop() }
    s.start()
    #expect(s.size() == "120x40", "control: the window starts at its size: \(s.size())")
    try s.attach()
    #expect(s.size() != "120x40", "control: an unpinned attach changes the window, so the pin below proves something")
  }

  @Test func withThePinTheWindowKeepsItsSize() throws {
    let s = Server()
    defer { s.stop() }
    s.start()
    #expect(Rig.pinWindowSize(socket: s.socket, session: "agent"))
    try s.attach()
    #expect(s.size() == "120x40", "the pinned window was resized: \(s.size())")
  }

  @Test func aSessionThatIsNotThereIsReportedNotIgnored() {
    let s = Server()
    defer { s.stop() }
    s.start()
    #expect(!Rig.pinWindowSize(socket: s.socket, session: "no-such-session"))
  }
}
