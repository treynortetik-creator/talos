import Foundation

/// The Terminals window's list: Main and every thread session in `workers.json`, each with a state badge, and what the
/// window shows when its entry is picked. Pure (no tmux, no AppKit): the window renders it and a test reads it.
public struct SwitcherEntry: Equatable, Sendable, Identifiable {
  public enum Kind: Equatable, Sendable { case main, thread }
  public enum Badge: String, Equatable, Sendable {
    case live, working, idle, starting, parked, stopping, failed, needsYou, notStarted, unknown

    public var text: String {
      switch self {
      case .live: return "Live"
      case .working: return "Working"
      case .idle: return "Idle"
      case .starting: return "Starting"
      case .parked: return "Parked"
      case .stopping: return "Stopping"
      case .failed: return "Failed"
      case .needsYou: return "Needs you"
      case .notStarted: return "Not started"
      case .unknown: return "Unknown"
      }
    }
  }

  public let id: String
  public let kind: Kind
  public let title: String
  public let badge: Badge
  /// The tmux session behind this entry (`agent` for Main, `t-<thread>` for a thread).
  public let tmuxSession: String
  public let cwd: String?
  /// One plain sentence for the entry: why it stopped, what it waits on.
  public let detail: String
  /// Whether a pane may exist to look at.
  public let canAttach: Bool
}

/// What the window's right-hand side shows for the picked entry.
public enum SwitcherContent: Equatable, Sendable {
  /// The embedded terminal, attached to this tmux session.
  case attach(session: String)
  /// A parked (or never started) thread: a button instead of a dead terminal.
  case resume(thread: String, label: String)
  /// A failed thread: the error in words, no terminal.
  case failed(title: String, detail: String)
  case note(String)
}

public enum SessionSwitcher {
  public enum MainState: Equatable, Sendable {
    case notSetUp
    case notStarted
    case starting
    case running
    case stopping
    case stopped(failure: String?)
  }

  public struct MainFacts: Equatable, Sendable {
    public var state: MainState
    /// A tmux session for Main exists (live or with a dead pane): there is a screen to look at.
    public var hasScreen: Bool
    /// What Main's supervisor says it needs the owner for, nil when nothing.
    public var needsYou: String?
    public init(state: MainState, hasScreen: Bool, needsYou: String? = nil) {
      self.state = state
      self.hasScreen = hasScreen
      self.needsYou = needsYou
    }
  }

  public static let mainId = "main"

  /// Main first, then every thread in `workers.json` by name. One entry that can't be read (a bad id, a session name tmux can't
  /// target) is left out; it never costs the list. `names` is thread id → display name; an unknown id shows as itself.
  /// `needsYou` is thread id → what its pane is waiting on.
  public static func entries(
    main: MainFacts, workers: WorkersFile?, names: [String: String] = [:], needsYou: [String: String] = [:]
  ) -> [SwitcherEntry] {
    var out = [mainEntry(main)]
    guard let workers else { return out }
    let threads: [SwitcherEntry] = workers.threads.compactMap { id, e in
      // the session name is derived from the id, never read from the file: a file that names another session can't make the
      // window attach to it
      guard WorkerSpec.isThreadId(id) else { return nil }
      let title = cleanTitle(names[id]) ?? id
      let waiting = needsYou[id]
      let badge = threadBadge(e, waiting: waiting)
      return SwitcherEntry(
        id: id, kind: .thread, title: title, badge: badge, tmuxSession: WorkerSpec.tmuxName(id), cwd: e.cwd,
        detail: threadDetail(e, waiting: waiting), canAttach: !WorkersFile.restingStates.contains(e.state))
    }
    out += threads.sorted { ($0.title.lowercased(), $0.id) < ($1.title.lowercased(), $1.id) }
    return out
  }

  static func mainEntry(_ m: MainFacts) -> SwitcherEntry {
    let badge: SwitcherEntry.Badge
    var detail: String
    if m.needsYou != nil, m.state == .running || m.state == .starting {
      badge = .needsYou
      detail = "Main is waiting on you: \(m.needsYou ?? "")."
    } else {
      switch m.state {
      case .running: (badge, detail) = (.live, "Main is running.")
      case .starting: (badge, detail) = (.starting, "Main is starting.")
      case .stopping: (badge, detail) = (.stopping, "Main is stopping.")
      case .stopped(let failure):
        badge = failure == nil ? .parked : .failed
        detail = failure ?? "Main is stopped."
      case .notStarted: (badge, detail) = (.notStarted, "Main hasn't started yet. Menu bar item → Start session.")
      case .notSetUp: (badge, detail) = (.notStarted, "Talos isn't set up yet. Window → Setup checklist…")
      }
    }
    return SwitcherEntry(
      id: mainId, kind: .main, title: "Main", badge: badge, tmuxSession: TmuxCommands.mainSession, cwd: nil, detail: detail,
      canAttach: m.hasScreen)
  }

