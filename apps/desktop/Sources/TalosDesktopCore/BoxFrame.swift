import Foundation

/// Claude's own input box, positively: its frame (a solid rule, the `❯` row, a solid rule) with only the status rows Claude Code draws under
/// it. Shared by the key guard (`KeyGuard`: typing goes only into this box) and the usage-limit reader (`UsageLimitScreen`: a menu above this
/// live box is quoted in the conversation, not live). The Linux supervisor's twin is apps/bridge/src/supervisor/box-frame.ts; the two read
/// the same rows the same way.
public enum BoxFrame {
  /// One part of a status row under the box (rows are split on runs of two or more spaces and on " · "), digits read as N. Taken from every
  /// real capture with an input box (Tests/Fixtures/real-*): the permission mode, its hints, the effort, the sign-in reminder.
  static let statusParts: [NSRegularExpression] = [
    // the mode head, only as the captures show it (`modeHead`)
    #"^(?:⏸ manual mode on|⏸ plan mode on|⏵⏵ accept edits on|⏵⏵ auto mode on|⏵⏵ bypass permissions on)(?: \(shift\+tab(?: to cycle\))?)?$"#,
    #"^\? for shortcuts$"#,
    #"^← for agents$"#,
    #"^/tasks to see subagents$"#,
    #"^esc to interrupt$"#,
    #"^↓ to manage$"#,
    // a background shell the session started (real-2.1.325-queued: "1 shell", the count read as N)
    #"^N shells?$"#,
    // a todo list on screen (real-2.1.325-status/todo-busy)
    #"^ctrl\+t to hide tasks$"#,
    #"^Not logged in$"#,
    #"^Run /login$"#,
    #"^[◐◑◒◓○●◔◕] (?:low|medium|high|xhigh|max)$"#,
    #"^/effort$"#,
    // the hint after a cleared draft and the tmux notice (real-2.1.318/input-e-cleared, input-e-idle-placeholder)
    #"^Ctrl\+Y to paste deleted text$"#,
    #"^tmux focus-events off$"#,
    #"^add 'set -g focus-events on' to ~/\.tmux\.conf and reattach for focus tracking$"#,
  ].map { try! NSRegularExpression(pattern: $0) }

