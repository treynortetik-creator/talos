import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// The PreToolUse hook a Mac thread session runs, the twin of apps/bridge/src/supervisor/pretool-hook.ts: it leaves one empty record
/// per tool call in <app home>/run/pretool, which the permission hook uses to find the call's tool_use id.
@Suite("WorkerPreTool")
struct WorkerPreToolTests {
  let session = WorkerHook.Session(home: "/home/alex", talosHome: "/home/alex/.talos", threadId: "trip")
  let head = "exec /usr/bin/env -i HOME='/home/alex' PATH=/usr/bin:/bin TALOS_APP_HOME='/home/alex/.talos' /bin/sh -c '"

  func preEntries(_ settings: [String: Any]) -> [[String: Any]] {
    ((settings["hooks"] as? [String: Any])?["PreToolUse"] as? [[String: Any]]) ?? []
  }

  @Test func theSettingsCarryThePreToolUseEntryForEveryTool() throws {
    let merged = WorkerSpec.withPermissionHook([:], hook: testHook, session: session)
    let entries = preEntries(merged)
    #expect(entries.count == 1)
    #expect(entries.first?["matcher"] == nil, "no matcher: every tool")
    let hooks = entries.first?["hooks"] as? [[String: Any]]
    #expect(hooks?.count == 1)
    #expect(hooks?.first?["type"] as? String == "command")
    #expect(hooks?.first?["timeout"] as? Int == 5)
    let cmd = hooks?.first?["command"] as? String ?? ""
    #expect(cmd.hasPrefix(head), "\(cmd.prefix(160))")
    #expect(cmd.hasSuffix("exit 0'"))
    #expect(cmd.contains("/run/pretool"))
    // the permission hook is still there, and is a different entry
    #expect(((merged["hooks"] as? [String: Any])?["PermissionRequest"] as? [Any])?.count == 1)
  }

  @Test func theGuardsPreToolUseHookStaysNextToIt() throws {
    let guards: [String: Any] = ["PreToolUse": [["matcher": "Bash", "hooks": [["type": "command", "command": "guard"]]]]]
    let entries = preEntries(WorkerSpec.withPermissionHook(["hooks": guards], hook: testHook, session: session))
    #expect(entries.count == 2)
    #expect(entries.first?["matcher"] as? String == "Bash", "the guards' entry first, unchanged")
    #expect(entries.last?["matcher"] == nil)
    // a PreToolUse of some other shape is left alone, as the Linux side leaves it
    let odd = WorkerSpec.withPermissionHook(["hooks": ["PreToolUse": "nonsense"]], hook: testHook, session: session)
    #expect((odd["hooks"] as? [String: Any])?["PreToolUse"] as? String == "nonsense")
  }

  @Test func aBuiltSpecsSettingsHaveItAndTheLaunchHashMoves() throws {
    let i = WorkerSpecTests().inputs()
    let json = try WorkerSpec.build(i).settingsJSON
    let settings = (try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]) ?? [:]
    let cmds = preEntries(settings).flatMap { ($0["hooks"] as? [[String: Any]]) ?? [] }.compactMap { $0["command"] as? String }
    #expect(cmds.count == 1 && cmds[0].hasPrefix("exec /usr/bin/env -i HOME='"), "\(cmds)")
    #expect(cmds[0].contains("TALOS_APP_HOME='/home/example/.talos'"))
  }

  /// The generated command, run as Claude Code runs it (through a shell), on a real-shaped PreToolUse input.
  @Test func theCommandLeavesOneRecordInAPrivateFolder() throws {
    let fm = FileManager.default
    let sandbox = try fm.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: fm.temporaryDirectory, create: true)
    defer { try? fm.removeItem(at: sandbox) }
    let app = sandbox.appendingPathComponent("app").path
    let s = WorkerHook.Session(home: sandbox.path, talosHome: app, threadId: "trip")
    let hooks = (WorkerSpec.withPermissionHook([:], hook: testHook, session: s)["hooks"] as? [String: Any])
    let cmd = ((preEntries(["hooks": hooks as Any]).first?["hooks"] as? [[String: Any]])?.first?["command"] as? String) ?? ""
    #expect(!cmd.isEmpty)
    try fm.createDirectory(atPath: app, withIntermediateDirectories: true)
    let input = #"{"session_id":"9a7c1e52-0b3d-4f6a-8c21-5d4e3f2a1b00","cwd":"/home/alex/p","permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"tool_use_id":"toolu_01AAAAAAAAAAAAAAAAAAAAAA"}"# + "\n"
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-c", cmd]
    p.environment = ["PATH": "/usr/bin:/bin"]
    let inPipe = Pipe()
    p.standardInput = inPipe
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try p.run()
    inPipe.fileHandleForWriting.write(Data(input.utf8))
    try inPipe.fileHandleForWriting.close()
    p.waitUntilExit()
    #expect(p.terminationStatus == 0)
    let dir = app + "/run/pretool"
    let attrs = try fm.attributesOfItem(atPath: dir)
    #expect((attrs[.posixPermissions] as? Int) == 0o700)
    let records = try fm.contentsOfDirectory(atPath: dir).filter { !$0.hasPrefix(".") }
    #expect(records.count == 1, "\(records)")
    if let r = records.first {
      #expect(r.contains(".9a7c1e52-0b3d-4f6a-8c21-5d4e3f2a1b00.-.toolu_01AAAAAAAAAAAAAAAAAAAAAA."))
      let a = try fm.attributesOfItem(atPath: dir + "/" + r)
      #expect((a[.size] as? Int) == 0 && (a[.posixPermissions] as? Int) == 0o600)
    }
  }
}
