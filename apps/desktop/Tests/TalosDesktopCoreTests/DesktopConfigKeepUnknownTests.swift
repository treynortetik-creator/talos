import Foundation
import Testing

@testable import TalosDesktopCore
import TalosTestSupport

/// Standing rule 1: the owner's desktop.json is never overwritten by what this build does not know. A key a newer build added, at
/// any depth, and a value this build could not read, come out of a save as they went in.
@Suite("DesktopConfig keeps what it does not know")
struct DesktopConfigKeepUnknownTests {
  private func tempFile() throws -> String {
    let dir = TestTemp.url.appendingPathComponent("keep-unknown-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("desktop.json").path
  }

  private func write(_ obj: [String: Any], to path: String) throws {
    try JSONSerialization.data(withJSONObject: obj).write(to: URL(fileURLWithPath: path))
  }

  private func read(_ path: String) throws -> [String: Any] {
    let data = try #require(FileManager.default.contents(atPath: path))
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  /// The file with the three depths of unknown keys: top, `session`, `hotkeys`.
  private func future() throws -> (path: String, base: [String: Any]) {
    let path = try tempFile()
    var base = try #require(try JSONSerialization.jsonObject(with: DesktopConfig.defaults.encoded()) as? [String: Any])
    base["future_top"] = ["nested": ["deep": [1, ["x": "y"]]], "flag": true] as [String: Any]
    var session = try #require(base["session"] as? [String: Any])
    session["future_session"] = ["a": 1]
    base["session"] = session
    var hot = try #require(base["hotkeys"] as? [String: Any])
    hot["future_hotkey"] = "cmd+k"
    base["hotkeys"] = hot
    try write(base, to: path)
    return (path, base)
  }

  @Test func unknownKeysAtEveryDepthSurviveASave() throws {
    let (path, _) = try future()
    var c = try #require(try ConfigFile.load(path))
    c.autoRestart.toggle()
    c.session.id = "abc"
    c.hotkeys.compose = "ctrl+opt+k"
    try ConfigFile.save(c, to: path)
    let out = try read(path)
    #expect(out["auto_restart"] as? Bool == c.autoRestart)
    #expect((out["session"] as? [String: Any])?["id"] as? String == "abc")
    #expect((out["hotkeys"] as? [String: Any])?["compose"] as? String == "ctrl+opt+k")
    let top = try #require(out["future_top"] as? [String: Any])
    #expect(top["flag"] as? Bool == true)
    #expect(((top["nested"] as? [String: Any])?["deep"] as? [Any])?.count == 2)
    #expect((out["session"] as? [String: Any])?["future_session"] as? [String: Int] == ["a": 1])
    #expect((out["hotkeys"] as? [String: Any])?["future_hotkey"] as? String == "cmd+k")
  }

  @Test func theLaunchTrustMigrationKeepsThemToo() throws {
    let (path, _) = try future()
    let r = LaunchTrustMigration.load(path)
    #expect(r.migrated)
    let out = try read(path)
    #expect(out["launch_trust"] as? Int == LaunchTrustMigration.version)
    #expect(out["future_top"] != nil)
    #expect((out["session"] as? [String: Any])?["future_session"] != nil)
  }

  @Test func aValueThisBuildCannotReadIsKeptAsItWas() throws {
    let (path, base) = try future()
    var raw = base
    raw["host"] = "teleport"  // a host a newer build offers
    raw["open_window_at_launch"] = "yes"
    raw["notify_thread"] = 5
    raw["launch_trust"] = "two"
    try write(raw, to: path)
    var c = try #require(try ConfigFile.load(path))
    #expect(c.host == .auto)
    c.keepAwakeOnAC = true
    try ConfigFile.save(c, to: path)
    let out = try read(path)
    #expect(out["keep_awake_on_ac"] as? Bool == true)
    #expect(out["host"] as? String == "teleport")
    #expect(out["open_window_at_launch"] as? String == "yes")
    #expect(out["notify_thread"] as? Int == 5)
    #expect(out["launch_trust"] as? String == "two")
  }

  @Test func aDeliberateChangeToAnUnreadableFieldIsWritten() throws {
    let (path, base) = try future()
    var raw = base
    raw["host"] = "teleport"
    try write(raw, to: path)
    var c = try #require(try ConfigFile.load(path))
    c.host = .tmux
    try ConfigFile.save(c, to: path)
    #expect(try read(path)["host"] as? String == "tmux")
  }

  @Test func aKeyTheAppClearsIsRemoved() throws {
    let (path, base) = try future()
    var raw = base
    raw["confirmed_launch"] = "fp"
    raw["confirmed_launch_mac"] = "mac"
    try write(raw, to: path)
    var c = try #require(try ConfigFile.load(path))
    c.confirmedLaunchMac = nil
    c.env = ["A": "1"]
    try ConfigFile.save(c, to: path)
    let out = try read(path)
    #expect(out["confirmed_launch_mac"] == nil)
    #expect(out["confirmed_launch"] as? String == "fp")
    #expect(out["env"] as? [String: String] == ["A": "1"])
  }

  @Test func theMigrationClearsAnExistingSealAndKeepsTheRest() throws {
    let (path, base) = try future()
    var raw = base
    raw["confirmed_launch"] = "fp"
    raw["confirmed_launch_mac"] = "mac"
    raw["confirmed_launch_parts"] = ["folder": "x"]
    try write(raw, to: path)
    #expect(LaunchTrustMigration.load(path).migrated)
    let out = try read(path)
    #expect(out["confirmed_launch"] as? String == nil)
    #expect(out["confirmed_launch_mac"] as? String == nil)
    #expect(out["confirmed_launch_parts"] as? [String: String] == nil)
    #expect(out["launch_trust"] as? Int == LaunchTrustMigration.version)
    #expect(out["future_top"] != nil)
    #expect((out["session"] as? [String: Any])?["future_session"] != nil)
  }

  @Test func aFileThatCannotBeDecodedStillLosesTheKeysTheAppCleared() throws {
    let (path, base) = try future()
    var raw = base
    raw["args"] = "not a list"  // decode throws on this
    raw["confirmed_launch"] = "fp"
    raw["confirmed_launch_mac"] = "mac"
    raw["confirmed_launch_parts"] = ["folder": "x"]
    raw["launch_trust"] = 2
    try write(raw, to: path)
    #expect((try? DesktopConfig.decode(JSONSerialization.data(withJSONObject: raw))) == nil)
    var c = DesktopConfig.defaults
    c.autoRestart = false
    try ConfigFile.save(c, to: path)
    let out = try read(path)
    #expect(out["auto_restart"] as? Bool == false)
    #expect(out["args"] as? [String] == [])
    #expect(out["confirmed_launch_mac"] == nil)
    #expect(out["confirmed_launch_parts"] == nil)
    #expect(out["launch_trust"] == nil)
    #expect(out["future_top"] != nil)
    #expect((out["session"] as? [String: Any])?["future_session"] != nil)
    #expect((out["hotkeys"] as? [String: Any])?["future_hotkey"] as? String == "cmd+k")
  }

  private func asides(of path: String) throws -> [String] {
    let dir = (path as NSString).deletingLastPathComponent
    return try FileManager.default.contentsOfDirectory(atPath: dir).filter { $0.hasPrefix("desktop.json.unreadable-") }.sorted()
  }

  @Test func aFileThatCannotBeDecodedIsMovedAsideWhole() throws {
    let (path, base) = try future()
    var raw = base
    raw["args"] = "not a list"
    try write(raw, to: path)
    let before = try #require(FileManager.default.contents(atPath: path))
    let moved = try ConfigFile.save(.defaults, to: path)
    let aside = try asides(of: path)
    #expect(aside.count == 1)
    #expect(moved == (path as NSString).deletingLastPathComponent + "/" + aside[0])
    #expect(FileManager.default.contents(atPath: moved ?? "") == before)
    #expect((try? ConfigFile.load(path)) != nil)
  }

  @Test func aFileThatIsNotJsonIsMovedAsideAndANewOneWritten() throws {
    let path = try tempFile()
    try Data("{ \"args\": [oops".utf8).write(to: URL(fileURLWithPath: path))
    let moved = try ConfigFile.save(.defaults, to: path)
    let asidePath = try #require(moved)
    let kept = try #require(FileManager.default.contents(atPath: asidePath))
    #expect(String(data: kept, encoding: .utf8) == "{ \"args\": [oops")
    #expect(try read(path)["v"] != nil)
  }

  @Test func aFileThatDecodesIsNeverMovedAside() throws {
    let (path, _) = try future()
    #expect(try ConfigFile.save(.defaults, to: path) == nil)
    #expect(try asides(of: path).isEmpty)
  }

  @Test func onlyTheNewestThreeUnreadableCopiesAreKept() throws {
    let path = try tempFile()
    let dir = (path as NSString).deletingLastPathComponent
    for stamp in ["20200101T000000000Z", "20200102T000000000Z", "20200103T000000000Z", "20200104T000000000Z"] {
      try Data(stamp.utf8).write(to: URL(fileURLWithPath: dir + "/desktop.json.unreadable-" + stamp))
    }
    try Data("garbage".utf8).write(to: URL(fileURLWithPath: path))
    let moved = try #require(try ConfigFile.save(.defaults, to: path))
    let left = try asides(of: path)
    #expect(left.count == 3)
    #expect(left.contains((moved as NSString).lastPathComponent))
    #expect(!left.contains("desktop.json.unreadable-20200101T000000000Z"))
    #expect(!left.contains("desktop.json.unreadable-20200102T000000000Z"))
  }

  @Test func theCopyJustSetAsideSurvivesEvenWhenTheClockWentBackwards() throws {
    let path = try tempFile()
    let dir = (path as NSString).deletingLastPathComponent
    for stamp in ["20990101T000000000Z", "20990102T000000000Z", "20990103T000000000Z"] {
      try Data(stamp.utf8).write(to: URL(fileURLWithPath: dir + "/desktop.json.unreadable-" + stamp))
    }
    try Data("garbage".utf8).write(to: URL(fileURLWithPath: path))
    let moved = try #require(try ConfigFile.save(.defaults, to: path))
    let kept = try #require(FileManager.default.contents(atPath: moved))
    #expect(String(data: kept, encoding: .utf8) == "garbage")
    #expect(try asides(of: path).count == 3)
  }

  @Test func aFailedWriteAfterTheMoveBringsTheUnreadableFileBack() throws {
    let path = try tempFile()
    let original = Data("garbage, not json".utf8)
    try original.write(to: URL(fileURLWithPath: path))
    struct Boom: Error {}
    #expect(throws: Boom.self) { try ConfigFile.save(.defaults, to: path) { _, _ in throw Boom() } }
    #expect(FileManager.default.contents(atPath: path) == original)
    #expect(try asides(of: path).isEmpty)
  }

  @Test func aSessionResetDropsTheOldSessionsUnknownKeys() throws {
    let (path, _) = try future()
    var c = try #require(try ConfigFile.load(path))
    c.session.id = "first"  // nothing to reset yet: the unknown key stays
    try ConfigFile.save(c, to: path)
    #expect((try read(path)["session"] as? [String: Any])?["future_session"] != nil)
    c.session = DesktopConfig.Session(id: nil, previousIds: ["first"])  // the owner started a new conversation
    try ConfigFile.save(c, to: path)
    let session = try #require(try read(path)["session"] as? [String: Any])
    #expect(session["future_session"] == nil)
    #expect(session["previous_ids"] as? [String] == ["first"])
    #expect(try read(path)["future_top"] != nil)
    #expect((try read(path)["hotkeys"] as? [String: Any])?["future_hotkey"] as? String == "cmd+k")
  }

  @Test func aNewFileHasOnlyTheKnownKeys() throws {
    let path = try tempFile()
    try ConfigFile.save(.defaults, to: path)
    #expect(try ConfigFile.load(path) == DesktopConfig.defaults)
  }
}
