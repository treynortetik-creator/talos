import Foundation

/// The two Selects Claude Code draws that a phone card or a Mac popup can answer (pane-prompts plan rows 8 and 9): a TOOL PERMISSION (a Bash
/// command, a file create or edit: `Do you want to proceed?`, numbered rows, `Esc to cancel · Tab to amend`) and the agent's own QUESTION
/// (AskUserQuestion: `☐ Color`, the question, numbered rows, `Enter to select · ↑/↓ to navigate · Esc to cancel`). Read from the real 2.1.318
/// captures (Tests/Fixtures/real-2.1.318: bash-permission, write-permission, perm-*, askuser-select).
///
/// The reader is exact. A screen it cannot read whole is nil: no card, no key. It anchors from the bottom (the footer, the numbered rows right
/// above it, the question row above those) so the text of a command or a file, which an agent writes, can never be taken for the Select: the
/// rows of a `╌` box are the subject and nothing else. The two footers are told apart on purpose: a tool permission's is `Esc to cancel…`, a
/// question's is `Enter to select · ↑/↓ to navigate · Esc to cancel`; the MCP, bypass and trust dialogs end `Enter to confirm · Esc to cancel`
/// and are read by `DialogReader`, never here.
///
/// `bound` is what an answer is tied to: the kind, the tool, the subject and every numbered row, and NOT the cursor, the countdown, the
/// footer or the description rows (they change without the question changing). The key gate compares a fresh read's `bound` with the one
/// the offer was made for, before every key (`KeyGuard.Intent.pane`).
public enum PaneSelect {
  public enum Kind: String, Codable, Sendable, Equatable {
    case toolPermission = "tool_permission"
    case agentQuestion = "agent_question"
  }

  public struct Row: Equatable, Sendable {
    /// The number drawn in front of the row: the key that selects it.
    public var number: Int
    public var label: String
  }

  public struct Screen: Equatable, Sendable {
    public var kind: Kind
    /// The tool's header as drawn (`Bash command`, `Create file`, `Edit file`, with `· from the … agent` when a sub-agent asks); nil for a question.
    public var tool: String?
    /// What the owner approves or answers: the command or the file for a tool, the question for a question. One exact text.
    public var subject: String
    public var rows: [Row]
    /// The row of the `❯` cursor in `rows`.
    public var cursor: Int
    /// A question's free-text row (`3. Type something.`), when it has one.
    public var freeText: Int?
    /// Tool permission: the row that allows this once (`Yes`) and the row that denies (`No`). Nil for a question.
    public var allow: Int?
    public var deny: Int?
    public var bound: String
    /// With `freeTextAt` given and the cursor on that row: what the row actually shows now (the owner's typing). nil otherwise.
    public var typed: String?

    /// What a card or popup shows in its subject box: the tool, then the command or file (`Bash command · touch a`); the question for a question.
    /// Never past 500 characters (a longer one is not a screen this reader reads).
    public var displaySubject: String { tool.map { "\($0) \u{00B7} \(subject)" } ?? subject }
  }

  /// The label Claude draws on the question's free-text row, until the owner types into it.
  public static let freeTextLabel = "Type something."
  /// What the card calls the free-text option.
  public static let otherLabel = "Other\u{2026}"
  public static let allowLabel = "Allow once"
  public static let denyLabel = "Deny"
  public static let maxSubject = 500
  /// Between the rows of a command that takes several: shown as one line (a real line break would be marked as a hidden character on a card).
  public static let rowBreak = " \u{23CE} "
  static let maxLabel = 120
  static let toolHeaders = ["Bash command", "Create file", "Edit file"]
  static let toolFooters = [
    "Esc to cancel", "Esc to cancel \u{00B7} Tab to amend",
    "Esc to cancel \u{00B7} Tab to amend \u{00B7} ctrl+x ctrl+k twice to stop background agents",
  ]
  /// The question's footer as 2.1.329 draws it: with the cursor on a row, and once the digit of the free-text row has focused its field (the footer then
  /// offers `ctrl+g to edit in VS Code`; captured: Tests/Fixtures/real-2.1.329/askuser-field-focused.txt). Both exactly; never the tool permission's.
  static let questionFooters = [
    "Enter to select \u{00B7} \u{2191}/\u{2193} to navigate \u{00B7} Esc to cancel",
    "Enter to select \u{00B7} \u{2191}/\u{2193} to navigate \u{00B7} ctrl+g to edit in VS Code \u{00B7} Esc to cancel",
  ]
  /// The row under the divider that ends the question and starts a chat instead. It is not an answer: a card never offers it.
  static let chatLabel = "Chat about this"
  /// The longest free-text answer: what one row of the pane can show back, so the Mac can confirm the words before it presses Enter.
  public static let maxAnswer = 120

