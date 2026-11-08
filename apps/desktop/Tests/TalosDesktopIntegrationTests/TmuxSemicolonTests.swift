import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// tmux ends a command at an argv element that ends in `;`, so an agent argument such as `be brief;` used to start nothing
/// ("unknown command"). Every element that reaches the agent must arrive exactly as the owner typed it, on the first start
/// (new-session) and on a restart (respawn-pane).
@Suite("A `;` at the end of an agent argument or variable reaches the agent as typed", .serialized, .enabled(if: Rig.hasTmux))
struct TmuxSemicolonTests {
  /// An ending `;`, a lone `;`, one already ending in `\;`, one with `;` inside, and a value that ends in `;` in the env.
  static let userArgs = ["be brief;", ";", "a\\;", "mid;dle", "two;;"]

  private func rig(scenario: String, env: [String: String] = [:]) throws -> Rig {
    try Rig(.tmux, scenario: scenario, env: env) { c in
      c.args += Self.userArgs
      c.env["FAKE_ARGV_DUMP"] = c.agentDir + "-argvdump"
      c.env["FAKE_ENV_DUMP"] = c.agentDir + "-envdump"
      c.env["TALOS_TEST_VALUE"] = "ends;"
    }
  }

  /// What start `n` received: the argv lines (`[element]`) in the order the fake wrote them, or nil until it exists.
  private func argv(_ r: Rig, _ n: Int) -> [String]? {
    (try? String(contentsOfFile: r.agentDir + "-argvdump.\(n)", encoding: .utf8)).map { $0.split(separator: "\n").map(String.init) }
  }

  private func env(_ r: Rig, _ n: Int) -> [String]? {
    (try? String(contentsOfFile: r.agentDir + "-envdump.\(n)", encoding: .utf8)).map { $0.split(separator: "\n").map(String.init) }
  }

  private var wanted: [String] { Self.userArgs.map { "[\($0)]" } }

  private func containsRun(_ lines: [String], _ run: [String]) -> Bool {
    lines.indices.contains { $0 + run.count <= lines.count && Array(lines[$0..<($0 + run.count)]) == run }
  }

  @Test
  func theFirstStartGetsEveryElementExactly() throws {
    let r = try rig(scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.wait(30) { argv(r, 1) != nil }, "the agent never started: \(r.phase()) \(r.audit)")
    let got = argv(r, 1) ?? []
    #expect(containsRun(got, wanted), "\(got)")
    #expect(env(r, 1)?.contains("TALOS_TEST_VALUE=ends;") == true, "\(env(r, 1) ?? [])")
    #expect(!r.audit.contains(" start_failed"), "\(r.audit)")
  }

  @Test
  func aRestartGetsEveryElementExactlyToo() throws {
    let r = try rig(scenario: "restart-silent.sh", env: ["FAKE_CRASH_AFTER": "6"])
    defer { r.teardown() }
    try coldStartConfirmed(r)
    #expect(r.wait(60) { argv(r, 2) != nil }, "never restarted: \(r.phase()) \(r.audit)")
    let first = argv(r, 1) ?? []
    let again = argv(r, 2) ?? []
    #expect(containsRun(first, wanted), "\(first)")
    #expect(containsRun(again, wanted), "\(again)")
    #expect(again.contains("[--resume]"), "the restart is a resume: \(again)")
    #expect(env(r, 2)?.contains("TALOS_TEST_VALUE=ends;") == true, "\(env(r, 2) ?? [])")
    #expect(!r.audit.contains(" restart_failed"), "\(r.audit)")
  }
}
