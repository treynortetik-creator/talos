import Foundation

/// Needs-you prompts: reads one of the three known dialogs off a worker's pane so a tap can answer it. Only what `DialogMatcher.liveDialog`
/// already calls trust, MCP consent or login-expired, and only when it can be read EXACTLY; anything else is nil and keeps today's
/// "open Terminals" line.
///
/// Read from real Claude Code captures (Tests/Fixtures/real-2.1.318 and real-2.1.319/needs-you-capture): after the last frame rule row the
/// dialog is its text, then a Select whose rows are NOT numbered, one of them carrying the `❯` cursor, every sibling aligned under the
/// cursor row's text, then `Enter to confirm · Esc to cancel` and nothing else. The cursor starts on a different row in each dialog (trust:
/// "No, exit", the first; MCP consent: the last), so the cursor row is always read, never assumed. Login is not a Select at all (the input
/// box stays, the footer says `Not logged in · Run /login`): it has a kind and nothing else.
///
/// With the escaped capture (`capture-pane -e`) given, it must show the same screen as the plain rows, the cursor row must be the coloured
/// one and every other option plain, and no option may be dim: the Select Claude draws, not text that looks like one.
public enum DialogReader {
  /// `devChannels` is Main's own warning about the development channel: it is published as `supervisor.main_dialog` (never read off a worker's pane by `read`).
  public enum Kind: String, Codable, Equatable, Sendable { case trust, mcpConsent = "mcp_consent", login, devChannels = "dev_channels" }

  public struct Dialog: Equatable, Sendable {
    public var kind: Kind
    /// The folder (trust) or the server name (MCP consent), only when it is on one row and so read whole. A path or name wrapped over rows
    /// can't be rejoined exactly, and a half is never offered.
    public var subject: String?
    /// The option rows, top to bottom, as drawn. Empty for login.
    public var options: [String]
    /// The row of the `❯` cursor in `options`; nil for login.
    public var cursor: Int?
    public init(kind: Kind, subject: String?, options: [String], cursor: Int?) {
      self.kind = kind
      self.subject = subject
      self.options = options
      self.cursor = cursor
    }
  }

  static let maxOptions = 6
  static let maxLabel = 120
  static let maxSubject = 500
  static let mcpHeader = "New MCP server found in this project"
  /// An option row, with its indent, at or past this many characters may be the first row of a wrapped label.
  static let maxRow = 62

  public static func read(rows: [String], escapedRows: [String]? = nil) -> Dialog? {
    if let escapedRows, normalized(rows) != normalized(escapedRows) { return nil }
    switch DialogMatcher.liveDialog(rows) {
    case .loginExpired: return Dialog(kind: .login, subject: nil, options: [], cursor: nil)
    case .trust: return readSelect(.trust, rows, escapedRows)
    case .mcpConsent: return readSelect(.mcpConsent, rows, escapedRows)
    default: return nil
    }
  }

  // MARK: the select

