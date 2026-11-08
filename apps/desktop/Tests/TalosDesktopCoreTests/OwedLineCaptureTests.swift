import Foundation
import Testing
@testable import TalosDesktopCore

/// Talos's pointer line in the REAL Claude Code 2.1.319 input box (Tests/Fixtures/real-2.1.319/owed-capture, logged out, nothing
/// submitted): typed at 120, 40 and 30 columns, then taken out with 53 Backspaces. `<name>.txt` is `capture-pane -p -J`, `<name>.ansi.txt`
/// the same with `-e` (the colours the draft check reads).
@Suite("Our pointer line in the real input box")
struct OwedLineCaptureTests {
  private static let dir = "real-2.1.319"
  private func plain(_ name: String) throws -> [String] { try RealScreens.rows("owed-capture/" + name, in: Self.dir) }
  private func ansi(_ name: String) throws -> [String] { try RealScreens.rows("owed-capture/" + name + ".ansi", in: Self.dir) }

  /// The `ours` rule of `typeOwedPointer`: text at normal intensity in the box, and exactly our line.
  private func isOurs(_ name: String) throws -> Bool {
    let rows = try plain(name)
    let coloured = InputBoxAttributes.draftPresent(escapedRows: try ansi(name)) == true
    return PointerTyper.draftPresent(rows: rows) && coloured && PointerTyper.boxText(rows: rows) == PointerTyper.text
  }

  private func isDraft(_ name: String) throws -> Bool {
    let rows = try plain(name)
    let coloured = InputBoxAttributes.draftPresent(escapedRows: try ansi(name)) == true
    return PointerTyper.draftPresent(rows: rows) && coloured
  }

  private func boxRows(_ name: String) throws -> [String] {
    let rows = try plain(name)
    let box = try #require(PointerTyper.inputBox(rows: rows), "no input box in \(name)")
    return rows[box].map { $0.trimmingCharacters(in: .whitespaces) }
  }

  @Test func theFirstScreenIsTheInputBoxAndNotADraft() throws {
    let rows = try plain("01-first")
    #expect(PointerTyper.inputBox(rows: rows) != nil)
    #expect(rows.contains { $0.contains("Not logged in") } && rows.contains { $0.contains("auto mode on") }, "control: the logged-out auto-mode screen")
    let draft = try isDraft("01-first")
    #expect(!draft)
    let ours = try isOurs("01-first")
    #expect(!ours)
  }

  @Test(arguments: ["02-typed-120", "05-typed-40", "05-typed-30"])
  func ourLineReadsAsOurTextWhateverTheWidth(name: String) throws {
    #expect(PointerTyper.boxText(rows: try plain(name)) == PointerTyper.text, "\(name)")
    let ours = try isOurs(name)
    #expect(ours, "\(name)")
    let draft = try isDraft(name)
    #expect(draft, "\(name): it is text, so it is held like a draft unless it is ours")
  }

  /// Where Claude breaks the line: at spaces, the continuation rows indented two spaces and without the `❯`.
  @Test func theLineWrapsAtSpacesWithIndentedContinuationRows() throws {
    #expect(try boxRows("02-typed-120") == ["\u{276F}\u{00A0}Talos: new message in this thread. Call read_inbound."])
    #expect(try boxRows("05-typed-40") == ["\u{276F}\u{00A0}Talos: new message in this thread.", "Call read_inbound."])
    #expect(try boxRows("05-typed-30") == ["\u{276F}\u{00A0}Talos: new message in this", "thread. Call", "read_inbound."])
    for name in ["05-typed-40", "05-typed-30"] {
      let rows = try plain(name)
      let box = try #require(PointerTyper.inputBox(rows: rows))
      for r in rows[box].dropFirst() { #expect(r.hasPrefix("  ") && !r.hasPrefix("   ") && !r.contains("\u{276F}"), "\(name): \(r)") }
    }
  }

  @Test(arguments: [
    "03-after-burst-120", "03b-cleared-120", "04-after-split-120", "06-after-burst-40", "06b-cleared-40", "06-after-burst-30",
    "06b-cleared-30",
  ])
  func afterTheBackspacesTheBoxIsThereAndEmpty(name: String) throws {
    let rows = try plain(name)
    #expect(PointerTyper.inputBox(rows: rows) != nil, "\(name)")
    #expect(PointerTyper.boxText(rows: rows) == "", "\(name)")
    let draft = try isDraft(name)
    let ours = try isOurs(name)
    #expect(!draft, "\(name)")
    #expect(!ours, "\(name)")
  }
}
