import Foundation

/// How a thread's own Claude Code session is launched (docs/OPTION-C.md, OPTION-C spec 4.3). Pure: it builds argv, env
/// and the per-worker settings file, and `validate` refuses anything that could load a channel, run headless, or reach
/// Telegram. The supervisor never launches a worker without `validate` passing.
public struct WorkerSpec: Equatable, Sendable {
  public var threadId: String
  public var program: String
  public var args: [String]
  public var env: [String: String]
  public var cwd: String
  /// The JSON written to `workers/<id>/settings.json` and passed with `--settings`.
  public var settingsJSON: String
  /// The listed MCP servers whose definitions are in the generated config (not `talos-app`); empty without a list.
  public var mcpAllowed: [String] = []
  /// Of those, the owner's own for the thread folder (local scope, or approved from its .mcp.json): main cannot see them.
  public var mcpOwnFolder: [String] = []
  /// What main has: the ceiling this spec is checked against (`PrivilegeCeiling`).
  public var main = PrivilegeCeiling.Main()

  public var tmuxSession: String { WorkerSpec.tmuxName(threadId) }
  public var argv: [String] { [program] + args }

  public static func tmuxName(_ threadId: String) -> String { "t-\(threadId)" }
  public static func sessionName(_ threadId: String) -> String { "talos-\(threadId)" }

  /// Never in a worker's argv (OPTION-C 4.3). The same list is `WORKER_FORBIDDEN_ARGS` in the protocol package.
  public static let forbiddenArgs = ["--channels", "--dangerously-load-development-channels", "-p", "--print", "--bg"]
  /// Stripped from the environment, on top of every `TELEGRAM_*` and `IMESSAGE_*` key.
  public static let strippedEnv: Set<String> = ["TALOS_APP_BRIDGE", "MCP_PROTOCOL_NEGOTIATION", "TELEGRAM_BOT_TOKEN"]
  public static let strippedPrefixes = ["TELEGRAM_", "IMESSAGE_"]
  public static let telegramPlugin = "telegram@claude-plugins-official"
  public static let imessagePlugin = "imessage@claude-plugins-official"

  /// Thread ids: `^[a-z][a-z0-9_]{0,31}$` (protocol `ThreadId`), so `t-<id>` is always a valid tmux name.
  public static func isThreadId(_ s: String) -> Bool {
    let b = Array(s.utf8)  // bytes, not Characters: a grapheme like `q` + a combining mark must not pass as `q`
    let lower = UInt8(ascii: "a")...UInt8(ascii: "z")
    let digit = UInt8(ascii: "0")...UInt8(ascii: "9")
    guard let f = b.first, lower.contains(f), b.count <= 32, s != "all" else { return false }
    return b.allSatisfy { lower.contains($0) || digit.contains($0) || $0 == UInt8(ascii: "_") }
  }

  public static func isUUID(_ s: String) -> Bool { ResumeRewrite.isUUID(s) }

  public enum BuildError: Error, Equatable, Sendable, CustomStringConvertible {
    case badThread(String)
    case badSessionId(String)
    case badModel(String)
    case badEffort(String)
    case forbiddenArg(String)
    case forbiddenEnv(String)
    case relativeCwd(String)
    /// `talos-app install-guards` ran but its settings file cannot be read, so a session cannot be started under it.
    case guardsUnreadable
    /// The settings' `permissions` (or its `deny`) have a shape the Talos-home deny cannot be added to.
    case fenceUnmergeable
    /// The settings lack the Talos-home deny (`WorkerFence`).
    case fenceMissing
    /// The Talos home has a character Claude Code reads as a glob, so no deny rule can name it.
    case unsafeTalosHome(String)
    /// The spec is wider than the main session on one axis (`PrivilegeCeiling`).
    case escalation(PrivilegeCeiling.Denial)

    public var description: String {
      switch self {
      case .badThread(let t): return "not a thread id: \(t)"
      case .badSessionId(let s): return "not a session id: \(s)"
      case .badModel(let m): return "not a model: \(m)"
      case .badEffort(let e): return "not an effort level: \(e)"
      case .forbiddenArg(let a): return "a thread session never runs with \(a)"
      case .forbiddenEnv(let k): return "a thread session never gets \(k)"
      case .relativeCwd(let c): return "the folder must be absolute: \(c)"
      case .guardsUnreadable: return "the guards settings file is installed but unreadable; run talos-app install-guards again"
      case .fenceUnmergeable: return "the settings' permissions can't take the Talos home deny: they are not an object with a list of deny rules"
      case .fenceMissing: return "the worker's settings lack the Talos home deny"
      case .unsafeTalosHome(let h): return "the Talos home can't be named in a deny rule: \(h)"
      case .escalation(let d): return "\(PrivilegeCeiling.code) (\(d.axis.rawValue)): \(d.detail)"
      }
    }
  }

