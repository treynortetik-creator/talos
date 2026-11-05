import Foundation
import Testing
import TalosDesktopCore

@testable import TalosSupervisor

/// The worker preamble the app writes when a thread has no `WORKER.md`. No tmux, no process: `preamble` only reads a file.
@Suite("Fallback worker preamble")
struct FallbackPreambleTests {
  /// What the bridge tells a thread's own session (WORKER_INSTRUCTIONS), as pinned by apps/bridge/test/tool-lists.test.ts.
  /// Read at test time so the Swift text cannot drift from it unseen.
  private static func bridgeWorkerText() throws -> String {
    let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()  // .../Tests/TalosDesktopIntegrationTests
    let repo = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let path = repo.appendingPathComponent("apps/bridge/test/fixtures/agent-instructions/worker.txt").path
    return try String(contentsOfFile: path, encoding: .utf8)
  }

  private func fallback(_ id: String = "trip") throws -> String {
    let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("talos-pre-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let o = WorkerManager.Options(
      talosHome: dir, agentDir: dir, claudePath: "claude", permissionFlag: nil, tmux: "tmux", tmuxConf: dir + "/tmux.conf")
    let m = WorkerManager(options: o, probe: LiveSystem(loginEnv: { [:] }), baseEnv: { [:] })
    return m.preamble(id)
  }

  @Test func namesNoTelegram() throws {
    #expect(!(try fallback()).localizedCaseInsensitiveContains("telegram"))
  }

  @Test func explainsHandoffsInTheBridgesWords() throws {
    let bridge = try Self.bridgeWorkerText()
    let start = try #require(bridge.range(of: "An item with kind=handoff"), "the bridge fixture no longer has the sentence")
    let end = try #require(bridge.range(of: "RESULT or BLOCK.", range: start.lowerBound..<bridge.endIndex))
    let sentence = String(bridge[start.lowerBound..<end.upperBound])
    #expect(try fallback().contains(sentence), "the fallback preamble must say exactly what the bridge says about hand-offs")
  }

  @Test func staysOneLine() throws {
    // the fake claude's log (and any `ps` line) holds one argv per line: a newline in the preamble splits it
    #expect(!(try fallback()).contains("\n"))
  }

  @Test func keepsTheRulesItAlreadyHad() throws {
    let p = try fallback("trip")
    #expect(p.contains("You are the dedicated session for the Talos thread \"trip\""))
    #expect(p.contains("call read_inbound"))
    #expect(p.contains("threads/trip.md"))
    #expect(p.contains("no git commands"))
  }
}
