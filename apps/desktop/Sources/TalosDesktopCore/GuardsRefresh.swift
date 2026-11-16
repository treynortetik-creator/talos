import Foundation

/// The guards' refresh at each start of Main: the app runs the owner's own `talos-app guards refresh` (apps/bridge/src/guards/refresh.ts)
/// when the guards are installed, so a release with new rules, a bun upgrade or a moved checkout is picked up without the owner running
/// `install-guards` again. The rules are the bridge's: nothing here builds one. The command prints one line, which is read strictly
/// here; only its fixed words reach the audit log or the phone, never anything else it printed.
public enum GuardsRefresh {
  /// The command's words after `talos-app`.
  public static let args = ["guards", "refresh"]
  /// Well past a bun start and a few file reads (well under a second); a hung one must not hold Main's start for long.
  public static let timeout: Double = 20

  public enum Change: String, CaseIterable, Sendable { case rules, bun, checkout, settings }
  /// The refusal words the bridge prints (refresh.ts `REFUSALS`).
  public static let refusals: Set<String> = [
    "arguments", "not-installed", "not-ours", "damaged", "unsafe", "other-home", "busy", "no-bun", "no-checkout", "checkout-moved",
  ]

  /// Where the app looks for bun, in order, each by its real path: Homebrew's two and bun's own installer. Never desktop.json's PATH or
  /// `talos_app_command`, which a session can edit (Fable R1-1).
  public static func bunCandidates(home: String) -> [String] { ["/opt/homebrew/bin/bun", "/usr/local/bin/bun", home + "/.bun/bin/bun"] }
  /// Folders anything may write without a guard (temp folders): never a bun or a checkout to pin.
  public static let tmpRoots = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"]
  /// The refresh's own environment: nothing from desktop.json, nothing a session set.
  public static func childEnv(home: String, talosHome: String) -> [String: String] {
    ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": home, "TALOS_APP_HOME": talosHome]
  }

  /// The bun and the checkout's cli.ts a guard hook command names, in every shape install has written (`"<bun>" "<cli>" guard-hook ...`
  /// and `[ -f "<bun>" ] && [ -x "<bun>" ] && [ -f "<cli>" ] && exec ...`): the bun is its first double-quoted JSON string, the cli.ts
  /// the first that ends in `/apps/bridge/src/cli.ts`, both before ` guard-hook`. nil for any other command.
  public static func pins(command: String) -> (bun: String, cli: String)? {
    guard let hookAt = command.range(of: " guard-hook --config ") else { return nil }
    let head = command[..<hookAt.lowerBound]
    var found: [String] = []
    var i = head.startIndex
    while found.count < 8, let open = head[i...].firstIndex(of: "\"") {
      var j = head.index(after: open)
      var escaped = false
      while j < head.endIndex {
        let c = head[j]
        if escaped { escaped = false } else if c == "\\" { escaped = true } else if c == "\"" { break }
        j = head.index(after: j)
      }
      guard j < head.endIndex,
        let s = (try? JSONSerialization.jsonObject(with: Data(head[open...j].utf8), options: [.fragmentsAllowed])) as? String
      else { return nil }
      found.append(s)
      i = head.index(after: j)
    }
    guard let bun = found.first, bun.hasPrefix("/"), let cli = found.first(where: { $0.hasSuffix("/apps/bridge/src/cli.ts") }) else { return nil }
    return (bun, cli)
  }

  /// The guard hook's pins in a settings file (the guards' own, Main's launch file, a thread's): its PreToolUse command hooks, the
  /// first that is ours.
  public static func pins(settings data: Data?) -> (bun: String, cli: String)? {
    guard let data, let o = SettingsJSON.object(data), let hooks = o["hooks"] as? [String: Any],
      let pre = hooks["PreToolUse"] as? [[String: Any]]
    else { return nil }
    for entry in pre {
      for h in (entry["hooks"] as? [[String: Any]]) ?? [] {
        if let c = h["command"] as? String, let p = pins(command: c) { return p }
      }
    }
    return nil
  }

  /// Whether `path` is `root` or inside it.
  public static func isUnder(_ path: String, _ roots: [String]) -> Bool {
    roots.contains { r in
      let root = r.count > 1 && r.hasSuffix("/") ? String(r.dropLast()) : r
      return path == root || path.hasPrefix(root + "/")
    }
  }

  public enum Outcome: Equatable, Sendable {
    case unchanged
    case changed([Change])
    case refused(String)
    /// Ran, but its answer is not one of the lines above (an older bridge without the command, a crash, a timeout).
    case failed(String)
  }