  static func threadBadge(_ e: WorkersFile.Entry, waiting: String?) -> SwitcherEntry.Badge {
    let hasProcess = !WorkersFile.restingStates.contains(e.state)
    if hasProcess, waiting != nil { return .needsYou }
    if e.state == "failed", e.error?.code == "needs_mac" { return .needsYou }
    switch e.state {
    case "busy": return .working
    case "live": return .idle
    case "starting": return .starting
    case "parking", "stopping": return .stopping
    case "parked": return .parked
    case "off": return .notStarted
    case "failed": return .failed
    default: return .unknown
    }
  }

  static func threadDetail(_ e: WorkersFile.Entry, waiting: String?) -> String {
    if !WorkersFile.restingStates.contains(e.state), let waiting {
      if waiting == WorkerNotice.draftKind {
        return "Unsent text is in its input box, so your message is waiting. Finish or clear it here."
      }
      return "Waiting on a \"\(waiting)\" prompt. Answer it here."
    }
    return ThreadSessions.detail(e)
  }

  /// What the right-hand side shows. A parked or never-started thread offers Resume instead of a terminal that isn't there;
  /// a failed one shows its error.
  public static func content(for e: SwitcherEntry, workers: WorkersFile?) -> SwitcherContent {
    switch e.kind {
    case .main:
      return e.canAttach ? .attach(session: e.tmuxSession) : .note(e.detail)
    case .thread:
      let state = workers?.threads[e.id]?.state ?? "unknown"
      switch state {
      case "parked": return .resume(thread: e.id, label: "Resume")
      case "off": return .resume(thread: e.id, label: "Start")
      case "failed":
        let err = workers?.threads[e.id]?.error
        var text = e.detail
        if let d = err?.detail, !d.isEmpty { text += " (\(err?.code ?? "error"): \(d))" }
        return .failed(title: "\(e.title) failed", detail: text)
      default:
        return e.canAttach ? .attach(session: e.tmuxSession) : .note(e.detail)
      }
    }
  }

  /// Cmd+1 … Cmd+9. nil outside the list: a shortcut for an entry that isn't there does nothing.
  public static func entry(forShortcut n: Int, in entries: [SwitcherEntry]) -> SwitcherEntry? {
    guard (1...9).contains(n), entries.indices.contains(n - 1) else { return nil }
    return entries[n - 1]
  }

  /// The `tmux attach` for a picked entry on the given tmux, nil when the entry has nothing to attach to.
  public static func attachArgv(
    for e: SwitcherEntry, tmux: String, socket: String, configPath: String
  ) -> [String]? {
    guard e.canAttach, TmuxCommands.isValidSessionName(e.tmuxSession) else { return nil }
    return TmuxCommands(tmux: tmux, socket: socket, configPath: configPath, session: e.tmuxSession).attach()
  }

  /// A name from a config file is shown in a sidebar: no control characters, no more than 40 characters.
  static func cleanTitle(_ s: String?) -> String? {
    guard let s else { return nil }
    let kept = String(String.UnicodeScalarView(s.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }))
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if kept.isEmpty { return nil }
    return kept.count > 40 ? String(kept.prefix(39)) + "\u{2026}" : kept
  }

  /// The numbers shown beside entries 1 to 9 in the sidebar.
  public static func shortcutLabel(index: Int) -> String? { index < 9 ? "\u{2318}\(index + 1)" : nil }

  /// thread id → display name, from the agent's `config.json`. Unreadable gives no names (ids are shown).
  public static func names(fromConfig data: Data?) -> [String: String] {
    let l = ThreadChoices.read(data)
    return Dictionary(l.threads.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
  }
}

/// The one line a worker stuck on a prompt gets in its own thread.
public enum WorkerNotice {
  /// The prompt in the owner's words. The CLI's own text is never copied into a notice (it is screen text).
  public static func promptName(_ s: DialogMatcher.Screen) -> String {
    switch s {
    case .trust: return "trust this folder"
    case .mcpConsent: return "approve a project MCP server"
    case .bypassDisclaimer: return "bypass permissions"
    case .loginExpired: return "log in"
    case .devChannels: return "development channels"
    case .unknownSelection: return "an unknown question"
    case .resumeMissing, .none: return s.label
    }
  }

  /// The `needs you` reason for a pointer held back by text in Claude's input box (not a dialog).
  public static let draftKind = "unsent text"

  public static func draftLine(threadName: String) -> String {
    let name = SessionSwitcher.cleanTitle(threadName) ?? "A thread"
    return "\(name)'s session has unsent text in its input box; your message is waiting. Open Terminals to finish or clear it."
  }

  public static func line(threadName: String, screen: DialogMatcher.Screen) -> String {
    let name = SessionSwitcher.cleanTitle(threadName) ?? "A thread"
    return "\(name)'s session is waiting on a '\(promptName(screen))' prompt; open Terminals \u{2192} \(name) on the Mac to answer."
  }
}
