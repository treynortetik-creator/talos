import Foundation
import Testing
@testable import TalosDesktopCore

/// The optional guards (`talos-app install-guards`) reach every launch: the main session, workers and a hand-opened claude.
@Suite("Guards settings")
struct GuardsSettingsTests {
  let sid = "6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41"

  /// A throwaway Talos home; `installed` writes the file install-guards writes.
  func home(installed: String? = nil) throws -> String {
    let dir = NSTemporaryDirectory() + "talos-guards-\(UUID().uuidString)"
    try FileManager.default.createDirectory(atPath: dir + "/guards", withIntermediateDirectories: true)
    if let installed { try Data(installed.utf8).write(to: URL(fileURLWithPath: dir + "/guards/settings.json")) }
    return dir
  }
  let rules = #"{"permissions":{"deny":["Bash(claude plugin:*)"]},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"x"}]}]}}"#

  func inputs(_ talosHome: String) -> WorkerSpec.Inputs {
    .init(
      threadId: "trip", claudePath: "/usr/local/bin/claude", baseEnv: ["PATH": "/usr/bin"], talosHome: talosHome,
      agentDir: "/home/alex/agent", model: "inherit", effort: nil, permissionFlag: nil, sessionId: sid, resume: false,
      nonce: "n0nce-0123456789abcdef", preamble: nil)
  }

  @Test func mainSessionGetsTheSettingsFileOnlyWhenInstalled() throws {
    let none = try home()
    #expect(GuardsSettings.applying(to: ["--model", "opus"], talosHome: none).args == ["--model", "opus"])
    let on = try home(installed: rules)
    let r = GuardsSettings.applying(to: ["--model", "opus"], talosHome: on)
    #expect(r.args == ["--model", "opus", "--settings", on + "/guards/settings.json"])
    #expect(r.warning == nil)
  }

  @Test func ownersSettingsFlagIsKeptAndWarnedAbout() throws {
    let on = try home(installed: rules)
    for args in [["--settings", "/x.json"], ["--settings=/x.json"]] {
      let r = GuardsSettings.applying(to: args, talosHome: on)
      #expect(r.args == args)
      #expect(r.warning?.contains("NOT active") == true)
    }
  }

  @Test func workerSettingsCarryTheHookAndDenyRulesBesideThePluginsOffKeys() throws {
    let spec = try WorkerSpec.build(inputs(try home(installed: rules)))
    let obj = try #require(try JSONSerialization.jsonObject(with: Data(spec.settingsJSON.utf8)) as? [String: Any])
    #expect(obj["enabledPlugins"] != nil)
    #expect(obj["hooks"] != nil)
    #expect((obj["permissions"] as? [String: Any])?["deny"] != nil)
    let plain = try WorkerSpec.build(inputs(try home()))
    #expect(!plain.settingsJSON.contains("hooks"))
  }

  @Test func aWorkerWillNotStartUnderGuardsItCannotRead() throws {
    #expect(throws: WorkerSpec.BuildError.guardsUnreadable) { try WorkerSpec.build(inputs(try home(installed: "not json"))) }
  }

  @Test func handOpenedClaudeGetsTheSameMergedSettings() throws {
    var f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-01T00:00:00Z", workers_supported: true, main_pane_pid: 2))
    var e = WorkersFile.Entry(threadId: "q", cwd: "/home/alex/proj-q")
    e.state = "failed"
    e.error = .init(code: "needs_mac", detail: "trust", at: "2026-11-01T00:00:00Z")
    f.threads["q"] = e
    let row = try #require(ThreadSessions.rows(from: f).first)
    let on = try home(installed: rules)
    let inv = try #require(ThreadSessions.claudeInvocation(for: row, claudePath: "claude", talosHome: on))
    let json = try #require(inv.args.last)
    #expect(json.contains("enabledPlugins") && json.contains("PreToolUse"))
    #expect(ThreadSessions.claudeInvocation(for: row, claudePath: "claude", talosHome: on + "-missing")?.args.last == ThreadSessions.pluginsOffSettings)
  }
}