  private static func readSelect(_ kind: Kind, _ rows: [String], _ escaped: [String]?) -> Dialog? {
    guard let rule = rows.lastIndex(where: DialogMatcher.isFrameRule) else { return nil }
    let top = rule + 1
    let block = Array(rows[top...])
    let cursors = block.indices.filter { cursorColumn(block[$0]) != nil }
    guard cursors.count == 1, let c = cursors.first, let col = cursorColumn(block[c]) else { return nil }
    let labelCol = col + 2
    var first = c, last = c
    while first > 0, !isBlank(block[first - 1]) {
      guard label(block[first - 1], at: labelCol) != nil else { return nil }
      first -= 1
    }
    while last + 1 < block.count, !isBlank(block[last + 1]) {
      guard label(block[last + 1], at: labelCol) != nil else { return nil }
      last += 1
    }
    let options = (first...last).compactMap { i in i == c ? cursorLabel(block[i]) : label(block[i], at: labelCol) }
    guard options.count == last - first + 1, (2...maxOptions).contains(options.count),
      Set(options.map { $0.unicodeScalars.map(\.value) }).count == options.count,
      options.allSatisfy({ (1...maxLabel).contains($0.count) && !hasControl($0) })
    else { return nil }
    // A label that wraps goes on a continuation row aligned like an option, which would read as one more option. The first row of a wrapped
    // label runs to the pane's width (80 columns at the least, in the Terminals viewer), and the longest real row is 56 characters: a longer
    // row is a dialog nobody captured, and is refused.
    guard (first...last).allSatisfy({ block[$0].count < maxRow }) else { return nil }
    // the footer and nothing after it
    let after = block[(last + 1)...].filter { !isBlank($0) }
    guard after.count == 1, let f = after.first?.trimmingCharacters(in: .whitespaces), f.hasPrefix("Enter to confirm"), f.contains("Esc to cancel")
    else { return nil }
    let header = Array(block[0..<first])
    let subject: String?
    switch kind {
    case .trust:
      guard let h = header.lastIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "Accessing workspace:" }) else { return nil }
      subject = rowAfter(header, h)
    case .mcpConsent:
      guard let h = header.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix(mcpHeader) }) else { return nil }
      let t = header[h].trimmingCharacters(in: .whitespaces)
      if t == mcpHeader {
        subject = nil
      } else if t.hasPrefix(mcpHeader + ": ") {
        // the name is on this row; a wrapped one continues on the next, so the row below must be blank
        let name = String(t.dropFirst(mcpHeader.count + 2)).trimmingCharacters(in: .whitespaces)
        subject = h + 1 < header.count && isBlank(header[h + 1]) ? valid(name) : nil
      } else {
        return nil
      }
    case .login, .devChannels: return nil  // login has no select; Main's own warning is never read off a worker's pane
    }
    if let escaped, !intensityOK(escaped, top: top, options: first...last, cursor: c) { return nil }
    return Dialog(kind: kind, subject: subject, options: options, cursor: c - first)
  }

  /// "Accessing workspace:", a blank row, ONE row of text, a blank row: that row. Two rows are a wrapped path.
  private static func rowAfter(_ header: [String], _ h: Int) -> String? {
    guard h + 2 < header.count, isBlank(header[h + 1]) else { return nil }
    var run: [String] = []
    var k = h + 2
    while k < header.count, !isBlank(header[k]) {
      run.append(header[k])
      k += 1
    }
    guard run.count == 1, k < header.count else { return nil }
    return valid(run[0].trimmingCharacters(in: .whitespaces))
  }

  private static func valid(_ s: String) -> String? {
    guard (1...maxSubject).contains(s.count), !hasControl(s), !s.contains("\u{2026}") else { return nil }
    return s
  }

  private static func hasControl(_ s: String) -> Bool { s.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) } }

  private static func isBlank(_ row: String) -> Bool { row.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  /// The column of the `❯` when the row is spaces, `❯`, a space and text.
  private static func cursorColumn(_ row: String) -> Int? {
    let n = row.prefix { $0 == " " }.count
    let rest = row.dropFirst(n)
    guard rest.first == DialogMatcher.Strings.pointer else { return nil }
    let after = rest.dropFirst()
    guard after.first == " ", let t = after.dropFirst().first, t != " ", t != "\u{00A0}" else { return nil }
    return n
  }

  private static func cursorLabel(_ row: String) -> String? {
    let t = row.drop { $0 == " " }.dropFirst(2).trimmingCharacters(in: .whitespaces)
    return t.isEmpty ? nil : t
  }

  /// A sibling option: exactly `col` spaces, then text that is not another cursor.
  private static func label(_ row: String, at col: Int) -> String? {
    guard row.prefix(col).count == col, row.prefix(col).allSatisfy({ $0 == " " }) else { return nil }
    let rest = row.dropFirst(col)
    guard let f = rest.first, f != " ", f != "\u{00A0}", f != DialogMatcher.Strings.pointer else { return nil }
    let t = rest.trimmingCharacters(in: .whitespaces)
    return t.isEmpty ? nil : t
  }

  // MARK: the escaped capture

  /// Escapes removed, trailing white space and trailing blank rows dropped: what both captures of one screen have in common.
  private static func normalized(_ rows: [String]) -> [String] {
    var out = rows.map { InputBoxAttributes.stripEscapes($0).replacingOccurrences(of: "\r", with: "").trimmingCharacters(in: .whitespaces) }
    while let l = out.last, l.isEmpty { out.removeLast() }
    return out
  }

  /// The cursor row coloured all the way, the other options not at all, none dim. The state is carried from row to row: tmux writes only
  /// the changes, so a row's first colour change may be a reset of the row above.
  private static func intensityOK(_ escaped: [String], top: Int, options: ClosedRange<Int>, cursor: Int) -> Bool {
    var fg = false, dim = false
    for (r, raw) in escaped.enumerated() {
      var visible = 0, coloured = 0, dimmed = 0
      let chars = Array(raw)
      var i = 0
      while i < chars.count {
        if chars[i] == "\u{1B}" {
          guard i + 1 < chars.count, chars[i + 1] == "[" else { i += 2; continue }
          var j = i + 2
          var params = ""
          while j < chars.count, !(chars[j].asciiValue.map { $0 >= 0x40 && $0 <= 0x7E } ?? true) {
            params.append(chars[j])
            j += 1
          }
          if j < chars.count, chars[j] == "m" { apply(params, fg: &fg, dim: &dim) }
          i = j + 1
          continue
        }
        if chars[i] != " " && chars[i] != "\u{00A0}" {
          visible += 1
          if fg { coloured += 1 }
          if dim { dimmed += 1 }
        }
        i += 1
      }
      guard let k = options.first(where: { top + $0 == r }) else { continue }
      if dimmed > 0 { return false }
      if k == cursor {
        if visible == 0 || coloured != visible { return false }
      } else if coloured > 0 {
        return false
      }
    }
    return true
  }

  /// SGR codes: 0 resets, 2 and 22 are dim, 30-37, 90-97 and 38 set a foreground colour (38 takes `5;n` or `2;r;g;b`), 39 clears it. Others
  /// change neither.
  private static func apply(_ params: String, fg: inout Bool, dim: inout Bool) {
    let codes = params.split(omittingEmptySubsequences: false, whereSeparator: { $0 == ";" || $0 == ":" }).map { $0.isEmpty ? 0 : (Int($0) ?? -1) }
    var i = 0
    while i < codes.count {
      switch codes[i] {
      case 0: fg = false; dim = false
      case 2: dim = true
      case 22: dim = false
      case 30...37, 90...97: fg = true
      case 38:
        fg = true
        if i + 1 < codes.count { i += codes[i + 1] == 5 ? 2 : (codes[i + 1] == 2 ? 4 : 0) }
      case 48:
        if i + 1 < codes.count { i += codes[i + 1] == 5 ? 2 : (codes[i + 1] == 2 ? 4 : 0) }
      case 39: fg = false
      default: break
      }
      i += 1
    }
  }
}

/// Text compared character for character, as the contract says: by unicode scalars. Swift's own `==` calls "e\u{301}" and "\u{E9}" the same, and a
/// label or a folder name is a thing the owner is asked to approve.
public enum ExactText {
  public static func equal(_ a: String, _ b: String) -> Bool { a.unicodeScalars.elementsEqual(b.unicodeScalars) }
  public static func equal(_ a: String?, _ b: String?) -> Bool {
    switch (a, b) {
    case (nil, nil): return true
    case (let x?, let y?): return equal(x, y)
    default: return false
    }
  }
  public static func equal(_ a: [String], _ b: [String]) -> Bool { a.count == b.count && zip(a, b).allSatisfy { equal($0, $1) } }
}
