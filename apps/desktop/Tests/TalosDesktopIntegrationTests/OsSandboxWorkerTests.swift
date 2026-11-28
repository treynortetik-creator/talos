import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// A thread session's real start (the real manager, a real tmux, the fake claude) with the OS sandbox switch ("Extra lock on protected
/// files"): the session's settings carry the sandbox the supervisor built, a start whose protected file has another name does not happen and
/// the thread's error says why, and a start with the switch off is as it was.
@Suite("A thread session's start with the OS sandbox switch", .serialized, .enabled(if: Rig.hasTmux))
struct OsSandboxWorkerTests {
  func rig(on: Bool) throws -> WorkerRig {
    let r = try WorkerRig()
    try setSwitch(r, on)
    try Data("{}".utf8).write(to: URL(fileURLWithPath: r.talosHome + "/devices.json"))
    return r
  }

  func setSwitch(_ r: WorkerRig, _ on: Bool) throws {
    try """
    {"default_thread":"general","os_sandbox":\(on),"dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},{"id":"trip","name":"trip","kind":"fixed","session":"dedicated"}]}
    """.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
  }

  func settings(_ r: WorkerRig) throws -> [String: Any] {
    let d = try #require(FileManager.default.contents(atPath: WorkerSpec.settingsPath(talosHome: r.talosHome, threadId: "trip")))
    return try #require(SettingsJSON.object(d))
  }

  func finish(_ r: WorkerRig) { r.teardown() }

  @Test func switchOnTheStartedSessionsSettingsCarryTheSandbox() throws {
    let r = try rig(on: true)
    defer { finish(r) }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" }, "\(r.why("trip"))")
    let s = try settings(r)
    let sb = try #require(s["sandbox"] as? [String: Any])
    #expect(sb["failIfUnavailable"] as? Bool == true && sb["allowUnsandboxedCommands"] as? Bool == false)
    let deny = try #require((sb["filesystem"] as? [String: Any])?["denyWrite"] as? [String])
    #expect(deny.contains(r.talosHome + "/config.json") && deny.contains(r.talosHome + "/workers"), "\(deny.prefix(3))")
    #expect((s["env"] as? [String: String])?["GIT_CONFIG_VALUE_0"] == r.talosHome + "/sandbox/gitignore")
    #expect(FileManager.default.fileExists(atPath: r.talosHome + "/sandbox/gitignore"))
  }

  @Test func switchOffTheStartedSessionsSettingsAreAsTheyWereBeforeTheSwitchExisted() throws {
    let r = try rig(on: false)
    defer { finish(r) }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" }, "\(r.why("trip"))")
    let s = try settings(r)
    #expect(s["sandbox"] == nil)
    #expect((s["env"] as? [String: Any])?["GIT_CONFIG_COUNT"] == nil)
    #expect(!FileManager.default.fileExists(atPath: r.talosHome + "/sandbox"))
  }

  @Test func aProtectedFileWithAnotherNameRefusesTheStartAndTheThreadSaysWhy() throws {
    let r = try rig(on: true)
    defer { finish(r) }
    let other = r.root + "/elsewhere"
    try FileManager.default.createDirectory(atPath: other, withIntermediateDirectories: true)
    #expect(Darwin.link(r.talosHome + "/devices.json", other + "/sneaky") == 0)
    r.mgr.startTicking()
    try r.wake("trip")
    let line = "devices.json has another name on this disk (a hard link); remove the other link, then start again"
    #expect(r.wait(10) { (r.entry("trip")?.error?.detail ?? "").contains(line) }, "\(r.why("trip"))")
    #expect(r.starts.isEmpty, "no session starts without the lock that was asked for: \(r.starts)")
    #expect(r.state("trip") != "live")
  }

  @Test func aLinkMadeAfterTheFirstCheckStillRefusesTheStartAtTheSpawn() throws {
    let r = try rig(on: true)
    defer { finish(r) }
    let other = r.root + "/elsewhere"
    try FileManager.default.createDirectory(atPath: other, withIntermediateDirectories: true)
    OsSandboxLaunch.setAfterFirstCheck(home: r.talosHome) { _ = Darwin.link(r.talosHome + "/devices.json", other + "/sneaky") }
    defer { OsSandboxLaunch.setAfterFirstCheck(home: r.talosHome, nil) }
    r.mgr.startTicking()
    try r.wake("trip")
    let line = "devices.json has another name on this disk (a hard link); remove the other link, then start again"
    #expect(r.wait(10) { (r.entry("trip")?.error?.detail ?? "").contains(line) }, "\(r.why("trip"))")
    #expect(r.starts.isEmpty, "no session starts: \(r.starts)")
  }

