import Foundation
import Testing
@testable import TalosDesktopCore

/// The update check report's words and rules (UpdateCheck.swift) and the instructions digest in the launch spec (LaunchSpecHash).
@Suite("Update check report (core)")
struct UpdateCheckTests {
  static let argv = ["/usr/local/bin/claude", "--settings", "/home/alex/.talos/workers/trip/settings.json", "--model", "opus"]
  static let base = ["PATH": "/usr/bin:/bin", "HOME": "/home/alex"]
  static let env = base.merging(["TALOS_APP_WORKER_THREAD": "trip", "TALOS_APP_WORKER_NONCE": "n"]) { _, b in b }
  static let files: [String: Data?] = ["settings.json": Data("{}".utf8), "permission-hook": Data("print(1)".utf8)]

  static func parts(prompt: String?, token: String? = nil, model: String = "opus") -> LaunchSpecHash.Parts {
    var a = argv
    a[a.count - 1] = model
    if let prompt { a += ["--append-system-prompt", prompt] }
    return .init(argv: a + ["--resume", "11111111-2222-4333-8444-555555555555"], env: env, baseEnv: base, files: files, token: token)
  }

  static func current(_ p: LaunchSpecHash.Parts) -> UpdateCheck.Current {
    .spec(p.hash, instructions: p.instructionsHash, specWith: { p.hash(instructionsHash: $0) })
  }

  static func record(_ p: LaunchSpecHash.Parts, instructions: Bool = true) -> WorkersFile.Launched {
    .init(
      cwd: "/home/alex/proj", model: "opus", effort: nil, mcp_allow: nil, spec_hash: p.hash,
      instructions_hash: instructions ? p.instructionsHash : nil)
  }

  // MARK: the instructions digest

  @Test func theInstructionsAreAFileOfTheSpecTokenReplacedAndTheirDigestIsTheirOwn() throws {
    let one = Self.parts(prompt: "<<<TALOS-FILE abcd1234 x>>>\nhi\n<<<TALOS-END abcd1234>>>", token: "abcd1234")
    let two = Self.parts(prompt: "<<<TALOS-FILE ffff0000 x>>>\nhi\n<<<TALOS-END ffff0000>>>", token: "ffff0000")
    #expect(one.hash == two.hash)
    #expect(one.instructionsHash == two.instructionsHash)
    let ih = try #require(one.instructionsHash)
    #expect(SpecHash.isValid(ih))
    #expect(ih == "sha256:" + SpecHash.hex(Data("<<<TALOS-FILE TOKEN x>>>\nhi\n<<<TALOS-END TOKEN>>>".utf8)))
    #expect(Self.parts(prompt: nil).instructionsHash == nil)
    // the `=` form is the same instructions
    var eq = Self.parts(prompt: nil)
    eq.argv.insert("--append-system-prompt=hi", at: 1)
    #expect(eq.instructionsHash == Self.parts(prompt: "hi").instructionsHash)
  }

  @Test func theSpecWithARecordedDigestInPlaceMatchesOnlyWhenNothingElseChanged() throws {
    let was = Self.parts(prompt: "old text")
    let edited = Self.parts(prompt: "new text")
    let alsoModel = Self.parts(prompt: "new text", model: "sonnet")
    let wasIH = try #require(was.instructionsHash)
    #expect(edited.hash != was.hash)
    #expect(edited.hash(instructionsHash: wasIH) == was.hash)
    #expect(alsoModel.hash(instructionsHash: wasIH) != was.hash)
    #expect(was.hash(instructionsHash: wasIH) == was.hash)
    #expect(was.hash(instructionsHash: "sha256:nothex") == nil)
  }

  // MARK: classify