  // MARK: reading

  /// The Select on the pane, or nil. `freeTextAt`: the row index that is the free-text row, when the offer already knows it (the owner's
  /// typing replaced its label, so that one row may read as anything while the cursor is on it).
  public static func read(rows all: [String], freeTextAt: Int? = nil) -> Screen? {
    var tail = PromptDetector.maskQueueCounter(all.map { $0.replacingOccurrences(of: "\r", with: "") })
    while let l = tail.last, DialogMatcher.clean(l).isEmpty || l.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { tail.removeLast() }
    guard let footer = tail.last.map(DialogMatcher.clean) else { return nil }
    // the known dialogs (and the usage-limit screen) are never these
    if DialogMatcher.liveDialog(tail) != .none || UsageLimitScreen.read(tail) != nil { return nil }
    if toolFooters.contains(footer) { return readTool(tail) }
    if questionFooters.contains(footer) { return readQuestion(tail, freeTextAt: freeTextAt) }
    return nil
  }

  /// A question with several tabs (`← ☐ Color  ☐ Size  ✔ Submit →`): the card does not take these, the owner answers them at the Mac.
  public static func isMultiQuestion(_ all: [String]) -> Bool {
    var tail = all
    while let l = tail.last, l.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { tail.removeLast() }
    guard let f = tail.last.map(DialogMatcher.clean), questionFooters.contains(f) else { return false }
    return tail.suffix(30).contains { r in
      let t = DialogMatcher.clean(r)
      return (t.hasPrefix("\u{2190}") && t.contains("\u{2610}")) || (t.contains("\u{2610}") && t.contains("Submit"))
    }
  }

  private static func isDashedBox(_ row: String) -> Bool {
    let t = row.trimmingCharacters(in: .whitespaces)
    return !t.isEmpty && t.allSatisfy { $0 == "\u{254C}" }
  }

