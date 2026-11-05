import Foundation

/// Strips what a Claude Code session leaves in its children's environment, so the agent the app starts never inherits
/// another session's identity. Claude Code 2.1.317 treats an inherited `CLAUDE_CODE_CHILD_SESSION` as "I am a child
/// session" and stops saving the transcript (seen 2026-11-03: nine hours of the owner's main session were not saved).
///
/// Deny by pattern, keep by name: every `CLAUDE_CODE_*` variable is dropped unless it is on `keep`/`keepPrefixes`, so a
/// marker a later Claude Code adds is dropped too. The owner's `desktop.json` `env` is applied after this (deliberate
/// settings), but even there the session markers in `sessionMarkers` are refused.
public enum ClaudeEnvScrub {
  /// Names that are never inherited, whatever the pattern says.
  public static let alwaysDrop: Set<String> = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "TMUX", "TMUX_PANE"]

  /// Settings an owner puts in a shell profile on purpose (the app itself sets none of them: it sets only
  /// TALOS_APP_BRIDGE and MCP_PROTOCOL_NEGOTIATION). Everything else under CLAUDE_CODE_ comes from a running session.
  public static let keep: Set<String> = [
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_API_KEY_HELPER_TTL_MS", "CLAUDE_CODE_SHELL", "CLAUDE_CODE_GIT_BASH_PATH",
    "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CODE_ENABLE_TELEMETRY",
  ]
  public static let keepPrefixes: [String] = ["CLAUDE_CODE_MAX_"]

  /// What identifies one running session; refused even from `desktop.json`.
  public static let sessionMarkers: Set<String> = [
    "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_BRIDGE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT",
  ]

  /// True for a variable the agent must not inherit from the process that launched the app.
  public static func isInherited(_ name: String) -> Bool {
    if alwaysDrop.contains(name) || sessionMarkers.contains(name) { return true }
    guard name.hasPrefix("CLAUDE_CODE_") else { return false }
    return !keep.contains(name) && !keepPrefixes.contains { name.hasPrefix($0) }
  }

  /// What identifies one running session or terminal, so no source may set it, `desktop.json` included. CLAUDE_EFFORT is
  /// in `alwaysDrop` (an inherited copy goes) but is also a setting an owner can choose, so it is not here.
  static let neverSettable: Set<String> = alwaysDrop.subtracting(["CLAUDE_EFFORT"])

  /// True for a variable no source may set, `desktop.json` included.
  public static func isSessionMarker(_ name: String) -> Bool {
    neverSettable.contains(name) || sessionMarkers.contains(name)
  }

  /// Names `env -u` clears in a pasted Terminal command: the markers a Claude-spawned shell holds, not the terminal's
  /// own TMUX.
  public static var unsetInPastedCommand: [String] {
    (sessionMarkers.union(alwaysDrop).subtracting(["TMUX", "TMUX_PANE"])).sorted()
  }

  public static func scrub(_ env: [String: String]) -> [String: String] { env.filter { !isInherited($0.key) } }

  /// Names to unset from `tmux show-environment` output (`NAME=value`, or `-NAME` for one already removed). An
  /// existing tmux server may have been started by a polluted process; `-e` on a new pane cannot remove those.
  public static func inheritedNames(inShowEnvironment out: String) -> [String] {
    out.split(separator: "\n").compactMap { line in
      var s = Substring(line)
      if s.hasPrefix("-") { s = s.dropFirst() }
      let name = String(s.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
      return !name.isEmpty && isInherited(name) ? name : nil
    }
  }
}
