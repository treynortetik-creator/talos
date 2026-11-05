import Foundation
import Testing
import TalosDesktopCore

/// Independent review of PR #68 (OC3). Tests named FINDING fail until the finding is fixed.
@Suite("Review OC3 core")
struct ReviewOC3CoreTests {
  /// Swift compares `Character`s, so a grapheme whose base is a-z passes the range check. The protocol's regex is ASCII.
  @Test func FINDING_aThreadIdIsAsciiOnly() {
    #expect(!WorkerSpec.isThreadId("a\u{200D}b"), "zero-width joiner")
    #expect(!WorkerSpec.isThreadId("q\u{0323}"), "combining mark with no precomposed form")
    #expect(!WorkerSpec.isThreadId("trip\u{0301}x"), "combining mark on a letter")
  }

  /// `tmuxName` must always be a name `TmuxCommands.isValidSessionName` accepts (D1-REVIEW finding 2).
  @Test func aValidThreadIdAlwaysMakesAValidSessionName() {
    for id in ["a", "trip", "a_b", "z9", String(repeating: "a", count: 32)] {
      #expect(WorkerSpec.isThreadId(id))
      #expect(TmuxCommands.isValidSessionName(WorkerSpec.tmuxName(id)))
    }
    for bad in ["", "A", "1a", "a-b", "a.b", "a:b", "a b", "a/b", "../x", "_nochannel", String(repeating: "a", count: 33)] {
      #expect(!WorkerSpec.isThreadId(bad), "\(bad)")
    }
  }

  private func spec() throws -> WorkerSpec {
    try WorkerSpec.build(
      .init(
        threadId: "trip", claudePath: "/bin/claude", baseEnv: ["HOME": "/h"], talosHome: "/h/t", agentDir: "/h/a",
        sessionId: "11111111-2222-4333-8444-555555555555", resume: true, nonce: "n"))
  }

  /// `validate()` is "the last line of defence": layer 2 only works if the state dirs are the empty folder.
  @Test func FINDING_validateRefusesARealTelegramStateDir() throws {
    var s = try spec()
    s.env["TELEGRAM_STATE_DIR"] = "/h/.claude/channels/telegram"
    #expect(throws: WorkerSpec.BuildError.self) { try s.validate() }
  }

  /// `-pfoo` is `-p foo` to a CLI parser. Not reachable from `build`; `validate` still claims to refuse `-p`.
  @Test func FINDING_validateRefusesAGluedPrintFlag() throws {
    var s = try spec()
    s.args.append("-pfoo")
    #expect(throws: WorkerSpec.BuildError.self) { try s.validate() }
  }

  /// Controls: on the resume path too, nothing a caller controls can land in an option position.
  @Test func hostileInputsNeverReachAnOptionPosition() throws {
    for bad in ["--channels", "-p", "--bg", "--print"] {
      #expect(throws: WorkerSpec.BuildError.self) {
        _ = try WorkerSpec.build(
          .init(
            threadId: "trip", claudePath: "/bin/claude", baseEnv: [:], talosHome: "/h/t", agentDir: "/h/a", model: bad,
            sessionId: "11111111-2222-4333-8444-555555555555", resume: true, nonce: "n"))
      }
      #expect(throws: WorkerSpec.BuildError.self) {
        _ = try WorkerSpec.build(
          .init(
            threadId: "trip", claudePath: "/bin/claude", baseEnv: [:], talosHome: "/h/t", agentDir: "/h/a", sessionId: bad,
            resume: true, nonce: "n"))
      }
      #expect(throws: WorkerSpec.BuildError.self) {
        _ = try WorkerSpec.build(
          .init(
            threadId: "trip", claudePath: "/bin/claude", baseEnv: [:], talosHome: "/h/t", agentDir: "/h/a",
            sessionId: "11111111-2222-4333-8444-555555555555", resume: true, nonce: "n", preamble: bad))
      }
    }
  }
}
