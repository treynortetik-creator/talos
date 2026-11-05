import Foundation

/// Adopt a running session (DESKTOP-SPEC 4.7): pre-fill `agent_dir`, `args`, the relevant `env` and `session.id` from the
/// live process that holds Telegram or the bridge. Pure: the caller reads the snapshot (KERN_PROCARGS2, proc_pidinfo).
public struct AdoptPlan: Equatable, Sendable {
  public var pid: Int32
  public var agentDir: String
  public var claudePath: String
  public var args: [String]
  public var env: [String: String]
  public var sessionId: String?
  /// macOS 26 returns no environment for another process in KERN_PROCARGS2, even the same user's (OBSERVED
  /// 2026-10-30, also `ps -E`). Then `env` is empty and the owner checks the variables his Terminal command sets.
  public var envReadable: Bool

  /// Variables that describe the terminal or the shell, not the agent. Never copied into desktop.json.
  static let terminalVars: Set<String> = [
    "TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "SHLVL", "PWD", "OLDPWD", "_",
    "TMUX", "TMUX_PANE", "ITERM_SESSION_ID", "ITERM_PROFILE", "LC_TERMINAL", "LC_TERMINAL_VERSION",
    "__CFBundleIdentifier", "__CF_USER_TEXT_ENCODING", "XPC_SERVICE_NAME", "XPC_FLAGS", "SECURITYSESSIONID",
    "COMMAND_MODE", "LOGNAME", "USER", "HOME", "SHELL",
    "TMPDIR", "SSH_AUTH_SOCK", "LaunchInstanceID", "OSLogRateLimit",
  ]

  /// `snapshot.argv[0]` is the claude binary as launched; the rest are its args. The env kept is what differs from the
  /// login shell's env (so `TALOS_APP_BRIDGE=1 claude …` comes over, PATH and friends don't).
  public static func from(
    snapshot: ProcessSnapshot, agentsEntry: AgentEntry?, loginEnv: [String: String]
  ) -> AdoptPlan? {
    guard let first = snapshot.argv.first, let dir = snapshot.cwd ?? agentsEntry?.cwd else { return nil }
    let raw = Array(snapshot.argv.dropFirst())
    var env: [String: String] = [:]
    for (k, v) in snapshot.env where !terminalVars.contains(k) && !ClaudeEnvScrub.isInherited(k) && loginEnv[k] != v {
      env[k] = v
    }
    let id = agentsEntry?.sessionId ?? ResumeRewrite.sessionId(in: raw).map { $0.lowercased() }
    return AdoptPlan(
      pid: snapshot.pid, agentDir: dir, claudePath: first.contains("/") ? first : "auto",
      args: ResumeRewrite.strip(raw), env: env, sessionId: id.flatMap { ResumeRewrite.isUUID($0) ? $0 : nil },
      envReadable: !snapshot.env.isEmpty)
  }

  /// The config the cold start under tmux will use. The session's confirmation is cleared: the owner confirms the dialog
  /// once in the pane.
  public func applied(to c: DesktopConfig, home: String) -> DesktopConfig {
    var n = c
    n.agentDir = agentDir.hasPrefix(home + "/") ? "~" + agentDir.dropFirst(home.count) : agentDir
    n.claudePath = claudePath
    n.args = args
    // Unreadable: keep what desktop.json already has. Either way the bridge variables stay, or a cold start would run an
    // agent the bridge reports as not live (audit D45).
    n.env = BridgeEnv.merged(envReadable ? env : c.env)
    if let id = sessionId, id != c.session.id {
      n.session = DesktopConfig.Session(id: id, previousIds: c.session.previousIds)
    }
    return n
  }
}