  /// JavaScript's white space and line terminators: what `\s` and `trim()` mean in the Linux twin (box-frame.ts). ICU's `\s` and
  /// Foundation's `.whitespaces` are other sets, so the rows are split and trimmed with this one and both sides read a row alike.
  static let jsSpaceClass = #"[\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]"#
  static let jsSpace: CharacterSet = CharacterSet(charactersIn: "\t\n\u{0B}\u{0C}\r \u{A0}\u{1680}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
    .union(CharacterSet(charactersIn: "\u{2000}"..."\u{200A}"))

  /// A whole status row of its own shape: the agents panel (real-2.1.322/idle-agents-panel), the main session's row exactly, and a
  /// subagent's row with its name, task, time and tokens. (Talos's own thread status line: `talosStatusLine`.) `\w` and `\s` spelled
  /// as JavaScript reads them (ASCII word characters, `jsSpaceClass`).
  static let statusRows: [NSRegularExpression] = [
    #"^⏺ main$"#,
    // a subagent's row: its name, its task (cut with "…" or left out on a narrow pane), its time and, when the pane has room, its token
    // count with either arrow (real-2.1.322/idle-agents-panel; real-2.1.325-status/subagent-busy at 120, 60 and 30 columns)
    #"^◯ [A-Za-z0-9_.-]+(?: \(\+N\))?(?:"# + jsSpaceClass + #"{2,}\S.*?)?"# + jsSpaceClass
      + #"+Ns(?: · [↑↓](?: N(?:\.N)?k? tokens)?)?$"#,
  ].map { try! NSRegularExpression(pattern: $0) }

  /// The status line Talos sets in every thread session's own settings (WorkerSpec, WorkerUsage.recorderSource), the same text on Linux
  /// (the protocol's USAGE_RECORDER_PY): "Talos", then ": <model>" (a letter or digit first, then at most 7 of [A-Za-z0-9 .()+-]; the
  /// recorder cuts the name at 8, so the row fits a 30-column pane, which Claude Code cuts at 26) when there is a model, then
  /// " | 7d: N%" (0 to 100) when there is a reading and a model (no percentage without a model). ASCII digits only (`[0-9]`: ICU's `\d` takes any script's) and `\z`, never `$` (which also stops
  /// before a final line break). Matched on the row's first part as drawn (`rowKind`); at most one such row under the box
  /// (`strangeRowUnder`). The longest is 26 characters ("Talos: Sonnet 4 | 7d: 100%").
  static let talosStatusLine = try! NSRegularExpression(
    pattern: #"^Talos(?:: [A-Za-z0-9][A-Za-z0-9 .()+\-]{0,7}(?: \| 7d: (?:100|[1-9]?[0-9])%)?)?\z"#)

  /// old recorder row: thread sessions started before the prefix change print it until they restart; remove after the release following
  /// this one. Only its form with the percentage, "<model> | 7d: N%" (the old recorder's model, up to 40, N 0 to 100), matched as
  /// `talosStatusLine` is; never starting with the word "Talos" (that row is `talosStatusLine`'s alone); the bare model-only form stays
  /// refused. It counts against the same one-row limit as `talosStatusLine` (`strangeRowUnder`).
  /// Tightened after Fable R3: the old recorder printed Claude Code's display name for the model, so the old row's model starts with a
  /// model family (Opus, Sonnet, Haiku, Fable, Claude, case-sensitive), then the end of the name or a space and at most 32 more of
  /// [A-Za-z0-9 .()+-]. Without it any 40 characters before " | 7d: N%" passed ("Approve (y) or deny (n) | 7d: 0%"). box-frame.ts, the same.
  static let oldRecorderRow = try! NSRegularExpression(
    pattern: #"^(?:Opus|Sonnet|Haiku|Fable|Claude)(?: [A-Za-z0-9 .()+\-]{0,32})? \| 7d: (?:100|[1-9]?[0-9])%\z"#)

  /// The whole of `s` matches `r`: a match that stops short of the end (ICU's `$` before a final line break) is no match.
  static func matches(_ r: NSRegularExpression, _ s: String) -> Bool {
    let n = (s as NSString).length
    guard let m = r.firstMatch(in: s, range: NSRange(location: 0, length: n)) else { return false }
    return m.range.location == 0 && m.range.length == n
  }

  /// `s` with JavaScript's `trim()`.
  static func jsTrim(_ s: String) -> String {
    let u = Array(s.unicodeScalars)
    var a = 0, b = u.count
    while a < b, jsSpace.contains(u[a]) { a += 1 }
    while b > a, jsSpace.contains(u[b - 1]) { b -= 1 }
    var v = String.UnicodeScalarView()
    v.append(contentsOf: u[a..<b])
    return String(v)
  }

  /// Digits read as N, ASCII only (JavaScript's `\d`).
  static func digitsAsN(_ s: String) -> String { s.replacingOccurrences(of: "[0-9]+", with: "N", options: .regularExpression) }

  static let partBreak = try! NSRegularExpression(pattern: jsSpaceClass + "{2,}| · ")

  /// A row's parts, as box-frame.ts splits it (`split(/\s{2,}| · /)`): on runs of two or more spaces and on " · ".
  static func parts(_ s: String) -> [String] {
    let ns = s as NSString
    var out: [String] = []
    var from = 0
    for m in partBreak.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
      out.append(ns.substring(with: NSRange(location: from, length: m.range.location - from)))
      from = m.range.location + m.range.length
    }
    out.append(ns.substring(from: from))
    return out
  }

  static func claudePart(_ p: String) -> Bool {
    let t = digitsAsN(jsTrim(p))
    return statusParts.contains { matches($0, t) }
  }

  /// The parts Claude Code may cut at the pane's edge, digits read as N: the last part of a status row on a narrow pane is drawn as the
  /// start of one of these and "…" (real-2.1.325-queued/busy-30: "esc to…").
  static let cuttableParts = [
    "esc to interrupt", "? for shortcuts", "← for agents", "/tasks to see subagents", "↓ to manage", "N shell", "N shells",
    "Not logged in", "Run /login", "/effort", "ctrl+t to hide tasks",
  ]

  /// The last part of a row, cut at the pane's edge: at least two characters of a `cuttableParts` entry, then "…".
  static func cutPart(_ p: String) -> Bool {
    let t = digitsAsN(jsTrim(p))
    guard t.hasSuffix("…") else { return false }
    let head = String(t.dropLast())
    return head.count >= 2 && cuttableParts.contains { $0.hasPrefix(head) && $0 != head }
  }

  /// Every part one Claude Code draws, the last one possibly cut at the pane's edge (`cutPart`).
  static func claudeParts(_ ps: [String]) -> Bool {
    guard let last = ps.last else { return true }
    return ps.dropLast().allSatisfy(claudePart) && (claudePart(last) || cutPart(last))
  }

  enum RowKind { case claude, recorder }

  // MARK: status parts Talos does not know (Pantheon's spec after Fable R3, both sides; the shared table's `status_row_vectors`)

  /// The most characters one unknown part may have, and the most unknown parts one row may carry.
  static let unknownPartMax = 24
  static let unknownPartsPerRow = 2
  /// The heads of Claude Code's status row that may open unknown parts, exactly as the captures show them (real-2.1.318 to 2.1.325):
  /// the mode glyph and words, then optionally " (shift+tab to cycle)" or its cut " (shift+tab". Any other head (a mode Talos has not
  /// seen) reads the row exactly: unknown parts on it refuse, and the head's shape goes to the audit.
  static let modeHead = try! NSRegularExpression(
    pattern: #"^(?:⏸ manual mode on|⏸ plan mode on|⏵⏵ accept edits on|⏵⏵ auto mode on|⏵⏵ bypass permissions on)(?: \(shift\+tab(?: to cycle\))?)?\z"#)
  /// The general shape of a mode head (a glyph, lower-case words, "on"): one that is not a `modeHead` is a mode Talos has not seen, read
  /// exactly and audited.
  static let modeLike = try! NSRegularExpression(pattern: #"^(?:⏸|⏵⏵) [a-z ]+ on(?: \(shift\+tab(?: to cycle\))?)?\z"#)
  /// One unknown part's shape, positively: ASCII lower-case letters, digits, space and / + . : , - only.
  static let unknownShapeRule = try! NSRegularExpression(pattern: #"^[a-z0-9 /+.:,\-]{1,24}\z"#)
  /// A single short word (four letters or fewer) is never an unknown part: a select's "yes", "deny", "ok" would be one.
  static let shortWord = try! NSRegularExpression(pattern: #"^[a-z]{1,4}\z"#)
  /// An option's number first ("1. yes", "2) no"): never an unknown part (Pantheon after Fable R3).
  static let optionFirst = try! NSRegularExpression(pattern: #"^[0-9]+[.)]"#)
  /// The word "enter" (a select's footer), on the part as it is (unknown parts are lower case ASCII): never an unknown part.
  static let enterWord = try! NSRegularExpression(pattern: #"\benter\b"#)

  /// One part Talos does not know that may still sit on Claude's status row (`unknownShapeRule`, not a `shortWord`, not an option number
  /// first, `optionFirst`, no "y/n" and not the word "enter" in it; a hint shaped "x to y" stays one by design), read on the
  /// part trimmed. Anything else on a row that opens unknown parts refuses the row (and its shape goes to the audit, `refusedShape`).
  static func unknownPart(_ p: String) -> Bool {
    let t = jsTrim(p)
    let range = NSRange(location: 0, length: (t as NSString).length)
    return matches(unknownShapeRule, t) && !matches(shortWord, t) && optionFirst.firstMatch(in: t, range: range) == nil && !t.contains("y/n")
      && enterWord.firstMatch(in: t, range: range) == nil
  }

  /// A control character, a format character (bidi, zero-width) or the replacement for a lone surrogate: the whole row is refused.
  static func hasHiddenScalars(_ s: String) -> Bool {
    s.unicodeScalars.contains { u in
      u.value == 0xFFFD || u.properties.generalCategory == .control || u.properties.generalCategory == .format
    }
  }

  /// An unknown part as its shape, for the audit: letters a, decimal digits N, everything else kept, at most 40 code points. Never the text.
  public static func unknownShape(_ p: String) -> String {
    var v = String.UnicodeScalarView()
    for u in jsTrim(p).unicodeScalars.prefix(40) {
      switch u.properties.generalCategory {
      case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter: v.append("a")
      case .decimalNumber: v.append("N")
      default: v.append(u)
      }
    }
    return String(v)
  }

  /// A refused part (or head) as its length and its character kinds, for the audit: "<code points>:<kinds>", the kinds in this order:
  /// a (ASCII lower case), A (ASCII upper case), N (ASCII digit), s (space), p (other ASCII punctuation), u (anything else); "Press Y"
  /// is "7:aAs". Never the text. The Linux supervisor's shape, the same.
  public static func refusedShape(_ p: String) -> String {
    let t = jsTrim(p)
    var seen = Set<Character>()
    for u in t.unicodeScalars {
      switch u.value {
      case 0x61...0x7A: seen.insert("a")
      case 0x41...0x5A: seen.insert("A")
      case 0x30...0x39: seen.insert("N")
      case 0x20: seen.insert("s")
      case 0x21...0x7E: seen.insert("p")
      default: seen.insert("u")
      }
    }
    return "\(t.unicodeScalars.count):" + String("aANspu".filter(seen.contains))
  }

  /// A row under the box as read: Claude's own or Talos's, with the parts Talos does not know on it.
  struct RowReading {
    var kind: RowKind
    var unknown: [String]
  }

  /// How one row reads: accepted, or refused (with, when it was refused for a part's shape or an unseen mode head, that shape).
  enum RowRead {
    case row(RowReading)
    case refused(shape: String?)
  }

  /// Claude Code's own status row (or blank), Talos's row (its first part, `talosStatusLine` or for one release `oldRecorderRow`; Claude
  /// Code's own parts may follow it on the row, as on a wide pane: real-2.1.323-statusline/thread), or neither. A row whose first part is
  /// one of Claude's mode heads (`modeHead`) or Talos's current row may also carry up to `unknownPartsPerRow` parts Talos does not know
  /// (`unknownPart`); the last part may be a known one cut at the edge. The old recorder row opens none. Any other row is read
  /// exactly. A row with a hidden character is refused whole. box-frame.ts `rowKind`.
  static func readRowDetailed(_ row: String) -> RowRead {
    let raw = DialogMatcher.clean(row)
    if hasHiddenScalars(raw) { return .refused(shape: nil) }
    let c = digitsAsN(raw)
    if c.isEmpty { return .row(RowReading(kind: .claude, unknown: [])) }
    if statusRows.contains(where: { matches($0, c) }) { return .row(RowReading(kind: .claude, unknown: [])) }
    let ps = parts(raw)
    if claudeParts(ps) { return .row(RowReading(kind: .claude, unknown: [])) }
    let first = jsTrim(ps[0])
    let current = matches(talosStatusLine, first)
    let ours = current || matches(oldRecorderRow, first)
    let rest = Array(ps.dropFirst())
    if ours && claudeParts(rest) { return .row(RowReading(kind: .recorder, unknown: [])) }
    // only a mode head seen in the captures, or Talos's current row, opens unknown parts. A mode head of the general mode-part shape
    // that is not one of them: the row reads exactly (refused), and the head's shape is audited
    let head = matches(modeHead, first)
    guard current || head else {
      return matches(modeLike, digitsAsN(first)) ? .refused(shape: "mode " + refusedShape(first)) : .refused(shape: nil)
    }
    var unknown: [String] = []
    for (i, p) in rest.enumerated() {
      if claudePart(p) || (i == rest.count - 1 && cutPart(p)) { continue }
      guard unknownPart(p) else { return .refused(shape: refusedShape(p)) }
      unknown.append(jsTrim(p))
    }
    guard unknown.count <= unknownPartsPerRow else { return .refused(shape: nil) }
    return .row(RowReading(kind: current ? .recorder : .claude, unknown: unknown))
  }

  static func readRow(_ row: String) -> RowReading? {
    if case .row(let r) = readRowDetailed(row) { return r }
    return nil
  }

  static func rowKind(_ row: String) -> RowKind? { readRow(row)?.kind }

  /// The shapes (`unknownShape`) of the parts Talos does not know on the rows under the box (`rows`: without escapes; `bottomRule`: the
  /// box's bottom rule), for the audit.
  public static func unknownShapes(_ rows: [String], bottomRule: Int) -> [String] {
    guard bottomRule + 1 < rows.count else { return [] }
    return rows[(bottomRule + 1)...].flatMap { readRow($0)?.unknown ?? [] }.map(unknownShape)
  }

  /// The shapes (`refusedShape`) of the parts that refused rows under the box for their shape, and of mode heads Talos has not seen,
  /// for the audit (`status_part_refused`): what a new Claude Code draws there that Talos should capture and add.
  public static func refusedShapes(_ rows: [String], bottomRule: Int) -> [String] {
    guard bottomRule + 1 < rows.count else { return [] }
    return rows[(bottomRule + 1)...].compactMap { r in
      if case .refused(let shape?) = readRowDetailed(r) { return shape }
      return nil
    }
  }

  /// The row is (or begins with) Talos's own thread status line (`rowKind`).
  public static func isTalosStatusLine(_ row: String) -> Bool { rowKind(row) == .recorder }

  /// One row under the input box is a status row Claude Code draws there (or blank). Talos's own row is not one (`isTalosStatusLine`).
  public static func statusRow(_ row: String) -> Bool { rowKind(row) == .claude }

  /// The first row under the box that is not a status row (its cleaned text), or nil when every row is one. `bottomRule`: the box's
  /// bottom rule row. Strict: a user's own status line is not a status row; Talos's own is allowed once (`rowKind`).
  public static func strangeRowUnder(_ rows: [String], bottomRule: Int) -> String? {
    guard bottomRule + 1 < rows.count else { return nil }
    var talosRows = 0
    var unknownRows = 0
    for i in (bottomRule + 1)..<rows.count {
      // a solid rule (another frame; `clean` would read it as blank) is never a status row
      if DialogMatcher.isFrameRule(rows[i]) { return String(rows[i].trimmingCharacters(in: .whitespaces).prefix(20)) }
      guard let read = readRow(rows[i]) else { return DialogMatcher.clean(rows[i]) }
      let kind = read.kind
      // parts Talos does not know: on one row under the box at most
      if !read.unknown.isEmpty {
        unknownRows += 1
        if unknownRows > 1 { return DialogMatcher.clean(rows[i]) }
      }
      // Talos's own status line is one row, new form or old (`oldRecorderRow`): a second of either is not it
      if kind == .recorder {
        talosRows += 1
        if talosRows > 1 { return DialogMatcher.clean(rows[i]) }
      }
    }
    return nil
  }

  /// Claude's input box is the live frame: the last box on the pane (`PointerTyper.inputBox`; rows without escapes, trailing blanks
  /// dropped) with only status rows under it. The rows inside it (its bottom rule is `upperBound`), or nil.
  public static func liveBox(_ rows: [String]) -> Range<Int>? {
    var all = rows
    while let l = all.last, l.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { all.removeLast() }
    guard let box = PointerTyper.inputBox(rows: all), strangeRowUnder(all, bottomRule: box.upperBound) == nil else { return nil }
    return box
  }

  /// The text in the box EXACTLY as typed, or nil when it is not drawn the way Claude Code draws typed text: the first row is the pointer
  /// and one space (a no-break space, as Claude Code draws it, or an ASCII one) then the text, each wrapped row two spaces then the text,
  /// rows broken at single spaces, no run of spaces inside.
  public static func exactBoxText(_ rows: [String], box: Range<Int>) -> String? {
    var parts: [String] = []
    for i in box {
      var r = Substring(rows[i])
      while r.last == " " { r = r.dropLast() }
      let prefixes = i == box.lowerBound ? ["\(DialogMatcher.Strings.pointer)\u{00A0}", "\(DialogMatcher.Strings.pointer) "] : ["  "]
      guard let prefix = prefixes.first(where: { r.hasPrefix($0) }) else { return nil }
      let t = r.dropFirst(prefix.count)
      guard let f = t.first, !f.isWhitespace, !t.contains("  "), !t.contains("\t"), !t.contains("\u{00A0}") else { return nil }
      parts.append(String(t))
    }
    return parts.isEmpty ? nil : parts.joined(separator: " ")
  }
}
