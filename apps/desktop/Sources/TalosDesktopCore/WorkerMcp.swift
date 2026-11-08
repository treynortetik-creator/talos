import Foundation

/// The MCP allow list at launch (docs/OPTION-C.md "Leads and the fence", `session_opts.mcp_allow`). No list: the session gets what Claude
/// Code gives it, as before. A list, even an empty one: `--strict-mcp-config` with a generated config holding `talos-app` (always) and the
/// definition of each listed server, copied from where the owner defined it; the claude.ai connectors and Chrome off; the browser and screen
/// servers denied; `mcp__<server>__*` denied for the servers that exist but are not on the list.
///
/// A server definition can carry credentials (`env`, `headers`). They are copied byte for byte into one file the app writes (0600, in a 0700
/// folder, atomically, never through a link), and no value from a definition is ever put in a log line, a notice or an error.
public enum WorkerMcp {
  public static let appName = "talos-app"
  /// Servers no list can open: they drive the owner's browser and screen.
  public static let neverOpen = ["claude-in-chrome", "computer-use"]

  /// A claude.ai account connector, as Claude Code names it (`claude.ai Gmail`).
  public static func isConnector(_ name: String) -> Bool { name.lowercased().hasPrefix("claude.ai ") }

  /// The prefix Claude Code gives a server's tools: anything outside letters, digits, `_` and `-` becomes `_`; a plugin's server is
  /// `plugin_<plugin>_<server>`.
  public static func prefix(_ name: String) -> String {
    let n = name.hasPrefix("plugin:") ? "plugin_" + name.dropFirst("plugin:".count) : name
    return String(String.UnicodeScalarView(n.unicodeScalars.map { s in
      (s.isASCII && (CharacterSet.alphanumerics.contains(s) || s == "_" || s == "-")) ? s : "_"
    }))
  }

  public static func configPath(talosHome: String, threadId: String) -> String {
    "\(talosHome)/workers/\(threadId)/mcp/mcp.json"
  }

  /// Claude Code's config folder: `CLAUDE_CONFIG_DIR` when the login environment sets it (absolute), else `<home>/.claude`.
  public static func claudeDir(home: String, env: [String: String]) -> String {
    if let c = env["CLAUDE_CONFIG_DIR"], c.hasPrefix("/") {
      var d = c
      while d.count > 1, d.hasSuffix("/") { d.removeLast() }
      return d
    }
    return home + "/.claude"
  }

  // MARK: where the owner defined servers

  private static func object(at path: String) -> [String: Any]? {
    guard let d = FileManager.default.contents(atPath: path) else { return nil }
    return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
  }

  /// A server table with the entries that are not objects, and the ones only an SDK host can register, left out.
  private static func table(_ raw: Any?) -> [String: [String: Any]] {
    var out: [String: [String: Any]] = [:]
    for (k, v) in (raw as? [String: Any]) ?? [:] {
      guard let def = v as? [String: Any], def["type"] as? String != "sdk" else { continue }
      out[k] = def
    }
    return out
  }

  private static func real(_ p: String) -> String {
    guard let r = realpath(p, nil) else { return p }
    defer { free(r) }
    return String(cString: r)
  }

  /// A server and where it was defined: `user`, `local` (the owner's own entry for the folder in the global config), `project` (the
  /// folder's `.mcp.json`) or `plugin`. `unfillable`: a plugin server that names a path this app cannot fill in.
  struct Entry {
    var def: [String: Any]
    var scope: String
    var unfillable = false
  }