  @Test func eachStateFromItsCase() throws {
    let was = Self.parts(prompt: "old text")
    let rec = Self.record(was)
    let C = UpdateCheck.self
    #expect(C.classify(Self.current(was), launched: rec, busy: false, startedInAgentFolder: false) == .unchanged)
    #expect(C.classify(Self.current(was), launched: rec, busy: true, startedInAgentFolder: false) == .unchanged, "busy and unchanged: nothing waits")
    #expect(C.classify(Self.current(Self.parts(prompt: "new text")), launched: rec, busy: false, startedInAgentFolder: false) == .instructionsChanged)
    #expect(C.classify(Self.current(Self.parts(prompt: "old text", model: "x")), launched: rec, busy: false, startedInAgentFolder: false) == .specChanged)
    #expect(C.classify(Self.current(Self.parts(prompt: "new text", model: "x")), launched: rec, busy: false, startedInAgentFolder: false) == .specChanged, "both")
    #expect(C.classify(Self.current(Self.parts(prompt: "new text")), launched: rec, busy: true, startedInAgentFolder: false) == .busy)
    #expect(C.classify(Self.current(was), launched: nil, busy: false, startedInAgentFolder: false) == .noRecord)
    var older = rec
    older.spec_hash = nil
    older.instructions_hash = nil
    #expect(C.classify(Self.current(was), launched: older, busy: true, startedInAgentFolder: false) == .noRecord)
    #expect(C.classify(.refused, launched: rec, busy: false, startedInAgentFolder: false) == .unknown)
    #expect(C.classify(.spec(nil, instructions: nil, specWith: { _ in nil }), launched: rec, busy: false, startedInAgentFolder: false) == .unknown)
    // an update already tried for this spec: nothing to do, as the queue reads it
    var tried = rec
    let now = Self.parts(prompt: "old text", model: "x")
    tried.update_tried_hash = now.hash
    #expect(C.classify(Self.current(now), launched: tried, busy: false, startedInAgentFolder: false) == .unchanged)
    // a record from before instructions_hash: an instruction edit cannot be told apart, so it is a spec change
    #expect(C.classify(Self.current(Self.parts(prompt: "new text")), launched: Self.record(was, instructions: false), busy: false, startedInAgentFolder: false) == .specChanged)
  }

  @Test func aSessionStartedInTheAgentFolderIsNeverInstructionsChanged() throws {
    let was = Self.parts(prompt: "old text")
    // even with a digest on its record (an edited file, a newer build's bug): its edit is a changed spec, never "instructions"
    let state = UpdateCheck.classify(Self.current(Self.parts(prompt: "new text")), launched: Self.record(was), busy: false, startedInAgentFolder: true)
    #expect(state == .specChanged)
  }

  // MARK: output

  @Test func theOutputIsIdsStatesAndOneCountLineAndNothingElse() throws {
    let rows: [UpdateCheck.Row] = [
      .init(id: "trip", state: .unchanged), .init(id: "alpha", state: .specChanged), .init(id: "beta", state: .instructionsChanged),
      .init(id: "gamma", state: .busy), .init(id: "old", state: .noRecord), .init(id: "bad", state: .unknown),
      .init(id: "Not An Id\u{1b}[31m", state: .specChanged), .init(id: "x\nfake  unchanged", state: .unchanged),
    ]
    #expect(UpdateCheck.lines(rows) == [
      "alpha  spec changed", "bad  unknown (dry plan refused)", "beta  instructions changed", "gamma  busy (would wait)",
      "old  no record", "trip  unchanged", "6 sessions: 1 unchanged, 3 to restart, 1 no record, 1 unknown",
    ])
    #expect(UpdateCheck.lines([]) == ["0 sessions: 0 unchanged, 0 to restart, 0 no record, 0 unknown"])
  }

  @Test func argumentsHelpAndUsage() throws {
    #expect(UpdateCheck.parse([]) == .run)
    #expect(UpdateCheck.parse(["--help"]) == .help)
    #expect(UpdateCheck.parse(["-h"]) == .help)
    for bad in [["--dry"], ["--help", "SECRETX"], ["/home/alex/.talos-secret"], ["SECRET\u{1b}]0;x"]] {
      guard case .usage(let line) = UpdateCheck.parse(bad) else {
        Issue.record("\(bad) parsed")
        continue
      }
      #expect(!line.contains("\n"))
      for a in bad where a != "--help" { #expect(!line.contains(a), "an argument is never echoed") }
    }
    #expect(UpdateCheck.help.contains(
      "a session started in the agent folder picks up an edit to that folder's instruction files at its next restart; restart it to apply the edit now."))
    for s in UpdateCheck.State.allCases { #expect(UpdateCheck.help.contains(s.rawValue)) }
    #expect(!UpdateCheck.unreadable.contains("/") && !UpdateCheck.unreadable.contains("\n"))
  }
}
