import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// A thread session's own live state file, through the real manager and a real tmux (the real entry point: a wake): the start seeds
/// `<agent>/threads/<id>.state.md`, stages the thread-state hook from the app bundle's sealed copy, registers it in the settings it
/// writes, and sets the flag the kit's other hooks read. The command the settings hold is then run as Claude Code runs it, against the
/// real kit hook, and puts the thread's own state in front of the session.
@Suite("Worker starts and the thread's live state file", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerStateStartTests {
  func auditLines(_ r: WorkerRig) -> [String] {
    ((try? String(contentsOfFile: r.root + "/audit.log", encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
  }

  func rig(hook: WorkerHook.BundleSource? = Rig.hookSource) throws -> WorkerRig {
    let r = try WorkerRig(threads: ["trip"], maxLive: 3)
    r.hookSource = hook
    r.makeManager()
    r.mgr.tune { $0.auditLogPath = r.root + "/audit.log" }
    return r
  }

  func settings(_ r: WorkerRig) throws -> [String: Any] {
    let text = try String(contentsOfFile: WorkerSpec.settingsPath(talosHome: r.talosHome, threadId: "trip"), encoding: .utf8)
    return try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
  }

  func commands(_ json: [String: Any], _ event: String) -> [String] {
    ((json["hooks"] as? [String: Any])?[event] as? [[String: Any]] ?? []).flatMap { ($0["hooks"] as? [[String: Any]] ?? []).compactMap { $0["command"] as? String } }
  }

  @Test func aStartSeedsTheStateFileStagesAndRegistersTheHookAndSetsTheFlag() throws {
    let r = try rig()
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let file = r.agentDir + "/threads/trip.state.md"
    #expect(try String(contentsOfFile: file, encoding: .utf8) == ThreadStateSeed.template(id: "trip", name: "trip"), "seeded with the thread's name")
    let hookDir = r.talosHome + "/workers/_hook"
    for n in WorkerHook.stateFileNames {
      #expect(FileManager.default.contentsEqual(atPath: hookDir + "/" + n, andPath: Rig.hookBundle.stateFile(n)), "\(n) is the bundle's")
    }
    let json = try settings(r)
    let inject = try #require(commands(json, "SessionStart").first)
    #expect(inject.hasPrefix("f='\(hookDir)/thread-state.py'; ") && inject.contains(" inject '\(r.agentDir)' "))
    #expect(commands(json, "PreCompact").first?.contains(" save '\(r.agentDir)' ") == true)
    let allow = (json["permissions"] as? [String: Any])?["allow"] as? [String] ?? []
    #expect(allow.contains("Edit(/\(r.agentDir)/threads/trip.state.md)") && allow.contains("Write(/\(r.agentDir)/threads/trip.state.md)"))
    // the flag is in the environment the worker process really got (the fake claude writes it down)
    #expect(r.lines(r.envLog + ".trip").contains("TALOS_APP_THREAD_STATE=1"), "\(r.lines(r.envLog + ".trip"))")
    #expect(!auditLines(r).contains { $0.contains("worker_state_seed_failed") })
  }

  /// The hook the settings name, run exactly as they say with the real interpreter the start resolved: the thread's state reaches it.
  @Test func theCommandTheSettingsHoldPutsTheThreadsOwnStateInFrontOfTheSession() throws {
    let r = try rig()
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    try "# trip live state\nOWNER-ASK-MARKER\n".write(toFile: r.agentDir + "/threads/trip.state.md", atomically: true, encoding: .utf8)
    let cmd = try #require(commands(try settings(r), "SessionStart").first)
    let ran = ProcessRunner.run(["/bin/sh", "-c", cmd], env: ["PATH": "/usr/bin:/bin", "TALOS_SESSION_ROLE": "main"], timeout: 30)
    #expect(ran.ok, "\(ran.status) err=\(ran.err)")
    #expect(ran.out.contains("OWNER-ASK-MARKER"), "out=\(ran.out)")
  }

  @Test func aStartNeverOverwritesAnExistingStateFile() throws {
    let r = try rig()
    defer { r.teardown() }
    try FileManager.default.createDirectory(atPath: r.agentDir + "/threads", withIntermediateDirectories: true)
    try "kept\n".write(toFile: r.agentDir + "/threads/trip.state.md", atomically: true, encoding: .utf8)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(try String(contentsOfFile: r.agentDir + "/threads/trip.state.md", encoding: .utf8) == "kept\n")
  }

  /// Silent failure: a seed that cannot be made is in the audit log, and the session still starts.
  @Test func aSeedThatCannotBeMadeIsAuditedAndNeverStopsTheStart() throws {
    let r = try rig()
    defer { r.teardown() }
    let elsewhere = r.root + "/elsewhere"
    try FileManager.default.createDirectory(atPath: elsewhere, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: r.agentDir + "/threads", withDestinationPath: elsewhere)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(auditLines(r).contains { $0.contains("worker_state_seed_failed thread=trip") }, "\(auditLines(r))")
    #expect(!FileManager.default.fileExists(atPath: elsewhere + "/trip.state.md"), "nothing written through the link")
  }

  /// A bundle built without the state files: the session runs as before (no hook, no allow rule, no flag), and is told nothing is wrong.
  @Test func aBundleWithoutTheStateFilesStartsAPlainSession() throws {
    let base = r_tmp()
    defer { try? FileManager.default.removeItem(atPath: base) }
    let kit = (Rig.kitHook as NSString).deletingLastPathComponent
    let bundle = try FakeAppBundle(
      in: base, script: FileManager.default.contents(atPath: Rig.kitHook)!, helper: FileManager.default.contents(atPath: kit + "/_talos_common.py"))
    let r = try rig(hook: .init(script: bundle.script, bundlePath: bundle.path, seal: { _ in nil }))
    defer { r.teardown() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let json = try settings(r)
    #expect(commands(json, "SessionStart").isEmpty && commands(json, "PreCompact").isEmpty)
    #expect(((json["permissions"] as? [String: Any])?["allow"]) == nil)
    let env = r.lines(r.envLog + ".trip")
    #expect(!env.isEmpty, "control: the worker's environment was recorded")
    #expect(!env.contains { $0.hasPrefix("TALOS_APP_THREAD_STATE") })
  }

  private func r_tmp() -> String {
    let p = (TestTemp.base as NSString).appendingPathComponent("talos-nostate-\(UUID().uuidString.prefix(8))")
    try? FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true)
    return (try? TestTemp.real(p)) ?? p
  }
}
