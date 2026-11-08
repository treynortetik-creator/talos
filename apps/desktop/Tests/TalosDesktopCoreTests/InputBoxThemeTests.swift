import Foundation
import Testing
@testable import TalosDesktopCore

/// The input row in every Claude Code theme (REAL `capture-pane -e` captures, `input-e-theme-*`; the default dark theme is
/// `input-e-idle-placeholder`). The draft-by-colour rule must hold in all of them, and the row's encoding is pinned so that a
/// recapture with a new CLI that draws it differently fails here instead of quietly holding or typing over the pointer.
@Suite("Input box in every theme")
struct InputBoxThemeTests {
  static let themes = ["auto", "light", "dark-cb", "light-cb", "dark-ansi", "light-ansi"]

  @Test(arguments: themes)
  func thePlaceholderIsEmptyAndADraftIsADraft(theme: String) throws {
    #expect(InputBoxAttributes.draftPresent(escapedRows: try RealScreens.rows("input-e-theme-\(theme)-placeholder")) == false, "\(theme)")
    #expect(InputBoxAttributes.draftPresent(escapedRows: try RealScreens.rows("input-e-theme-\(theme)-draft")) == true, "\(theme)")
  }

  /// The raw input row: the last row whose plain text starts with the cursor and a no-break space.
  static func inputRow(_ name: String) throws -> String {
    try #require(try RealScreens.rows(name).last { InputBoxAttributes.stripEscapes($0).hasPrefix("\u{276F}\u{00A0}") }, "\(name)")
  }

  /// Every SGR sequence on a row, in order (`ESC[0;2m` -> "0;2").
  static func codes(_ row: String) -> [String] {
    let re = try! NSRegularExpression(pattern: "\u{1B}\\[([0-9;]*)m")
    return re.matches(in: row, range: NSRange(row.startIndex..., in: row)).compactMap { m in
      Range(m.range(at: 1), in: row).map { String(row[$0]) }
    }
  }

  @Test(arguments: themes.map { "input-e-theme-\($0)-placeholder" } + ["input-e-idle-placeholder"])
  func thePlaceholderRowIsDrawnTheKnownWay(name: String) throws {
    let row = try Self.inputRow(name)
    #expect(row.hasPrefix("\u{1B}[39m\u{276F}\u{00A0}\u{1B}[7m"), "\(name): the row no longer starts cursor, NBSP, reverse cell")
    // only the codes 2.1.318 uses: default colour, reverse cursor cell, dim (alone or after a reset), reset
    let seen = Set(Self.codes(row))
    #expect(seen.isSubset(of: ["39", "7", "0;2", "2", "0"]), "\(name): new codes on the input row: \(seen.sorted())")
    #expect(seen.contains("0;2") || seen.contains("2"), "\(name): the placeholder is no longer drawn dim")
  }

  @Test(arguments: themes.map { "input-e-theme-\($0)-draft" } + ["input-e-real-draft"])
  func theDraftRowIsDrawnTheKnownWay(name: String) throws {
    let row = try Self.inputRow(name)
    #expect(row == "\u{1B}[39m\u{276F}\u{00A0}hello draft\u{1B}[7m \u{1B}[0m", "\(name): the draft row changed: \(row.debugDescription)")
  }
}
