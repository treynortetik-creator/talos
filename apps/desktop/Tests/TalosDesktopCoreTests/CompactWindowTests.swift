import Foundation
import Testing
@testable import TalosDesktopCore

/// A thread's "compact at" setting (`session_opts.compact_window`): read from the config the way the bridge reads it, put in the
/// session's environment as CLAUDE_CODE_AUTO_COMPACT_WINDOW, part of the launch spec hash, and a live change that restarts the session.
/// The TypeScript side is apps/bridge/src/supervisor/compact-window.ts; swift-parity.test.ts holds the name and the range equal.
@Suite("Compact window")
struct CompactWindowTests {
  static let name = "CLAUDE_CODE_AUTO_COMPACT_WINDOW"
  let sid = "6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41"

  func inputs(_ window: Int?, base: [String: String] = ["PATH": "/usr/bin:/bin", "HOME": "/home/example"]) -> WorkerSpec.Inputs {
    var i = WorkerSpec.Inputs(
      threadId: "trip", claudePath: "/usr/local/bin/claude", baseEnv: base, talosHome: "/home/example/.talos",
      agentDir: "/home/example/agent", permissionHook: testHook, permissionFlag: "--dangerously-skip-permissions",
      sessionId: sid, resume: false, nonce: "n0nce-0123456789abcdef")
    i.compactWindow = window
    return i
  }

  // MARK: the environment

  @Test func aSetValueIsThePlainDigitsAndTheSpecStillValidates() throws {
    let s = try WorkerSpec.build(inputs(400_000))
    #expect(s.env[Self.name] == "400000")
    try s.validate()
  }

  @Test func unsetIsNotInTheEnvironmentAtAll() throws {
    #expect(try WorkerSpec.build(inputs(nil)).env[Self.name] == nil)
  }

