import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// Main's saved conversation id (desktop.json `session.id`, a file an agent may be able to write) reaches claude's argv. It sits outside
/// the launch seal (the fingerprint strips it), so it must never become a flag of its own: only a UUID is passed, and as ONE argument.
@Suite("Main's session id in the argv")
struct SessionIdArgvTests {
  static let hostile = ["--some-flag", "--settings=/x", "11111111-2222-4333-8444-555555555555 --dangerously-skip-permissions", "", "-r", "x"]

  @Test(arguments: hostile)
  func aSavedIdThatIsNotAUUIDNeverReachesTheArgv(_ id: String) {
    let base = ["--dangerously-load-development-channels", "server:talos-app"]
    for mode in [ResumeRewrite.Mode.resume(id), .newSession(id)] {
      let argv = ResumeRewrite.apply(base, mode)
      #expect(!argv.contains(id), "\(mode): \(argv)")
      #expect(!argv.contains { !id.isEmpty && $0.contains(id) }, "\(mode): \(argv)")
      #expect(argv == base, "no session flag at all for a non-id: \(argv)")
    }
  }

  @Test func aUUIDIsOneArgument() {
    let id = "11111111-2222-4333-8444-555555555555"
    #expect(ResumeRewrite.apply(["--a"], .resume(id)) == ["--a", "--resume=\(id)"])
    #expect(ResumeRewrite.apply(["--a"], .newSession(id)) == ["--a", "--session-id=\(id)"])
  }

  /// Everything that reads an argv back understands the one-argument form, and still the two-argument one.
  @Test func theReadersKnowBothForms() {
    let id = "11111111-2222-4333-8444-555555555555"
    for argv in [["--a", "--resume=\(id)"], ["--a", "--session-id=\(id)"], ["--a", "--resume", id], ["--a", "--session-id", id]] {
      #expect(ResumeRewrite.strip(argv) == ["--a"], "\(argv)")
      #expect(ResumeRewrite.sessionId(in: argv) == id, "\(argv)")
      #expect(ResumeRewrite.apply(ResumeRewrite.apply(argv, .resume(id)), .newSession(id)) == ["--a", "--session-id=\(id)"])
    }
  }

  /// The fingerprint the owner sealed must not move: a changed one would make every owner confirm Main's launch again. Pinned to the value
  /// this config had before the one-argument form (computed before the change, on ab92b56d), and the same whichever form a stored argv carries.
  @Test func theLaunchFingerprintOfAnUnchangedConfigIsUnchanged() {
    var c = DesktopConfig.defaults
    c.agentDir = "/home/alex/agent"
    c.args = ["--dangerously-skip-permissions", "--dangerously-load-development-channels", "server:talos-app"]
    c.env = ["TALOS_APP_HOME": "/home/alex/.config/talos/app"]
    let fp = c.launchFingerprint(resolvedClaude: "/home/alex/.local/bin/claude")
    #expect(fp == Self.pinned, "fingerprint \(fp)")
    let parts = c.launchParts(resolvedClaude: "/home/alex/.local/bin/claude")
    let id = "11111111-2222-4333-8444-555555555555"
    for extra in [["--resume", id], ["--resume=\(id)"], ["--session-id=\(id)"]] {
      var d = c
      d.args += extra
      #expect(d.launchFingerprint(resolvedClaude: "/home/alex/.local/bin/claude") == fp, "\(extra)")
      #expect(d.launchParts(resolvedClaude: "/home/alex/.local/bin/claude") == parts, "\(extra)")
    }
  }

  /// The menu's Copy Terminal command (`SupervisorController.terminalCommand` is `LaunchSpec.rollback(configNow, …).render()`, and
  /// `Supervisor.terminalCommand` the same): a bad id is left out by the builder AND by the renderer.
  @Test(arguments: hostile)
  func theCopiedTerminalCommandNeverCarriesABadId(_ id: String) {
    var c = DesktopConfig.defaults
    c.agentDir = "/home/alex/agent"
    c.session.id = id
    let cmd = LaunchSpec.rollback(c, home: "/home/alex").render()
    #expect(!cmd.contains("--resume"), "\(cmd)")
    #expect(id.isEmpty || id == "x" || !cmd.contains(id), "\(cmd)")
    // the renderer alone, given a bad id by some other caller
    let raw = LaunchSpec(agentDir: "/home/alex/agent", env: [:], program: "claude", args: [], resumeId: id).render()
    #expect(!raw.contains("--resume"), "\(raw)")
  }

  @Test func aGoodIdIsCopiedAsBefore() {
    var c = DesktopConfig.defaults
    c.agentDir = "/home/alex/agent"
    c.session.id = "11111111-2222-4333-8444-555555555555"
    #expect(LaunchSpec.rollback(c, home: "/home/alex").render().hasSuffix("--resume 11111111-2222-4333-8444-555555555555"))
  }

  static let pinned = "770e67838e8540c5a3a80a06225e06a782782188fb3a7dc2a784b19d0f25c6b1"
}
