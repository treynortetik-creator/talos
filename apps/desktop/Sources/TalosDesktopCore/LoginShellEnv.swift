import Foundation

/// The environment the agent starts with (DESKTOP-SPEC 4.1, review finding 18): the owner's login shell's `env`, minus
/// what only describes the terminal it ran in, plus `desktop.json` `env`, plus `TERM`/`COLORTERM`. So hooks, plugins and
/// the bridge see what they see in Terminal today.
public enum LoginShellEnv {
  public static let marker = "__TALOS_ENV_BEGIN__"
  /// `/bin/zsh -lic '<this>'`. The marker skips anything an interactive rc file prints first.
  public static let shellScript = "printf '%s\\0' \(marker); /usr/bin/env -0"
  public static let timeoutSeconds: Double = 5

  /// The spec's list, plus variables that would make claude or tmux think they are nested.
  public static let denylist: Set<String> = [
    "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "SHLVL", "PWD", "OLDPWD", "_",
  ]  // Claude Code and tmux markers are `ClaudeEnvScrub`'s.

  /// Parses `env -0` output that follows the marker. nil when the marker is missing (the shell failed or timed out).
  public static func parse(_ data: Data) -> [String: String]? {
    let bytes = [UInt8](data)
    let m = [UInt8](marker.utf8) + [0]
    guard let start = find(m, in: bytes) else { return nil }
    var out: [String: String] = [:]
    var field: [UInt8] = []
    for b in bytes[(start + m.count)...] {
      if b == 0 {
        add(field, to: &out)
        field.removeAll(keepingCapacity: true)
      } else {
        field.append(b)
      }
    }
    add(field, to: &out)
    return out
  }

  static func add(_ field: [UInt8], to out: inout [String: String]) {
    guard !field.isEmpty, let s = String(bytes: field, encoding: .utf8), let eq = s.firstIndex(of: "="),
      eq != s.startIndex
    else { return }
    out[String(s[..<eq])] = String(s[s.index(after: eq)...])
  }

  static func find(_ needle: [UInt8], in hay: [UInt8]) -> Int? {
    guard needle.count <= hay.count else { return nil }
    var i = 0
    while i + needle.count <= hay.count {
      if hay[i] == needle[0], Array(hay[i..<(i + needle.count)]) == needle { return i }
      i += 1
    }
    return nil
  }

  /// shell env − denylist − inherited Claude Code markers (`ClaudeEnvScrub`), then `overrides` (desktop.json `env`) on
  /// top, then TERM and COLORTERM. THE one place every launch path builds the agent's environment.
  public static func build(shellEnv: [String: String], overrides: [String: String]) -> [String: String] {
    var env = ClaudeEnvScrub.scrub(shellEnv.filter { !denylist.contains($0.key) })
    for (k, v) in overrides where !ClaudeEnvScrub.isSessionMarker(k) { env[k] = v }
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    return env
  }

  /// Looks `name` up on `PATH` (no shell). Absolute or relative paths with a `/` are returned when executable.
  public static func which(_ name: String, path: String?, isExecutable: (String) -> Bool) -> String? {
    if name.contains("/") { return isExecutable(name) ? name : nil }
    for dir in (path ?? "").split(separator: ":") where !dir.isEmpty {
      let candidate = "\(dir)/\(name)"
      if isExecutable(candidate) { return candidate }
    }
    return nil
  }
}
