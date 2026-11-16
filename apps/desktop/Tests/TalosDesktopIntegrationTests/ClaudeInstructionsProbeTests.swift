import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport

/// With `--setting-sources user` a real Claude Code session gets none of its folder's CLAUDE.md and AGENTS.md files (found on
/// Delphi, 2026-11-12), so the app hands them over as text (WorkerInstructions.swift). This runs the real `claude` for one turn:
/// haiku, every installed plugin off, all hooks off, no tools, no MCP server, nothing saved, a clean environment with only the home
/// (for the sign-in), PATH and the user. A folder `child` inside a repository `parent`: AGENTS.md in both, CLAUDE.md in the child.
/// CONTROL: the same session without the app's text names none of the three codewords; with it, all three.
/// It costs one cheap model turn each way, so it runs only when TALOS_REAL_CLAUDE_PROBE=1 and a signed-in `claude` is there.
@Suite("A real thread-folder session gets its instruction files")
struct ClaudeInstructionsProbeTests {
  static let claude: String? = {
    let path = (ProcessInfo.processInfo.environment["PATH"] ?? "") + ":" + NSHomeDirectory() + "/.local/bin:/opt/homebrew/bin:/usr/local/bin"
    for d in path.split(separator: ":") where FileManager.default.isExecutableFile(atPath: "\(d)/claude") { return "\(d)/claude" }
    return nil
  }()
  static var enabled: Bool { ProcessInfo.processInfo.environment["TALOS_REAL_CLAUDE_PROBE"] == "1" && claude != nil }
  static let words = ["PARENT-ALPHA-7719", "CHILD-BRAVO-4402", "CLAUDE-CHARLIE-9031"]

  /// Every installed plugin off, the channel plugins named besides.
  func pluginsOff() -> [String: Bool] {
    var off: [String: Bool] = [WorkerSpec.telegramPlugin: false, WorkerSpec.imessagePlugin: false]
    let file = NSHomeDirectory() + "/.claude/plugins/installed_plugins.json"
    if let d = FileManager.default.contents(atPath: file), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
      let plugins = j["plugins"] as? [String: Any]
    {
      for k in plugins.keys { off[k] = false }
    }
    return off
  }

  func ask(_ extra: [String], cwd: String, keep: Bool = false) throws -> String {
    let settings = try JSONSerialization.data(withJSONObject: ["enabledPlugins": pluginsOff(), "disableAllHooks": true])
    let p = Process()
    p.executableURL = URL(fileURLWithPath: Self.claude!)
    p.arguments = [
      "-p", "List every codeword that appears anywhere in your instructions, separated by spaces, and nothing else. If there are none, reply NONE.",
      "--model", "haiku", "--tools", "", "--strict-mcp-config", "--settings", String(decoding: settings, as: UTF8.self),
    ] + (keep ? [] : ["--no-session-persistence"]) + extra
    p.currentDirectoryURL = URL(fileURLWithPath: cwd)
    let env = ProcessInfo.processInfo.environment
    p.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "USER": env["USER"] ?? "", "LOGNAME": env["LOGNAME"] ?? ""]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    p.standardInput = FileHandle.nullDevice
    try p.run()
    let deadline = Date().addingTimeInterval(180)
    while p.isRunning, Date() < deadline { usleep(200_000) }
    if p.isRunning { p.terminate() }
    return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
  }

  @Test(.enabled(if: enabled))
  func theSessionNamesAllThreeCodewordsOnlyWithTheAppsText() throws {
    let root = try TestTemp.real(TestTemp.base) + "/talos-instr-probe-\(UUID().uuidString.prefix(8))"
    defer {
      try? FileManager.default.removeItem(atPath: root)
      // what claude keeps for the test's folders (by the git root and by the folder), never anything else
      let projects = NSHomeDirectory() + "/.claude/projects"
      let mark = (root as NSString).lastPathComponent
      for d in (try? FileManager.default.contentsOfDirectory(atPath: projects)) ?? [] where d.contains(mark) && mark.hasPrefix("talos-instr-probe-") {
        try? FileManager.default.removeItem(atPath: projects + "/" + d)
      }
    }
    let parent = root + "/parent", child = parent + "/child", agent = root + "/agent", talos = root + "/talos"
    for d in [parent + "/.git", child, agent, talos] { try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
    try "Codeword: \(Self.words[0])\n".write(toFile: parent + "/AGENTS.md", atomically: true, encoding: .utf8)
    try "Codeword: \(Self.words[1])\n".write(toFile: child + "/AGENTS.md", atomically: true, encoding: .utf8)
    try "Codeword: \(Self.words[2])\n".write(toFile: child + "/CLAUDE.md", atomically: true, encoding: .utf8)
    // the spec's home is the test root, so the parent counts as a folder above the thread's (the real claude runs with the real
    // home, for its sign-in)
    func buildSpec() throws -> WorkerSpec {
      try WorkerSpec.build(.init(
        threadId: "probe", claudePath: Self.claude!, baseEnv: ["HOME": root, "PATH": "/usr/bin:/bin"], talosHome: talos,
        agentDir: agent, permissionHook: .init(script: talos + "/workers/_hook/permission-relay.py", python: "/usr/bin/python3"), cwd: child,
        sessionId: UUID().uuidString.lowercased(), resume: false, nonce: "probe-nonce-0123456789"))
    }
    let spec = try buildSpec()
    let sources = try #require(MainArgs.lastValue(spec.args, "--setting-sources"))
    #expect(sources == "user")
    // CONTROL: what a thread session got before the fix
    let before = try ask(["--setting-sources", sources], cwd: child)
    #expect(!before.isEmpty, "claude answered nothing: is it signed in?")
    for w in Self.words { #expect(!before.contains(w), "\(w) reached the session without the app's text: \(before)") }
    // with the app's text
    let text = try #require(MainArgs.lastValue(spec.args, "--append-system-prompt"))
    let after = try ask(["--setting-sources", sources, "--append-system-prompt", text], cwd: child)
    for w in Self.words { #expect(after.contains(w), "\(w) is missing: \(after)") }

    // B1: an edited AGENTS.md reaches a resumed conversation, since the prompt snapshot is off
    #expect(spec.args.contains(WorkerSpec.snapshotOff))
    let sid = UUID().uuidString.lowercased(), control = UUID().uuidString.lowercased()
    _ = try ask(["--setting-sources", sources, WorkerSpec.snapshotOff, "--append-system-prompt", text, "--session-id", sid], cwd: child, keep: true)
    _ = try ask(["--setting-sources", sources, "--append-system-prompt", text, "--session-id", control], cwd: child, keep: true)
    try "Codeword: CHILD-DELTA-5150\n".write(toFile: child + "/AGENTS.md", atomically: true, encoding: .utf8)
    let edited = try #require(MainArgs.lastValue(try buildSpec().args, "--append-system-prompt"))
    // CONTROL (R1-10): with the snapshot on, as by default, the resumed conversation still has the first text
    let replayed = try ask(["--setting-sources", sources, "--append-system-prompt", edited, "--resume", control], cwd: child, keep: true)
    #expect(!replayed.contains("CHILD-DELTA-5150") && replayed.contains(Self.words[1]), "the snapshot did not replay the first text: \(replayed)")
    let resumed = try ask(["--setting-sources", sources, WorkerSpec.snapshotOff, "--append-system-prompt", edited, "--resume", sid], cwd: child, keep: true)
    #expect(resumed.contains("CHILD-DELTA-5150"), "the edited file did not reach the resumed conversation: \(resumed)")
  }
}
