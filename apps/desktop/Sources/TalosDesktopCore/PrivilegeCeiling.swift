import Foundation

/// A thread session may never start WIDER than the main session (docs/OPTION-C.md "Leads and the fence"). Three axes, checked on the
/// spec that is about to run and refused one by one, each with a typed reason:
///
/// - `permission_mode`: bypass is wider than the default mode, which is wider than plan. A worker's mode is its command line's, else the
///   `permissions.defaultMode` of its settings; main's is its own launch flag.
/// - `mcp`: the servers a worker's list opens must be servers main can use itself.
/// - `deny_rules`: the worker's deny rules must include every one main has.
///
/// The build adds main's deny rules to the worker's settings, so a spec that is built is narrower on that axis by construction; this check
/// is the last word on the finished spec, the way the fence check is, and a spec changed after the build is refused too.
public enum PrivilegeCeiling {
  /// The failure code `workers.json` carries; the axis goes beside it.
  public static let code = "mode_escalation_denied"

  public enum Axis: String, Sendable {
    case permissionMode = "permission_mode"
    case mcp
    case denyRules = "deny_rules"
  }

  public struct Denial: Error, Equatable, Sendable {
    public var axis: Axis
    /// One plain sentence. Names servers and rules, never a value from a server's definition.
    public var detail: String
    public init(axis: Axis, detail: String) {
      self.axis = axis
      self.detail = detail
    }
  }

  /// What main has: its permission arguments and default mode, the servers it can use and the deny rules it runs under (absolute).
  public struct Main: Equatable, Sendable {
    /// Main's real launch arguments, or just its permission flag.
    public var permissionArgs: [String]
    /// Main's `permissions.defaultMode` from the settings it reads, when it has one.
    public var defaultMode: String?
    public var mcpServers: Set<String>
    public var denyRules: [String]
    public init(
      permissionArgs: [String] = [], defaultMode: String? = nil, mcpServers: Set<String> = [], denyRules: [String] = []
    ) {
      self.permissionArgs = permissionArgs
      self.defaultMode = defaultMode
      self.mcpServers = mcpServers
      self.denyRules = denyRules
    }
    public var mode: Mode { Mode.from(args: permissionArgs, settingsDefault: defaultMode) }
  }

  /// A permission mode: how wide it is, and its name when the launch named one (`nil` is the built-in default, which is not known).
  public struct Mode: Comparable, Equatable, Sendable {
    public var rank: Int
    public var name: String?
    public static func < (a: Mode, b: Mode) -> Bool { a.rank < b.rank }
    public static func == (a: Mode, b: Mode) -> Bool { a.rank == b.rank }

    static let ranks: [String: Int] = [
      "plan": 0, "dontAsk": 0, "default": 1, "acceptEdits": 2, "auto": 3, "bypassPermissions": 4,
    ]
    static let widest = 4
    /// Flags that take a value, so the value is never read as a flag.
    private static let valued: Set<String> = [
      "--settings", "--name", "--model", "--append-system-prompt", "--mcp-config", "--resume", "--session-id", "--effort",
    ]

    /// The mode a launch starts in: the last mode flag, else `settingsDefault`, else the default mode. A name this build does not know is
    /// the widest. A flag that only makes bypass reachable by key counts as bypass.
    public static func from(args: [String], settingsDefault: String?) -> Mode {
      var named: String?
      var reachable = false
      var i = 0
      while i < args.count {
        let a = args[i]
        if a == "--dangerously-skip-permissions" {
          named = "bypassPermissions"
        } else if a == "--allow-dangerously-skip-permissions" {
          reachable = true
        } else if a == "--permission-mode" {
          if i + 1 < args.count { named = args[i + 1] }
          i += 1
        } else if a.hasPrefix("--permission-mode=") {
          named = String(a.dropFirst("--permission-mode=".count))
        } else if valued.contains(a) {
          i += 1
        }
        i += 1
      }
      var name = named ?? settingsDefault
      if name == "manual" { name = "default" }
      let base = ranks[name ?? "default"] ?? widest
      return Mode(rank: reachable ? max(base, widest) : base, name: name)
    }
  }