  /// Every server a session started in `cwd` could use, by name. Precedence is Claude Code's: local over user over project, so a
  /// `.mcp.json` the folder ships (which anyone can write) never shadows a definition the owner made. Plugin servers are namespaced
  /// (`plugin:<plugin>:<server>`) and cannot collide. Holds credentials: never log it.
  static func entries(cwd: String, home: String, claudeDir: String) -> [String: Entry] {
    var out: [String: Entry] = [:]
    if let project = object(at: cwd + "/.mcp.json") {
      // both shapes: `{ "mcpServers": { … } }` and the table itself
      for (k, v) in table(project["mcpServers"] ?? project) { out[k] = Entry(def: v, scope: "project") }
    }
    let isDefault = claudeDir == home + "/.claude"
    let globals = isDefault ? [home + "/.claude.json", claudeDir + "/.claude.json"] : [claudeDir + "/.claude.json"]
    var local: [String: [String: Any]] = [:]
    for file in globals {
      guard let j = object(at: file) else { continue }
      for (k, v) in table(j["mcpServers"]) { out[k] = Entry(def: v, scope: "user") }
      let projects = j["projects"] as? [String: Any]
      for key in [cwd, real(cwd)] {
        if let p = projects?[key] as? [String: Any] { for (k, v) in table(p["mcpServers"]) { local[k] = v } }
      }
    }
    for (k, v) in local { out[k] = Entry(def: v, scope: "local") }
    for (k, v) in pluginServers(claudeDir: claudeDir, projectDir: cwd) { out[k] = v }
    return out
  }

  /// Every server a session started in `cwd` could use, by name, with its definition.
  public static func catalog(cwd: String, home: String, claudeDir: String) -> [String: [String: Any]] {
    entries(cwd: cwd, home: home, claudeDir: claudeDir).mapValues { $0.def }
  }

  /// The names a session started in `cwd` could use.
  public static func visibleNames(cwd: String, home: String, claudeDir: String) -> Set<String> {
    Set(entries(cwd: cwd, home: home, claudeDir: claudeDir).keys).union([appName])
  }

  /// What the owner approved of the folder's `.mcp.json`. The docs name the keys (`enabledMcpjsonServers`, `enableAllProjectMcpServers`,
  /// `disabledMcpjsonServers`) and say they live in settings files; they do not say whether Claude Code also keeps them in the folder's
  /// entry in the global config, which older versions do, so both are read: the folder's entry in the global config, and the user's own
  /// `settings.json`. The folder's own settings files are NOT read: a cloned repository can't approve its own servers. A rejection beats
  /// an approval.
  static func projectApproved(_ name: String, cwd: String, home: String, claudeDir: String) -> Bool {
    var enabled = Set<String>()
    var disabled = Set<String>()
    var all = false
    func take(_ o: [String: Any]?) {
      guard let o else { return }
      enabled.formUnion((o["enabledMcpjsonServers"] as? [String]) ?? [])
      disabled.formUnion((o["disabledMcpjsonServers"] as? [String]) ?? [])
      if o["enableAllProjectMcpServers"] as? Bool == true { all = true }
    }
    let isDefault = claudeDir == home + "/.claude"
    for file in isDefault ? [home + "/.claude.json", claudeDir + "/.claude.json"] : [claudeDir + "/.claude.json"] {
      let projects = object(at: file)?["projects"] as? [String: Any]
      for key in [cwd, real(cwd)] { take(projects?[key] as? [String: Any]) }
    }
    take(object(at: claudeDir + "/settings.json"))
    return !disabled.contains(name) && (all || enabled.contains(name))
  }