  @Test func aValueOutOfRangeIsNeverPutInTheEnvironment() throws {
    for bad in [0, 5, 99_999, 1_000_001, -400_000] {
      #expect(try WorkerSpec.build(inputs(bad)).env[Self.name] == nil, "\(bad)")
    }
    for ok in [100_000, 1_000_000] { #expect(try WorkerSpec.build(inputs(ok)).env[Self.name] == String(ok)) }
  }

  @Test func theThreadsValueReplacesTheLoginOneAndUnsetLeavesTheOwners() throws {
    let login = ["PATH": "/usr/bin:/bin", Self.name: "250000"]
    #expect(try WorkerSpec.build(inputs(400_000, base: login)).env[Self.name] == "400000")
    #expect(try WorkerSpec.build(inputs(nil, base: login)).env[Self.name] == "250000")
  }

  @Test func theNameSurvivesTheScrubAndTheFolderFileMayNotSetIt() {
    #expect(!ClaudeEnvScrub.isInherited(Self.name))
    // it comes from the launch; a thread folder's own settings file may not name it (the allow list is shared with the kit hook)
    #expect(!WorkerHook.allowedEnv.contains(Self.name))
  }

  // MARK: the --settings env (it outranks the owner's user settings env)

  func settingsEnv(_ s: WorkerSpec) -> [String: Any]? {
    (jsonObject(s.settingsJSON) ?? [:])["env"] as? [String: Any]
  }

  @Test func aSetValueIsInTheSettingsEnvOverTheOwnersAndTheSpecValidates() throws {
    let s = try WorkerSpec.build(inputs(400_000, base: ["PATH": "/usr/bin:/bin", Self.name: "850000"]))
    #expect(settingsEnv(s)?[Self.name] as? String == "400000")
    try s.validate()
  }

  @Test func unsetOrOutOfRangeWritesNothingToTheSettingsEnv() throws {
    for w in [nil, 5, 99_999, 1_000_001] {
      #expect(settingsEnv(try WorkerSpec.build(inputs(w)))?[Self.name] == nil, "\(String(describing: w))")
    }
  }

  @Test func validateAllowsTheKeyWithTheSpecsValueAndRefusesAnyOther() throws {
    let s = try WorkerSpec.build(inputs(400_000))
    func with(_ v: String) -> WorkerSpec {
      var obj = jsonObject(s.settingsJSON) ?? [:]
      var env = obj["env"] as? [String: Any] ?? [:]
      env[Self.name] = v
      obj["env"] = env
      var out = s
      out.settingsJSON = String(decoding: (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data(), as: UTF8.self)
      return out
    }
    try with("400000").validate()
    #expect(throws: WorkerSpec.BuildError.self) { try with("850000").validate() }
    #expect(throws: WorkerSpec.BuildError.self) { try with("400k").validate() }
  }

  // MARK: the launch spec hash

  @Test func setChangedAndClearedAreThreeDifferentSpecs() throws {
    func hash(_ w: Int?) throws -> String? {
      let base = ["PATH": "/usr/bin:/bin", "HOME": "/home/example"]
      let s = try WorkerSpec.build(inputs(w, base: base))
      return LaunchSpecHash.Parts(argv: s.args, env: s.env, baseEnv: base, files: ["settings.json": Data(s.settingsJSON.utf8)], token: s.promptToken).hash
    }
    let none = try hash(nil)
    let a = try hash(400_000)
    #expect(none != nil && a != nil && a != none)
    #expect(try hash(300_000) != a)
    #expect(try hash(400_000) == a)
    #expect(!LaunchSpecHash.excludedEnv.contains(Self.name))
  }

  // MARK: the config

  func settings(_ opts: String, extra: String = "") -> ThreadSessionSettings? {
    let cfg = """
      {"default_thread":"general","dedicated":{"enabled":true},"threads":[{"id":"general","kind":"fixed"},
       {"id":"trip","kind":"fixed","session":"dedicated","session_opts":\(opts)}\(extra)]}
      """
    return DedicatedSettings.parse(Data(cfg.utf8)).threads["trip"]
  }

  @Test func aGoodValueIsReadAndAbsentOrNullIsUnset() {
    #expect(settings(#"{"cwd":"/home/alex/trip","compact_window":400000}"#)?.compactWindow == 400_000)
    #expect(settings(#"{"compact_window":100000}"#)?.compactWindow == 100_000)
    #expect(settings(#"{"compact_window":1000000}"#)?.compactWindow == 1_000_000)
    #expect(settings(#"{"cwd":"/home/alex/trip"}"#)?.compactWindow == nil)
    #expect(settings(#"{"compact_window":null}"#)?.compactWindow == nil)
  }

  @Test func aBadValueIsUnsetAndCostsNoOtherField() {
    for bad in ["5", "99999", "1000001", "400000.5", "\"400000\"", "\"auto\"", "true", "[]", "{}"] {
      let s = settings(#"{"cwd":"/home/alex/trip","model":"sonnet","idle_park_min":90,"compact_window":\#(bad)}"#)
      #expect(s?.compactWindow == nil, "\(bad)")
      #expect(s?.cwd == "/home/alex/trip" && s?.model == "sonnet" && s?.idleParkMin == 90, "\(bad)")
    }
  }

  @Test func aSubThreadHasItsOwnAndNeverItsParents() {
    let cfg = """
      {"default_thread":"general","dedicated":{"enabled":true},"threads":[{"id":"general","kind":"fixed"},
       {"id":"p","kind":"fixed","session":"dedicated","session_opts":{"cwd":"/home/alex/p","compact_window":400000}},
       {"id":"s","kind":"fixed","session":"dedicated","parent_id":"p"},
       {"id":"s2","kind":"fixed","session":"dedicated","parent_id":"p","session_opts":{"compact_window":200000}}]}
      """
    let t = DedicatedSettings.parse(Data(cfg.utf8)).threads
    #expect(t["p"]?.compactWindow == 400_000)
    #expect(t["s"]?.compactWindow == nil)
    #expect(t["s2"]?.compactWindow == 200_000)
  }

  // MARK: a live change

  func launched(_ w: Int?) -> WorkersFile.Launched {
    .init(cwd: "/home/example/trip", model: "inherit", effort: nil, mcp_allow: nil, compact_window: w)
  }
  func wanted(_ w: Int?) -> LaunchChange.Signature {
    .init(cwd: "/home/example/trip", model: "inherit", effort: nil, mcpAllow: nil, compactWindow: w)
  }

  @Test func aChangeRestartsAndNamesIt() {
    #expect(LaunchChange.compare(launched: launched(nil), wanted: wanted(400_000)) == .restart(wanted: wanted(400_000), changed: ["compact_window"]))
    #expect(LaunchChange.compare(launched: launched(400_000), wanted: wanted(300_000)) == .restart(wanted: wanted(300_000), changed: ["compact_window"]))
    #expect(LaunchChange.compare(launched: launched(400_000), wanted: wanted(nil)) == .restart(wanted: wanted(nil), changed: ["compact_window"]))
  }

  @Test func theSameValueOrNeitherIsNoChange() {
    #expect(LaunchChange.compare(launched: launched(400_000), wanted: wanted(400_000)) == .none)
    #expect(LaunchChange.compare(launched: launched(nil), wanted: wanted(nil)) == .none)
    // no record of the launch at all (an older build's entry) is never a change
    #expect(LaunchChange.compare(launched: nil, wanted: wanted(400_000)) == .none)
  }

  @Test func theLaunchRecordRoundTripsAndAnOldOrJunkOneReadsAsNone() throws {
    let enc = try JSONEncoder().encode(launched(400_000))
    #expect(try JSONDecoder().decode(WorkersFile.Launched.self, from: enc).compact_window == 400_000)
    #expect(!String(decoding: try JSONEncoder().encode(launched(nil)), as: UTF8.self).contains("compact_window"))
    for text in [#"{"cwd":"/a"}"#, #"{"cwd":"/a","compact_window":5}"#, #"{"cwd":"/a","compact_window":"x"}"#, #"{"cwd":"/a","compact_window":2500000}"#] {
      let l = try JSONDecoder().decode(WorkersFile.Launched.self, from: Data(text.utf8))
      #expect(l.compact_window == nil, "\(text)")
    }
  }
}
