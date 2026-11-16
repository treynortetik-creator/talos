import Foundation
import TalosTestSupport
import Testing
@testable import TalosDesktopCore

/// Claude Code's own computer use is off for Main and for every thread session, list or no list (Talos's screen tools replace
/// it). Main gets it through its one `--settings`, merged with the guards when they are installed.
@Suite("Claude Code's computer use is denied to every Talos session")
struct ComputerUseDeniedTests {
  let home = "/home/alex/.talos"
  var guardsFile: String { GuardsSettings.path(talosHome: home) }

  func denied(_ json: [String: Any]) -> [String] {
    (json["deniedMcpServers"] as? [[String: Any]] ?? []).compactMap { $0["serverName"] as? String }
  }

  @Test func withoutGuardsMainGetsTheDenyAsSettingsText() throws {
    let r = GuardsSettings.applyingToMain(
      to: ["--channels", "plugin:talos-app@x"], talosHome: home, read: { _ in nil }, write: { _, _ in Issue.record("no write") })
    #expect(r.warnings.isEmpty)
    #expect(Array(r.args.suffix(2)) == ["--channels", "plugin:talos-app@x"], "the owner's args keep their order, last")
    #expect(r.args.count == 4 && r.args[0] == "--settings")
    let obj = try #require(SettingsJSON.object(Data(r.args[1].utf8)))
    #expect(denied(obj) == ["computer-use"])
    #expect(obj.count == 1)
  }

