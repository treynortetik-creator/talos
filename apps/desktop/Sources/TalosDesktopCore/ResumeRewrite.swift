import Foundation

/// Rewrites claude's session flags (DESKTOP-SPEC 4.1, 4.3 step 6). The stored `args` never carry a session flag: every
/// start strips them and appends exactly one `--resume=<uuid>` or `--session-id=<uuid>`. The readers below take both forms.
public enum ResumeRewrite {
  public enum Mode: Equatable, Sendable {
    case resume(String)
    case newSession(String)
  }

  /// Flags that take a value we strip together with it.
  static let valued: Set<String> = ["--resume", "-r", "--session-id"]
  /// Flags we strip on their own.
  static let bare: Set<String> = ["--continue", "-c", "--fork-session"]

  public static func strip(_ args: [String]) -> [String] {
    var out: [String] = []
    var i = 0
    while i < args.count {
      let a = args[i]
      if valued.contains(a) {
        // `--resume` with no id (opens a picker) is dropped; a following flag is not its value.
        if i + 1 < args.count, !args[i + 1].hasPrefix("-") { i += 2 } else { i += 1 }
        continue
      }
      if a.hasPrefix("--resume=") || a.hasPrefix("--session-id=") || bare.contains(a) {
        i += 1
        continue
      }
      out.append(a)
      i += 1
    }
    return out
  }

  /// The stored args with exactly one session flag, as ONE argument (`--resume=<id>`, `--session-id=<id>`), so the id can never be read as
  /// a flag of its own. The id comes from desktop.json, which an agent may be able to write, and is outside the launch seal (the fingerprint
  /// strips it): anything but a UUID gets no session flag at all here. Main's start refuses such an id before it gets this far
  /// (`launchLocked`, `SupervisorNotice.sessionIdInvalid`); this is the second fence.
  public static func apply(_ args: [String], _ mode: Mode) -> [String] {
    var out = strip(args)
    switch mode {
    case .resume(let id) where isUUID(id): out.append("--resume=" + id)
    case .newSession(let id) where isUUID(id): out.append("--session-id=" + id)
    case .resume, .newSession: break
    }
    return out
  }

  /// The id named by `--resume`/`-r`/`--session-id` (last one wins), if any.
  public static func sessionId(in args: [String]) -> String? {
    var found: String?
    var i = 0
    while i < args.count {
      let a = args[i]
      if valued.contains(a), i + 1 < args.count, !args[i + 1].hasPrefix("-") {
        found = args[i + 1]
        i += 2
        continue
      }
      if a.hasPrefix("--resume=") { found = String(a.dropFirst("--resume=".count)) }
      if a.hasPrefix("--session-id=") { found = String(a.dropFirst("--session-id=".count)) }
      i += 1
    }
    return found
  }

  public static func isUUID(_ s: String) -> Bool { UUID(uuidString: s) != nil }
}
