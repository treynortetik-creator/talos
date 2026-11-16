import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// Restart on update, Fable R1-1: a spec hash must be the same in every process. Swift draws a new hashing seed per process (unless
/// SWIFT_DETERMINISTIC_HASHING is set), so a Dictionary or Set walked into the settings' bytes or argv gives another order, another
/// hash, and after each relaunch every quiet session would restart for no release. The hash is built here, in this process and in two
/// child processes of this very test bundle, from one fixture agent folder whose settings name many hook events and commands.
enum SpecProbe {
  static let rootVar = "TALOS_SPEC_PROBE_ROOT"
  static let sessionId = "11111111-2222-4333-8444-555555555555"

  /// A new folder for the fixture, under the tests' temp folder.
  static func dir() throws -> String {
    let d = (TestTemp.base as NSString).appendingPathComponent("talos-spec-probe-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    return Rig.realPath(d)
  }

  static func env(_ root: String) -> [String: String] {
    ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": root + "/home", "LANG": "en_US.UTF-8"]
  }

  /// The fixture: an agent folder and an owner's ~/.claude whose settings run many hooks (each its own script), and a status line.
  static func make(_ root: String) throws {
    for d in ["/agent/.claude", "/home/.claude", "/talos-home"] {
      try FileManager.default.createDirectory(atPath: root + d, withIntermediateDirectories: true)
    }
    func hooks(_ tag: String) -> String {
      let events = (1...24).map { e in
        let cmds = (1...3).map { c in #"{"type":"command","command":"python3 hooks/\#(tag)-\#(e)-\#(c).py --flag"}"# }.joined(separator: ",")
        return #""Event\#(e)":[{"matcher":"m\#(e)","hooks":[\#(cmds)]}]"#
      }.joined(separator: ",")
      return #"{"hooks":{\#(events)},"statusLine":{"type":"command","command":"sh /opt/\#(tag)/status.sh","padding":0}}"#
    }
    try hooks("agent").write(toFile: root + "/agent/.claude/settings.json", atomically: true, encoding: .utf8)
    try hooks("owner").write(toFile: root + "/home/.claude/settings.json", atomically: true, encoding: .utf8)
    try #"{"mcpServers":{"talos-app":{"command":"talos-app","args":["mcp"],"env":{"B":"2","A":"1","C":"3"}}}}"#
      .write(toFile: root + "/agent/.mcp.json", atomically: true, encoding: .utf8)
    try #"{"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},{"id":"trip","name":"trip","kind":"fixed","session":"dedicated"}]}"#
      .write(toFile: root + "/talos-home/config.json", atomically: true, encoding: .utf8)
  }

  /// The hash a dry plan gives for a running `trip` session on the fixture, through the manager's real spec builder.
  static func hash(_ root: String) -> WorkerManager.DryPlan? {
    var o = WorkerManager.Options(
      talosHome: root + "/talos-home", agentDir: root + "/agent", claudePath: "/usr/local/bin/claude",
      permissionFlag: "--dangerously-skip-permissions", tmux: "/usr/bin/false", tmuxConf: "/dev/null")
    o.permissionHook = Rig.hookSource
    o.home = root + "/home"
    let e = env(root)
    let m = WorkerManager(options: o, probe: LiveSystem(loginEnv: { e }), baseEnv: { e })
    return m.queue.sync {
      guard let s = m.loadSettings()?.threads["trip"] else { return nil }
      var entry = WorkersFile.Entry(threadId: "trip", cwd: root + "/agent")
      entry.state = "live"
      entry.session_id = sessionId
      m.rt["trip"] = WorkerManager.Runtime(entry: entry)
      return m.dryPlan("trip", s)
    }
  }

  /// This test bundle run again in a new process, with only `filter` and the fixture's folder: its own hashing seed.
  static func child(root: String, filter: String) -> (ok: Bool, why: String) {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: "--test-bundle-path"), i + 1 < args.count, args[0].hasSuffix("swiftpm-testing-helper") else {
      return (false, "not run by swiftpm-testing-helper, so the bundle cannot be run again: \(args)")
    }
    let bundle = args[i + 1]
    var env = ProcessInfo.processInfo.environment
    env["SWIFT_DETERMINISTIC_HASHING"] = nil  // the seed must be random, as in the app
    env[rootVar] = root
    let r = ProcessRunner.run(
      [args[0], "--test-bundle-path", bundle, "--filter", filter, bundle, "--testing-library", "swift-testing"], env: env, timeout: 120)
    return (r.ok, "status \(r.status): \(r.out.suffix(2000)) \(r.err.suffix(1000))")
  }
}

@Suite("Restart on update: one spec hash in every process", .serialized)
struct WorkerSpecStabilityTests {
  /// Runs only as the child (`SpecProbe.child`): writes the hash this process gives.
  @Test func specHashProbeChild() throws {
    guard let root = ProcessInfo.processInfo.environment[SpecProbe.rootVar] else { return }
    guard case .hash(let h?)? = SpecProbe.hash(root) else { Issue.record("no hash: \(String(describing: SpecProbe.hash(root)))"); return }
    try h.write(toFile: root + "/hash-\(getpid())", atomically: true, encoding: .utf8)
  }

