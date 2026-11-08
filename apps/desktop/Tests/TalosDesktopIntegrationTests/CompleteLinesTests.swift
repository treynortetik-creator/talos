import Foundation
import Testing

/// The fakes' logs are read while they are being written (see `completeLines`).
@Suite("Test logs: only finished lines count")
struct CompleteLinesTests {
  @Test func aHalfWrittenLastLineIsNotALine() throws {
    let p = NSTemporaryDirectory() + "complete-lines-\(UUID().uuidString).log"
    defer { try? FileManager.default.removeItem(atPath: p) }
    let first = "claude --session-id abc"
    let half = String(repeating: "x", count: 1024)  // a 1,330-byte line cut by bash 3.2 at its first write
    try (first + "\n" + half).write(toFile: p, atomically: true, encoding: .utf8)
    #expect(completeLines(p) == [first])
    try (first + "\n" + half + " --resume abc\n").write(toFile: p, atomically: true, encoding: .utf8)
    #expect(completeLines(p).count == 2)
    #expect(completeLines(p).last?.hasSuffix("--resume abc") == true)
    #expect(completeLines(p + ".missing").isEmpty)
  }
}
