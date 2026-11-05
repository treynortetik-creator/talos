import Foundation

/// Reads the agent's screen (DESKTOP-SPEC 4.3 steps 3 and 7, 4.4). Every CLI string lives in `Strings`, pinned to the
/// tested CLI range; an unknown screen is never answered, only reported.
public enum DialogMatcher {
  /// The CLI versions these strings were read from (OBSERVED in the 2.1.312 binary, 2026-10-29/30).
  public static let testedCLIVersions: ClosedRange<CLIVersion> = CLIVersion(2, 1, 312)...CLIVersion(2, 1, 312)

  public enum Strings {
    public static let devTitle = "WARNING: Loading development channels"
    public static let channelsPrefix = "Channels:"
    public static let devConfirm = "I am using this for local development"
    /// The selection cursor in front of the focused option (SMOKE S3 confirms the rendering).
    public static let pointer: Character = "❯"
    /// The registration notice once channels are live: "Channels (experimental) messages from <…> inject directly in
    /// this session · restart without <flag> to stop".
    public static let noticeStart = "Channels (experimental) messages from"
    public static let noticeEnd = "inject directly in this session"
    public static let resumeMissing = "No session found with ID"
    /// What `--resume <id>` itself prints in the CLI (read from 2.1.314); `resumeMissing` is the other path's wording.
    public static let resumeMissingConversation = "No conversation found with session ID"
    public static let trust = ["Yes, I trust this folder", "Yes, I trust these settings"]
    public static let mcpConsent = ["New MCP server found in this project", "new MCP servers found in this project"]
    public static let bypass = "WARNING: Claude Code running in Bypass Permissions mode"
    public static let login = ["Please run /login", "Run /login", "Not logged in", "OAuth token has expired"]
  }

  public struct DevChannels: Equatable, Sendable {
    /// Entries of the `Channels:` line, nil when the line wasn't found.
    public var channels: [String]?
    /// Text of the one highlighted row (cursor stripped), nil when there are none or more than one.
    public var highlighted: String?
    /// How many times the title is on screen (more than one = ambiguous, never confirmed).
    public var titleCount: Int
    public var channelLineCount: Int
  }

  public enum Screen: Equatable, Sendable {
    case devChannels(DevChannels)
    case trust
    case mcpConsent
    case bypassDisclaimer
    case loginExpired
    case resumeMissing
    /// A selection cursor in front of a numbered option we don't know.
    case unknownSelection
    case none

    public var isDialog: Bool { self != .none && self != .resumeMissing }

    public var label: String {
      switch self {
      case .devChannels: return "dev-channel warning"
      case .trust: return "folder trust"
      case .mcpConsent: return "MCP server consent"
      case .bypassDisclaimer: return "bypass-permissions disclaimer"
      case .loginExpired: return "login expired"
      case .resumeMissing: return "conversation not found"
      case .unknownSelection: return "an unknown question"
      case .none: return "nothing"
      }
    }
  }

  /// Strips borders and padding a dialog box may draw around a row.
  public static func clean(_ row: String) -> String {
    let box: Set<Character> = ["│", "┃", "║", "╭", "╮", "╰", "╯", "─", "━", "┌", "┐", "└", "┘"]
    var s = Substring(row)
    while let f = s.first, f == " " || f == "\t" || box.contains(f) { s = s.dropFirst() }
    while let l = s.last, l == " " || l == "\t" || box.contains(l) { s = s.dropLast() }
    return String(s)
  }

  static func isHighlighted(_ cleaned: String) -> Bool { cleaned.first == Strings.pointer }

  /// `❯ 2. Something`: a cursor in front of a numbered option.
  static func isIndexedCursor(_ cleaned: String) -> Bool {
    guard isHighlighted(cleaned) else { return false }
    let s = cleaned.dropFirst().drop { $0 == " " }
    guard let dot = s.firstIndex(of: ".") else { return false }
    return !s[..<dot].isEmpty && s[..<dot].allSatisfy(\.isNumber)
  }

  /// The highlighted row's label: cursor and a `1. ` index removed.
  static func label(ofHighlighted cleaned: String) -> String {
    var s = cleaned.dropFirst().drop { $0 == " " }
    if let dot = s.firstIndex(of: "."), s[..<dot].allSatisfy(\.isNumber), !s[..<dot].isEmpty {
      s = s[s.index(after: dot)...].drop { $0 == " " }
    }
    return String(s).trimmingCharacters(in: .whitespaces)
  }

