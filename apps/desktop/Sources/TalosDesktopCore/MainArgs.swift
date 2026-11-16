import Foundation

/// Main's launch arguments, read the way Claude Code reads them. The privilege ceiling is worked out from them, so a reading that
/// differs from Claude Code's is a ceiling for a main that does not exist:
/// - nothing after `--` is a flag (it is the prompt), so a `--settings` there is not main's;
/// - a flag's value is never read as a flag (`--append-system-prompt --restricted` restricts nothing);
/// - a flag whose value is optional takes the next word only when that word is not a flag (`--resume --settings x`).
public enum MainArgs {
  /// Flags that always take the next word as their value.
  static let valued: Set<String> = [
    "--settings", "--setting-sources", "--permission-mode", "--name", "--model", "--append-system-prompt", "--system-prompt",
    "--mcp-config", "--session-id", "--effort", "--add-dir", "--agent", "--agents", "--allowedTools", "--disallowedTools",
    "--fallback-model", "--plugin-dir", "--managed-settings", "-n", "--allowed-tools", "--disallowed-tools", "--tools",
    "--system-prompt-file", "--append-system-prompt-file", "--json-schema", "--permission-prompt-tool", "--debug-file", "--betas",
    "--file", "--output-format", "--input-format",
  ]
  /// Flags whose value is optional: the next word is theirs only when it does not start with `-`.
  static let optionalValued: Set<String> = ["-r", "--resume", "--debug", "-w", "--worktree", "--from-pr", "--remote", "--rc"]

  static func skipsNext(_ args: [String], _ k: Int) -> Bool {
    if valued.contains(args[k]) { return true }
    guard optionalValued.contains(args[k]), k + 1 < args.count else { return false }
    return !args[k + 1].hasPrefix("-")
  }

  /// Each argument Claude Code reads as a flag, with the index of its value when it takes one (`--flag value`), up to `--`.
  static func flags(_ args: [String]) -> [(index: Int, flag: String, hasNext: Bool)] {
    var out: [(Int, String, Bool)] = []
    var k = 0
    while k < args.count {
      if args[k] == "--" { break }
      let takes = skipsNext(args, k)
      out.append((k, args[k], takes))
      k += takes ? 2 : 1
    }
    return out
  }

  /// Whether a flag with no value is given.
  public static func hasFlag(_ args: [String], _ flag: String) -> Bool { flags(args).contains { $0.flag == flag } }

  /// Main's bypass flag, when Claude Code reads one in its arguments: what a thread session, and a claude the owner opens by hand
  /// for one (the Terminals page's needs_mac row), is started with. Never by a plain search of the words: the flag after `--` is
  /// part of the prompt, and one that is another flag's value (`--append-system-prompt --dangerously-skip-permissions`) is text.
  public static let bypass = "--dangerously-skip-permissions"
  public static func bypassFlag(_ args: [String]) -> String? { hasFlag(args, bypass) ? bypass : nil }

  /// Whether a flag added at the end of the arguments (the guards' `--settings`) would not be read as one: the flags end with `--`
  /// (it would be part of the prompt), or the last flag still waits for its value (it would be that value).
  public static func swallowsAppended(_ args: [String]) -> Bool {
    let read = flags(args)
    let next = read.last.map { $0.index + ($0.hasNext ? 2 : 1) } ?? 0
    if next < args.count { return args[next] == "--" }
    return next > args.count || (read.last.map { valued.contains($0.flag) && !$0.hasNext } ?? false)
  }

  /// The last value of a flag (`--flag value` or `--flag=value`; a later one overrides an earlier), nil when it is not given.
  public static func lastValue(_ args: [String], _ flag: String) -> String? {
    var value: String?
    for f in flags(args) {
      if f.flag == flag {
        value = f.index + 1 < args.count ? args[f.index + 1] : ""
      } else if f.flag.hasPrefix(flag + "=") {
        value = String(f.flag.dropFirst(flag.count + 1))
      }
    }
    return value
  }

  /// A settings source `--setting-sources` can leave out. The managed settings and the flag's own (`--settings`) are always read.
  public enum Source: String, Sendable { case user, project, local }

  /// The sources main loads: its last `--setting-sources` (a comma-separated list; a name Claude Code does not know is no source),
  /// none of them in restricted mode (`--restricted`), and nil when the arguments say nothing (all of them).
  public static func settingSources(_ args: [String]) -> Set<Source>? {
    if hasFlag(args, "--restricted") { return [] }
    guard let value = lastValue(args, "--setting-sources") else { return nil }
    return Set(value.split(separator: ",").compactMap { Source(rawValue: $0.trimmingCharacters(in: .whitespaces)) })
  }

  static func loads(_ sources: Set<Source>?, _ s: Source) -> Bool { sources.map { $0.contains(s) } ?? true }

  /// The arguments without the bypass flags: bypass is ruled out for main, so it falls through them to its next mode. The last
  /// `--permission-mode` is the one Claude Code uses: when that is bypass, main falls past every `--permission-mode`.
  public static func withoutBypass(_ args: [String]) -> [String] {
    let lastIsBypass = lastValue(args, "--permission-mode") == "bypassPermissions"
    var drop = Set<Int>()
    for f in flags(args) {
      if f.flag == "--dangerously-skip-permissions" || f.flag == "--allow-dangerously-skip-permissions" { drop.insert(f.index) }
      if f.flag == "--permission-mode=bypassPermissions" || (lastIsBypass && f.flag.hasPrefix("--permission-mode=")) { drop.insert(f.index) }
      if f.flag == "--permission-mode", lastIsBypass || (f.index + 1 < args.count && args[f.index + 1] == "bypassPermissions") {
        drop.insert(f.index)
        drop.insert(f.index + 1)
      }
    }
    return args.enumerated().filter { !drop.contains($0.offset) }.map(\.element)
  }
}
