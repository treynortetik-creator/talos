import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// Main's real launch (the real supervisor, a real pty, the fake claude logging its argv): Claude Code's own computer use is
/// denied through Main's one `--settings`, without the guards and with them.
private func plainRig() throws -> Rig {
  try Rig(.direct, scenario: "idle.sh") { c in
    c.args = ["--dangerously-skip-permissions"]
    c.talosAppCommand = [Rig.fixtures + "/talos-app"]
  }
}

private func startPlain(_ r: Rig) {
  r.start()
  #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) && r.starts.count == 1 }, "\(r.phase()), starts \(r.starts)")
}

@Suite("Main's launch denies Claude Code's computer use", .serialized)
struct MainComputerUseDeniedTests {
  @Test func withoutTheGuardsTheDenyRidesAsSettingsText() throws {
    let r = try plainRig()
    defer { r.teardown() }
    startPlain(r)
    let start = try #require(r.starts.last)
    #expect(start.contains(#"--settings {"deniedMcpServers":[{"serverName":"computer-use"}]}"#), "\(start)")
  }

  @Test func withTheGuardsMainReadsTheMergedFileBesideThem() throws {
    let r = try plainRig()
    defer { r.teardown() }
    try FileManager.default.createDirectory(atPath: r.talosHome + "/guards", withIntermediateDirectories: true)
    try Data(#"{"permissions":{"deny":["Bash(rm:*)"]}}"#.utf8).write(
      to: URL(fileURLWithPath: GuardsSettings.path(talosHome: r.talosHome)))
    startPlain(r)
    let start = try #require(r.starts.last)
    let launch = GuardsSettings.mainLaunchPath(talosHome: r.talosHome)
    #expect(start.contains("--settings \(launch)"), "\(start)")
    let data = try #require(FileManager.default.contents(atPath: launch))
    let obj = try #require(SettingsJSON.object(data))
    #expect((obj["deniedMcpServers"] as? [[String: Any]])?.compactMap { $0["serverName"] as? String } == ["computer-use"])
    #expect((obj["permissions"] as? [String: Any])?["deny"] as? [String] == ["Bash(rm:*)"])
  }
}

/// R1-4 (c): the owner's own --settings at Main's real launch.
@Suite("Main's launch with the owner's own --settings", .serialized)
struct MainOwnSettingsComputerUseTests {
  func withArgs(_ r: Rig, _ extra: [String]) {
    var c = r.sup.currentConfig()
    c.args = ["--dangerously-skip-permissions"] + extra
    r.sup.updateConfig(c)
  }

  @Test func theOwnersFileIsLeftInPlaceAndTheDenyRidesBesideIt() throws {
    let r = try plainRig()
    defer { r.teardown() }
    let mine = r.talosHome + "/mine.json"
    try Data(#"{"model":"opus"}"#.utf8).write(to: URL(fileURLWithPath: mine))
    withArgs(r, ["--settings", mine])
    startPlain(r)
    let start = try #require(r.starts.last)
    #expect(start.contains("--disallowedTools mcp__computer-use --settings \(mine)"), "\(start)")
    #expect(!FileManager.default.fileExists(atPath: GuardsSettings.mainLaunchPath(talosHome: r.talosHome)), "no copy of theirs")
    #expect(r.phonePosts.filter { $0.contains("computer use") }.isEmpty)
  }

  @Test func aMissIsSaidOnThePhoneOnce() throws {
    let r = try plainRig()
    defer { r.teardown() }
    try FileManager.default.createDirectory(atPath: r.talosHome + "/guards", withIntermediateDirectories: true)
    try Data("not json".utf8).write(to: URL(fileURLWithPath: GuardsSettings.path(talosHome: r.talosHome)))
    startPlain(r)
    #expect(r.wait(10) { r.phonePosts.contains { $0.contains("couldn't add the rule that turns off Claude Code's own computer use") } }, "\(r.posts)")
    #expect(r.audit.contains(GuardsSettings.notDenied))
    // a second launch in the same run does not say it again
    r.sup.restartCold()
    #expect(r.wait(15) { r.sup.tickNow(); return r.starts.count >= 2 }, "\(r.starts)")
    #expect(r.phonePosts.filter { $0.contains("computer use") }.count == 1, "\(r.posts)")
  }
}