  public static func classify(_ rows: [String]) -> Screen {
    let cleaned = rows.map(clean)
    let joined = cleaned.joined(separator: "\n")
    if joined.contains(Strings.resumeMissing) || joined.contains(Strings.resumeMissingConversation) { return .resumeMissing }

    let titles = cleaned.filter { $0.contains(Strings.devTitle) }.count
    // The dialog is on screen only with its selection: a title alone is what an answered dialog leaves behind (or a line
    // that quotes it) and must not hold the "press Enter" question open. A pane too short for the title reads as an unknown
    // question (the owner is told, nothing is confirmed): a highlighted row alone, without the title, can be quoted text.
    if titles > 0 && cleaned.contains(where: isIndexedCursor) {
      let channelRows = cleaned.filter { $0.hasPrefix(Strings.channelsPrefix) }
      var channels: [String]?
      if channelRows.count == 1, let at = cleaned.firstIndex(where: { $0.hasPrefix(Strings.channelsPrefix) }) {
        // Ink hard-wraps the list at the pane width and `capture-pane -J` can't re-join that, so the rows after
        // `Channels:` up to the blank line belong to it (D1-REVIEW finding 4). Empty entries are kept: a dangling
        // comma never shortens the list.
        var text = String(cleaned[at].dropFirst(Strings.channelsPrefix.count))
        var k = at + 1
        while k < cleaned.count, !cleaned[k].trimmingCharacters(in: .whitespaces).isEmpty {
          text += " " + cleaned[k]
          k += 1
        }
        let t = text.trimmingCharacters(in: .whitespaces)
        channels = t.isEmpty ? [] : t.split(separator: ",", omittingEmptySubsequences: false).map {
          $0.trimmingCharacters(in: .whitespaces)
        }
      }
      let hl = cleaned.filter(isHighlighted)
      return .devChannels(
        DevChannels(
          channels: channels, highlighted: hl.count == 1 ? label(ofHighlighted: hl[0]) : nil, titleCount: titles,
          channelLineCount: channelRows.count))
    }
    if Strings.trust.contains(where: joined.contains) { return .trust }
    if Strings.mcpConsent.contains(where: joined.contains) { return .mcpConsent }
    if joined.contains(Strings.bypass) { return .bypassDisclaimer }
    if Strings.login.contains(where: joined.contains) { return .loginExpired }
    if cleaned.contains(where: isIndexedCursor) { return .unknownSelection }
    return .none
  }

  /// `classify` for a worker, whose screen is a conversation: a resumed thread may well quote these phrases. A dialog
  /// needs its shape, not just its words: a selection cursor for the question dialogs, and for "not logged in" a line
  /// that is that message, not a sentence that mentions it. Rows that only quote the development-channels warning or a
  /// resume error are left out before classifying, so they can't hide a real dialog below them either.
  public static func workerScreen(_ rows: [String]) -> Screen {
    let hasCursor = rows.map(clean).contains(where: isIndexedCursor)
    let shown = rows.filter { row in
      let c = clean(row)
      if c.contains(Strings.devTitle), !hasCursor { return false }
      return !(mentionsResumeError(c) && !isResumeError(c))
    }
    let s = classify(shown)
    let cleaned = shown.map(clean)
    switch s {
    case .trust, .mcpConsent, .bypassDisclaimer:
      return cleaned.contains(where: isIndexedCursor) ? s : .none
    case .loginExpired:
      let isMessage = cleaned.contains { row in
        Strings.login.contains { row.hasPrefix($0) || row.contains("· \($0)") }
      }
      return isMessage ? s : .none
    default:
      return s
    }
  }

  /// A rule row of a dialog's frame: the line Claude draws above it (`────────`), or a box edge (`╭──────╮`).
  static func isFrameRule(_ row: String) -> Bool {
    let box: Set<Character> = ["─", "━", "╭", "╮", "╰", "╯", "┌", "┐", "└", "┘", "═"]
    let t = row.filter { $0 != " " && $0 != "\t" }
    guard t.count >= 10 else { return false }
    return t.filter { box.contains($0) }.count * 10 >= t.count * 8
  }

