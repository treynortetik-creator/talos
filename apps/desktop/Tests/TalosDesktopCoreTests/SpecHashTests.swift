import Foundation
import Testing
@testable import TalosDesktopCore

/// Restart on update, the Mac's half of the hash: the shared vectors (packages/protocol/fixtures/spec-hash/vectors.json, which the
/// TypeScript suite reads too), the launch spec's rules (what is in it and what never is), the launch record's two fields, the owner's
/// line, and the two settings it reads (`restart_on_update`, the governor in status.json).
@Suite("Restart on update: spec hash")
struct SpecHashTests {
  static func repo() -> URL {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url
  }

  /// The vectors file, read whole by the Mac's own parser: its strings as UTF-16 units, as JSON.parse keeps them, so the lone
  /// surrogates of the must-throw inputs arrive as they are written.
  static func vectors() throws -> SpecJSON {
    try SpecJSON.parse(Data(contentsOf: repo().appending(path: "packages/protocol/fixtures/spec-hash/vectors.json")))
  }

  static func field(_ v: SpecJSON, _ k: String) -> SpecJSON? {
    guard case .object(let members) = v else { return nil }
    return members.last { $0.key == Array(k.utf16) }?.value
  }
  static func items(_ v: SpecJSON?) -> [SpecJSON] {
    guard case .array(let a)? = v else { return [] }
    return a
  }
  static func text(_ v: SpecJSON?) -> String? {
    guard case .string(let u)? = v else { return nil }
    return String(decoding: u, as: UTF16.self)
  }

  /// `value` with the item at `path` replaced (`with` nil: an absent value, so a key is left out and an array item is null).
  static func put(_ value: SpecJSON, _ path: [SpecJSON], _ with: SpecJSON?) -> SpecJSON {
    guard let first = path.first else { return with ?? .null }
    let rest = Array(path.dropFirst())
    switch (value, first) {
    case (.object(let members), .string(let key)):
      var out = members.filter { $0.key != key }
      let old = members.first { $0.key == key }?.value ?? .null
      if rest.isEmpty {
        if let with { out.append(.init(units: key, with)) }
      } else {
        out.append(.init(units: key, put(old, rest, with)))
      }
      return .object(out)
    case (.array(var list), .number(let n)):
      let i = Int(n)
      while list.count <= i { list.append(.null) }
      list[i] = rest.isEmpty ? (with ?? .null) : put(list[i], rest, with)
      return .array(list)
    default:
      return value
    }
  }

  @Test func everySharedVectorGivesItsJcsTextAndHash() throws {
    let list = Self.items(Self.field(try Self.vectors(), "vectors"))
    #expect(list.count >= 17)
    for v in list {
      let name = Self.text(Self.field(v, "name")) ?? "?"
      var spec = try #require(Self.field(v, "input"))
      for p in Self.items(Self.field(v, "undefined_paths")) { spec = Self.put(spec, Self.items(p), nil) }
      #expect(try JCS.text(spec) == Self.text(Self.field(v, "jcs")), "\(name)")
      #expect(try SpecHash.hash(spec) == Self.text(Self.field(v, "hash")), "\(name)")
    }
  }

  @Test func everyMustThrowInputThrows() throws {
    let list = Self.items(Self.field(try Self.vectors(), "must_throw"))
    #expect(list.count >= 4)
    for v in list {
      var spec = try #require(Self.field(v, "input"))
      if let r = Self.field(v, "replace") {
        let with: Double = Self.text(Self.field(r, "with")) == "NaN" ? .nan : .infinity
        spec = Self.put(spec, Self.items(Self.field(r, "path")), .number(with))
      }
      #expect(throws: SpecJSON.Failure.self, "\(Self.text(Self.field(v, "name")) ?? "?")") { try SpecHash.hash(spec) }
    }
  }

