import Foundation
import Testing
@testable import TalosDesktopCore

/// `workers.json` carries what is owed to a thread's session: the pointer line (`pointer_owed_until`, the claim deadline) and its
/// Enter (`enter_owed`). Both are optional and written only when set, so a file without them is the file of every earlier build, and
/// a file with them still loads in an earlier build (its decoder reads the keys it knows and the hub's schema drops the rest).
@Suite("workers.json owed pointer")
struct PointerOwedCoreTests {
  private func file(_ extra: String) -> Data {
    Data(
      """
      {"v":1,"supervisor":{"pid":7,"heartbeat_at":"2026-10-30T00:00:00.000Z","workers_supported":true,"main_pane_pid":0},
       "threads":{"trip":{"state":"live","tmux":"t-trip","cwd":"/tmp/x"\(extra)}}}
      """.utf8)
  }

  private func keys(_ f: WorkersFile) throws -> Set<String> {
    let root = try #require(try JSONSerialization.jsonObject(with: f.encoded()) as? [String: Any])
    let e = try #require((root["threads"] as? [String: Any])?["trip"] as? [String: Any])
    return Set(e.keys)
  }

  @Test func aFileWithoutTheFieldsLoadsAndIsWrittenWithoutThem() throws {
    let f = try #require(WorkersFile.decode(file("")))
    let k = try keys(f)
    #expect(!k.contains("pointer_owed_until") && !k.contains("enter_owed"), "\(k)")
    #expect(k.contains("error"), "the keys written before are still written, nulls included")
  }

  @Test func theOwedFieldsSurviveALoadAndAWrite() throws {
    let f = try #require(WorkersFile.decode(file(",\"pointer_owed_until\":\"2026-10-30T00:02:00.000Z\",\"enter_owed\":true")))
    let k = try keys(f)
    #expect(k.contains("pointer_owed_until") && k.contains("enter_owed"), "\(k)")
    let again = try #require(WorkersFile.decode(f.encoded()))
    #expect(again == f)
  }

  @Test func aKeyANewerBuildAddsIsIgnored() throws {
    #expect(WorkersFile.decode(file(",\"something_new\":{\"a\":1}")) != nil)
  }
}

@Suite("owed pointer constants and the box text")
struct PointerOwedConstantsTests {
  /// The hub's deadlines are the protocol's; the Mac keeps a copy in seconds.
  @Test func theClaimDeadlinesAreTheProtocolsOwn() throws {
    let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let ts = try String(
      contentsOf: here.appendingPathComponent("../../../../packages/protocol/src/thread-sessions.ts").standardized, encoding: .utf8)
    func value(_ name: String) throws -> Double {
      let line = try #require(ts.split(separator: "\n").first { $0.hasPrefix("export const \(name) = ") })
      let n = line.split(separator: "=").last!.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "_", with: "")
      return try #require(Double(n))
    }
    #expect(try value("CLAIM_DEADLINE_MS") / 1000 == PointerTyper.claimDeadline)
    #expect(try value("CLAIM_DEADLINE_COLD_MS") / 1000 == PointerTyper.claimDeadlineCold)
    #expect(ts.contains("export const WORKER_POINTER_TEXT = '\(PointerTyper.text)'"))
  }

  private func screen(_ box: [String]) -> [String] {
    let rule = String(repeating: "\u{2500}", count: 40)
    return ["", rule] + box + [rule, "  footer"]
  }

  @Test func ourOwnLineInTheBoxIsRecognisedExactly() {
    let one = screen(["\u{276F}\u{00A0}\(PointerTyper.text)"])
    #expect(PointerTyper.boxText(rows: one) == PointerTyper.text)
    // wrapped over indented rows
    let words = PointerTyper.text.split(separator: " ").map(String.init)
    let wrapped = screen(["\u{276F}\u{00A0}" + words[0..<4].joined(separator: " "), "  " + words[4...].joined(separator: " ")])
    #expect(PointerTyper.boxText(rows: wrapped) == PointerTyper.text)
    // more than our line, or less, is not it
    #expect(PointerTyper.boxText(rows: screen(["\u{276F}\u{00A0}\(PointerTyper.text) and more"])) != PointerTyper.text)
    #expect(PointerTyper.boxText(rows: screen(["\u{276F}\u{00A0}my note \(PointerTyper.text)"])) != PointerTyper.text)
    #expect(PointerTyper.boxText(rows: screen(["\u{276F}\u{00A0}Talos: new message"])) != PointerTyper.text)
    #expect(PointerTyper.boxText(rows: screen(["\u{276F}\u{00A0} "])) == "")
    #expect(PointerTyper.boxText(rows: ["no box here"]) == nil)
  }
}