  /// A dialog that is really waiting on a worker (live, busy or starting), where a conversation is on screen and any of the
  /// dialogs' words may be quoted in it. Read from real 2.1.318 captures (Tests/Fixtures/real-2.1.318): Claude's dialogs are a
  /// rule row, their text, and a Select whose rows are numbered or NOT (the trust and MCP dialogs hide the numbers) with one `❯`
  /// cursor, then `Enter to confirm · Esc to cancel`. All of these, or it is not one: the frame's rule row, one selection cursor
  /// and either that footer or numbered options below it, the dialog's phrase below the rule (not in output above it), and all
  /// of it in the bottom `region` rows. The worker's own question menu is not a dialog (its words are the worker's), and neither
  /// is the input box (rule, `❯` row, rule: no cursor below the last rule).
  public static func liveDialog(_ rows: [String], region: Int = 24) -> Screen {
    var tail = rows
    while let l = tail.last, l.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { tail.removeLast() }
    let bottom = Array(tail.suffix(region))
    guard let rule = bottom.lastIndex(where: { isFrameRule($0) }) else { return .none }
    let block = Array(bottom[(rule + 1)...])
    let cleaned = block.map(clean)
    guard cleaned.filter({ $0.first == Strings.pointer }).count == 1 else { return .none }
    let footer = cleaned.contains { $0.hasPrefix("Enter to confirm") || $0.contains("Esc to cancel") }
    guard footer || cleaned.contains(where: isIndexedCursor) else { return .none }
    let s = classify(block)
    switch s {
    case .trust, .mcpConsent, .bypassDisclaimer, .loginExpired: break
    default: return .none
    }
    // the phrase is part of the dialog: one of its rows, below the rule, not a line that merely quotes it
    let phraseRows = cleaned.filter { row in
      Strings.trust.contains(where: row.contains) || Strings.mcpConsent.contains(where: row.contains)
        || row.contains(Strings.bypass) || Strings.login.contains(where: { row.hasPrefix($0) || row.contains("\u{00B7} \($0)") })
    }
    return phraseRows.isEmpty ? .none : s
  }

  /// The registration notice is on screen (channels are live: the dialog was answered).
  public static func noticeSeen(_ rows: [String]) -> Bool {
    // Joined with spaces: a narrow pane may wrap the notice across rows.
    let joined = rows.map(clean).joined(separator: " ")
    guard let start = joined.range(of: Strings.noticeStart) else { return false }
    return joined[start.upperBound...].contains(Strings.noticeEnd)
  }

  private static func mentionsResumeError(_ row: String) -> Bool {
    row.contains(Strings.resumeMissing) || row.contains(Strings.resumeMissingConversation)
  }

  /// The CLI prints the error on a line of its own. A sentence that mentions it is a conversation.
  private static func isResumeError(_ row: String) -> Bool {
    row.hasPrefix(Strings.resumeMissing) || row.hasPrefix(Strings.resumeMissingConversation)
  }

  /// `--resume` failed: the positive signal in 4.3 step 7. Any other early exit is a crash.
  public static func resumeMissing(_ rows: [String]) -> Bool {
    rows.map(clean).contains(where: isResumeError)
  }
}

/// `claude --version` → `2.1.312 (Claude Code)`.
public struct CLIVersion: Comparable, Hashable, Sendable, CustomStringConvertible {
  public var major: Int, minor: Int, patch: Int
  public init(_ major: Int, _ minor: Int, _ patch: Int) {
    self.major = major
    self.minor = minor
    self.patch = patch
  }

  public static func parse(_ text: String) -> CLIVersion? {
    guard let tok = text.split(whereSeparator: { $0 == " " || $0 == "\n" }).first else { return nil }
    let nums = tok.split(separator: ".").map { Int($0) }
    guard nums.count == 3, let a = nums[0], let b = nums[1], let c = nums[2] else { return nil }
    return CLIVersion(a, b, c)
  }

  public static func < (l: CLIVersion, r: CLIVersion) -> Bool {
    (l.major, l.minor, l.patch) < (r.major, r.minor, r.patch)
  }

  public var description: String { "\(major).\(minor).\(patch)" }
}