  /// The record a `talos-app` server entry is compared with: the pins in the installed guards' hook and the bun from the fixed list, by real path;
  /// nothing from the agent folder; none when the guards are not installed, and none when either sits where a session can write.
  @Test func theRecordedBridgeComesFromTheGuardsHookAndTheFixedBunList() throws {
    let r = try rig(on: false)
    defer { finish(r) }
    let home = r.root + "/home"
    func put(_ cli: String, bun: String) throws {
      try FileManager.default.createDirectory(atPath: r.talosHome + "/guards", withIntermediateDirectories: true)
      let cmd = "\"\(bun)\" \"\(cli)\" guard-hook --config /x"
      let s: [String: Any] = ["hooks": ["PreToolUse": [["hooks": [["type": "command", "command": cmd]]]]]]
      try JSONSerialization.data(withJSONObject: s).write(to: URL(fileURLWithPath: r.talosHome + "/guards/settings.json"))
    }
    let bunPath = home + "/.bun/bin/bun"
    try FileManager.default.createDirectory(atPath: home + "/.bun/bin", withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: bunPath, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
    let cli = r.root + "/clone/apps/bridge/src/cli.ts"
    try FileManager.default.createDirectory(atPath: r.root + "/clone/apps/bridge/src", withIntermediateDirectories: true)
    try Data("1".utf8).write(to: URL(fileURLWithPath: cli))
    // no guards installed: no record
    #expect(OsSandboxLaunch.recordedBridge(talosHome: r.talosHome, home: home, tmpRoots: []) == nil)
    try put(cli, bun: bunPath)
    let got = OsSandboxLaunch.recordedBridge(talosHome: r.talosHome, home: home, tmpRoots: [])
    // the bun is the first executable of the fixed list (this Mac's own may come before the test's), by real path
    let first = (GuardsRefresh.bunCandidates(home: home) + [bunPath]).compactMap { Supervisor.realPath($0) }.first { FileManager.default.isExecutableFile(atPath: $0) }
    #expect(got?.bun == first && got?.bridgeDir == Supervisor.realPath(r.root + "/clone/apps/bridge"), "\(String(describing: got))")
    #expect(got?.bunInTemp == false, "not in a temp folder here")
    // every other executable bun of the list is kept (a second bun is fenced and denied too)
    let all = (GuardsRefresh.bunCandidates(home: home) + [bunPath]).compactMap { Supervisor.realPath($0) }.filter { FileManager.default.isExecutableFile(atPath: $0) }
    #expect(Set(([got?.bun ?? ""] + (got?.extraBuns ?? []))) == Set(all), "\(String(describing: got))")
    // a clone in a folder a session works in still gets the record (the clone fence needs it); under a temp root or the Talos home: no record
    #expect(OsSandboxLaunch.recordedBridge(talosHome: r.talosHome, home: home, tmpRoots: [Supervisor.realPath(r.root) ?? r.root]) == nil)
    let inHome = r.talosHome + "/clone/apps/bridge/src/cli.ts"
    try FileManager.default.createDirectory(atPath: r.talosHome + "/clone/apps/bridge/src", withIntermediateDirectories: true)
    try Data("1".utf8).write(to: URL(fileURLWithPath: inHome))
    try put(inHome, bun: bunPath)
    #expect(OsSandboxLaunch.recordedBridge(talosHome: r.talosHome, home: home, tmpRoots: []) == nil, "a clone inside the Talos home: no record")
    // a bun in a temp folder keeps the record, marked
    try put(cli, bun: bunPath)
    let marked = OsSandboxLaunch.recordedBridge(talosHome: r.talosHome, home: home, tmpRoots: [Supervisor.realPath(home) ?? home])
    #expect(marked != nil && marked?.bunInTemp == true || first.map { !($0.hasPrefix(Supervisor.realPath(home) ?? home)) } == true, "\(String(describing: marked))")
  }
}