  @Test func numbersAreWrittenAsJavaScriptWritesThem() throws {
    let cases: [(Double, String)] = [
      (0, "0"), (-0.0, "0"), (1, "1"), (-1, "-1"), (1.5, "1.5"), (100, "100"), (1e21, "1e+21"), (1e20, "100000000000000000000"),
      (1e-6, "0.000001"), (1e-7, "1e-7"), (5e-324, "5e-324"), (123.456, "123.456"), (-1.25e-9, "-1.25e-9"), (1.7976931348623157e308, "1.7976931348623157e+308"),
    ]
    for (d, s) in cases { #expect(try JCS.number(d) == s, "\(d)") }
  }

  // MARK: the launch spec

  static let argv = ["/usr/local/bin/claude", "--settings", "/home/alex/.talos/workers/trip/settings.json", "--name", "talos-trip"]
  static let base = ["PATH": "/usr/bin:/bin", "HOME": "/home/alex", "LANG": "en_US.UTF-8"]
  static func env(nonce: String = "aa") -> [String: String] {
    base.merging(["TALOS_APP_WORKER_THREAD": "trip", "TALOS_APP_HOME": "/home/alex/.talos", "TALOS_APP_WORKER_NONCE": nonce]) { _, b in b }
  }
  static let files: [String: Data?] = ["settings.json": Data("{}".utf8), "permission-hook": Data("print(1)".utf8), "mcp.json": nil]

  static func hash(
    argv: [String] = argv, env: [String: String] = env(), base: [String: String] = base, files: [String: Data?] = files, token: String? = nil
  ) -> String? {
    LaunchSpecHash.hash(argv: argv, env: env, baseEnv: base, files: files, token: token)
  }

  @Test func theSameLaunchTwiceIsTheSameHashAndItIsAValidOne() throws {
    let a = try #require(Self.hash())
    #expect(SpecHash.isValid(a))
    #expect(Self.hash() == a)
  }

  @Test func theNonceAndTheSessionIdInEitherFormAreNotInIt() throws {
    let a = try #require(Self.hash())
    #expect(Self.hash(env: Self.env(nonce: "bb")) == a)
    for session in [
      ["--resume", "11111111-2222-4333-8444-555555555555"], ["--session-id", "aaaaaaaa-2222-4333-8444-555555555555"], ["-r", "x"],
      ["--resume=11111111-2222-4333-8444-555555555555"], ["--session-id=x"],
    ] {
      #expect(Self.hash(argv: Self.argv + session) == a, "\(session)")
    }
    #expect(LaunchSpecHash.argvWithoutSession(["c", "--resume", "id", "--model", "x", "--session-id=y"]) == ["c", "--model", "x"])
  }

  @Test func onlyWhatTheStartSetsCountsSoTheLoginEnvironmentDriftingChangesNothing() throws {
    let a = try #require(Self.hash())
    // a variable the start strips or leaves as it is: in the login environment or not, the same spec
    var drifted = Self.base
    drifted["TELEGRAM_BOT_TOKEN"] = "123:x"
    drifted["SOME_TOOL_HOME"] = "/opt/tool"
    var env = Self.env()
    env["SOME_TOOL_HOME"] = "/opt/tool"
    #expect(Self.hash(env: env, base: drifted) == a)
    // a value the start sets that changes: another spec
    var other = Self.env()
    other["TALOS_APP_HOME"] = "/home/alex/.talos2"
    #expect(Self.hash(env: other) != a)
  }

  @Test func theModelTheHookBytesTheSettingsAndTheStripRuleEachChangeIt() throws {
    let a = try #require(Self.hash())
    #expect(Self.hash(argv: Self.argv + ["--model", "opus"]) != a)
    var hook = Self.files
    hook["permission-hook"] = Data("print(2)".utf8)
    #expect(Self.hash(files: hook) != a)
    var settings = Self.files
    settings["settings.json"] = Data("{\"a\":1}".utf8)
    #expect(Self.hash(files: settings) != a)
    var helper = Self.files
    helper["permission-hook-helper"] = Data("x".utf8)
    #expect(Self.hash(files: helper) != a)
    let spec = LaunchSpecHash.spec(argv: Self.argv, env: Self.env(), baseEnv: Self.base, files: Self.files)
    let other = LaunchSpecHash.spec(argv: Self.argv, env: Self.env(), baseEnv: Self.base, files: Self.files, stripRules: WorkerEnvStripRules.text + " ")
    #expect(try SpecHash.hash(spec) == a)
    #expect(try SpecHash.hash(other) != a)
  }

  @Test func theInstructionTokenIsReplacedSoTheSameFilesAreTheSameSpec() throws {
    let one = Self.argv + ["--append-system-prompt", "<<<TALOS-FILE 0123abcd x>>>\nhi\n<<<TALOS-END 0123abcd>>>"]
    let two = Self.argv + ["--append-system-prompt", "<<<TALOS-FILE ffff9999 x>>>\nhi\n<<<TALOS-END ffff9999>>>"]
    #expect(Self.hash(argv: one, token: "0123abcd") == Self.hash(argv: two, token: "ffff9999"))
    #expect(Self.hash(argv: one, token: "0123abcd") != Self.hash(argv: one))
    let changed = Self.argv + ["--append-system-prompt", "<<<TALOS-FILE ffff9999 x>>>\nbye\n<<<TALOS-END ffff9999>>>"]
    #expect(Self.hash(argv: one, token: "0123abcd") != Self.hash(argv: changed, token: "ffff9999"))
  }

  @Test func theStripRuleIsTheListsTheStrippingCodeReads() throws {
    let text = WorkerEnvStripRules.text
    for name in WorkerSpec.strippedEnv.union(ClaudeEnvScrub.alwaysDrop).union(ClaudeEnvScrub.sessionMarkers).union(ClaudeEnvScrub.keep)
      .union(ClaudeEnvScrub.shellStartup).union(LoginShellEnv.denylist).union(LoginShellEnv.workerSwitchAlways)
      .union(LoginShellEnv.workerSwitchNoChannel)
    {
      #expect(text.contains("\"\(name)\""), "\(name)")
    }
    for p in WorkerSpec.strippedPrefixes + ClaudeEnvScrub.shellStartupPrefixes + ClaudeEnvScrub.keepPrefixes { #expect(text.contains("\"\(p)\"")) }
    // and the stripping code reads those same lists: a leaked worker switch is dropped by them
    #expect(LoginShellEnv.isWorkerChannelSwitch("TELEGRAM_STATE_DIR", "/x" + LoginShellEnv.noChannelSuffix))
    #expect(!LoginShellEnv.isWorkerChannelSwitch("TELEGRAM_STATE_DIR", "/x/mine"))
    #expect(LoginShellEnv.isWorkerChannelSwitch("ENABLE_CLAUDEAI_MCP_SERVERS", "true"))
    #expect(text == (try JCS.text(WorkerEnvStripRules.object)))
  }

  // MARK: the launch record

  static let h1 = "sha256:" + String(repeating: "a", count: 64)
  static let h2 = "sha256:" + String(repeating: "b", count: 64)

  @Test func theLaunchRecordKeepsBothHashesAndReadsGarbageAsMissing() throws {
    let l = WorkersFile.Launched(cwd: "/home/alex/proj", model: "inherit", effort: nil, mcp_allow: nil, spec_hash: Self.h1, update_tried_hash: Self.h2)
    let back = try JSONDecoder().decode(WorkersFile.Launched.self, from: try JSONEncoder().encode(l))
    #expect(back.spec_hash == Self.h1)
    #expect(back.update_tried_hash == Self.h2)
    // an older build's record: no fields, still read
    let old = try JSONDecoder().decode(WorkersFile.Launched.self, from: Data(#"{"cwd":"/home/alex/proj","model":"sonnet"}"#.utf8))
    #expect(old.spec_hash == nil && old.update_tried_hash == nil && old.model == "sonnet")
    // what is not a hash reads as absent, and costs nothing else in the record
    for bad in [#""sha256:XYZ""#, "7", "null", #""sha256:\#(String(repeating: "A", count: 64))""#, #"{"a":1}"#, #""md5:\#(String(repeating: "a", count: 64))""#] {
      let d = Data(#"{"cwd":"/home/alex/proj","model":"sonnet","spec_hash":\#(bad),"update_tried_hash":\#(bad)}"#.utf8)
      let r = try JSONDecoder().decode(WorkersFile.Launched.self, from: d)
      #expect(r.spec_hash == nil && r.update_tried_hash == nil && r.model == "sonnet", "\(bad)")
    }
    #expect(WorkersFile.Launched(cwd: "/x", model: "inherit", effort: nil, mcp_allow: nil, spec_hash: "nope").spec_hash == nil)
  }

  // MARK: the owner's line

  @Test func theOwnersLineIsTheProtocolsWordForWord() throws {
    let url = Self.repo().appending(path: "apps/desktop/Tests/Fixtures/update-restart-line.json")
    let root = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    let cases = try #require(root["cases"] as? [[String: Any]])
    #expect(cases.count >= 8)
    for c in cases {
      let line = UpdateRestartLine.line(
        restarted: c["restarted"] as? [String] ?? [], waiting: c["waiting"] as? [String] ?? [], failed: c["failed"] as? [String] ?? [],
        notRestarted: c["notRestarted"] as? [String] ?? [])
      #expect(line == c["line"] as? String, "\(c["name"] ?? "?")")
    }
  }

  // MARK: the settings it reads

  @Test func restartOnUpdateIsOnUnlessItIsTheBooleanFalse() throws {
    func read(_ v: String?) -> Bool? {
      let field = v.map { #","restart_on_update":\#($0)"# } ?? ""
      return DedicatedSettings.readable(Data(#"{"dedicated":{"enabled":true\#(field)},"threads":[]}"#.utf8))?.restartOnUpdate
    }
    #expect(read(nil) == true)
    #expect(read("true") == true)
    #expect(read("false") == false)
    for junk in ["0", "\"false\"", "null", "{}"] { #expect(read(junk) == true, "\(junk)") }
  }

  @Test func statusJsonGivesTheGovernorAndTheBridgeCommit() throws {
    func status(_ extra: String) -> BridgeStatus? {
      BridgeStatus.decode(Data(#"{"v":1,"pid":42,"mode":"live","relay":{"connected":true},"updated_at":"2026-11-14T00:00:00.000Z"\#(extra)}"#.utf8))
    }
    #expect(status(#","governor":"ok","bridge_commit":"abc1234""#)?.governor == "ok")
    #expect(status(#","governor":"ok","bridge_commit":"abc1234""#)?.bridgeCommit == "abc1234")
    #expect(status(#","governor":"paused""#)?.governor == "paused")
    #expect(status(#","governor":"newer_state""#)?.governor == "unknown")
    #expect(status(#","governor":null"#)?.governor == nil)
    #expect(status("")?.governor == nil)  // an older bridge: no field, and the rest still reads
    #expect(status(#","governor":7,"bridge_commit":"a b""#)?.bridgeCommit == nil)
  }
}