  public struct Inputs: Sendable {
    public var threadId: String
    public var claudePath: String
    /// The login-shell env main uses (DESKTOP-SPEC 4.1).
    public var baseEnv: [String: String]
    /// `$TALOS_APP_HOME`.
    public var talosHome: String
    public var agentDir: String
    /// Thread folder; nil = the agent folder.
    public var cwd: String?
    /// `inherit` = no `--model` (same as main's default).
    public var model: String
    public var effort: String?
    /// The owner's permission flag from desktop.json (`--dangerously-skip-permissions`), when main uses it.
    public var permissionFlag: String?
    public var sessionId: String
    public var resume: Bool
    public var nonce: String
    /// The worker preamble (`--append-system-prompt`).
    public var preamble: String?
    /// `--mcp-config` for a folder other than the agent folder.
    public var mcpConfigPath: String?
    /// The thread's MCP allow list, planned (nil = no list: today's behaviour). Replaces `mcpConfigPath`.
    public var mcp: WorkerMcp.Plan?
    /// The servers main can use and the deny rules it runs under: the ceiling the spec is checked against.
    public var mainMcpServers: Set<String>
    public var mainDenyRules: [String]
    /// Main's real launch arguments (`--dangerously-skip-permissions`, `--permission-mode X`); nil = just `permissionFlag`.
    public var mainArgs: [String]?
    /// Main's `permissions.defaultMode` from the settings it reads, when its arguments name no mode (`PrivilegeCeiling.mainDefaultMode`).
    public var mainDefaultMode: String?

    public init(
      threadId: String, claudePath: String, baseEnv: [String: String], talosHome: String, agentDir: String,
      cwd: String? = nil, model: String = "inherit", effort: String? = nil, permissionFlag: String? = nil,
      sessionId: String, resume: Bool, nonce: String, preamble: String? = nil, mcpConfigPath: String? = nil,
      mcp: WorkerMcp.Plan? = nil, mainMcpServers: Set<String> = [], mainDenyRules: [String] = [], mainArgs: [String]? = nil,
      mainDefaultMode: String? = nil
    ) {
      self.threadId = threadId
      self.claudePath = claudePath
      self.baseEnv = baseEnv
      self.talosHome = talosHome
      self.agentDir = agentDir
      self.cwd = cwd
      self.model = model
      self.effort = effort
      self.permissionFlag = permissionFlag
      self.sessionId = sessionId
      self.resume = resume
      self.nonce = nonce
      self.preamble = preamble
      self.mcpConfigPath = mcpConfigPath
      self.mcp = mcp
      self.mainMcpServers = mainMcpServers
      self.mainDenyRules = mainDenyRules
      self.mainArgs = mainArgs
      self.mainDefaultMode = mainDefaultMode
    }
  }

  public static func settingsPath(talosHome: String, threadId: String) -> String {
    "\(talosHome)/workers/\(threadId)/settings.json"
  }
  public static func noChannelDir(talosHome: String) -> String { "\(talosHome)/workers/_nochannel" }

  static func isModel(_ m: String) -> Bool {
    guard let f = m.first, f.isASCII, f.isLetter || f.isNumber, m.count <= 80 else { return false }
    return m.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._[]-".contains($0)) }
  }

