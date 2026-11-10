import Foundation

/// A prompt of the CLI's that Talos has no name for, found from its SHAPE on the screen (not its words): a tool permission, the
/// agent's own question, any Select waiting on a keypress. The known four dialogs keep their own handling (`DialogMatcher`); this
/// answers `nil` for them, so nothing is announced twice. Read from real 2.1.318 captures (Tests/Fixtures/real-2.1.318, README).
///
/// The rule, all of it:
/// - one `❯` cursor row with text after it, and in the same block of rows (no blank row, no frame rule between) at least one
///   sibling option whose text lines up with the cursor's text (numbered or not; a `✔` marker may stand in front of the label). A
///   cursor alone under a second rule (the agent's `4. Chat about this`) finds its siblings in the block right above that rule;
/// - the prompt's region, from the nearest frame rule above the options (`────`; none on the first-run Selects, then from the
///   question) to the bottom of the screen, holds that one `❯` and no other (the `❯ ` rows of the history are above the rule);
/// - the last row of the screen is not Claude's status bar (`? for shortcuts`, `mode on`, `shift+tab to cycle`): that is the idle
///   input box, whose `❯` is followed by free text or a placeholder;
/// - the cursor block is not an input box: a frame rule right above it AND right below it;
/// - none of the known dialogs, and not the dev-channels dialog whether or not its title is still on the pane.
/// The footer (`Esc to cancel`, `Enter to select · ↑/↓ to navigate · Esc to cancel` …) is supporting evidence, never required.
public enum PromptDetector {
  public enum Kind: Equatable, Sendable { case bashCommand, fileCreate, fileEdit, question, other }

  public struct Prompt: Equatable, Sendable {
    public var kind: Kind
    /// The first line of the question, cleaned for a notice (one line, no control characters, at most 100 characters). nil when the
    /// row above the options is transcript chrome (`✻ Worked for 2s`, `⏺ …`, `⎿ …`) and not a question.
    public var question: String?
    /// One of the CLI's footer lines was the last row.
    public var footer: Bool
    /// The prompt's own rows (the stillness is measured on these, not on the transcript above them).
    public var region: [String]
    /// What the prompt is, with nothing that depends on the pane's width or on the owner's keys: the text of the region without its
    /// rules, `╌` boxes, footer and option rows (so not the cursor, and not what is typed into "Type something."), all whitespace
    /// removed. A resize, a cursor move or typing leaves it as it was; another command or question changes it.
    public var signature: String
    /// Seconds left on Claude Code's own "will automatically block this request" countdown (the dangerous-rm prompt shows it even in
    /// bypass mode and blocks the call itself when it runs out); nil when the prompt has none. Read from the frame, then masked: the
    /// ticking digits are in neither the region nor the signature.
    public var autoBlockSeconds: Int?

    /// The signature as a short name (FNV-1a), for records on disk that must not keep a command line.
    public var hash: String {
      var h: UInt64 = 0xcbf2_9ce4_8422_2325
      for b in signature.utf8 { h = (h ^ UInt64(b)) &* 0x100_0000_01b3 }
      return String(h, radix: 16)
    }

    /// The name in the owner's words; nil when the kind can't be told.
    public var title: String? {
      switch kind {
      case .bashCommand: return "Bash command"
      case .fileCreate: return "file create"
      case .fileEdit: return "file edit"
      case .question: return "question"
      case .other: return nil
      }
    }
  }

  static let footers = [
    "Esc to cancel", "Esc to cancel \u{00B7} Tab to amend", "Enter to select \u{00B7} \u{2191}/\u{2193} to navigate \u{00B7} Esc to cancel",
    "Enter to confirm \u{00B7} Esc to cancel",
    "Esc to cancel \u{00B7} Tab to amend \u{00B7} ctrl+x ctrl+k twice to stop background agents",
  ]
  /// The idle input box's status bar, in every mode captured.
  static let statusBar = ["? for shortcuts", "mode on", "shift+tab to cycle"]
  private static let space: Set<Character> = [" ", "\u{00A0}"]
  private static let edge: Set<Character> = ["\u{2502}", "\u{2503}", "\u{2551}"]
  private static let chrome: Set<Character> = ["\u{273B}", "\u{23FA}", "\u{23BF}"]

