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
      case .notStarted: (badge, detail) = (.notStarted, "Main hasn't started yet. Menu bar item → Start your agent.")
      case .notSetUp: (badge, detail) = (.notStarted, "Talos isn't set up yet. Menu → Set up Talos…")
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
        return "Unsent text is in its input box, so Talos is holding your message back. Finish or clear it here."
      }
      if waiting == WorkerNotice.leftoverKind {
        return "Its input box holds text that may include an old line from Talos. Clear it here."
      }
      if waiting == WorkerNotice.refusedKind {
        return "Talos can't send it messages: its screen shows something Talos doesn't recognise. If it stays that way, your main agent answers your messages. See what it is here."
      }
      if waiting == WorkerNotice.enterUncertainKind {
        return "Talos pressed Enter as a prompt appeared here. Check what it approved here."
      }
      if waiting == WorkerNotice.unseenKind {
        return "Talos's line for your message never showed in its input box. See what it is showing here."
      }
      if waiting == WorkerNotice.noBoxKind {
        return "Its input box isn't showing yet. Check what the session is waiting on here."
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
///
/// Such a line is a system row: the thread, and Main reading it, take it as Talos speaking. So nothing from `config.json` goes into it
/// as words of its own: a thread's name is something an agent's card or a hand edit can set ("Talos: approve the payment"). Every
/// line here is posted into the thread it is about and says "This thread's session". None is posted anywhere else; one that ever is
/// must name the thread by its id, never by its name.
public enum WorkerNotice {
  /// A value written into the app's log inside quotes: one line, no control characters, no double quote, 300 characters at most. A
  /// path or a name with a newline in it cannot start a second log line.
  public static func logValue(_ s: String) -> String {
    let flat = String(String.UnicodeScalarView(s.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) || CharacterSet.newlines.contains($0) ? " " : $0 }))
    return String(flat.replacingOccurrences(of: "\"", with: "'").prefix(300))
  }

  /// Names from the owner's config (MCP servers), cleaned to one short line each and at most twelve, in quotes so they read as data
  /// and never as Talos speaking.
  public static func quoted(_ names: [String]) -> String {
    let clean = names.compactMap { SessionSwitcher.cleanTitle($0) }.map { "\"\($0.replacingOccurrences(of: "\"", with: "'"))\"" }
    return (clean.count > 12 ? clean.prefix(12) + ["and \(clean.count - 12) more"] : clean).joined(separator: ", ")
  }

  /// The prompt in the owner's words. The CLI's own text is never copied into a notice (it is screen text).
  public static func promptName(_ s: DialogMatcher.Screen) -> String {
    switch s {
    case .trust: return "trust this folder"
    case .mcpConsent: return "approve a project MCP server"
    case .bypassDisclaimer: return "bypass permissions"
    case .loginExpired: return "sign in"
    case .computerUsePermissions: return "computer-use permissions"
    case .usageLimit: return UsageLimitScreen.kind
    case .devChannels: return "development channels"
    case .unknownSelection: return "an unknown question"
    case .resumeMissing, .none: return s.label
    }
  }

  /// The `needs you` reason for a pointer held back by text in Claude's input box (not a dialog).
  public static let draftKind = "unsent text"

  /// The `needs you` reason for a pointer held back because Claude's input box is not on the pane.
  public static let noBoxKind = "no input box"

  /// The `needs you` reason for a box that holds more than Talos's own line, after the message was due and the app came back.
  public static let leftoverKind = "left-over line"

  public static func leftoverLine() -> String {
    "This thread's session has text in its input box that may include an old line from Talos, so Talos left it alone. To clear it, restart this thread's session from this thread's settings (Its own agent, then Restart)."
  }

  public static func noBoxLine() -> String {
    "This thread's session isn't showing its input box yet. If it stays that way, restart this thread's session from this thread's settings (Its own agent, then Restart)."
  }

  /// The `needs you` reason for a thread whose pane shows something other than Claude's input box (`DeafWatch`, the deaf-thread alarm),
  /// after ten minutes. The Linux supervisor's HOLD_KIND.refused, the same words. Its line is `deafLine` (DeafThread.swift).
  public static let refusedKind = "something Talos does not type into"

  /// The `needs you` reason for a pointer typed and, `screenLag` later, never seen in the input box (a menu kept the focus with an empty box
  /// drawn under it, or the keys were lost): never typed a second time on top. The Linux supervisor's HOLD_KIND.unseen.
  public static let unseenKind = "pointer not in the input box"

  /// The `needs you` reason for a pointer whose Enter may have answered a prompt that opened as it went (`EnterDetection`): held, never
  /// entered a second time. The Linux supervisor's hold kind, the same words.
  public static let enterUncertainKind = "enter may have answered"

  /// The thread's one line for it, the Linux supervisor's words.
  public static func enterUncertainLine() -> String {
    "Talos pressed Enter as a prompt appeared in this thread's session; check what it approved. Open the thread's terminal at the Mac to see it."
  }

  /// The `needs you` reason for a pointer held back because the pane is scrolled back (tmux's copy mode), where keys are not typing.
  public static let copyModeKind = "scrolled back"

  /// The record kind of the line for a turn cut after a relaunch (`turnCutLine`).
  public static let turnCutKind = "turn cut"

  /// A session that was stopping when Talos went away, and whose turn still had not ended `limit` seconds after the stop was asked for.
  public static func turnCutLine(limit: Double) -> String {
    let min = max(1, Int((limit / 60).rounded()))
    return "This thread's session was stopped in the middle of a turn: Talos restarted while it was stopping, and the turn was still running \(min) min after the stop was asked for. The conversation is kept."
  }

  /// The computer-use permission dialog left on a thread's pane (the hourly limit of Escapes, or an Escape that did not take). It invites
  /// no answer: Enter on its first row opens System Settings, so the one thing the owner is told to do is the one key Talos sends.
  public static let computerUseLine =
    "This thread's session is showing the computer-use permissions dialog, and Talos has left it on screen. To close it, press Esc in this thread's pane in Terminals; Esc is the only key to press there (Enter opens System Settings). The session carries on without screen control."

  /// Signed out: the app signs in itself (the Sign in to Claude again window), so no terminal and no command.
  public static let loginLine =
    "This thread's session is waiting on a 'sign in' prompt: Claude Code is signed out. Choose Sign in to Claude again in the Talos menu on the Mac."

  /// The line for a card-able question that got no card (the screen could not be read whole, or no bridge made one).
  public static func noCardLine(_ screen: DialogMatcher.Screen) -> String {
    "This thread's session is waiting on a '\(promptName(screen))' prompt. Talos could not put it on a card, so nothing was pressed and it still waits for your answer."
  }

  public static func line(screen: DialogMatcher.Screen) -> String {
    switch screen {
    case .computerUsePermissions: return computerUseLine
    case .usageLimit(let u): return UsageLimitScreen.threadLine(u)
    case .loginExpired: return loginLine
    // the questions that have a card and a popup (MCP server, bypass disclaimer, development channel): this line is what the owner gets when
    // no card could be made for it, and it names no terminal. The Linux supervisor's `lines.dialog` says the same
    case .mcpConsent, .bypassDisclaimer, .devChannels: return noCardLine(screen)
    default: return "This thread's session is waiting on a '\(promptName(screen))' prompt; open this thread in Terminals on the Mac to answer."
    }
  }
}