  @Test func withGuardsTheMergedFileSitsBesideThemAndKeepsEverything() throws {
    let guards = #"{"hooks":{"PreToolUse":[]},"permissions":{"deny":["Edit(/x)"]},"deniedMcpServers":[{"serverName":"other"}]}"#
    var wrote: (Data, String)?
    let r = GuardsSettings.applyingToMain(
      to: ["--model", "opus"], talosHome: home, read: { $0 == guardsFile ? Data(guards.utf8) : nil }, write: { wrote = ($0, $1) })
    #expect(r.warnings.isEmpty)
    #expect(r.args == ["--settings", GuardsSettings.mainLaunchPath(talosHome: home), "--model", "opus"])
    let (data, path) = try #require(wrote)
    #expect(path == home + "/guards/main-launch.json")
    let obj = try #require(SettingsJSON.object(data))
    #expect(denied(obj) == ["other", "computer-use"])
    #expect((obj["permissions"] as? [String: Any])?["deny"] as? [String] == ["Edit(/x)"])
    #expect(obj["hooks"] != nil)
    // already denied there: not twice
    var again: Data?
    _ = GuardsSettings.applyingToMain(
      to: [], talosHome: home, read: { _ in Data(#"{"deniedMcpServers":[{"serverName":"computer-use"}]}"#.utf8) },
      write: { d, _ in again = d })
    let againData = try #require(again)
    #expect(denied(try #require(SettingsJSON.object(againData))) == ["computer-use"])
  }

  /// R2-4: the owner's own --settings stays where it is (a copy would change what its relative paths mean and stop later edits
  /// reaching Main). The deny goes in as a permission rule on the command line, which Claude Code adds to every settings source.
  @Test func theOwnersSettingsStayInPlaceAndTheDenyIsADisallowedTool() throws {
    let rule = ["--disallowedTools", "mcp__computer-use"]
    let own = GuardsSettings.applyingToMain(
      to: ["--resume=abc", "--settings", "conf/mine.json", "--", "hi"], talosHome: home,
      read: { p in p == guardsFile ? nil : { Issue.record("read \(p)"); return nil }() }, write: { _, p in Issue.record("wrote \(p)") })
    #expect(own.warnings.isEmpty)
    #expect(own.args == ["--resume=abc"] + rule + ["--settings", "conf/mine.json", "--", "hi"], "the rule sits right before their --settings")
    let inline = GuardsSettings.applyingToMain(to: [#"--settings={"model":"x"}"#], talosHome: home, read: { _ in nil }, write: { _, _ in Issue.record("write") })
    #expect(inline.args == rule + [#"--settings={"model":"x"}"#] && inline.warnings.isEmpty)
    // a file Talos cannot read is no miss any more: the rule does not depend on it
    let gone = GuardsSettings.applyingToMain(to: ["--settings", "/home/alex/gone.json"], talosHome: home, read: { _ in nil })
    #expect(gone.args == rule + ["--settings", "/home/alex/gone.json"] && gone.warnings.isEmpty)
    // with the guards installed they stay off for this launch, as before, and say so
    let both = GuardsSettings.applyingToMain(to: ["--settings=/home/alex/mine.json"], talosHome: home, read: { _ in Data("{}".utf8) }, write: { _, _ in })
    #expect(both.args == rule + ["--settings=/home/alex/mine.json"])
    #expect(both.warnings.count == 1 && both.warnings[0].contains("the guards are NOT active"))
    #expect(
      GuardsSettings.notDeniedPhoneLine
        == "Talos couldn't add the rule that turns off Claude Code's own computer use to Main's start. If Claude Code asks for screen access, say no; Talos's screen tools work without it.")
  }

  /// R3-4: a --settings after `--` is part of the prompt, not the owner's flag.
  @Test func aSettingsWordAfterTheDoubleDashIsThePrompt() throws {
    let r = GuardsSettings.applyingToMain(to: ["--x", "--", "--settings", "/y.json"], talosHome: home, read: { _ in nil })
    #expect(r.warnings.isEmpty)
    #expect(r.args.first == "--settings" && Array(r.args.suffix(4)) == ["--x", "--", "--settings", "/y.json"])
    #expect(denied(try #require(SettingsJSON.object(Data(r.args[1].utf8)))) == ["computer-use"])
    let before = GuardsSettings.applyingToMain(to: ["--settings", "/a.json", "--", "--settings", "/y.json"], talosHome: home, read: { _ in nil })
    #expect(before.args == ["--disallowedTools", "mcp__computer-use", "--settings", "/a.json", "--", "--settings", "/y.json"])
  }

  @Test func eachMissWithoutTheOwnersSettingsSaysSo() {
    // args ending in a prompt: the flag goes in front, so the prompt stays the prompt
    let prompt = GuardsSettings.applyingToMain(to: ["--resume=abc", "--", "hello"], talosHome: home, read: { _ in nil })
    #expect(prompt.warnings.isEmpty && prompt.args.first == "--settings" && Array(prompt.args.suffix(3)) == ["--resume=abc", "--", "hello"])
    // the guards cannot be read: they still go in, as before, and the miss is said
    let broken = GuardsSettings.applyingToMain(to: [], talosHome: home, read: { _ in Data("not json".utf8) })
    #expect(broken.args == ["--settings", guardsFile] && broken.warnings == ["the guards' file cannot be read: Claude Code's own computer use is NOT turned off for main"])
    // the merged file cannot be written: the guards' own file goes in
    let unwritable = GuardsSettings.applyingToMain(
      to: [], talosHome: home, read: { _ in Data("{}".utf8) }, write: { _, _ in throw POSIXError(.EACCES) })
    #expect(unwritable.args == ["--settings", guardsFile] && unwritable.warnings.count == 1)
  }

  @Test func aHandOpenedThreadSessionHasItDeniedToo() throws {
    var f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-01T00:00:00Z", workers_supported: true, main_pane_pid: 2))
    var e = WorkersFile.Entry(threadId: "q", cwd: "/home/alex/proj-q")
    e.state = "failed"
    e.error = .init(code: "needs_mac", detail: "trust", at: "2026-11-01T00:00:00Z")
    f.threads["q"] = e
    let row = try #require(ThreadSessions.rows(from: f).first)
    let inv = try #require(ThreadSessions.claudeInvocation(for: row, claudePath: "/usr/local/bin/claude", talosHome: home))
    let obj = try #require(SettingsJSON.object(Data((inv.args.last ?? "").utf8)))
    #expect(denied(obj).contains("computer-use"))
  }

  @Test func theRealWriterMakesAPrivateFile() throws {
    let dir = TestTemp.base + "cu-\(UUID().uuidString)"
    defer { try? FileManager.default.removeItem(atPath: dir) }
    try FileManager.default.createDirectory(atPath: dir + "/guards", withIntermediateDirectories: true)
    try Data(#"{"permissions":{"deny":["Bash(x)"]}}"#.utf8).write(to: URL(fileURLWithPath: GuardsSettings.path(talosHome: dir)))
    let r = GuardsSettings.applyingToMain(to: [], talosHome: dir)
    #expect(r.warnings.isEmpty && r.args == ["--settings", GuardsSettings.mainLaunchPath(talosHome: dir)])
    var st = stat()
    #expect(stat(GuardsSettings.mainLaunchPath(talosHome: dir), &st) == 0 && (st.st_mode & 0o777) == 0o600)
    let written = try #require(FileManager.default.contents(atPath: GuardsSettings.mainLaunchPath(talosHome: dir)))
    let obj = try #require(SettingsJSON.object(written))
    #expect(denied(obj) == ["computer-use"])
  }

  @Test func theAlwaysDeniedListIsPartOfTheNeverOpenOne() {
    #expect(WorkerMcp.alwaysDenied == ["computer-use"])
    #expect(Set(WorkerMcp.alwaysDenied).isSubset(of: Set(WorkerMcp.neverOpen)))
  }
}
