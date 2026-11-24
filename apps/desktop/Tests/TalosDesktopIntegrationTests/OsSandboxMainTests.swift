import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// Main's real launch (the real supervisor, a real pty, the fake claude logging its argv) with the OS sandbox switch ("Extra lock on
/// protected files", config.json `os_sandbox`): the one `--settings` carries the sandbox, a start whose protected file has another name does
/// not happen, and turning the switch off takes the file lock off. The home is the rig's own throwaway folder.
private func sandboxRig(on: Bool) throws -> Rig {
  let r = try Rig(.direct, scenario: "idle.sh") { c in
    c.args = ["--dangerously-skip-permissions"]
    c.talosAppCommand = [Rig.fixtures + "/talos-app"]
    c.notifyThread = "general"  // the post's thread is named here: config.json is the file the test breaks
  }
  try setSwitch(r, on)
  for n in ["devices.json", "secret-backend"] { try Data("x".utf8).write(to: URL(fileURLWithPath: r.talosHome + "/" + n)) }
  return r
}

private func setSwitch(_ r: Rig, _ on: Bool) throws {
  try Data(#"{"agent":{"name":"Testagent"},"default_thread":"general","os_sandbox":\#(on)}"#.utf8).write(to: URL(fileURLWithPath: r.talosHome + "/config.json"))
}

private func finish(_ r: Rig) { r.teardown() }

@Suite("Main's launch with the OS sandbox switch", .serialized)
struct OsSandboxMainTests {
  @Test func switchOnTheOneSettingsTextCarriesTheSandboxAnd() throws {
    let r = try sandboxRig(on: true)
    defer { finish(r) }
    r.start()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) && r.starts.count == 1 }, "\(r.phase()), \(r.audit)")
    let start = try #require(r.starts.last)
    let text = try #require(start.components(separatedBy: "--settings ").dropFirst().first?.components(separatedBy: " --dangerously-skip-permissions").first)
    let settings = try #require(SettingsJSON.object(Data(text.utf8)))
    let sb = try #require(settings["sandbox"] as? [String: Any])
    #expect(sb["enabled"] as? Bool == true && sb["failIfUnavailable"] as? Bool == true && sb["allowUnsandboxedCommands"] as? Bool == false)
    let deny = try #require((sb["filesystem"] as? [String: Any])?["denyWrite"] as? [String])
    #expect(deny.contains(r.talosHome + "/config.json"), "\(deny.prefix(4))")
    #expect((settings["env"] as? [String: String])?["GIT_CONFIG_VALUE_0"] == r.talosHome + "/sandbox/gitignore")
    #expect(FileManager.default.fileExists(atPath: r.talosHome + "/sandbox/gitignore"))
    #expect(sb["allowAppleEvents"] as? Bool == false && sb["enableWeakerNetworkIsolation"] as? Bool == false)
  }

  @Test func aProtectedFileWithAnotherNameStopsTheStartAndTheOwnerIsToldWhy() throws {
    let r = try sandboxRig(on: true)
    defer { finish(r) }
    let other = r.root + "/elsewhere"
    try FileManager.default.createDirectory(atPath: other, withIntermediateDirectories: true)
    #expect(Darwin.link(r.talosHome + "/devices.json", other + "/sneaky") == 0)
    r.start()
    let line = "devices.json has another name on this disk (a hard link); remove the other link, then start again"
    #expect(r.wait(10) { r.sup.tickNow(); return stopReason(r.phase()) == .startFailed(line) }, "\(r.phase())")
    #expect(r.starts.isEmpty, "nothing starts without the lock that was asked for: \(r.starts)")
    #expect(r.audit.contains("os_sandbox_refused"))
    // the same start with the switch off: no refusal, and no sandbox in the settings (the way it was before the switch existed)
    try setSwitch(r, false)
    r.sup.restartCold()
    #expect(r.wait(15) { r.sup.tickNow(); return isRunning(r.phase()) && r.starts.count == 1 }, "\(r.phase())")
    #expect(try #require(r.starts.last).contains("sandbox") == false)
  }

  /// A config.json nobody can read keeps what the last good reading said: with the lock on then, it stays on, the audit log has it and the owner gets
  /// one notice. Run twice in one process on purpose: the notice is once per Talos home, so a second app run (or an earlier test that also found an
  /// unreadable file) never uses it up for this home. (It failed on a CI runner where another test had gone first.)
  @Test(arguments: [1, 2]) func aConfigFileThatCannotBeParsedKeepsALockThatWasOnWithOneNotice(run: Int) throws {
    let r = try sandboxRig(on: true)
    defer { finish(r) }
    r.start()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) && r.starts.count == 1 }, "\(r.phase()), \(r.audit)")
    #expect(r.phonePosts.allSatisfy { !$0.contains("the extra lock stays on") }, "a good file says nothing")
    try Data("{ this is not json".utf8).write(to: URL(fileURLWithPath: r.talosHome + "/config.json"))
    r.sup.restartCold()
    #expect(r.wait(15) { r.sup.tickNow(); return isRunning(r.phase()) && r.starts.count == 2 }, "\(r.phase()), \(r.audit)")
    let start = try #require(r.starts.last)
    #expect(start.contains("\"failIfUnavailable\":true"), "the sandbox is in the settings: \(start)")
    #expect(r.audit.contains("os_sandbox_config_unreadable") && r.audit.contains("kept on"), "\(r.audit)")
    #expect(r.wait(10) { r.phonePosts.contains { $0.contains("the extra lock stays on") } }, "run \(run): \(r.posts)")
    // a third start of the same run finds the file unreadable again and says nothing more
    r.sup.restartCold()
    #expect(r.wait(15) { r.sup.tickNow(); return isRunning(r.phase()) && r.starts.count == 3 }, "\(r.phase())")
    #expect(r.phonePosts.filter { $0.contains("the extra lock stays on") }.count == 1, "\(r.phonePosts)")
  }

  /// The notice is posted only when this start really carries the lock: a launch that already names its own `--settings` goes ahead without the
  /// lock (and says so), and a start the preflight refuses does not happen, so neither may tell the owner "the extra lock stays on".
  @Test func aKeptOnLockIsNotAnnouncedWhenTheStartDoesNotCarryIt() throws {
    let own = try Rig(.direct, scenario: "idle.sh") { c in
      c.args = ["--settings", "/home/alex/own.json", "--dangerously-skip-permissions"]
      c.talosAppCommand = [Rig.fixtures + "/talos-app"]
      c.notifyThread = "general"
    }
    defer { finish(own) }
    try setSwitch(own, true)
    own.start()
    #expect(own.wait(10) { own.sup.tickNow(); return isRunning(own.phase()) && own.starts.count == 1 }, "\(own.phase()), \(own.audit)")
    try Data("{ this is not json".utf8).write(to: URL(fileURLWithPath: own.talosHome + "/config.json"))
    own.sup.restartCold()
    #expect(own.wait(15) { own.sup.tickNow(); return isRunning(own.phase()) && own.starts.count == 2 }, "\(own.phase()), \(own.audit)")
    #expect(own.audit.contains("kept on"), "\(own.audit)")
    Thread.sleep(forTimeInterval: 1)
    #expect(own.phonePosts.allSatisfy { !$0.contains("the extra lock stays on") }, "a launch without the lock does not say it stays on: \(own.phonePosts)")

    let refused = try sandboxRig(on: true)
    defer { finish(refused) }
    refused.start()
    #expect(refused.wait(10) { refused.sup.tickNow(); return isRunning(refused.phase()) && refused.starts.count == 1 }, "\(refused.phase()), \(refused.audit)")
    try Data("{ this is not json".utf8).write(to: URL(fileURLWithPath: refused.talosHome + "/config.json"))
    let other = refused.root + "/elsewhere"
    try FileManager.default.createDirectory(atPath: other, withIntermediateDirectories: true)
    #expect(Darwin.link(refused.talosHome + "/devices.json", other + "/sneaky") == 0)
    refused.sup.restartCold()
    let line = "devices.json has another name on this disk (a hard link); remove the other link, then start again"
    #expect(refused.wait(15) { refused.sup.tickNow(); return stopReason(refused.phase()) == .startFailed(line) }, "\(refused.phase())")
    Thread.sleep(forTimeInterval: 1)
    #expect(refused.phonePosts.allSatisfy { !$0.contains("the extra lock stays on") }, "a refused start does not say it: \(refused.phonePosts)")
  }

  /// A lock nobody ever switched on is not turned on by a damaged file, and the owner is told nothing about a lock he never asked for.
  @Test func aConfigFileThatCannotBeParsedLeavesALockThatWasNeverOnOffAndSaysNothingAboutIt() throws {
    let r = try sandboxRig(on: true)
    defer { finish(r) }
    try Data("{ this is not json".utf8).write(to: URL(fileURLWithPath: r.talosHome + "/config.json"))
    r.start()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) && r.starts.count == 1 }, "\(r.phase()), \(r.audit)")
    let start = try #require(r.starts.last)
    #expect(!start.contains("sandbox"), "no sandbox in the settings: \(start)")
    #expect(r.audit.contains("os_sandbox_config_unreadable") && r.audit.contains("kept off"), "the audit log has it: \(r.audit)")
    Thread.sleep(forTimeInterval: 1)
    #expect(r.phonePosts.allSatisfy { !$0.contains("extra lock") }, "\(r.phonePosts)")
  }

  @Test func theUnreadableNoticeIsOnceForEachTalosHome() {
    #expect(OsSandboxLaunch.firstUnreadable(talosHome: "/home/alex/a"))
    #expect(!OsSandboxLaunch.firstUnreadable(talosHome: "/home/alex/a"))
    #expect(OsSandboxLaunch.firstUnreadable(talosHome: "/home/alex/b"))
  }

  /// The check runs once more as the last step before the process starts: a second name made for a protected file after the first check (here
  /// between the settings being written and the spawn) refuses the start and nothing runs.
  @Test func aLinkMadeAfterTheFirstCheckStillStopsTheStartAtTheSpawn() throws {
    let r = try sandboxRig(on: true)
    defer { finish(r) }
    let other = r.root + "/elsewhere"
    try FileManager.default.createDirectory(atPath: other, withIntermediateDirectories: true)
    // the link appears while the first check has passed: made from the supervisor's own seam right after the settings are built
    OsSandboxLaunch.setAfterFirstCheck(home: r.talosHome) { _ = Darwin.link(r.talosHome + "/devices.json", other + "/sneaky") }
    defer { OsSandboxLaunch.setAfterFirstCheck(home: r.talosHome, nil) }
    r.start()
    let line = "devices.json has another name on this disk (a hard link); remove the other link, then start again"
    #expect(r.wait(10) { r.sup.tickNow(); return stopReason(r.phase()) == .startFailed(line) }, "\(r.phase())")
    #expect(r.starts.isEmpty, "\(r.starts)")
  }

  /// A flag an earlier build left on one of its three files is cleared at the start, whatever the switch says.
  @Test func anOldFlagIsClearedAtTheNextStart() throws {
    let r = try sandboxRig(on: false)
    defer { finish(r) }
    let f = r.talosHome + "/secret-backend"
    #expect(lchflags(f, UInt32(UF_IMMUTABLE)) == 0)
    r.start()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) && r.starts.count == 1 }, "\(r.phase())")
    var st = stat()
    lstat(f, &st)
    #expect(st.st_flags & UInt32(UF_IMMUTABLE) == 0)
  }
}