  public static func build(_ i: Inputs) throws -> WorkerSpec {
    guard isThreadId(i.threadId) else { throw BuildError.badThread(i.threadId) }
    guard isUUID(i.sessionId) else { throw BuildError.badSessionId(i.sessionId) }
    guard isModel(i.model) else { throw BuildError.badModel(i.model) }
    if let e = i.effort, e.isEmpty || e.count > 16 || !e.allSatisfy({ $0 >= "a" && $0 <= "z" }) {
      throw BuildError.badEffort(e)
    }
    let cwd = i.cwd ?? i.agentDir
    guard cwd.hasPrefix("/") else { throw BuildError.relativeCwd(cwd) }
    guard WorkerFence.isSafe(talosHome: i.talosHome) else { throw BuildError.unsafeTalosHome(i.talosHome) }

    var env = ClaudeEnvScrub.scrub(i.baseEnv).filter { k, _ in
      !strippedEnv.contains(k) && !strippedPrefixes.contains(where: { k.hasPrefix($0) })
    }
    let noChannel = noChannelDir(talosHome: i.talosHome)
    env["TALOS_APP_WORKER_THREAD"] = i.threadId
    env["TALOS_SESSION_ROLE"] = "worker"
    env["TALOS_APP_HOME"] = i.talosHome
    env["TALOS_APP_WORKER_NONCE"] = i.nonce
    // a Telegram or iMessage plugin that starts anyway finds no token here and exits before it touches anything
    env["TELEGRAM_STATE_DIR"] = noChannel
    env["IMESSAGE_STATE_DIR"] = noChannel
    // with a list, claude.ai connectors are not fetched (the setting below says the same; some versions read only one of them)
    if i.mcp != nil { env["ENABLE_CLAUDEAI_MCP_SERVERS"] = "false" }

    var args: [String] = []
    if let p = i.permissionFlag, !p.isEmpty { args.append(p) }
    args += ["--settings", settingsPath(talosHome: i.talosHome, threadId: i.threadId)]
    args += ["--name", sessionName(i.threadId)]
    if i.model != "inherit" { args += ["--model", i.model] }
    if let pre = i.preamble, !pre.isEmpty { args += ["--append-system-prompt", pre] }
    if let plan = i.mcp {
      // only the servers in the generated file; Chrome off
      args += ["--strict-mcp-config", "--mcp-config", plan.configPath, "--no-chrome"]
    } else if let m = i.mcpConfigPath {
      args += ["--mcp-config", m]
    }
    args += i.resume ? ["--resume", i.sessionId.lowercased()] : ["--session-id", i.sessionId.lowercased()]

    // both channel plugins off for this session only (never the owner's user settings)
    var plugins: [String: Bool] = [telegramPlugin: false, imessagePlugin: false]
    // with a list, every installed plugin that is not on it is off too
    for key in i.mcp?.disabledPlugins ?? [] { plugins[key] = false }
    var settings: [String: Any] = ["enabledPlugins": plugins]
    if let e = i.effort { settings["effortLevel"] = e }
    if i.mcp != nil {
      settings["disableClaudeAiConnectors"] = true
      settings["deniedMcpServers"] = WorkerMcp.neverOpen.map { ["serverName": $0] }
    }
    // the optional guards ride in the same file, since Claude Code takes one --settings
    guard let withGuards = GuardsSettings.merged(settings, talosHome: i.talosHome) else { throw BuildError.guardsUnreadable }
    // the fence goes in AFTER the guards, as a union: the guards' file replaces `permissions` and `hooks` wholesale. Main's own deny rules
    // come with it, so a worker is never wider than main on that axis.
    let fenceRules = WorkerFence.denyRules(talosHome: i.talosHome) + i.mainDenyRules + (i.mcp?.denyRules ?? [])
    guard var fenced = WorkerFence.adding(deny: fenceRules, to: Self.withPermissionHook(
        WorkerFence.anchoring(withGuards, slashAnchor: i.talosHome + "/guards", cwdAnchor: i.agentDir), agentDir: i.agentDir))
    else {
      throw BuildError.fenceUnmergeable
    }
    // Main's real mode goes into the settings as the default mode. It outranks the thread folder's project and local settings, so a
    // folder asking for `acceptEdits` cannot widen what the session starts in. When no source names main's mode, write the built-in
    // default explicitly (unless a settings file already names one, which the ceiling then checks) so the thread folder cannot override it.
    let main = PrivilegeCeiling.Main(
      permissionArgs: i.mainArgs ?? (i.permissionFlag.map { [$0] } ?? []), defaultMode: i.mainDefaultMode, mcpServers: i.mainMcpServers,
      denyRules: i.mainDenyRules)
    var perms = fenced["permissions"] as? [String: Any] ?? [:]
    if let name = main.mode.name {
      perms["defaultMode"] = name
    } else if perms["defaultMode"] == nil {
      perms["defaultMode"] = "default"  // the ceiling check below still refuses a file that asks for more than main is known to have
    }
    fenced["permissions"] = perms
    // an MCP server of the thread folder the owner has not approved there is not launched
    if let refusal = i.mcp?.refusal { throw BuildError.escalation(.init(axis: .mcp, detail: refusal)) }
    settings = fenced
    let data = try JSONSerialization.data(withJSONObject: settings, options: [.sortedKeys])
    let spec = WorkerSpec(
      threadId: i.threadId, program: i.claudePath, args: args, env: env, cwd: cwd,
      settingsJSON: String(decoding: data, as: UTF8.self), mcpAllowed: i.mcp?.allowed ?? [],
      mcpOwnFolder: i.mcp.map { Array($0.ownFolder.keys) } ?? [], main: main)
    try spec.validate()
    return spec
  }

