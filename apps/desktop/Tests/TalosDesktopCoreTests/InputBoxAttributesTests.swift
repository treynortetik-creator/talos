import Foundation
import Testing
@testable import TalosDesktopCore

/// Is there a draft in Claude's input box? The plain text of a placeholder (`❯` NBSP `Try "…"`) and of a draft is the same, so the
/// colours decide (`InputBoxAttributes`): dim text and the one reverse-video cursor cell are a placeholder, anything at normal
/// intensity is a draft. The four `input-e-*` captures are REAL (`capture-pane -e`); the rest are SYNTHETIC rows.
@Suite("Input box draft by attributes")
struct InputBoxAttributesTests {
  @Test(arguments: [
    ("input-e-idle-placeholder", false), ("input-e-real-draft", true), ("input-e-draft-looks-like-placeholder", true),
    ("input-e-cleared", false),
  ])
  func theRealCapturesSayWhetherThereIsADraft(name: String, draft: Bool) throws {
    #expect(InputBoxAttributes.draftPresent(escapedRows: try RealScreens.rows(name)) == draft, "\(name)")
  }

  /// The plain text is the same for the placeholder and the draft that reads like it: that is why the plain check cannot decide.
  @Test func theRealPlainTextOfThePlaceholderAndOfADraftLikeItAreTheSame() throws {
    func plainInput(_ name: String) throws -> String {
      let rows = try RealScreens.rows(name).map { InputBoxAttributes.stripEscapes($0) }
      return try #require(rows.first { $0.hasPrefix("\u{276F}\u{00A0}") }).trimmingCharacters(in: .whitespaces)
    }
    #expect(try plainInput("input-e-draft-looks-like-placeholder") == "\u{276F}\u{00A0}Try \"fix lint errors\"")
    #expect(PointerTyper.draftPresent(rows: try RealScreens.rows("input-e-idle-placeholder").map { InputBoxAttributes.stripEscapes($0) }))
  }

  @Test(arguments: ["empty-input", "turn-done", "after-esc"])
  func thePlainCapturesWithAnEmptyBoxAreNotDrafts(name: String) throws {
    #expect(!PointerTyper.draftPresent(rows: try RealScreens.rows(name)))
    #expect(InputBoxAttributes.draftPresent(escapedRows: try RealScreens.rows(name)) == false, "no colours: only the text counts")
  }

  @Test func thePlainDraftCaptureIsStillADraft() throws {
    #expect(PointerTyper.draftPresent(rows: try RealScreens.rows("draft-input")))
    #expect(InputBoxAttributes.draftPresent(escapedRows: try RealScreens.rows("draft-input")) == true)
  }

  // SYNTHETIC rows from here: the state is tracked across the whole row, code by code, left to right.
  private let rule = String(repeating: "\u{2500}", count: 40)
  private func box(_ input: String) -> [String] { ["output", rule, input, rule, "  ? for shortcuts"] }
  private let esc = "\u{1B}["

  @Test func syntheticDimThenResetThenNormalTextIsADraft() {
    #expect(InputBoxAttributes.draftPresent(escapedRows: box("\u{276F}\u{00A0}\(esc)2mTry \(esc)0mhello")) == true)
    #expect(InputBoxAttributes.draftPresent(escapedRows: box("\u{276F}\u{00A0}\(esc)2mTry \(esc)mhello")) == true, "an empty ESC[m is a reset")
  }

  @Test func syntheticDimThenCancelledByTwentyTwoThenTextIsADraft() {
    #expect(InputBoxAttributes.draftPresent(escapedRows: box("\u{276F}\u{00A0}\(esc)2mTry \(esc)22mhello")) == true)
  }

  @Test func syntheticCombinedCodesApplyLeftToRight() {
    // 0;2 resets then dims: all dim, a placeholder
    #expect(InputBoxAttributes.draftPresent(escapedRows: box("\u{276F}\u{00A0}\(esc)7mT\(esc)0;2mry here\(esc)0m")) == false)
    // 2;22 dims then cancels: normal text
    #expect(InputBoxAttributes.draftPresent(escapedRows: box("\u{276F}\u{00A0}\(esc)2;22mhello\(esc)0m")) == true)
    // reverse cancelled by 27, then text: normal
    #expect(InputBoxAttributes.draftPresent(escapedRows: box("\u{276F}\u{00A0}\(esc)7mT\(esc)27mext\(esc)0m")) == true)
  }

  @Test func syntheticUnknownCodesCountAsNotDim() {
    #expect(InputBoxAttributes.draftPresent(escapedRows: box("\u{276F}\u{00A0}\(esc)2m\(esc)3mitalic words\(esc)0m")) == true)
    // a colour is an unknown code too (and so are its operands): the safe side, a draft
    #expect(InputBoxAttributes.draftPresent(escapedRows: box("\u{276F}\u{00A0}\(esc)2;38;5;244mgrey placeholder\(esc)0m")) == true)
  }

  @Test func syntheticACursorCellAloneIsEmptyAndAOneLetterDraftUnderTheCursorIsNot() {
    #expect(InputBoxAttributes.draftPresent(escapedRows: box("\u{276F}\u{00A0}\(esc)7m \(esc)0m")) == false)
    #expect(InputBoxAttributes.draftPresent(escapedRows: box("\u{276F}\u{00A0}\(esc)7mx\(esc)0m")) == true, "no dim text with it: the letter is a draft")
  }

  @Test func syntheticNoBoxIsNoAnswer() {
    #expect(InputBoxAttributes.draftPresent(escapedRows: ["no box here"]) == nil)
    #expect(InputBoxAttributes.draftPresent(escapedRows: []) == nil)
  }
}
