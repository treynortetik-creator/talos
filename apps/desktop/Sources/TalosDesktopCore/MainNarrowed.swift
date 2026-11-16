import Foundation

/// A mode that narrows the main session in a way nothing passes on to a thread session, so the session would be wider than Main:
/// - restricted mode (`--restricted`, `CLAUDE_CODE_RESTRICTED`): no user, project or local settings, no bypass, no code-running tools;
/// - `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG`: the owner's own skills, commands and agents cannot widen permissions;
/// - safe mode (`--safe-mode`, `CLAUDE_CODE_SAFE_MODE`) and bare mode (`--bare`, `CLAUDE_CODE_SIMPLE`): no plugins, no auto-discovered
///   MCP servers, no customizations.
/// A worker's environment drops every `CLAUDE_CODE_*` variable that is not on the keep list (`ClaudeEnvScrub`, in `WorkerSpec.build`),
/// which is all four switches, and its arguments never carry the flags. A thread session cannot be held to any of them, so under a
/// Main that runs in one, none starts (the Linux supervisor's rule, `mainNarrowedMode`).
public enum MainNarrowed {
  /// An environment switch as Claude Code reads one: 1, true, yes or on (any case).
  public static func envOn(_ v: String?) -> Bool {
    guard let v else { return false }
    return ["1", "true", "yes", "on"].contains(v.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
  }

  /// The flag as Claude Code reads the arguments (`MainArgs`: never another flag's value, nothing after `--`), alone or with a value
  /// (`--restricted=…`): any spelling of it counts, since a value this build cannot judge must not read as off.
  public static func hasFlag(_ args: [String], _ flag: String) -> Bool {
    MainArgs.flags(args).contains { $0.flag == flag || $0.flag.hasPrefix(flag + "=") }
  }

  /// What a start is called when it cannot be told whether it runs in one of these modes.
  public static let unknown = "a mode this Mac can't check (the main session was started with other settings than it has now)"

  /// The mode of a main session found already running (the app was reopened). Its real arguments and, where the system lets another
  /// process read it, its real environment say so. Otherwise, when the pane is the launch the settings name (`sameLaunch`), what the
  /// settings say (`configured`). When it is some other launch and its environment cannot be read, it is not known, and not known is
  /// not "none": only a pane whose arguments AND environment were both read is known to be in no mode.
  public static func found(argv: [String]?, env: [String: String]?, sameLaunch: Bool, configured: String?) -> String? {
    if let real = mode(args: argv ?? [], env: env ?? [:]) { return real }
    if sameLaunch { return configured }
    return argv != nil && !(env ?? [:]).isEmpty ? nil : unknown
  }

  /// The mode's name for the thread's line, or nil when Main runs in none of them.
  public static func mode(args: [String], env: [String: String]) -> String? {
    if hasFlag(args, "--restricted") || envOn(env["CLAUDE_CODE_RESTRICTED"]) { return "restricted mode (--restricted or CLAUDE_CODE_RESTRICTED)" }
    if envOn(env["CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG"]) { return "CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG" }
    if hasFlag(args, "--safe-mode") || envOn(env["CLAUDE_CODE_SAFE_MODE"]) { return "safe mode (--safe-mode or CLAUDE_CODE_SAFE_MODE)" }
    if hasFlag(args, "--bare") || envOn(env["CLAUDE_CODE_SIMPLE"]) { return "bare mode (--bare or CLAUDE_CODE_SIMPLE)" }
    return nil
  }

  /// The switches, for a check that a worker's spec carries none of them.
  public static let variables = ["CLAUDE_CODE_RESTRICTED", "CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG", "CLAUDE_CODE_SAFE_MODE", "CLAUDE_CODE_SIMPLE"]
  public static let flags = ["--restricted", "--safe-mode", "--bare"]

  /// What `workers.json` says of the refused start.
  public static func detail(_ mode: String) -> String { "the main session runs in \(mode), which a thread session cannot be held to" }

  /// The one line the thread gets, naming the mode, with the way out.
  public static func line(_ mode: String) -> String {
    "This thread's own session did not start: the main session runs in \(mode), and a thread session can't be held to that. Messages go to the main session. To use this thread's own session, turn that mode off in the Mac app's settings (the main session's arguments, or its environment), restart the main session, then restart this thread's session."
  }
}