  /// nil when the spec is within main's ceiling. `mcpOwnFolder` are the listed servers that are the owner's own for the thread folder
  /// (local scope, or approved from its .mcp.json): main cannot see them, and they are allowed.
  public static func check(
    args: [String], settings: [String: Any], mcpAllowed: [String], mcpOwnFolder: [String], main: Main
  ) -> Denial? {
    let perms = settings["permissions"] as? [String: Any]
    let worker = Mode.from(args: args, settingsDefault: perms?["defaultMode"] as? String)
    if worker > main.mode {
      return Denial(axis: .permissionMode, detail: "this session would run in a wider permission mode than the main session")
    }
    let extra = mcpAllowed.filter { $0 != WorkerMcp.appName && !main.mcpServers.contains($0) && !mcpOwnFolder.contains($0) }
    if !extra.isEmpty {
      return Denial(axis: .mcp, detail: "the main session cannot use these MCP servers: \(extra.joined(separator: ", "))")
    }
    let deny = (perms?["deny"] as? [String]) ?? []
    let lacking = main.denyRules.filter { !deny.contains($0) }
    if !lacking.isEmpty {
      return Denial(axis: .denyRules, detail: "this session lacks deny rules the main session has: \(lacking.prefix(3).joined(separator: ", "))")
    }
    return nil
  }

  // MARK: what main has, from the files it reads

  /// Tools whose rules name a path.
  static let pathTools: Set<String> = ["Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit", "MultiEdit"]

  /// A path rule in the absolute `//` form, anchored where it was defined (docs: a `/path` anchors at the settings source, `path` and
  /// `./path` at the current folder). A relative rule copied as it is would mean something else in a worker's folder: `Read(./.env)` is
  /// the agent folder's `.env` for main and must stay that, not become a deny on the worker's own. Other rules are returned as they are.
  public static func absolutize(_ rule: String, slashAnchor: String, cwdAnchor: String) -> String {
    guard rule.hasSuffix(")"), let open = rule.firstIndex(of: "(") else { return rule }
    let tool = String(rule[rule.startIndex..<open])
    guard pathTools.contains(tool) else { return rule }
    let pattern = String(rule[rule.index(after: open)..<rule.index(before: rule.endIndex)])
    func trim(_ p: String) -> String {
      var h = p
      while h.count > 1, h.hasSuffix("/") { h.removeLast() }
      return h
    }
    if pattern.hasPrefix("//") || pattern.hasPrefix("~") { return rule }
    if pattern.hasPrefix("/") { return "\(tool)(/\(trim(slashAnchor))\(pattern))" }
    var rel = pattern
    while rel.hasPrefix("./") { rel.removeFirst(2) }
    return "\(tool)(/\(trim(cwdAnchor))/\(rel))"
  }

  private static func settingsObject(_ path: String) -> [String: Any]? {
    guard let d = FileManager.default.contents(atPath: path) else { return nil }
    return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
  }

  /// The deny rules main runs under, wherever they live for it: the guards' file (added to main's launch as `--settings`) and the agent
  /// folder's project settings, shared and local. Each is made absolute where it was defined (see `absolutize`). The owner's user
  /// settings apply to a worker as they do to main.
  public static func mainDenyRules(agentDir: String, talosHome: String) -> [String] {
    var out: [String] = []
    let sources: [(path: String, slash: String)] = [
      (GuardsSettings.path(talosHome: talosHome), talosHome + "/guards"),
      (agentDir + "/.claude/settings.json", agentDir),
      (agentDir + "/.claude/settings.local.json", agentDir),
    ]
    for src in sources {
      guard let deny = (settingsObject(src.path)?["permissions"] as? [String: Any])?["deny"] as? [String] else { continue }
      for r in deny {
        let a = absolutize(r, slashAnchor: src.slash, cwdAnchor: agentDir)
        if !out.contains(a) { out.append(a) }
      }
    }
    return out
  }

  /// The `permissions.defaultMode` main starts in when its launch arguments name no mode: the first of the guards' file (main's
  /// `--settings`, when it is added), the agent folder's local and shared project settings and the user's, in Claude Code's order. `auto`
  /// and `bypassPermissions` do not take effect in the project files, and then the built-in default applies, not the user's value.
  /// nil when there is none: the built-in default is not something this app can read.
  public static func mainDefaultMode(agentDir: String, talosHome: String, claudeDir: String, guardsActive: Bool = true) -> String? {
    func mode(_ path: String) -> String? { (settingsObject(path)?["permissions"] as? [String: Any])?["defaultMode"] as? String }
    if guardsActive, let m = mode(GuardsSettings.path(talosHome: talosHome)) { return m }
    for project in [agentDir + "/.claude/settings.local.json", agentDir + "/.claude/settings.json"] {
      if let m = mode(project) { return m == "auto" || m == "bypassPermissions" ? nil : m }
    }
    return mode(claudeDir + "/settings.json")
  }
}