  /// Servers of plugins that are installed and switched on, named `plugin:<plugin>:<server>`. Read from the plugin's install folder
  /// (`.mcp.json`, or `mcpServers` in `.claude-plugin/plugin.json`). `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` are filled in
  /// and `CLAUDE_PLUGIN_ROOT` is set in a stdio server's environment; `${CLAUDE_PLUGIN_DATA}` is not something this app can name, so a
  /// server that uses it is marked unfillable.
  static func pluginServers(claudeDir: String, projectDir: String) -> [String: Entry] {
    var out: [String: Entry] = [:]
    for plugin in installedPlugins(claudeDir: claudeDir) where plugin.enabled {
      var defs: [String: [String: Any]] = [:]
      if let mcp = object(at: plugin.root + "/.mcp.json") { defs = table(mcp["mcpServers"] ?? mcp) }
      if defs.isEmpty, let manifest = object(at: plugin.root + "/.claude-plugin/plugin.json") { defs = table(manifest["mcpServers"]) }
      for (server, def) in defs {
        var filled = substitute(def, root: plugin.root, project: projectDir) as? [String: Any] ?? def
        if def["command"] != nil {
          var env = (filled["env"] as? [String: Any]) ?? [:]
          env["CLAUDE_PLUGIN_ROOT"] = plugin.root
          filled["env"] = env
        }
        let text = (try? JSONSerialization.data(withJSONObject: filled)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        out["plugin:\(plugin.name):\(server)"] = Entry(def: filled, scope: "plugin", unfillable: text.contains("${CLAUDE_PLUGIN_DATA}"))
      }
    }
    return out
  }

  /// The installed plugins: `<name>@<marketplace>` key, name, install folder, and whether the owner has it switched on. Both layouts of
  /// `installed_plugins.json` are read (a list of installs per plugin, or one object), neither verified against Claude Code's own code.
  static func installedPlugins(claudeDir: String) -> [(key: String, name: String, root: String, enabled: Bool)] {
    guard let installed = object(at: claudeDir + "/plugins/installed_plugins.json"),
      let plugins = installed["plugins"] as? [String: Any]
    else { return [] }
    let enabled = (object(at: claudeDir + "/settings.json")?["enabledPlugins"] as? [String: Any]) ?? [:]
    var out: [(key: String, name: String, root: String, enabled: Bool)] = []
    for (key, value) in plugins.sorted(by: { $0.key < $1.key }) {
      let entry = (value as? [Any])?.compactMap { $0 as? [String: Any] }.last ?? (value as? [String: Any])
      guard let root = entry?["installPath"] as? String, root.hasPrefix("/") else { continue }
      let name = String(key.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
      guard !name.isEmpty else { continue }
      out.append((key: key, name: name, root: root, enabled: enabled[key] as? Bool == true))
    }
    return out
  }

  private static func substitute(_ v: Any, root: String, project: String) -> Any {
    if let s = v as? String {
      return s.replacingOccurrences(of: "${CLAUDE_PLUGIN_ROOT}", with: root).replacingOccurrences(of: "${CLAUDE_PROJECT_DIR}", with: project)
    }
    if let a = v as? [Any] { return a.map { substitute($0, root: root, project: project) } }
    if let d = v as? [String: Any] { return d.mapValues { substitute($0, root: root, project: project) } }
    return v
  }

  /// The plugins that carry a messaging channel into a session: never on a thread session's list.
  static func isChannelPlugin(_ name: String) -> Bool {
    let parts = name.split(separator: ":", omittingEmptySubsequences: false)
    return parts.count >= 3 && parts[0] == "plugin" && ["telegram", "imessage"].contains(String(parts[1]))
  }

  // MARK: the plan

  public struct Plan: Equatable, Sendable {
    public var configPath: String
    /// The bytes of the generated `mcp.json`.
    public var configJSON: Data
    /// The listed servers whose definitions are in the file, in the order listed. `talos-app` is always in it and is not named here.
    public var allowed: [String]
    /// Listed servers that exist nowhere: skipped, and told to the thread.
    public var missing: [String]
    /// Listed servers a thread session can never have (connectors, the browser, channel plugins) or that this app cannot set up (a plugin
    /// path it cannot fill in): left out, and told to the thread.
    public var refused: [String]
    /// `mcp__<server>__*` for the servers that exist but are not on the list, and for the connectors.
    public var denyRules: [String]
    /// Listed servers that are the owner's own for the thread folder, with where he defined them (`local` or `project`).
    public var ownFolder: [String: String]
    /// Set when a listed server of the folder's `.mcp.json` has not been approved there: the plan is not launched, and this says how to fix it.
    public var refusal: String?
    /// Every installed plugin that is not on the list (`<name>@<marketplace>`): switched off in the worker's settings.
    public var disabledPlugins: [String]
  }

  /// The plan for a list. nil when the agent folder has no `talos-app` definition to copy: a session without it cannot read its messages.
  public static func plan(
    allow: [String], agentDir: String, cwd: String, home: String, claudeDir: String, talosHome: String, threadId: String
  ) -> Plan? {
    guard let agent = object(at: agentDir + "/.mcp.json"),
      let talos = table(agent["mcpServers"])[appName]
    else { return nil }
    let cat = entries(cwd: cwd, home: home, claudeDir: claudeDir)
    var servers: [String: Any] = [appName: WorkerSpec.cleanMcpEntry(talos)]
    var allowed: [String] = []
    var missing: [String] = []
    var refused: [String] = []
    var unapproved: [String] = []
    var own: [String: String] = [:]
    for name in allow where name != appName && !allowed.contains(name) && !missing.contains(name) && !refused.contains(name) {
      if isConnector(name) || neverOpen.contains(name) || isChannelPlugin(name) {
        refused.append(name)
        continue
      }
      guard let entry = cat[name] else {
        missing.append(name)
        continue
      }
      if entry.unfillable {
        refused.append(name)
        continue
      }
      if entry.scope == "project" {
        guard projectApproved(name, cwd: cwd, home: home, claudeDir: claudeDir) else {
          unapproved.append(name)
          continue
        }
      }
      if entry.scope == "local" || entry.scope == "project" { own[name] = entry.scope }
      // whatever the definition says, nothing a worker must never get goes with it
      servers[name] = WorkerSpec.cleanMcpEntry(entry.def)
      allowed.append(name)
    }
    // the servers that exist for main or for this folder, less the ones the list opens
    var known = Set(cat.keys).union(entries(cwd: agentDir, home: home, claudeDir: claudeDir).keys)
    known.subtract(allowed)
    known.remove(appName)
    var rules = known.sorted().map { "mcp__\(prefix($0))__*" }
    rules += neverOpen.map { "mcp__\(prefix($0))__*" } + ["mcp__claude_ai_*"]
    var seen = Set<String>()
    rules = rules.filter { seen.insert($0).inserted }
    // every installed plugin whose servers are not on the list is off for this session
    let listed = Set(allowed.compactMap { n -> String? in
      let p = n.split(separator: ":", omittingEmptySubsequences: false)
      return p.count >= 3 && p[0] == "plugin" ? String(p[1]) : nil
    })
    let disabledPlugins = installedPlugins(claudeDir: claudeDir).filter { !listed.contains($0.name) }.map { $0.key }
    let refusal: String? = unapproved.isEmpty
      ? nil
      : unapproved.map {
        "`\($0)` is defined only in \(cwd)/.mcp.json and has not been approved there. Run `claude mcp add -s local \($0) …` in that folder, or approve it once in Claude Code there (start `claude` in it and answer the question), then save the thread again."
      }.joined(separator: " ")
    guard let data = try? JSONSerialization.data(withJSONObject: ["mcpServers": servers], options: [.sortedKeys]) else { return nil }
    return Plan(
      configPath: configPath(talosHome: talosHome, threadId: threadId), configJSON: data, allowed: allowed, missing: missing,
      refused: refused, denyRules: rules, ownFolder: own, refusal: refusal, disabledPlugins: disabledPlugins)
  }

  // MARK: writing it

  public enum WriteError: Error, Equatable, Sendable {
    case linkRefused(String)
    case failed(String)
  }

  private static func kind(_ path: String) -> mode_t? {
    var st = stat()
    guard lstat(path, &st) == 0 else { return nil }
    return st.st_mode & S_IFMT
  }

  /// The generated file: its folder is 0700 (made so, or made private again), the file is 0600 and replaces the old one whole. A link
  /// in the way, at the worker's folder, at `mcp/` or at the file itself, is refused before anything is written.
  public static func write(_ plan: Plan) throws {
    let dir = (plan.configPath as NSString).deletingLastPathComponent
    let parent = (dir as NSString).deletingLastPathComponent
    for p in [parent, dir, plan.configPath] {
      if kind(p) == S_IFLNK { throw WriteError.linkRefused(p) }
    }
    if let k = kind(plan.configPath), k != S_IFREG { throw WriteError.failed("not a regular file: \(plan.configPath)") }
    do {
      try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    } catch {
      throw WriteError.failed("cannot make \(parent)")
    }
    if kind(dir) == nil, mkdir(dir, 0o700) != 0 { throw WriteError.failed("cannot make \(dir)") }
    guard kind(dir) == S_IFDIR, chmod(dir, 0o700) == 0 else { throw WriteError.failed("not a folder: \(dir)") }
    do {
      try AtomicFile.write(plan.configJSON, to: plan.configPath, mode: 0o600)
    } catch {
      throw WriteError.failed("cannot write \(plan.configPath)")
    }
  }
}
