import Foundation

/// Is there a draft in Claude's input box? Read from `tmux capture-pane -e` (real 2.1.318 captures, Tests/Fixtures/real-2.1.318): the
/// plain text of the idle placeholder (`❯` NBSP `Try "…"`) and of a draft are the same, even a draft that reads `Try "…"`. The colours
/// differ: the placeholder is dim (SGR 2) apart from one reverse-video cursor cell (SGR 7), and anything drawn at normal intensity is
/// the owner's. The state is tracked across the whole row, code by code, left to right. Only 0 (and an empty code), 1, 2, 7, 22, 27 and
/// 39 are known; any other code counts as "not dim", which reads as a draft: the safe side, a pointer is never typed onto text.
public enum InputBoxAttributes {
  /// `ESC [ … m` and any other CSI sequence removed.
  public static func stripEscapes(_ s: String) -> String {
    var out = ""
    var it = s.makeIterator()
    while let ch = it.next() {
      if ch == "\u{1B}" {
        guard let next = it.next() else { break }
        if next == "[" { while let c = it.next(), !(c.asciiValue.map { $0 >= 0x40 && $0 <= 0x7E } ?? false) {} }
        continue
      }
      out.append(ch)
    }
    return out
  }

  struct Cell {
    var ch: Character
    var dim: Bool
    var reverse: Bool
  }

  /// The visible characters of a row with the attributes they were drawn with. `dim` and `reverse` carry on from `state`.
  static func cells(_ row: String, dim: inout Bool, reverse: inout Bool) -> [Cell] {
    var out: [Cell] = []
    let chars = Array(row)
    var i = 0
    while i < chars.count {
      let ch = chars[i]
      if ch == "\u{1B}", i + 1 < chars.count, chars[i + 1] == "[" {
        var j = i + 2
        var params = ""
        while j < chars.count, !(chars[j].asciiValue.map { $0 >= 0x40 && $0 <= 0x7E } ?? true) {
          params.append(chars[j])
          j += 1
        }
        if j < chars.count, chars[j] == "m" {
          for code in params.split(separator: ";", omittingEmptySubsequences: false) {
            switch code.isEmpty ? "0" : String(code) {
            case "0": dim = false; reverse = false
            case "1", "39": break
            case "2": dim = true
            case "22": dim = false
            case "7": reverse = true
            case "27": reverse = false
            default: dim = false
            }
          }
        }
        i = j + 1
        continue
      }
      out.append(Cell(ch: ch, dim: dim, reverse: reverse))
      i += 1
    }
    return out
  }

  /// nil: no input box on the screen. Otherwise whether the owner has text in it.
  public static func draftPresent(escapedRows: [String]) -> Bool? {
    let plain = escapedRows.map(stripEscapes)
    guard let box = PointerTyper.inputBox(rows: plain) else { return nil }
    var dim = false, reverse = false
    var all: [Cell] = []
    for r in box {
      var cs = cells(escapedRows[r], dim: &dim, reverse: &reverse)
      if r == box.lowerBound {
        // the glyph and the one separator after it are not the text
        if let g = cs.firstIndex(where: { $0.ch == DialogMatcher.Strings.pointer }) {
          cs = Array(cs[(g + 1)...])
          if let f = cs.first, f.ch == " " || f.ch == "\u{00A0}" { cs.removeFirst() }
        }
      }
      all += cs
    }
    let visible = all.filter { !$0.ch.isWhitespace && $0.ch != "\u{00A0}" }
    let normal = visible.contains { !$0.dim && !$0.reverse }
    let reversed = visible.contains { !$0.dim && $0.reverse }
    let dimmed = visible.contains { $0.dim }
    return normal || (reversed && !dimmed)
  }
}