  private static func isBlank(_ row: String) -> Bool { row.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  /// `❯ 2. label` or `  2. label`: the number, the label, whether the cursor is on it, and the column the label starts at.
  private static func numbered(_ row: String) -> (n: Int, label: String, cursor: Bool, col: Int)? {
    var chars = Substring(row)
    var col = 0
    while chars.first == " " {
      chars = chars.dropFirst()
      col += 1
    }
    var cursor = false
    if chars.first == DialogMatcher.Strings.pointer {
      cursor = true
      chars = chars.dropFirst()
      col += 1
      guard chars.first == " " else { return nil }
      while chars.first == " " {
        chars = chars.dropFirst()
        col += 1
      }
    }
    let digits = chars.prefix { $0.isASCII && $0.isNumber }
    guard (1...2).contains(digits.count), let n = Int(digits) else { return nil }
    let rest = chars.dropFirst(digits.count)
    guard rest.hasPrefix(". ") else { return nil }
    let label = rest.dropFirst(2).trimmingCharacters(in: .whitespaces)
    guard !label.isEmpty else { return nil }
    return (n, label, cursor, col + digits.count + 2)
  }

  private static func hasControl(_ s: String) -> Bool { s.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) } }

  private static func exactText(_ s: String) -> String? {
    guard (1...maxSubject).contains(s.count), !hasControl(s), !s.contains("\u{2026}"), !s.contains("\u{FFFD}") else { return nil }
    return s
  }

  /// The numbered rows right above `end` (exclusive), top to bottom, with the index of the first. Rows between them that are not numbered
  /// (a description under an option, indented deeper than its label) are skipped when `descriptions` is true.
  private static func optionRows(_ t: [String], above end: Int, descriptions: Bool) -> (first: Int, rows: [(n: Int, label: String, cursor: Bool, index: Int)])? {
    var out: [(n: Int, label: String, cursor: Bool, index: Int)] = []
    var i = end - 1
    var pending: [Int] = []  // description rows seen (below their option) and not yet claimed by the numbered row above them
    while i >= 0 {
      if let r = numbered(t[i]) {
        guard pending.allSatisfy({ leadingSpaces(t[$0]) >= r.col }) else { return nil }
        pending = []
        out.append((r.n, r.label, r.cursor, i))
      } else if descriptions, !isBlank(t[i]), !DialogMatcher.isFrameRule(t[i]) {
        pending.append(i)
      } else {
        break
      }
      i -= 1
    }
    // rows left over above the top option are the question's own text (2.1.329 draws no blank row between it and the options), not descriptions
    guard let first = out.last?.index else { return nil }
    return (first, out.reversed())
  }

  private static func leadingSpaces(_ r: String) -> Int { r.prefix { $0 == " " }.count }

  private static func finish(_ kind: Kind, tool: String?, subject: String, found: [(n: Int, label: String, cursor: Bool, index: Int)], freeTextAt: Int?) -> Screen? {
    guard (2...6).contains(found.count), found.enumerated().allSatisfy({ $0.element.n == $0.offset + 1 }),
      Set(found.map { $0.label.unicodeScalars.map(\.value) }).count == found.count,
      found.allSatisfy({ (1...maxLabel).contains($0.label.count) && !hasControl($0.label) }),
      found.filter(\.cursor).count == 1, let cursor = found.firstIndex(where: \.cursor)
    else { return nil }
    var rows = found.map { Row(number: $0.n, label: $0.label) }
    var free = rows.firstIndex { $0.label == freeTextLabel }
    var typed: String?
    // the owner's typing replaced the free-text row's label: the offer knows which row that is, and the cursor is on it
    if let at = freeTextAt, kind == .agentQuestion, rows.indices.contains(at), cursor == at {
      typed = rows[at].label
      rows[at].label = freeTextLabel
      free = at
    } else if let at = freeTextAt, free != at {
      return nil
    }
    var allow: Int?, deny: Int?
    if kind == .toolPermission {
      guard let a = rows.firstIndex(where: { $0.label == "Yes" }), let d = rows.firstIndex(where: { $0.label == "No" }), a != d else { return nil }
      allow = a
      deny = d
    }
    let bound = ([kind.rawValue, tool ?? "", subject] + rows.map { "\($0.number). \($0.label)" }).joined(separator: "\u{1F}")
    let screen = Screen(kind: kind, tool: tool, subject: subject, rows: rows, cursor: cursor, freeText: free, allow: allow, deny: deny, bound: bound, typed: typed)
    return screen.displaySubject.count <= maxSubject ? screen : nil
  }

  // MARK: a tool permission

  /// Anchored from the QUESTION row upward, never from a rule or a header found by looking for one: a command or a file is text an agent writes, and
  /// it can contain its own rule row, its own `Bash command` and its own `╌` rows to make the reader start inside it. So the screen above the question
  /// must be exactly one prompt: ONE frame rule in all the rows above it, the header right under that rule, exactly two `╌` rows after the header
  /// (the box), and no row of the box's body that is a header. Anything else is no prompt (no card, the line says so).
  private static func readTool(_ t: [String]) -> Screen? {
    var end = t.count - 1
    while end > 0, isBlank(t[end - 1]) { end -= 1 }
    guard let opts = optionRows(t, above: end, descriptions: false), opts.first >= 2 else { return nil }
    let qAt = opts.first - 1
    let question = DialogMatcher.clean(t[qAt])
    guard question.hasPrefix("Do you want"), question.hasSuffix("?"), exactText(question) != nil else { return nil }
    let rules = (0..<qAt).filter { DialogMatcher.isFrameRule(t[$0]) }
    guard rules.count == 1, let top = rules.first, top + 1 < qAt else { return nil }
    let headerAt = top + 1
    let header = DialogMatcher.clean(t[headerAt])
    guard toolHeaders.contains(where: { header == $0 || header.hasPrefix($0 + " \u{00B7} from the ") }), exactText(header) != nil else { return nil }
    guard t[top...].filter({ DialogMatcher.clean($0).first == DialogMatcher.Strings.pointer }).count == 1 else { return nil }
    let dashes = (headerAt + 1..<qAt).filter { isDashedBox(t[$0]) }
    guard dashes.count == 2 else { return nil }
    let open = dashes[0], close = dashes[1]
    // no row of the body is itself a header (a forged prompt inside the command or the diff)
    for r in t[(open + 1)..<close] {
      let c = DialogMatcher.clean(r)
      if toolHeaders.contains(where: { c == $0 || c.hasPrefix($0 + " ") }) { return nil }
    }
    let subject: String
    if header.hasPrefix("Bash command") {
      let lines = t[(open + 1)..<close].map { $0.trimmingCharacters(in: .whitespaces) }
      guard !lines.isEmpty, !lines.contains(where: \.isEmpty), lines.allSatisfy({ exactText($0) != nil }) else { return nil }
      subject = lines.joined(separator: rowBreak)
    } else {
      // a file: the path is the one row between the header and the diff
      let path = t[(headerAt + 1)..<open].filter { !isBlank($0) }
      guard path.count == 1, let p = exactText(path[0].trimmingCharacters(in: .whitespaces)) else { return nil }
      subject = p
    }
    return finish(.toolPermission, tool: header, subject: subject, found: opts.rows, freeTextAt: nil)
  }

  // MARK: the agent's question

  /// Anchored the same way: from the footer up through the numbered rows (and the one divider before the last row), then the question, then the ONE frame
  /// rule above the whole thing with `☐ <label>` right under it. A rule or a `☐` row inside the question's text is no question.
  private static func readQuestion(_ t: [String], freeTextAt: Int?) -> Screen? {
    var end = t.count - 1
    while end > 0, isBlank(t[end - 1]) { end -= 1 }
    let rules = (0..<end).filter { DialogMatcher.isFrameRule(t[$0]) }
    guard (1...2).contains(rules.count), let top = rules.first, top + 1 < end, !isMultiQuestion(t) else { return nil }
    guard DialogMatcher.clean(t[top + 1]).hasPrefix("\u{2610} ") else { return nil }
    guard let opts = optionRows(t, above: end, descriptions: true) else { return nil }
    var rowsFound = opts.rows
    var first = opts.first
    if rules.count == 2 {
      // the divider stands right before the last row, which is the only row under it
      let mid = rules[1]
      guard opts.rows.count == 1, mid == end - 2 || mid == end - 3, mid < first, let upper = optionRows(t, above: mid, descriptions: true) else { return nil }
      rowsFound = upper.rows + opts.rows
      first = upper.first
    }
    guard first > top + 1, t[top...].filter({ DialogMatcher.clean($0).first == DialogMatcher.Strings.pointer }).count == 1 else { return nil }
    // the question: the rows between the header and the first option, as one text
    let q = t[(top + 2)..<first].filter { !isBlank($0) }.map { $0.trimmingCharacters(in: .whitespaces) }
    guard !q.isEmpty, q.count <= 4, !q.contains(where: { DialogMatcher.clean($0).hasPrefix("\u{2610}") }), let subject = exactText(q.joined(separator: " "))
    else { return nil }
    return finish(.agentQuestion, tool: nil, subject: subject, found: rowsFound, freeTextAt: freeTextAt)
  }

  // MARK: what is offered, and how a choice becomes a key

  /// The options a card or a popup shows. A tool permission offers `Allow once` and `Deny` and nothing else: the rows that grant more than this
  /// once (always allow, switch to auto mode, accept edits) are a standing grant and stay at the Mac. A question offers every row as read,
  /// the free-text row as `Other…`.
  public static func offered(_ s: Screen) -> [String] {
    switch s.kind {
    case .toolPermission: return [allowLabel, denyLabel]
    case .agentQuestion: return (0..<answerRows(s)).map { $0 == s.freeText ? otherLabel : s.rows[$0].label }
    }
  }

  /// How many of a question's rows are answers: every row but `Chat about this` when it is the last (it ends the question and starts a chat; it is not offered).
  static func answerRows(_ s: Screen) -> Int { s.rows.last?.label == chatLabel ? s.rows.count - 1 : s.rows.count }

  /// The row a card's option stands for.
  public static func row(_ s: Screen, forOption i: Int) -> Int? {
    switch s.kind {
    case .toolPermission:
      if i == 0 { return s.allow }
      if i == 1 { return s.deny }
      return nil
    case .agentQuestion: return (0..<answerRows(s)).contains(i) ? i : nil
    }
  }

  /// The free-text option's index (the same index in `offered`), when the question has one.
  public static func freeTextOption(_ s: Screen) -> Int? { s.kind == .agentQuestion ? s.freeText : nil }

  /// The text a free-text answer may carry: one line, 1 to 120 characters, no control or invisible character (refused, never stripped: what is
  /// typed is what the owner wrote). nil: not typed at all.
  public static func cleanAnswerText(_ text: String) -> String? {
    let t = text.trimmingCharacters(in: .whitespaces)
    guard (1...maxAnswer).contains(t.count), DialogVisibleText.show(t) == t, !hasControl(t) else { return nil }
    return t
  }
}