  /// The kit's PermissionRequest hook (`kit/hooks/permission-relay.py`, linked into the agent folder's `hooks/`). A thread session
  /// is not a channel, so Claude Code never relays its permission prompts; this hook is how they reach the phone. It carries the
  /// session's own nonce and thread from the environment above, and prints nothing (leaving Claude Code's prompt as it is) when the
  /// script, python3, the bridge or the owner's switch is missing. The agent folder's path is quoted, and the script is read from
  /// there, not from the thread folder the session runs in. `TALOS_APP_PERM_HOOK_SOURCE=worker` marks this copy: the agent folder's
  /// own copy (registered in its settings, and loaded too when the thread folder is the agent folder) stays silent in a thread
  /// session, so one prompt raises one card.
  public static func permissionHookCommand(agentDir: String) -> String {
    let script = LaunchSpec.shellQuote(agentDir + "/hooks/permission-relay.py")
    return "f=\(script); [ -f \"$f\" ] || exit 0; command -v python3 >/dev/null 2>&1 || exit 0; TALOS_APP_PERM_HOOK_SOURCE=worker exec python3 \"$f\""
  }

  /// `settings` with the permission hook added under `hooks.PermissionRequest`, next to whatever hooks are already there (the
  /// optional guards' PreToolUse hook). Hooks of some other shape are left exactly as they are.
  public static func withPermissionHook(_ settings: [String: Any], agentDir: String) -> [String: Any] {
    var out = settings
    var hooks: [String: Any]
    if let existing = out["hooks"] {
      guard let dict = existing as? [String: Any] else { return settings }
      hooks = dict
    } else {
      hooks = [:]
    }
    var entries = (hooks["PermissionRequest"] as? [Any]) ?? []
    entries.append([
      "hooks": [["type": "command", "timeout": 3600, "command": permissionHookCommand(agentDir: agentDir)]]
    ])
    hooks["PermissionRequest"] = entries
    out["hooks"] = hooks
    return out
  }

  /// The last line of defence: a spec that could load a channel, run headless or carry a Telegram token never runs.
  public func validate() throws {
    for a in args {
      for f in Self.forbiddenArgs where a == f || a.hasPrefix(f + "=") {
        throw BuildError.forbiddenArg(f)
      }
      if a.hasPrefix("-p"), !a.hasPrefix("--") { throw BuildError.forbiddenArg("-p") }  // `-pfoo` is `-p foo` to a parser
      if a.hasPrefix("server:") || a.hasPrefix("plugin:") { throw BuildError.forbiddenArg(a) }
    }
    for k in env.keys {
      if Self.strippedEnv.contains(k) { throw BuildError.forbiddenEnv(k) }
      if Self.strippedPrefixes.contains(where: { k.hasPrefix($0) }), k != "TELEGRAM_STATE_DIR", k != "IMESSAGE_STATE_DIR" {
        throw BuildError.forbiddenEnv(k)
      }
    }
    // the state dirs may only ever be the empty folder: the plugins read a token from there
    let empty = env["TALOS_APP_HOME"].map { Self.noChannelDir(talosHome: $0) }
    for k in ["TELEGRAM_STATE_DIR", "IMESSAGE_STATE_DIR"] where env[k] != empty { throw BuildError.forbiddenEnv(k) }
    guard env["TALOS_APP_WORKER_THREAD"] == threadId else { throw BuildError.forbiddenEnv("TALOS_APP_WORKER_THREAD") }
    guard settingsJSON.contains("\"\(Self.telegramPlugin)\":false"), settingsJSON.contains("\"\(Self.imessagePlugin)\":false")
    else { throw BuildError.forbiddenEnv("enabledPlugins") }
    // the Talos home deny, and then the ceiling: a spec wider than main on any axis never runs
    if !WorkerFence.missing(settingsJSON: settingsJSON, talosHome: env["TALOS_APP_HOME"] ?? "").isEmpty { throw BuildError.fenceMissing }
    let settings = (try? JSONSerialization.jsonObject(with: Data(settingsJSON.utf8))) as? [String: Any] ?? [:]
    if let d = PrivilegeCeiling.check(
      args: args, settings: settings, mcpAllowed: mcpAllowed, mcpOwnFolder: mcpOwnFolder, main: main) { throw BuildError.escalation(d) }
  }