  /// Column of the first character that is not padding or a box edge, and the text from there.
  private static func lead(_ row: String) -> (col: Int, text: Substring) {
    var col = 0
    var s = Substring(row)
    while let f = s.first, space.contains(f) || edge.contains(f) {
      s = s.dropFirst()
      col += 1
    }
    return (col, s)
  }

  private static func isBlank(_ row: String) -> Bool { lead(row).text.isEmpty }
  private static func isDashedBox(_ row: String) -> Bool {
    let t = lead(row).text
    return !t.isEmpty && t.allSatisfy { $0 == "\u{254C}" }
  }
  private static func isRule(_ row: String) -> Bool { DialogMatcher.isFrameRule(row) }

  /// The tab header of the agent's questions: `☐ Color`, or `← ☐ Color  ☐ Size  ✔ Submit →` for several.
  private static func isQuestionHeader(_ row: String) -> Bool {
    let t = lead(row).text
    return t.hasPrefix("\u{2610}") || (t.hasPrefix("\u{2190}") && t.contains("\u{2610}"))
  }

  /// `❯ label`: the cursor column and the label's column; nil when it is not a cursor row with something after it.
  private static func cursor(_ row: String) -> (col: Int, label: Int)? {
    let l = lead(row)
    guard l.text.first == DialogMatcher.Strings.pointer else { return nil }
    var rest = l.text.dropFirst()
    var label = l.col + 1
    while let f = rest.first, space.contains(f) {
      rest = rest.dropFirst()
      label += 1
    }
    guard label > l.col + 1, !rest.isEmpty else { return nil }
    if rest.hasPrefix("\u{2714} ") { label += 2 }
    return (l.col, label)
  }

  private static func isSibling(_ row: String, label: Int) -> Bool {
    let l = lead(row)
    if l.col == label { return !isDashedBox(row) }
    return l.col == label - 2 && l.text.hasPrefix("\u{2714} ")
  }

  /// Claude's idle input box is on screen (its status bar is the last row): whatever prompt was there is over.
  public static func isIdle(_ rows: [String]) -> Bool {
    var tail = rows
    while let l = tail.last, isBlank(l) { tail.removeLast() }
    guard let bottom = tail.last.map(DialogMatcher.clean) else { return false }
    return statusBar.contains(where: bottom.contains)
  }

  /// The countdown row of Claude Code's own auto-block (` ⚠ Claude Code will automatically block this request in 1:54, to avoid …`):
  /// its seconds, and the rows with its digits masked. Only a row that says "automatically block" is touched (digits in a command or a
  /// question are not).
  static func maskCountdown(_ rows: [String]) -> (rows: [String], seconds: Int?) {
    var seconds: Int?
    let masked = rows.map { row -> String in
      guard row.contains("automatically block") else { return row }
      if let r = row.range(of: #"\d+:\d\d"#, options: .regularExpression) {
        let parts = row[r].split(separator: ":").compactMap { Int($0) }
        if parts.count == 2 { seconds = parts[0] * 60 + parts[1] }
        return row.replacingCharacters(in: r, with: "#:##")
      }
      if let r = row.range(of: #"\d+ ?(seconds|s)\b"#, options: .regularExpression) {
        seconds = Int(row[r].prefix(while: { $0.isNumber }))
        return row.replacingCharacters(in: r, with: "#s")
      }
      return row
    }
    return (masked, seconds)
  }

