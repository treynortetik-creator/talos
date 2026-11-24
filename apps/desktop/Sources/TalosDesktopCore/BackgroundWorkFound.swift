import Foundation

/// What a thread session's park reads of its background work (docs/OPTION-C.md, "Idle"): how many tasks run under its pane, and the
/// first one's command, for the line its thread gets when a park cuts them. The same rule as the app updater's quiet look
/// (`BackgroundWork.offenders`): a shell claude started (the Bash tool, a command run in the background included) and anything under it
/// is work; claude's MCP servers and its own helpers (caffeinate) are not. A sub-agent runs inside the claude process and is not seen
/// by itself: only while a command it started through the Bash tool runs (that shell is claude's child too). One waiting on the model
/// or a web fetch has no process to see.
extension BackgroundWork {
  public struct Found: Equatable, Sendable {
    public var count: Int
    /// The first task's command as the owner would read it (`command(argv:)`), nil when there is none or it could not be read.
    public var first: String?
    public init(count: Int, first: String? = nil) {
      self.count = count
      self.first = first
    }
    public static let none = Found(count: 0)
  }

  /// The background work under one pane's root process. `argv` reads a task's own argv (only for the first, the line's).
  public static func found(_ table: [Proc], pane: Int32, argv: (Int32) -> [String]?) -> Found {
    let tasks = offenders(table, panes: [pane])
    guard let top = tasks.first else { return .none }
    return Found(count: tasks.count, first: command(argv: argv(top.pid) ?? top.argv, name: top.name))
  }

  /// The command a task runs, as one line of at most `limit` characters. The Bash tool's shell runs `<shell> -c <script>` where the
  /// script sources a snapshot of the owner's shell and then runs the command through `eval '<command>'`: the command is what is
  /// shown. Any other shell's `-c` script is shown whole; anything else, its argv. Control characters become spaces.
  public static func command(argv: [String]?, name: String, limit: Int = 60) -> String {
    var text = name
    if let argv, !argv.isEmpty {
      if let c = argv.firstIndex(of: "-c"), c + 1 < argv.count {
        text = evalCommand(argv[c + 1]) ?? argv[c + 1]
      } else {
        text = argv.joined(separator: " ")
      }
    }
    let flat = String(String.UnicodeScalarView(text.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : $0 }))
    let trimmed = flat.trimmingCharacters(in: .whitespaces)
    return String((trimmed.isEmpty ? name : trimmed).prefix(limit))
  }

  /// The text inside the Bash tool's `eval '...'`, with the shell's `'"'"'` (a quote inside single quotes) put back as `'`.
  static func evalCommand(_ script: String) -> String? {
    guard let open = script.range(of: "eval '") else { return nil }
    var out = ""
    var i = open.upperBound
    let quoteBreak = "'\"'\"'"
    while i < script.endIndex {
      if script[i...].hasPrefix(quoteBreak) {
        out.append("'")
        i = script.index(i, offsetBy: quoteBreak.count)
      } else if script[i] == "'" {
        return out
      } else {
        out.append(script[i])
        i = script.index(after: i)
      }
    }
    return out
  }

  /// The record kind of the line a thread gets when a park cut its background work.
  public static let cutKind = "background cut"

  /// The record kind and the line a thread gets when it starts over the limit because the quiet sessions all have work running.
  public static let busyKind = "computer busy"
  public static let busyLine = "Your computer is busy: other threads still have work running in the background, so this one started anyway and nothing was stopped."

  /// The thread's one line: how many tasks were running and the first one's command.
  public static func cutLine(_ f: Found) -> String {
    let first = f.first.map { ": \($0)" } ?? ""
    return "Parked while \(f.count) background task(s) were running\(first)."
  }
}