  @Test func theSameFixtureGivesTheSameHashInThreeProcesses() throws {
    #expect(ProcessInfo.processInfo.environment["SWIFT_DETERMINISTIC_HASHING"] == nil, "the seed must be random here, as in the app")
    let root = try SpecProbe.dir()
    defer { try? FileManager.default.removeItem(atPath: root) }
    try SpecProbe.make(root)
    guard case .hash(let mine?)? = SpecProbe.hash(root) else { Issue.record("no hash in this process"); return }
    for _ in 0..<2 {
      let r = SpecProbe.child(root: root, filter: "specHashProbeChild")
      #expect(r.ok, "\(r.why)")
    }
    let files = try FileManager.default.contentsOfDirectory(atPath: root).filter { $0.hasPrefix("hash-") }
    #expect(files.count == 2, "\(files)")
    for f in files { #expect(try String(contentsOfFile: root + "/" + f, encoding: .utf8) == mine, "\(f)") }
  }

  @Test func theFenceListsTheHookScriptsInOneOrder() throws {
    // the walk itself: the same settings, the same list, sorted by the keys whatever this process's seed
    let root = try SpecProbe.dir()
    defer { try? FileManager.default.removeItem(atPath: root) }
    try SpecProbe.make(root)
    let files = [(settings: root + "/agent/.claude/settings.json", base: root + "/agent")]
    let list = WorkerFence.scripts(files: files, projectDir: root + "/agent", home: root + "/home")
    #expect(list.count == 24 * 3 + 1)
    // the hooks' events by name, then each command in its own order (the status line is the settings' other key: after "hooks")
    let events = (1...24).map { "Event\($0)" }.sorted()
    let want = events.flatMap { e in (1...3).map { root + "/agent/hooks/agent-\(e.dropFirst(5))-\($0).py" } } + ["/opt/agent/status.sh"]
    #expect(list == want)
  }

  @Test func anAgentFolderSessionsSpecHoldsTheTalosAppEntryItLoadsItself() throws {
    // Linux hashes it as `agent-mcp.json` (workers-wiring.ts specFiles): a session in the agent folder reads the folder's .mcp.json itself
    let root = try SpecProbe.dir()
    defer { try? FileManager.default.removeItem(atPath: root) }
    try SpecProbe.make(root)
    guard case .hash(let a?)? = SpecProbe.hash(root) else { Issue.record("no hash"); return }
    try #"{"mcpServers":{"talos-app":{"command":"talos-app","args":["mcp","--v2"]},"other":{"command":"x"}}}"#
      .write(toFile: root + "/agent/.mcp.json", atomically: true, encoding: .utf8)
    guard case .hash(let b?)? = SpecProbe.hash(root) else { Issue.record("no hash"); return }
    #expect(a != b)
    // a server other than talos-app is not the session's to hash (the list decides those): unchanged by it
    try #"{"mcpServers":{"talos-app":{"command":"talos-app","args":["mcp","--v2"]},"other":{"command":"y"}}}"#
      .write(toFile: root + "/agent/.mcp.json", atomically: true, encoding: .utf8)
    #expect(SpecProbe.hash(root) == .hash(b))
  }
}