  public static func detect(_ rows: [String]) -> Prompt? {
    var tail = rows
    while let l = tail.last, isBlank(l) { tail.removeLast() }
    guard !tail.isEmpty else { return nil }
    let counted = maskCountdown(tail)
    tail = counted.rows
    let cleaned = tail.map(DialogMatcher.clean)
    if let bottom = cleaned.last, statusBar.contains(where: bottom.contains) { return nil }
    if DialogMatcher.liveDialog(tail) != .none { return nil }
    // The dev-channels dialog has no rule above its title; on a short pane the title is gone but the options are not.
    if case .devChannels = DialogMatcher.classify(tail) { return nil }
    if cleaned.contains(where: { $0.contains(DialogMatcher.Strings.devConfirm) }) { return nil }

    for c in tail.indices.reversed() {
      guard let cur = cursor(tail[c]) else { continue }
      // the block of rows around the cursor: no blank row and no frame rule inside it
      var first = c, last = c
      while first > 0, !isBlank(tail[first - 1]), !isRule(tail[first - 1]) { first -= 1 }
      while last + 1 < tail.count, !isBlank(tail[last + 1]), !isRule(tail[last + 1]) { last += 1 }
      // an input box is its block between two rules
      if first > 0, last + 1 < tail.count, isRule(tail[first - 1]), isRule(tail[last + 1]) { continue }
      var siblings = (first...last).filter { $0 != c && isSibling(tail[$0], label: cur.label) }
      // the cursor alone under a second rule: its options are the block right above that rule
      var upper: ClosedRange<Int>?
      if siblings.isEmpty, first >= 2, isRule(tail[first - 1]), !isBlank(tail[first - 2]), !isRule(tail[first - 2]) {
        var uf = first - 2
        while uf > 0, !isBlank(tail[uf - 1]), !isRule(tail[uf - 1]) { uf -= 1 }
        let above = (uf...(first - 2)).filter { isSibling(tail[$0], label: cur.label) }
        if !above.isEmpty {
          siblings = above
          upper = uf...(first - 2)
        }
      }
      guard let seed = siblings.min().map({ upper != nil ? $0 : min($0, c) }) else { continue }
      let blockFirst = upper?.lowerBound ?? first
      // where the options start: up from the first option while rows are options or their descriptions
      var top = seed
      while top > blockFirst, isSibling(tail[top - 1], label: cur.label) || lead(tail[top - 1]).col > cur.label { top -= 1 }
      // the question: the group of rows right above the options (blank rows skipped), its first row
      var q = top - 1
      while q >= 0, isBlank(tail[q]) { q -= 1 }
      var group: [Int] = []
      while q >= 0, !isBlank(tail[q]), !isRule(tail[q]), !isDashedBox(tail[q]), !isQuestionHeader(tail[q]) {
        group.append(q)
        q -= 1
      }
      let questionRow = group.last
      // the prompt's region: from the nearest frame rule above its options (or its question) to the bottom
      let rule = tail[..<blockFirst].lastIndex(where: isRule)
      let start = rule ?? questionRow ?? 0
      let region = Array(tail[start...])
      guard region.filter({ lead($0).text.first == DialogMatcher.Strings.pointer }).count == 1 else { continue }
      switch DialogMatcher.classify(region) {
      case .trust, .mcpConsent, .bypassDisclaimer, .loginExpired, .devChannels: return nil
      default: break
      }
      let footer = footers.contains(cleaned[tail.count - 1])
      return Prompt(
        kind: kind(of: region, question: questionRow.map { cleaned[$0] }),
        question: questionRow.flatMap { question(from: tail[$0]) }, footer: footer, region: region,
        signature: signature(tail, from: start, optionsFrom: top, label: cur.label, footer: footer),
        autoBlockSeconds: region.contains(where: { $0.contains("automatically block") }) ? counted.seconds : nil)
    }
    return nil
  }

  private static func kind(of region: [String], question: String?) -> Kind {
    let rows = region.map(DialogMatcher.clean)
    // a header may say who asks: `Bash command · from the general-purpose agent`
    func header(_ h: String) -> Bool { rows.contains { $0 == h || $0.hasPrefix(h + " \u{00B7} ") } }
    if header("Bash command") { return .bashCommand }
    if header("Create file") { return .fileCreate }
    if header("Edit file") || question?.hasPrefix("Do you want to make this edit") == true { return .fileEdit }
    if region.contains(where: isQuestionHeader) { return .question }
    return .other
  }