  /// What the pane runs: a small script that replaces the environment wholesale and execs the worker (same pid). A file,
  /// 0600 in the worker's 0700 folder, not tmux arguments: tmux caps one command at ~16 KB, treats an argument ending in
  /// `;` as a separator, and arguments are visible in `ps`.
  public func launchScript() -> String {
    var e = env
    e["TERM"] = e["TERM"] ?? "xterm-256color"
    let pairs = e.keys.sorted().map { LaunchSpec.shellQuote("\($0)=\(e[$0] ?? "")") }
    let words = (["/usr/bin/env", "-i"] + pairs + [LaunchSpec.shellQuote(program)] + args.map(LaunchSpec.shellQuote))
    return "#!/bin/sh\nexec " + words.joined(separator: " ") + "\n"
  }

  /// The `talos-app` entry for a worker's `--mcp-config`, with anything a worker must never get removed from its env.
  public static func cleanMcpEntry(_ entry: [String: Any]) -> [String: Any] {
    var out = entry
    if let env = entry["env"] as? [String: Any] {
      out["env"] = env.filter { k, _ in
        !strippedEnv.contains(k) && !strippedPrefixes.contains(where: { k.hasPrefix($0) })
      }
    }
    return out
  }

  /// The identity of a folder for "one worker per folder": realpath, no trailing slash, case-folded (APFS). `cwd` as
  /// given when it doesn't resolve.
  public static func folderKey(_ cwd: String) -> String {
    let r: String
    if let p = realpath(cwd, nil) {
      r = String(cString: p)
      free(p)
    } else {
      r = cwd
    }
    return r.lowercased().replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
  }

  /// The folder re-check before every start (docs/OPTION-C.md: the bridge checks a thread folder only when it changes,
  /// so it could have been swapped for a symlink since). After resolving symlinks it must be an existing directory under
  /// `home` (not `home` itself), and not inside `~/.claude` (as named, or wherever it is a symlink to) or `$TALOS_APP_HOME`.
  /// Compared case-insensitively, as APFS is. It must also fit the protocol's `AbsolutePath`: this resolved value goes into
  /// `workers.json`, and one entry the hub can't parse reads as "supervisor down" for every thread. nil = fine, else the reason.
  public static func folderProblem(_ cwd: String, home: String, talosHome: String) -> String? {
    func real(_ p: String) -> String? {
      guard let r = realpath(p, nil) else { return nil }
      defer { free(r) }
      return String(cString: r)
    }
    guard cwd.hasPrefix("/"), !cwd.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else {
      return "the folder must be an absolute path without . or .."
    }
    guard let r = real(cwd) else { return "the folder does not exist" }
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: r, isDirectory: &isDir), isDir.boolValue else { return "not a folder" }
    let unsendable = r.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f }
    guard r.utf16.count <= 512, !unsendable else { return "the folder path is too long or has control characters" }
    let norm = { (p: String) in (real(p) ?? p).lowercased().replacingOccurrences(of: "/+$", with: "", options: .regularExpression) }
    let f = r.lowercased()
    let h = norm(home)
    func under(_ root: String) -> Bool { f == root || f.hasPrefix(root + "/") }
    if !under(h) || f == h { return "the folder must be inside your home folder" }
    if under(h + "/.claude") || under(norm(home + "/.claude")) { return "the folder can't be inside ~/.claude" }
    if under(norm(talosHome)) { return "the folder can't be inside the Talos data folder" }
    return nil
  }

  /// A worker's argv must never look like main's (TakeoverCheck): channels on the command line = a bug.
  public static func argvLooksLikeMain(_ argv: [String]) -> Bool {
    argv.contains { a in forbiddenArgs.prefix(2).contains(where: { a == $0 || a.hasPrefix($0 + "=") }) }
      || argv.contains("server:talos-app")
  }
}
