import Foundation
import Testing

@testable import TalosDesktopCore
import TalosTestSupport

/// `ConfigFile.read` tells "no desktop.json" (not set up: the defaults) from "a desktop.json this build cannot read" (never the
/// defaults). Every case goes through the real decoder on a real file.
@Suite("desktop.json: missing is not unreadable")
struct ConfigFileReadTests {
  private func scratch() throws -> String {
    let dir = (TestTemp.base as NSString).appendingPathComponent("talos-cfgread-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return dir
  }

  @Test func noFileIsMissing() throws {
    let dir = try scratch()
    defer { try? FileManager.default.removeItem(atPath: dir) }
    #expect(ConfigFile.read(dir + "/desktop.json") == .missing)
    #expect(ConfigFile.read(dir + "/no-such-folder/desktop.json") == .missing)
  }

  @Test func aSavedConfigIsLoadedAsItWasSaved() throws {
    let dir = try scratch()
    defer { try? FileManager.default.removeItem(atPath: dir) }
    var c = DesktopConfig.defaults
    c.agentDir = "/home/alex/agent"
    c.autoRestart = false
    try ConfigFile.save(c, to: dir + "/desktop.json")
    #expect(ConfigFile.read(dir + "/desktop.json") == .loaded(c))
  }

  @Test(arguments: [
    "{ \"agent_dir\": \"/home/alex/agent\", ",  // cut short: not JSON
    "not json at all",
    "{\"agent_dir\": 5}",  // a value of the wrong kind
    "{\"auto_restart\": \"yes\"}",
    "[1, 2, 3]",  // JSON, but not a config
    "",  // an empty file
  ])
  func aFileThatDoesNotDecodeIsUnreadableNeverTheDefaults(text: String) throws {
    let dir = try scratch()
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let path = dir + "/desktop.json"
    try Data(text.utf8).write(to: URL(fileURLWithPath: path))
    #expect(ConfigFile.read(path) == .unreadable)
  }

  /// One unknown value costs that one item, not the file: an older or newer build's file still loads.
  @Test func anUnknownHostOrAnUnknownKeyStillLoads() throws {
    let dir = try scratch()
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let path = dir + "/desktop.json"
    try Data("{\"agent_dir\": \"/home/alex/agent\", \"host\": \"hologram\", \"from_a_newer_build\": {\"x\": 1}}".utf8).write(
      to: URL(fileURLWithPath: path))
    guard case .loaded(let c) = ConfigFile.read(path) else {
      Issue.record("an unknown value made the whole file unreadable")
      return
    }
    #expect(c.agentDir == "/home/alex/agent" && c.host == DesktopConfig.defaults.host)
  }

  @Test func aFolderOrAFileThatMayNotBeReadIsUnreadable() throws {
    let dir = try scratch()
    defer {
      chmod(dir + "/locked.json", 0o600)
      try? FileManager.default.removeItem(atPath: dir)
    }
    try FileManager.default.createDirectory(atPath: dir + "/desktop.json", withIntermediateDirectories: true)
    #expect(ConfigFile.read(dir + "/desktop.json") == .unreadable)
    try ConfigFile.save(.defaults, to: dir + "/locked.json")
    chmod(dir + "/locked.json", 0o000)
    #expect(ConfigFile.read(dir + "/locked.json") == (getuid() == 0 ? .loaded(.defaults) : .unreadable))
    try FileManager.default.createSymbolicLink(atPath: dir + "/dangling.json", withDestinationPath: dir + "/nowhere.json")
    #expect(ConfigFile.read(dir + "/dangling.json") == .unreadable)
  }

  @Test func theNoticeSaysWhatWasNotDoneAndWhatToDo() {
    let t = SupervisorNotice.configUnreadable
    #expect(t.contains("desktop.json") && t.contains("Nothing was started") && t.contains("no setting will be saved"))
    #expect(SupervisorNotice.event(for: t) == .couldNotStart, "it raises a banner")
    for phase in [SupervisorNotice.PhaseKind.running, .starting, .stopped, .other] {
      #expect(!SupervisorNotice.isStale(t, phase: phase, needsYou: false), "it stands for the whole run")
    }
  }

  @Test func thePhoneLinesAreTheirOwnWording() {
    let gaveUp = CrashPost.restartGaveUp(agentName: "Testagent", why: .folderMissing, at: "09:41")
    #expect(gaveUp.hasPrefix("Testagent's session crashed and the Mac could not start it again (its folder is missing)."))
    #expect(CrashPost.restartGaveUp(agentName: nil, why: .channelsHeld, at: "09:41").contains("another session holds its channels"))
    #expect(CrashPost.restartGaveUp(agentName: nil, why: .claudeMissing, at: "09:41").contains("claude was not found"))
    let exiting = CrashPost.cleanExitLoop(at: "09:41")
    #expect(exiting.hasPrefix("Main keeps exiting cleanly") && exiting.contains("Nothing was restored"))
    // neither is the crash-loop line ("stopped restarting at"), which promises a restore
    #expect(!gaveUp.contains("stopped restarting at") && !exiting.contains("stopped restarting at"))
  }

  /// The clean-exit cap is the contract's number (`MAIN_RESTART.clean_exits_per_hour`), read from the contract's own file so the
  /// Mac and the Linux supervisor cannot drift apart. The stop is the contract's `clean_exit_loop`.
  @Test func theCleanExitCapIsTheContractsNumber() throws {
    let here = URL(fileURLWithPath: #filePath)  // apps/desktop/Tests/TalosDesktopCoreTests/<file>
    let repo = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let text = try String(contentsOf: repo.appendingPathComponent("packages/protocol/src/supervisor.ts"), encoding: .utf8)
    let m = try #require(text.firstMatch(of: /clean_exits_per_hour:\s*(\d+)/), "the contract no longer has clean_exits_per_hour")
    #expect(Int(m.1) == MainRestartContract.cleanExitsPerHour)
    #expect(text.contains("'clean_exit_loop'"), "the stop reason's name in the contract")
    let resume = try #require(text.firstMatch(of: /resume_error_within_s:\s*(\d+)/), "the contract no longer has resume_error_within_s")
    #expect(Double(resume.1) == MainRestartContract.resumeErrorWithinS)
    let tries = try #require(text.firstMatch(of: /cannot_launch_tries:\s*(\d+)/), "the contract no longer has cannot_launch_tries")
    #expect(Int(tries.1) == MainRestartContract.cannotLaunchTries)
    #expect(MainRestartContract.cleanExitLoop == "clean_exit_loop")
    // Main's silent-failure watch (MainWatch): the relay out of reach, and a Main that stopped reading
    let relay = try #require(text.firstMatch(of: /relay_down_s:\s*(\d+)/), "the contract no longer has relay_down_s")
    #expect(Double(relay.1) == MainRestartContract.relayDownS)
    let unseen = try #require(text.firstMatch(of: /unseen_s:\s*(\d+)/), "the contract no longer has unseen_s")
    #expect(Double(unseen.1) == MainRestartContract.unseenS)
    let quiet = try #require(text.firstMatch(of: /unseen_quiet_s:\s*(\d+)/), "the contract no longer has unseen_quiet_s")
    #expect(Double(quiet.1) == MainRestartContract.unseenQuietS)
    let stall = try #require(text.firstMatch(of: /model_stall_s:\s*(\d+)/), "the contract no longer has model_stall_s")
    #expect(Double(stall.1) == MainRestartContract.stallS)
    let long = try #require(text.firstMatch(of: /model_stall_thinking_s:\s*(\d+)/), "the contract no longer has model_stall_thinking_s")
    #expect(Double(long.1) == MainRestartContract.stallThinkingS)
    let blank = try #require(text.firstMatch(of: /model_stall_blank_s:\s*(\d+)/), "the contract no longer has model_stall_blank_s")
    #expect(Double(blank.1) == MainRestartContract.stallBlankS)
  }
}
