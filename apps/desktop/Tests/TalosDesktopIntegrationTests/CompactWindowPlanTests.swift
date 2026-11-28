import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// The compact point through the manager's real start path: the thread's config.json entry, read by `loadSettings`, reaches the spec the
/// manager would launch (`specInputs`, the dry plan runs the same builder as a start), and its hash changes with it.
@Suite("Compact window in the Mac's start", .serialized)
struct CompactWindowPlanTests {
  static let name = "CLAUDE_CODE_AUTO_COMPACT_WINDOW"

  /// The spec parts a dry plan gives for a running `trip` session whose config entry has `opts` as its session_opts.
  static func parts(_ root: String, opts: String) throws -> LaunchSpecHash.Parts? {
    try """
      {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},
       {"id":"trip","name":"trip","kind":"fixed","session":"dedicated","session_opts":\(opts)}]}
      """.write(toFile: root + "/talos-home/config.json", atomically: true, encoding: .utf8)
    var o = WorkerManager.Options(
      talosHome: root + "/talos-home", agentDir: root + "/agent", claudePath: "/usr/local/bin/claude",
      permissionFlag: "--dangerously-skip-permissions", tmux: "/usr/bin/false", tmuxConf: "/dev/null")
    o.permissionHook = Rig.hookSource
    o.home = root + "/home"
    let e = SpecProbe.env(root)
    let m = WorkerManager(options: o, probe: LiveSystem(loginEnv: { e }), baseEnv: { e })
    return m.queue.sync {
      guard let s = m.loadSettings()?.threads["trip"] else { return nil }
      var entry = WorkersFile.Entry(threadId: "trip", cwd: root + "/agent")
      entry.state = "live"
      entry.session_id = SpecProbe.sessionId
      m.rt["trip"] = WorkerManager.Runtime(entry: entry)
      guard case .spec(let parts, _) = m.dryPlanDetail("trip", s) else { return nil }
      return parts
    }
  }

  @Test func theConfigValueReachesTheLaunchEnvironmentAndTheHash() throws {
    let root = try SpecProbe.dir()
    defer { try? FileManager.default.removeItem(atPath: root) }
    try SpecProbe.make(root)
    let none = try #require(try Self.parts(root, opts: "{}"))
    let a = try #require(try Self.parts(root, opts: #"{"compact_window":400000}"#))
    let b = try #require(try Self.parts(root, opts: #"{"compact_window":300000}"#))
    #expect(none.env[Self.name] == nil)
    // and in the settings file the session is started with, where it outranks the owner's user settings
    func settingsEnv(_ p: LaunchSpecHash.Parts) -> String? {
      let data = (p.files["settings.json"] ?? nil) ?? Data()
      let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      return (obj?["env"] as? [String: Any])?[Self.name] as? String
    }
    #expect(settingsEnv(a) == "400000" && settingsEnv(none) == nil)
    #expect(a.env[Self.name] == "400000" && b.env[Self.name] == "300000")
    #expect(none.hash != nil && a.hash != none.hash && b.hash != a.hash)
  }

  @Test func aBadConfigValueIsUnsetAndTheSpecIsTheOneWithoutIt() throws {
    let root = try SpecProbe.dir()
    defer { try? FileManager.default.removeItem(atPath: root) }
    try SpecProbe.make(root)
    let none = try #require(try Self.parts(root, opts: "{}"))
    for bad in ["5", "99999", "1000001", "\"auto\"", "null"] {
      let p = try #require(try Self.parts(root, opts: #"{"compact_window":\#(bad)}"#))
      #expect(p.env[Self.name] == nil, "\(bad)")
      #expect(p.hash == none.hash, "\(bad)")
    }
  }
}
