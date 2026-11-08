import Foundation

/// The Terminal screen's session tabs, as the page sees them (`terminal_sessions`, packages/protocol/src/native.ts). Built from
/// the same `SessionSwitcher` list the Terminals window shows, so both always agree on the states, the order and what a
/// parked or failed session offers. Pure: no tmux, no AppKit.
public enum TerminalSessions {
  public static let mainId = SessionSwitcher.mainId
  /// Main and up to 100 threads (the `threads` message carries at most 100 as well).
  public static let itemsMax = 101

  /// The page's word for a session state. Values are the ones `TERMINAL_SESSION_STATES` lists.
  public static func stateWord(_ b: SwitcherEntry.Badge) -> String {
    switch b {
    case .needsYou: return "needs_you"
    case .notStarted: return "not_started"
    default: return b.rawValue
    }
  }

  public enum ResumeOutcome: String, Equatable, Sendable {
    case asked
    case alreadyPending = "already_pending"
    case parkPending = "park_pending"
    case failed
  }

  public struct Item: Equatable, Sendable {
    public var id: String
    public var name: String
    public var state: String
    public var key: String?
    /// "terminal", "resume", "error" or "note".
    public var panel: String
    /// "resume" or "start" on a resume panel.
    public var action: String?
    public var detail: String

    public var object: [String: Any] {
      ["id": id, "name": name, "state": state, "key": key as Any? ?? NSNull(), "panel": panel, "action": action as Any? ?? NSNull(), "detail": detail]
    }

    /// The page's own rules for one item.
    var isValid: Bool {
      TerminalSessions.isValidSession(id) && (1...80).contains(name.utf16.count) && detail.utf16.count <= 600
        && (key == nil || key.map { $0.count == 1 && ("1"..."9").contains($0) } == true)
    }
  }

  /// "main" or a thread id: the only two things a page may name. Anything else (a tmux target, a path, `all`) is refused.
  public static func isValidSession(_ s: String) -> Bool { s == mainId || ThreadIdRule.isValid(s) }

  /// The list the page gets. A thread whose id is "main" is left out: the page could not tell it from Main.
  public static func items(entries: [SwitcherEntry], workers: WorkersFile?) -> [Item] {
    var out: [Item] = []
    for e in entries {
      if e.kind == .thread, e.id == mainId { continue }
      guard isValidSession(e.id) else { continue }
      var panel = "terminal"
      var action: String?
      var detail = e.detail
      switch SessionSwitcher.content(for: e, workers: workers) {
      case .attach: panel = "terminal"
      case .resume(_, let label):
        panel = "resume"
        action = label.lowercased()
      case .failed(_, let text):
        panel = "error"
        detail = text
      case .note(let text):
        panel = "note"
        detail = text
      }
      out.append(
        Item(
          id: e.id, name: clamp(e.title, units: 80), state: stateWord(e.badge), key: out.count < 9 ? String(out.count + 1) : nil,
          panel: panel, action: action, detail: clean(detail)))
      if out.count == itemsMax { break }
    }
    return sendable(out)
  }

  /// Text from a file, shown in the page: no control characters, at most 600 UTF-16 units, cut on a character boundary.
  static func clean(_ s: String) -> String {
    clamp(String(String.UnicodeScalarView(s.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })), units: 600)
  }

  /// At most `units` UTF-16 units, cut on a character boundary (the page's limit counts UTF-16 units, not characters).
  static func clamp(_ s: String, units: Int) -> String {
    var out = ""
    for ch in s {
      if out.utf16.count + ch.utf16.count > units { break }
      out.append(ch)
    }
    return out
  }

  /// The items the page's own rules accept. One that fails them is left out: it never costs the whole message.
  public static func sendable(_ items: [Item]) -> [Item] { items.filter(\.isValid) }

  /// The entry the page's `session` names, nil for a session that is not in the list (a thread that was archived, a made-up id).
  public static func entry(forSession id: String, in entries: [SwitcherEntry]) -> SwitcherEntry? {
    guard isValidSession(id) else { return nil }
    return entries.first { $0.id == id && ($0.kind == .main) == (id == mainId) }
  }

  /// A Resume press is honoured only for a thread the list shows as resumable right now, so a page cannot wake a session that
  /// is running, failed, or not in the list.
  public static func mayResume(_ threadId: String, entries: [SwitcherEntry], workers: WorkersFile?) -> Bool {
    guard threadId != mainId, let e = entry(forSession: threadId, in: entries), e.kind == .thread else { return false }
    if case .resume = SessionSwitcher.content(for: e, workers: workers) { return true }
    return false
  }

  /// What a thread's tab shows in the native view: its tmux session, or a line instead (the page shows the Resume panel and the
  /// error itself and closes the native view for those; the line only covers the moment before the page has caught up).
  public enum ThreadTarget: Equatable, Sendable {
    case attach(argv: [String])
    case note(String)
    case gone
  }

  public static let goneNote = "That session isn't in the list any more."

  /// The target for a session id the page named. The tmux session comes from the list (`WorkerSpec.tmuxName(id)`), never from
  /// anything the page sent beyond the id; an id that is not in the list (or names Main) is `gone`.
  public static func threadTarget(
    _ id: String, entries: [SwitcherEntry]?, workers: WorkersFile?, attach: (SwitcherEntry) -> [String]?
  ) -> ThreadTarget {
    guard let entries, id != mainId, let e = entry(forSession: id, in: entries), e.kind == .thread else { return .gone }
    switch SessionSwitcher.content(for: e, workers: workers) {
    case .attach:
      guard let argv = attach(e) else { return .note("This Mac can't show that session here.") }
      return .attach(argv: argv)
    case .resume, .failed, .note: return .note(e.detail)
    }
  }
}