  /// Screen text in a notice: one line, no control characters, no double quotes (the notice quotes it), 100 characters at most. nil for
  /// transcript chrome, which is the agent's output and not the question.
  private static func question(from row: String) -> String? {
    let cleaned = DialogMatcher.clean(row)
    if let f = cleaned.first, chrome.contains(f) { return nil }
    let text = cleaned.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.map(String.init).joined()
      .replacingOccurrences(of: "\"", with: "'")
    let one = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    if one.isEmpty { return nil }
    return one.count > 100 ? String(one.prefix(100)) + "\u{2026}" : one
  }

  /// From the first option on, the option rows (the cursor's, its siblings and their descriptions, wherever they stand, so also the one
  /// under a second rule) are left out: which one the cursor is on, and what is typed into "Type something.", are not the prompt.
  private static func signature(_ rows: [String], from start: Int, optionsFrom top: Int, label: Int, footer: Bool) -> String {
    var keep: [String] = []
    for i in start..<rows.count where !isRule(rows[i]) && !isDashedBox(rows[i]) {
      if footer, i == rows.count - 1 { continue }
      if i >= top, cursor(rows[i]) != nil || isSibling(rows[i], label: label) || lead(rows[i]).col > label { continue }
      keep.append(String(lead(rows[i]).text))
    }
    return keep.joined().filter { !$0.isWhitespace && $0 != "\u{00A0}" }
  }
}

/// When a prompt counts, and when it is over. Fed once per look at the screen. A prompt is announced after its region has held still
/// for `settle` (the transcript above it may blink; the region does not include that), once, however long it stays and wherever the
/// owner moves the cursor; a different prompt in its place is announced after its own wait. `hold` (an attached client has typed
/// lately: the owner's own picker, or the owner at the keys) starts the wait over with every look. It is over when it has been gone for
/// `clearAfter` (a redraw for a moment is not the end) or at once when the idle input box is on screen (`idle`); one that comes back
/// after that is a new one.
public struct PromptWatch: Sendable {
  public init() {}
  /// The prompt announced and not yet over.
  public private(set) var current: PromptDetector.Prompt?
  private var seen: PromptDetector.Prompt?
  private var stillSince: Double = 0
  private var goneSince: Double?
  private var screen: [String]?
  private var screenSince: Double = 0

  public enum Change: Equatable, Sendable { case none, appeared(PromptDetector.Prompt), cleared }

  /// Whether the whole screen has held still for `settle` (fed once per look).
  public mutating func screenStill(_ rows: [String], at t: Double, settle: Double) -> Bool {
    if screen != rows {
      screen = rows
      screenSince = t
    }
    return t - screenSince >= settle
  }

  public mutating func observe(
    _ p: PromptDetector.Prompt?, at t: Double, settle: Double = 5, clearAfter: Double = 2, hold: Bool = false, idle: Bool = false
  ) -> Change {
    guard let p else {
      seen = nil
      guard current != nil else { return .none }
      if idle {
        current = nil
        goneSince = nil
        return .cleared
      }
      if goneSince == nil { goneSince = t }
      guard let gone = goneSince, t - gone >= clearAfter else { return .none }
      current = nil
      goneSince = nil
      return .cleared
    }
    goneSince = nil
    if seen?.region != p.region {
      seen = p
      stillSince = t
    }
    if hold { stillSince = t }
    if let cur = current, cur.signature == p.signature {
      current = p  // the cursor moved or the footer changed: the same prompt
      return .none
    }
    guard !hold, t - stillSince >= settle else { return .none }
    current = p
    return .appeared(p)
  }
}

/// How long a worker's pane has shown no dialog shape at all, repaints or not. Fed once per look. A held needs-you flag clears when this
/// says gone: a pane whose status line repaints faster than `settle` never has a settled screen, so stillness cannot say it.
public struct DialogAbsence: Sendable {
  public init() {}
  private var since: Double?

  /// `present`: a dialog or prompt shape is on the screen now. True once none has been for `settle` running; a shape back starts over.
  public mutating func gone(present: Bool, at t: Double, settle: Double) -> Bool {
    guard !present else {
      since = nil
      return false
    }
    if since == nil { since = t }
    return t - (since ?? t) >= settle
  }

  public mutating func reset() { since = nil }
}
