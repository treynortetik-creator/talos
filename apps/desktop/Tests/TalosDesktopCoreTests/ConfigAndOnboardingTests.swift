import Foundation
import Testing
@testable import TalosDesktopCore

@Suite("DesktopConfig (D1 schema)")
struct DesktopConfigSchemaTests {
  @Test func aD0EraFileDecodesWithDefaults() throws {
    let old = #"{"v":1,"agent_dir":"~/x","claude_path":"auto","args":[],"env":{},"session":{"id":null,"confirmed_at":null,"approved_dev_channels":[]},"auto_restart":true,"auto_confirm_restart":true,"start_session_on_launch":true,"open_terminal_on_dialog":true,"start_at_login":false,"relay_url":"https://relay.example.com"}"#
    let c = try DesktopConfig.decode(Data(old.utf8))
    #expect(c.host == .auto)
    #expect(c.session.previousIds == [])
    #expect(c.session.confirmedCliVersion == nil)
    #expect(c.hotkeys.compose == "ctrl+opt+space")
    #expect(c.agentDir == "~/x")
  }

  @Test func writesEverySpecKey() throws {
    let obj = try #require(jsonObject(String(decoding: try DesktopConfig.defaults.encoded(), as: UTF8.self)))
    for k in ["v", "host", "agent_dir", "claude_path", "args", "env", "session", "auto_restart", "auto_confirm_restart",
      "start_session_on_launch", "open_terminal_on_dialog", "hotkeys", "relay_url"]
    {
      #expect(obj[k] != nil, "missing \(k)")
    }
    let s = try #require(obj["session"] as? [String: Any])
    for k in ["id", "previous_ids", "confirmed_at", "confirmed_cli_version", "approved_dev_channels"] {
      #expect(s.keys.contains(k), "missing session.\(k)")
    }
  }

  @Test func savesAtomicallyWith0600() throws {
    let dir = NSTemporaryDirectory() + "talos-cfg-\(UUID().uuidString.prefix(6))"
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let path = dir + "/desktop.json"
    var c = DesktopConfig.defaults
    c.session.id = "x"
    try ConfigFile.save(c, to: path)
    try ConfigFile.save(c, to: path)
    let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int
    #expect(mode == 0o600)
    let back = try ConfigFile.load(path)
    #expect(back == c)
    let files = try FileManager.default.contentsOfDirectory(atPath: dir)
    #expect(files == ["desktop.json"], "no temp files left")
    let missing = try ConfigFile.load(dir + "/missing.json")
    #expect(missing == nil)
  }

  @Test func retireKeepsTheLastFive() {
    var s = DesktopConfig.Session(id: "6", previousIds: ["1", "2", "3", "4", "5"], confirmedAt: "x", confirmedCliVersion: "v")
    s.retireCurrentId()
    #expect(s.previousIds == ["2", "3", "4", "5", "6"])
    #expect(s.id == nil && s.confirmedAt == nil && s.confirmedCliVersion == nil)
  }

  @Test func fingerprintIgnoresSessionFlags() {
    var a = DesktopConfig.defaults
    a.args = ["--x"]
    var b = a
    b.args = ["--x", "--resume", "abc"]
    #expect(a.launchFingerprint(resolvedClaude: "/c") == b.launchFingerprint(resolvedClaude: "/c"))
    b.args = ["--y"]
    #expect(a.launchFingerprint(resolvedClaude: "/c") != b.launchFingerprint(resolvedClaude: "/c"))
    #expect(a.launchFingerprint(resolvedClaude: "/c") != a.launchFingerprint(resolvedClaude: "/d"))
  }
}

@Suite("PermissionsModel")
struct PermissionsModelTests {
  @Test func everyRowAndOnlyWarnings() {
    let rows = PermissionsModel.rows { k in
      switch k {
      case .accessibility: return .granted
      case .fullDiskAccess: return .missing
      default: return .askedOnFirstUse
      }
    }
    #expect(rows.count == PermissionsModel.Kind.allCases.count)
    #expect(Set(rows.map(\.kind)) == Set(PermissionsModel.Kind.allCases))
    #expect(rows.allSatisfy { $0.isWarningOnly })
    #expect(rows.first { $0.kind == .accessibility }?.needsAttention == false)
    #expect(rows.first { $0.kind == .fullDiskAccess }?.action == .openSettings(PermissionsModel.settingsBase + "Privacy_AllFiles"))
    #expect(rows.first { $0.kind == .screenRecording }?.action == .openSettings(PermissionsModel.settingsBase + "Privacy_ScreenCapture"))
    #expect(rows.first { $0.kind == .desktopFolder }?.action == .triggerPrompt)
    #expect(PermissionsModel.summary(rows) == "Permissions: 1 to review (warnings only)")
    #expect(PermissionsModel.summary(PermissionsModel.rows { _ in .granted }).hasPrefix("Permissions: nothing missing"))
  }
}

@Suite("AdoptPlan and CrashPost")
struct AdoptAndPostTests {
  let id = "0f1e2d3c-4b5a-4968-8776-655443322110"

  @Test func prefillsFromASnapshot() {
    let snap = ProcessSnapshot(
      pid: 7, ppid: 1, pgid: 7, startTime: 1,
      argv: ["claude", "--dangerously-skip-permissions", "--channels", "plugin:t@x", "--resume", id],
      env: ["TALOS_APP_BRIDGE": "1", "PATH": "/usr/bin", "TERM_PROGRAM": "Apple_Terminal", "SHLVL": "2"],
      cwd: "/home/example/agent")
    let p = AdoptPlan.from(snapshot: snap, agentsEntry: nil, loginEnv: ["PATH": "/usr/bin"])
    #expect(p?.agentDir == "/home/example/agent")
    #expect(p?.claudePath == "auto")
    #expect(p?.args == ["--dangerously-skip-permissions", "--channels", "plugin:t@x"])
    #expect(p?.env == ["TALOS_APP_BRIDGE": "1"])
    #expect(p?.sessionId == id)
    #expect(p?.envReadable == true)
    let c = p?.applied(to: .defaults, home: "/home/example")
    #expect(c?.agentDir == "~/agent")
    #expect(c?.session.id == id && c?.session.confirmedAt == nil)
  }

  @Test func agentsEntryWinsAndUnreadableEnvKeepsTheConfig() {
    let snap = ProcessSnapshot(pid: 7, ppid: 1, pgid: 7, startTime: 1, argv: ["/x/claude"], env: [:], cwd: "/a")
    let e = AgentEntry(kind: "interactive", pid: 7, sessionId: id, status: "idle", cwd: "/a")
    let p = AdoptPlan.from(snapshot: snap, agentsEntry: e, loginEnv: [:])
    #expect(p?.sessionId == id && p?.claudePath == "/x/claude" && p?.envReadable == false)
    var base = DesktopConfig.defaults
    base.env = ["KEEP": "1"]
    #expect(p?.applied(to: base, home: "/h").env == BridgeEnv.merged(["KEEP": "1"]))  // kept, plus the bridge variables (D45)
  }

  @Test func crashPostText() {
    let a = CrashPost.readAppConfig(Data(#"{"agent":{"name":"Atlas"},"default_thread":"general"}"#.utf8))
    #expect(a.agentName == "Atlas" && a.defaultThread == "general")
    #expect(CrashPost.readAppConfig(nil).defaultThread == nil)
    #expect(CrashPost.text(agentName: "Atlas", at: "14:02") == "Atlas's session stopped restarting at 14:02")
    #expect(CrashPost.clockTime(Date(timeIntervalSince1970: 0), timeZone: TimeZone(identifier: "UTC")!) == "00:00")
  }
}
