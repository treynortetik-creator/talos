import Foundation

/// "What would an update restart?", read-only (`Talos --update-check`; the Linux twin is `talos-app update-check --dry`). For each
/// running thread session it says one of six states, then one count line, and nothing else: no file text, no path, no hash, no
/// environment, no settings and no display name, only thread ids. The words live here so the command, its help and its tests share them.
public enum UpdateCheck {
  public enum State: String, CaseIterable, Sendable {
    case unchanged = "unchanged"
    /// Something other than the instructions alone changed (the instructions may have too).
    case specChanged = "spec changed"
    /// Only the instructions a session outside the agent folder is handed changed.
    case instructionsChanged = "instructions changed"
    /// Started by a build that kept no spec: an update restarts it once.
    case noRecord = "no record"
    /// Its spec changed and it is in a turn: the restart waits for the turn to end.
    case busy = "busy (would wait)"
    /// The dry plan refused (a start now would be refused too) or could not be made: the update leaves it alone.
    case unknown = "unknown (dry plan refused)"
  }

  public struct Row: Equatable, Sendable {
    public var id: String
    public var state: State
    public init(id: String, state: State) {
      self.id = id
      self.state = state
    }
  }

  /// What the dry plan gave for one session.
  public enum Current: Sendable {
    case refused
    /// `spec`: the hash a start would record now (nil: none could be made). `instructions`: its instructions digest (nil in the agent
    /// folder). `specWith`: this same spec's hash with a recorded instructions digest in place of its own.
    case spec(String?, instructions: String?, specWith: @Sendable (String) -> String?)
  }

  /// The state of one running session. `startedInAgentFolder`: its record says it was started in the agent folder (then it is never
  /// "instructions changed": that folder's own files are not hashed). `busy`: in a turn now.
  public static func classify(_ current: Current, launched: WorkersFile.Launched?, busy: Bool, startedInAgentFolder: Bool) -> State {
    guard case .spec(let spec?, let instructions, let specWith) = current else { return .unknown }
    // the update check's own rule (WorkerUpdateRestart.swift): either one equal is nothing to do
    if launched?.spec_hash == spec || launched?.update_tried_hash == spec { return .unchanged }
    guard let launched, let recorded = launched.spec_hash else { return .noRecord }
    if busy { return .busy }
    if !startedInAgentFolder, let was = launched.instructions_hash, let now = instructions, was != now, specWith(was) == recorded {
      return .instructionsChanged
    }
    return .specChanged
  }

  /// The id as printed: a thread id (`WorkerSpec.isThreadId`) only, so no key in the file can put other text on the screen.
  public static func printable(_ id: String) -> Bool { WorkerSpec.isThreadId(id) }

  /// The whole output: one line per row (by id), then the count.
  public static func lines(_ rows: [Row]) -> [String] {
    let sorted = rows.filter { printable($0.id) }.sorted { $0.id < $1.id }
    var out = sorted.map { "\($0.id)  \($0.state.rawValue)" }
    let n = { (s: Set<State>) in sorted.filter { s.contains($0.state) }.count }
    out.append(
      "\(sorted.count) sessions: \(n([.unchanged])) unchanged, \(n([.specChanged, .instructionsChanged, .busy])) to restart, "
        + "\(n([.noRecord])) no record, \(n([.unknown])) unknown")
    return out
  }

  /// The sentence the help must hold (Pantheon 2026-11-14): an agent-folder instruction edit is not an update.
  public static let agentFolderNote =
    "a session started in the agent folder picks up an edit to that folder's instruction files at its next restart; restart it to apply the edit now."

  public static let help = """
    Usage: Talos --update-check [--help]

    Says, without changing anything, which running thread sessions an update would restart: one line per session,
    "<thread id>  <state>", then a count. It starts nothing, writes nothing and takes no lock.

    States:
      unchanged                    a start now would launch the same spec
      spec changed                 the launch changed (the app, its settings, the thread's settings or its own instructions)
      instructions changed         only the instruction files a session outside the agent folder is handed changed
      no record                    started by an older build that kept no spec: an update restarts it once
      busy (would wait)            its spec changed and it is in a turn: the restart waits for the turn to end
      unknown (dry plan refused)   a start now would be refused, or its spec cannot be worked out: it is left alone

    Note: \(agentFolderNote)

    It works a start out the way the app does: from desktop.json and the login shell read the way the app's is (never this
    terminal's environment). When desktop.json cannot be read it says so on one line and every running session is unknown.

    Exit status: 0 whether or not anything would restart; 1 when the saved sessions cannot be read; 2 on a usage error.
    """

  public enum Command: Equatable, Sendable {
    case run
    case help
    case usage(String)
  }

  /// The arguments after `--update-check`.
  public static func parse(_ args: [String]) -> Command {
    if args.isEmpty { return .run }
    if args == ["--help"] || args == ["-h"] { return .help }
    // never echo an argument back: it could be anything
    return .usage("update-check: unknown argument (see --update-check --help)")
  }

  /// The one line (on stderr) when desktop.json is there and cannot be read: a start's launch is not known, so every running session
  /// is unknown (no path in it).
  public static let launchSettingsUnreadable = "the app's launch settings could not be read"

  /// The one line for a workers.json that exists and cannot be read (no path in it).
  public static let unreadable = "update-check: the saved thread sessions (workers.json) cannot be read"

  /// Exit statuses.
  public static let exitOK: Int32 = 0
  public static let exitUnreadable: Int32 = 1
  public static let exitUsage: Int32 = 2
}