  /// The outcome of one run: its exit code, whether it timed out, and its stdout. The line must be the only line on stdout.
  public static func parse(status: Int32, timedOut: Bool, stdout: Data) -> Outcome {
    if timedOut { return .failed("timed out") }
    let text = String(decoding: stdout.prefix(4096), as: UTF8.self)
    let lines = text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    guard lines.count == 1, let line = lines.first, line.hasPrefix("guards refresh: ") else {
      return .failed(status == 0 ? "unreadable answer" : "exit \(status)")
    }
    let words = line.dropFirst("guards refresh: ".count).split(separator: " ", omittingEmptySubsequences: false).map(String.init)
    switch (words.first, status) {
    case ("unchanged", 0) where words.count == 1: return .unchanged
    case ("changed", 0) where words.count >= 2:
      let changes = words.dropFirst().compactMap(Change.init(rawValue:))
      guard changes.count == words.count - 1, Set(changes).count == changes.count else { return .failed("unreadable answer") }
      return .changed(changes)
    case ("refused", let s) where s != 0 && words.count == 2 && refusals.contains(words[1]): return .refused(words[1])
    default: return .failed(status == 0 ? "unreadable answer" : "exit \(status)")
    }
  }

  /// What a start of Main does with an outcome: an audit row (nil: none) and whether the owner is told.
  public struct Report: Equatable, Sendable {
    public var event: String
    public var fields: [String: String]
    public var tellOwner: Bool
    public init(event: String, fields: [String: String], tellOwner: Bool) {
      self.event = event
      self.fields = fields
      self.tellOwner = tellOwner
    }
  }

  /// A change names what changed (`changed=rules,bun`), never the rules. Nothing changed: no row. A refusal for "not installed" (removed
  /// between the app's look and the run) or "busy" (another refresh is on it) is said in the log only; any other refusal or failure is
  /// said in the log and to the owner, once per run of the app.
  public static func report(_ o: Outcome) -> Report? {
    switch o {
    case .unchanged: return nil
    case .changed(let c): return Report(event: "guards_refreshed", fields: ["changed": c.map(\.rawValue).joined(separator: ",")], tellOwner: false)
    case .refused(let w) where w == "not-installed" || w == "busy":
      return Report(event: "guards_refresh_skipped", fields: ["why": w], tellOwner: false)
    case .refused(let w): return Report(event: "guards_refresh_failed", fields: ["why": w], tellOwner: true)
    case .failed(let w): return Report(event: "guards_refresh_failed", fields: ["why": w], tellOwner: true)
    }
  }

  /// The owner's phone line for a refresh that failed. `why` is one of the fixed words above.
  public static func phoneLine(why: String) -> String {
    "Talos couldn't refresh the guards before starting Main (\(why)). The guards installed before still apply as they were. "
      + "If this keeps happening, run talos-app install-guards in Terminal."
  }

  /// The owner's line when a refresh moved the guard hook to another bun (`bun` is the path the app chose, never the command's text).
  public static func bunChangedLine(bun: String) -> String {
    "Talos moved the guard hook to the bun at \(bun) (the one it had is gone or changed). Sessions started before this restart onto it."
  }

  /// The bun the app would pin (`chosen`, its real path) is not the one the guard hook names (`pinned`), whatever the refresh said.
  public static func bunDiffersLine(pinned: String, chosen: String) -> String {
    "The guard hook still runs with the bun at \(pinned), and the bun Talos finds now is \(chosen). Talos moves the hook to it at the next start of Main that can; if this stays, run talos-app install-guards in Terminal."
  }

  /// After `busyLimit` starts of Main in a row found another refresh running.
  public static let busyLimit = 3
  public static let busyLine =
    "Talos couldn't refresh the guards at the last few starts of Main: another refresh was always running. The guards installed before still apply."

  /// Main's guard hook names a bun (or a checkout) that is gone: every guarded call is blocked until Main restarts.
  public static let mainHookGoneLine =
    "Main's guard hook can't start (its Bun moved), so Main's tool calls are blocked. Talos restarts Main as soon as nobody is typing; nothing is lost."
  /// The same for a thread's session; `name` is the thread's name as config.json gives it.
  public static func threadHookGoneLine(_ name: String) -> String {
    "Thread \(name)'s guard hook can't start (its Bun moved), so its tool calls are blocked. Talos restarts it as soon as it is quiet; nothing is lost."
  }
}
