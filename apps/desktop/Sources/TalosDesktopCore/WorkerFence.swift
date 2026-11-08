import Foundation

/// The Talos-home deny on every dedicated worker (docs/OPTION-C.md "Leads and the fence"). A thread session works for one thread; the
/// Talos home holds every thread's messages, keys and databases. Read, Grep, Glob, Edit, Write and NotebookEdit are denied on the whole
/// home, and Claude Code also applies those rules to Bash `cat`, `head`, `tail`, `sed`, `tee` and redirections. They do not stop a program
/// that opens the file itself (`sqlite3`, `python`, `grep -r`): only a sandbox does, and a worker has none.
///
/// The spelling is the one the bridge's lead fence uses (apps/bridge/src/lead/settings.ts): `Tool(//abs/**)` and `Tool(//abs)`, in the
/// spelling given and in lower case (macOS compares names without case). There is no `!` rule of any kind: a `!` pattern is read against
/// the current folder and cannot reopen a folder a rule blocks whole. The per-thread inbox lives outside the home for that reason.
public enum WorkerFence {
  /// Readers, then writers: the bridge's order.
  public static let tools = ["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit"]

  /// Claude Code reads `* ? [ ] { }` in a rule as a glob, and `(` `)` end the pattern, so a home with one of them cannot be named by a rule.
  public static func isSafe(talosHome: String) -> Bool {
    guard talosHome.hasPrefix("/"), talosHome.count > 1 else { return false }
    return !talosHome.unicodeScalars.contains { "*?[]{}()".unicodeScalars.contains($0) || $0.value < 0x20 || $0.value == 0x7f }
  }

  /// The spellings of the home a rule names: as given, then where it really is (a symbolic link in the path), each also in lower case.
  static func spellings(_ talosHome: String) -> [String] {
    func trim(_ p: String) -> String {
      var h = p
      while h.count > 1, h.hasSuffix("/") { h.removeLast() }
      return h
    }
    let given = trim(talosHome)
    var out: [String] = []
    var candidates = [given]
    if let r = realpath(given, nil) {
      candidates.append(trim(String(cString: r)))
      free(r)
    }
    for c in candidates { for f in [c, c.lowercased()] where !out.contains(f) { out.append(f) } }
    return out
  }

  public static func denyRules(talosHome: String) -> [String] {
    let forms = spellings(talosHome)
    return tools.flatMap { tool in forms.flatMap { ["\(tool)(/\($0)/**)", "\(tool)(/\($0))"] } }
  }

  /// `settings` with `rules` added to `permissions.deny` (a union: what is there stays, nothing repeats). nil when `permissions` or its
  /// `deny` is there in a shape that cannot be added to: it is never replaced.
  public static func adding(deny rules: [String], to settings: [String: Any]) -> [String: Any]? {
    var out = settings
    var perms: [String: Any] = [:]
    if let existing = out["permissions"] {
      guard let dict = existing as? [String: Any] else { return nil }
      perms = dict
    }
    var deny: [String] = []
    if let existing = perms["deny"] {
      guard let list = existing as? [String] else { return nil }
      deny = list
    }
    for r in rules where !deny.contains(r) { deny.append(r) }
    perms["deny"] = deny
    out["permissions"] = perms
    return out
  }

  /// `settings` with every path rule in `permissions.deny` made absolute where it was defined (`PrivilegeCeiling.absolutize`). The guards'
  /// file was written for main, which runs in the agent folder: `Read(.private)` there is not a rule about the worker's own folder.
  public static func anchoring(_ settings: [String: Any], slashAnchor: String, cwdAnchor: String) -> [String: Any] {
    guard var perms = settings["permissions"] as? [String: Any], let deny = perms["deny"] as? [String] else { return settings }
    perms["deny"] = deny.map { PrivilegeCeiling.absolutize($0, slashAnchor: slashAnchor, cwdAnchor: cwdAnchor) }
    var out = settings
    out["permissions"] = perms
    return out
  }

  public static func applying(_ settings: [String: Any], talosHome: String) -> [String: Any]? {
    adding(deny: denyRules(talosHome: talosHome), to: settings)
  }

  /// The deny rules in a settings file's text, nil when it cannot be read.
  static func denyList(settingsJSON: String) -> [String]? {
    guard let obj = (try? JSONSerialization.jsonObject(with: Data(settingsJSON.utf8))) as? [String: Any] else { return nil }
    guard let perms = obj["permissions"] as? [String: Any] else { return [] }
    return perms["deny"] as? [String] ?? []
  }

  /// The fence rules a settings text lacks (all of them when it cannot be read).
  public static func missing(settingsJSON: String, talosHome: String) -> [String] {
    let want = denyRules(talosHome: talosHome)
    guard let have = denyList(settingsJSON: settingsJSON) else { return want }
    return want.filter { !have.contains($0) }
  }
}
