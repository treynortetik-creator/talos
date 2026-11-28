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
  /// The session is outside the agent folder, so it must load the owner's settings only (`userSourcesOnly`).
  public var foldersSettingsOff = false
  /// The settings sources main loads (nil: all of them): a worker never loads one main does not.
  public var mainSources: Set<MainArgs.Source>?
  /// The delimiter token drawn for the instruction files in `--append-system-prompt` (nil: none were given): the launch spec hashes
  /// argv with it replaced (`LaunchSpecHash`), so the same files are the same spec at every start.
  public var promptToken: String?

  public var tmuxSession: String { WorkerSpec.tmuxName(threadId) }
  public var argv: [String] { [program] + args }

  public static func tmuxName(_ threadId: String) -> String { "t-\(threadId)" }
  public static func sessionName(_ threadId: String) -> String { "talos-\(threadId)" }

  /// Never in a worker's argv (OPTION-C 4.3). The same list is `WORKER_FORBIDDEN_ARGS` in the protocol package.
  public static let forbiddenArgs = ["--channels", "--dangerously-load-development-channels", "-p", "--print", "--bg"]
  /// Stripped from the environment, on top of every `TELEGRAM_*` and `IMESSAGE_*` key.
  public static let strippedEnv: Set<String> = ["TALOS_APP_BRIDGE", "MCP_PROTOCOL_NEGOTIATION", "TELEGRAM_BOT_TOKEN"]
  public static let strippedPrefixes = ["TELEGRAM_", "IMESSAGE_"]
  /// The instruction-files mode every thread session's settings name (`InstructionFiles.merged`): AGENTS.md is read beside CLAUDE.md.
  public static var instructionMode: String? {
    let configs = InstructionFiles.merged([:])["pluginConfigs"] as? [String: Any]
    return ((configs?[InstructionFiles.pluginIds[0]] as? [String: Any])?["options"] as? [String: Any])?["instructionFiles"] as? String
  }
  public static let snapshotOff = "--system-prompt-snapshot=off"

  /// The settings files whose hooks and status line every session is fenced from editing the programs of, each with the folder
  /// its relative paths start from (the agent folder, for all of them, as on Linux): the agent folder's own, and the owner's.
  public static func hookSettingsFiles(agentDir: String, home: String, env: [String: String]) -> [(settings: String, base: String)] {
    WorkerHook.projectSettingsFiles(agentDir).map { ($0, agentDir) }
      + Set([home + "/.claude", WorkerMcp.claudeDir(home: home, env: env)]).sorted().flatMap { [($0 + "/settings.json", agentDir), ($0 + "/settings.local.json", agentDir)] }
  }

  /// The deny and ask rules of the thread folder's chain of project settings (the folders from the home down, `.claude/settings.json`
  /// and `.claude/settings.local.json`), which a session under `--setting-sources user` no longer loads itself (R1-1). They only
  /// narrow, so they are carried into the session's own settings, each made absolute where it was defined: `/x` from that file's
  /// folder, `./x` and a bare name from the thread folder.
  public static func folderRules(cwd: String, home: String, parentCwd: String? = nil) -> (deny: [String], ask: [String]) {
    var deny: [String] = [], ask: [String] = []
    func collect(_ folder: String) {
      let me = WorkerHook.resolved(folder) ?? folder
      for f in WorkerInstructions.folders(folder, home: home) {
        for file in WorkerHook.projectSettingsFiles(f) {
          guard let d = WorkerHook.readSmall(file, cap: WorkerHook.settingsCap),
            let perms = ((try? JSONSerialization.jsonObject(with: d)) as? [String: Any])?["permissions"] as? [String: Any]
          else { continue }
          for r in (perms["deny"] as? [Any] ?? []).compactMap({ $0 as? String }) {
            let a = PrivilegeCeiling.absolutize(r, slashAnchor: f, cwdAnchor: me)
            if !deny.contains(a) { deny.append(a) }
          }
          for r in (perms["ask"] as? [Any] ?? []).compactMap({ $0 as? String }) {
            let a = PrivilegeCeiling.absolutize(r, slashAnchor: f, cwdAnchor: me)
            if !ask.contains(a) { ask.append(a) }
          }
        }
      }
    }
    // a sub-thread that keeps its own folder outside its parent's keeps the parent's privacy rules too: the parent's chain first
    if let parentCwd, SubThreadFolder.ownFolder(cwd: cwd, parentCwd: parentCwd) != nil { collect(parentCwd) }
    collect(cwd)
    return (deny, ask)
  }
  /// The most `--append-system-prompt` carries, in UTF-8 bytes.
  public static let appendCap = 300 * 1024
  /// A thread session outside the agent folder loads only the owner's own settings.
  public static let userSourcesOnly = ["--setting-sources", "user"]
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
    /// A sub-thread's folder is not inside its parent thread's folder (`SubThreadFolder`).
    case subThreadFolder(String)
    /// `talos-app install-guards` ran but its settings file cannot be read, so a session cannot be started under it.
    case guardsUnreadable
    /// The settings' `permissions` (or its `deny`) have a shape the Talos-home deny cannot be added to.
    case fenceUnmergeable
    /// The settings lack the Talos-home deny (`WorkerFence`).
    case fenceMissing
    /// The settings lack the write deny on the session's own hook copy, settings or MCP config (`WorkerFence.workerFilesDeny`).
    case workerFilesOpen
    /// The OS sandbox switch is on and the settings do not carry the sandbox the supervisor built (`OsSandbox.carries`).
    case sandboxMissing
    /// The Talos home has a character Claude Code reads as a glob, so no deny rule can name it.
    case unsafeTalosHome(String)
    /// The spec is wider than the main session on one axis (`PrivilegeCeiling`).
    case escalation(PrivilegeCeiling.Denial)
    /// A session outside the agent folder would load that folder's own settings.
    case folderSettingsLoaded
    /// Main's own --setting-sources leaves out what the session would load.
    case settingSourcesWiderThanMain

    public var description: String {
      switch self {
      case .badThread(let t): return "not a thread id: \(t)"
      case .badSessionId(let s): return "not a session id: \(s)"
      case .badModel(let m): return "not a model: \(m)"
      case .badEffort(let e): return "not an effort level: \(e)"
      case .forbiddenArg(let a): return "a thread session never runs with \(a)"
      case .forbiddenEnv(let k): return "a thread session never gets \(k)"
      case .relativeCwd(let c): return "the folder must be absolute: \(c)"
      case .subThreadFolder(let why): return "sub-thread folder: \(why)"
      case .guardsUnreadable: return "the guards settings file is installed but unreadable; run talos-app install-guards again"
      case .fenceUnmergeable: return "the settings' permissions can't take the Talos home deny: they are not an object with a list of deny rules"
      case .fenceMissing: return "the worker's settings lack the Talos home deny"
      case .workerFilesOpen: return "the worker's settings don't deny editing its own permission hook, settings or MCP config"
      case .sandboxMissing: return "the OS sandbox block is not in the settings as the supervisor built it"
      case .unsafeTalosHome(let h): return "the Talos home can't be named in a deny rule: \(h)"
      case .escalation(let d): return "\(PrivilegeCeiling.code) (\(d.axis.rawValue)): \(d.detail)"
      case .folderSettingsLoaded: return "a thread session outside the agent folder must start with --setting-sources user"
      case .settingSourcesWiderThanMain:
        return "the main session's --setting-sources leaves out settings a thread session would load (a thread session outside the agent folder loads your own settings, ~/.claude); add user to main's --setting-sources, or remove the flag"
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
    /// The PermissionRequest hook the session's settings run: its script and the python3 that runs it, both absolute (`WorkerHook`).
    public var permissionHook: WorkerHook.Installed
    /// Thread folder; nil = the agent folder.
    public var cwd: String?
    /// A sub-thread's parent thread folder; nil = not a sub-thread. The folder above must then be inside it.
    public var parentCwd: String?
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
    /// Every other thread's folder: their Claude Code settings are denied to this session's edits too (`WorkerFence.settingsDeny`).
    public var otherFolders: [String]
    /// The developer thread fence as the supervisor read config.json for this start (`WorkerFence.threadFenceOn`): false only when
    /// the owner turned it off, and then the settings carry no Talos-home deny. Everything else in them (main's deny rules, the guards,
    /// `extraDeny`, the settings-file deny, a lead folder's own deny) is the same either way.
    public var threadFence = true
    /// The opt-in OS sandbox (`OsSandbox`), built by the supervisor for this start when config.json says `os_sandbox: true`: its block and
    /// environment go into the settings. nil: the switch is off and the launch is as before.
    public var osSandbox: OsSandbox.Pieces?
    /// This start is a `--resume` that resumes the turn the last launch had cut (`CutTurn`): Claude Code is asked to continue it. Ignored
    /// for a start that is not `--resume`.
    public var resumeCutTurn = false
    /// The thread's compact point in tokens (`compactWindowEnv`); nil: not set.
    public var compactWindow: Int?

    public init(
      threadId: String, claudePath: String, baseEnv: [String: String], talosHome: String, agentDir: String,
      permissionHook: WorkerHook.Installed, cwd: String? = nil, model: String = "inherit", effort: String? = nil, permissionFlag: String? = nil,
      sessionId: String, resume: Bool, nonce: String, preamble: String? = nil, mcpConfigPath: String? = nil,
      mcp: WorkerMcp.Plan? = nil, mainMcpServers: Set<String> = [], mainDenyRules: [String] = [], mainArgs: [String]? = nil,
      mainDefaultMode: String? = nil, parentCwd: String? = nil, otherFolders: [String] = []
    ) {
      self.otherFolders = otherFolders
      self.threadId = threadId
      self.claudePath = claudePath
      self.baseEnv = baseEnv
      self.talosHome = talosHome
      self.agentDir = agentDir
      self.permissionHook = permissionHook
      self.cwd = cwd
      self.parentCwd = parentCwd
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

  /// A thread's compact point as the variable Claude Code reads (it outranks the autoCompactWindow setting): plain digits, nothing for unset
  /// or for a value outside the range (apps/bridge/src/supervisor/compact-window.ts is the same rule). The name is in `ClaudeEnvScrub.keep`.
  public static let compactWindowRange = 100_000...1_000_000
  public static func compactWindowEnv(_ n: Int?) -> [String: String] {
    guard let n, compactWindowRange.contains(n) else { return [:] }
    return ["CLAUDE_CODE_AUTO_COMPACT_WINDOW": String(n)]
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
    if let parent = i.parentCwd, let why = SubThreadFolder.problem(cwd: cwd, parentCwd: parent) { throw BuildError.subThreadFolder(why) }

    // TALOS_APP_THREAD_STATE is set below, and only with the thread-state hook registered: never inherited
    var env = ClaudeEnvScrub.scrub(i.baseEnv).filter { k, _ in
      !strippedEnv.contains(k) && !strippedPrefixes.contains(where: { k.hasPrefix($0) }) && k != WorkerHook.threadStateEnv
    }
    let noChannel = noChannelDir(talosHome: i.talosHome)
    env["TALOS_APP_WORKER_THREAD"] = i.threadId
    env["TALOS_SESSION_ROLE"] = "worker"
    // the kit's session-start and compaction-guard leave Main's state to Main only for a session whose own state hook is registered
    // (`addingThreadState` below): a worker without it (an app built without the hook) keeps today's behaviour exactly
    if i.permissionHook.stateBytes != nil { env[WorkerHook.threadStateEnv] = "1" }
    env["TALOS_APP_HOME"] = i.talosHome
    env["TALOS_APP_WORKER_NONCE"] = i.nonce
    // the only CLAUDE_CODE_ names a session is given (everything inherited was scrubbed above): a resume of a cut turn, nothing else
    if i.resume, i.resumeCutTurn { env.merge(CutTurn.resumeEnv) { _, new in new } }
    // a Telegram or iMessage plugin that starts anyway finds no token here and exits before it touches anything
    env["TELEGRAM_STATE_DIR"] = noChannel
    env["IMESSAGE_STATE_DIR"] = noChannel
    for (k, v) in compactWindowEnv(i.compactWindow) { env[k] = v }
    // with a list, claude.ai connectors are not fetched (the setting below says the same; some versions read only one of them)
    if i.mcp != nil { env["ENABLE_CLAUDEAI_MCP_SERVERS"] = "false" }

    let home = i.baseEnv["HOME"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? NSHomeDirectory()
    var args: [String] = []
    if let p = i.permissionFlag, !p.isEmpty { args.append(p) }
    args += ["--settings", settingsPath(talosHome: i.talosHome, threadId: i.threadId)]
    // Outside the agent folder, none of the folder's own settings load: not its .claude/settings(.local).json, nor its git root's,
    // nor its skills, commands, subagents or CLAUDE.md (Claude Code 2.1.322 holds all of them to the project source). Only the
    // owner's own (~/.claude), this file (--settings) and managed settings do. The agent folder's are the kit's, the ones main runs
    // under, so a session there loads them as main does.
    // Never wider than main: when main's own --setting-sources leaves out `user`, a session outside the agent folder is refused (it
    // would load settings main does not), and one in the agent folder gets main's own sources.
    let ownFolder = WorkerSpec.folderKey(cwd) != WorkerSpec.folderKey(i.agentDir)
    // main's own --setting-sources only: a main in restricted, safe or bare mode refuses every thread start already (MainNarrowed)
    let mainSources = MainArgs.lastValue(i.mainArgs ?? [], "--setting-sources").map { v in
      Set(v.split(separator: ",").compactMap { MainArgs.Source(rawValue: $0.trimmingCharacters(in: .whitespaces)) })
    }
    if ownFolder {
      if let m = mainSources, !m.contains(.user) { throw BuildError.settingSourcesWiderThanMain }
      args += Self.userSourcesOnly
    } else if let m = mainSources {
      guard !m.isEmpty else { throw BuildError.settingSourcesWiderThanMain }
      args += ["--setting-sources", [MainArgs.Source.user, .project, .local].filter(m.contains).map(\.rawValue).joined(separator: ",")]
    }
    // the system prompt is rendered again at every start, so an edited AGENTS.md or WORKER.md reaches a resumed conversation
    // (on by default, the first appended prompt is replayed at every --resume; Hestia's B1, seen on 2.1.322)
    args.append(Self.snapshotOff)
    args += ["--name", sessionName(i.threadId)]
    if i.model != "inherit" { args += ["--model", i.model] }
    // the instruction files the session no longer loads itself, after the thread's own preamble (WorkerInstructions.swift)
    // the whole argument stays under `appendCap` (R1-7): the files get what the preamble leaves
    let token = WorkerInstructions.newToken()
    let projectText = ownFolder ? WorkerInstructions.collect(
      folder: cwd, home: home, configDir: WorkerMcp.claudeDir(home: home, env: i.baseEnv), mode: Self.instructionMode, token: token,
      budget: Self.appendCap - (i.preamble?.utf8.count ?? 0) - 2).text : nil
    let appended = [i.preamble, projectText].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    if !appended.isEmpty { args += ["--append-system-prompt", promptValue(appended)] }
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
    for key in i.mcp?.disabledPlugins ?? [] where !InstructionFiles.isPlugin(key: key) { plugins[key] = false }
    var settings = InstructionFiles.merged(["enabledPlugins": plugins])
    if let e = i.effort { settings["effortLevel"] = e }
    // the compact point rides in the settings env too: the owner's user settings env would otherwise win over the one in the process env
    let compact = compactWindowEnv(i.compactWindow)
    if !compact.isEmpty { settings["env"] = compact }
    // no auto mode (a subagent's or a setting's `auto` would let a classifier answer the prompts this hook raises), and no inline
    // shell from skills or custom commands, which runs with no prompt at all (Hestia's third review, F2 and F3)
    settings["disableAutoMode"] = "disable"
    settings["disableSkillShellExecution"] = true
    // Claude Code's own computer use is off for every session; a list also turns off the browser server
    settings["deniedMcpServers"] = (i.mcp != nil ? WorkerMcp.neverOpen : WorkerMcp.alwaysDenied).map { ["serverName": $0] }
    if i.mcp != nil { settings["disableClaudeAiConnectors"] = true }
    // the optional guards ride in the same file, since Claude Code takes one --settings
    guard let withGuards = GuardsSettings.merged(settings, talosHome: i.talosHome) else { throw BuildError.guardsUnreadable }
    // the fence goes in AFTER the guards, as a union: the guards' file replaces `permissions` and `hooks` wholesale. Main's own deny rules
    // come with it, so a worker is never wider than main on that axis.
    let settingsDeny = WorkerFence.settingsDeny(
      // and the folders above each up to its git root, and its git roots, whose Claude Code files a session there reads too
      projectFolders: ([cwd, i.agentDir] + i.otherFolders).flatMap { [$0] + WorkerHook.configFolders($0).folders },
      configDirs: Array(Set([home + "/.claude", WorkerMcp.claudeDir(home: home, env: i.baseEnv)])).sorted(),
      // the global config, which holds the owner's user-scope MCP servers (and CLAUDE_CONFIG_DIR's own)
      files: WorkerMcp.globalConfigFiles(home: home, claudeDir: WorkerMcp.claudeDir(home: home, env: i.baseEnv), configDirSet: WorkerMcp.configDirSet(env: i.baseEnv))
        + [home + "/.claude.json"]
        // the programs the agent folder's settings and the owner's run: a PreToolUse hook can answer "allow"
        + WorkerFence.scripts(files: Self.hookSettingsFiles(agentDir: i.agentDir, home: home, env: i.baseEnv), projectDir: i.agentDir, home: home),
      trees: [i.agentDir + "/hooks", [i.agentDir, "kit", "hooks"].joined(separator: "/")],
      // and every .claude below the agent folder: a nested one loads when the session reads a file beside it (Hestia's M1)
      nested: [i.agentDir])
    let carried = ownFolder ? Self.folderRules(cwd: cwd, home: home, parentCwd: i.parentCwd) : (deny: [], ask: [])
    // with the developer thread fence off the session gets main's access: no Talos-home deny, and nothing else dropped
    // and the files the session runs under in the Talos home (its hook copy, settings, MCP config), denied to writers either way
    let fenceRules = (i.threadFence ? WorkerFence.denyRules(talosHome: i.talosHome) : []) + WorkerFence.workerFilesDeny(talosHome: i.talosHome)
      + WorkerFence.extraDeny + settingsDeny + WorkerFence.deniedTools + i.mainDenyRules
      + (i.mcp?.denyRules ?? []) + carried.deny
    // the hook's home is the session's own, as the hook read it before; its Talos home and thread are this start's, as text
    let hookSession = WorkerHook.Session(
      home: WorkerHook.hookHome(home), talosHome: i.talosHome, threadId: i.threadId, folder: cwd,
      folderHooksCount: WorkerSpec.folderKey(cwd) != WorkerSpec.folderKey(i.agentDir))
    guard var fenced = WorkerFence.adding(deny: fenceRules, to: Self.withPermissionHook(
        WorkerFence.anchoring(withGuards, slashAnchor: i.talosHome + "/guards", cwdAnchor: i.agentDir), hook: i.permissionHook,
        session: hookSession))
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
    if !carried.ask.isEmpty {
      var ask = perms["ask"] as? [String] ?? []
      for r in carried.ask where !ask.contains(r) { ask.append(r) }
      perms["ask"] = ask
    }
    if let name = main.mode.name {
      perms["defaultMode"] = name
    } else if perms["defaultMode"] == nil {
      perms["defaultMode"] = "default"  // the ceiling check below still refuses a file that asks for more than main is known to have
    }
    fenced["permissions"] = perms
    // the thread-state hook (its own live state file, put back at every boundary) and the one edit it lets the session make
    if i.permissionHook.stateBytes != nil {
      guard let added = addingThreadState(
        fenced, hook: i.permissionHook, session: .init(home: hookSession.home, talosHome: i.talosHome, threadId: i.threadId),
        talosHome: i.talosHome, agentDir: i.agentDir, threadId: i.threadId)
      else { throw BuildError.fenceUnmergeable }
      fenced = added
    }
    // the status line records the session's plan-usage reading for the bridge (WorkerUsage), run by the hook's python3; it takes
    // the place of any other status line, which a session outside the agent folder does not load anyway
    fenced["statusLine"] = WorkerUsage.statusLine(python: i.permissionHook.python, talosHome: i.talosHome, threadId: i.threadId)
    // an MCP server of the thread folder the owner has not approved there is not launched
    if let refusal = i.mcp?.refusal { throw BuildError.escalation(.init(axis: .mcp, detail: refusal)) }
    // the opt-in OS sandbox rides in the same file (the switch is on: the supervisor built it for this start)
    if let sb = i.osSandbox { fenced = OsSandbox.with(fenced, sb) }
    settings = fenced
    let data = try JSONSerialization.data(withJSONObject: settings, options: [.sortedKeys])
    let spec = WorkerSpec(
      threadId: i.threadId, program: i.claudePath, args: args, env: env, cwd: cwd,
      settingsJSON: String(decoding: data, as: UTF8.self), mcpAllowed: i.mcp?.allowed ?? [],
      mcpOwnFolder: i.mcp.map { Array($0.ownFolder.keys) } ?? [], main: main, foldersSettingsOff: ownFolder, mainSources: mainSources,
      promptToken: projectText == nil ? nil : token)
    try spec.validate(threadFence: i.threadFence, osSandbox: i.osSandbox)
    return spec
  }

  /// `settings` with the session's permission hook (`WorkerHook.command`) added under `hooks.PermissionRequest`, next to whatever hooks are already there (the
  /// optional guards' PreToolUse hook). Hooks of some other shape are left exactly as they are.
  public static func withPermissionHook(_ settings: [String: Any], hook: WorkerHook.Installed, session: WorkerHook.Session) -> [String: Any] {
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
      "hooks": [["type": "command", "timeout": 3600, "command": WorkerHook.command(hook, for: session)]]
    ])
    hooks["PermissionRequest"] = entries
    WorkerPreTool.add(to: &hooks, session: session)  // the PreToolUse record the permission hook looks its call up by (pretool-hook.ts)
    out["hooks"] = hooks
    return out
  }

  /// The thread's instructions (WORKER.md) as the value of `--append-system-prompt`. Text that starts like a flag or a channel spec
  /// starts on a new line instead, so neither the CLI nor `validate` can read it as one, and the thread still starts.
  static func promptValue(_ s: String) -> String {
    s.hasPrefix("-") || s.hasPrefix("server:") || s.hasPrefix("plugin:") ? "\n" + s : s
  }

  /// The last line of defence: a spec that could load a channel, run headless or carry a Telegram token never runs.
  /// `threadFence` is the supervisor's own read of the developer thread fence for this start, never anything the spec says: only
  /// when it is false may the settings lack the Talos-home deny. A spec built with the fence off is refused where the read is on.
  public func validate(threadFence: Bool = true, osSandbox: OsSandbox.Pieces? = nil) throws {
    for a in args {
      for f in Self.forbiddenArgs where a == f || a.hasPrefix(f + "=") {
        throw BuildError.forbiddenArg(f)
      }
      if a.hasPrefix("-p"), !a.hasPrefix("--") { throw BuildError.forbiddenArg("-p") }  // `-pfoo` is `-p foo` to a parser
      if a.hasPrefix("server:") || a.hasPrefix("plugin:") { throw BuildError.forbiddenArg(a) }
    }
    // the folder's own settings stay off: exactly the user source, read the way Claude Code reads the flag (its last one wins)
    if foldersSettingsOff, MainArgs.settingSources(args) != [.user] { throw BuildError.folderSettingsLoaded }
    if MainArgs.lastValue(args, "--system-prompt-snapshot") != "off" { throw BuildError.forbiddenArg("--system-prompt-snapshot") }
    if let m = mainSources, !(MainArgs.settingSources(args) ?? [.user, .project, .local]).isSubset(of: m) { throw BuildError.settingSourcesWiderThanMain }
    for k in env.keys {
      if Self.strippedEnv.contains(k) || ClaudeEnvScrub.isShellStartup(k) { throw BuildError.forbiddenEnv(k) }
      if Self.strippedPrefixes.contains(where: { k.hasPrefix($0) }), k != "TELEGRAM_STATE_DIR", k != "IMESSAGE_STATE_DIR" {
        throw BuildError.forbiddenEnv(k)
      }
    }
    // the cut-turn names come as the pair, with exactly these values, and only on a `--resume` (CutTurn.resumeEnv)
    let resumeNames = CutTurn.resumeEnv.keys.filter { env[$0] != nil }
    if !resumeNames.isEmpty {
      for (k, v) in CutTurn.resumeEnv where env[k] != v { throw BuildError.forbiddenEnv(k) }
      if !args.contains("--resume") { throw BuildError.forbiddenEnv(resumeNames.sorted()[0]) }
    }
    // the state dirs may only ever be the empty folder: the plugins read a token from there
    let empty = env["TALOS_APP_HOME"].map { Self.noChannelDir(talosHome: $0) }
    for k in ["TELEGRAM_STATE_DIR", "IMESSAGE_STATE_DIR"] where env[k] != empty { throw BuildError.forbiddenEnv(k) }
    // the settings env may carry the compact point, and only with the value the process env has
    if let senv = (try? JSONSerialization.jsonObject(with: Data(settingsJSON.utf8)) as? [String: Any])?["env"] as? [String: Any] {
      for (k, v) in senv where k == "CLAUDE_CODE_AUTO_COMPACT_WINDOW" && (v as? String) != env[k] { throw BuildError.forbiddenEnv(k) }
      for k in senv.keys where k != "CLAUDE_CODE_AUTO_COMPACT_WINDOW" && ClaudeEnvScrub.isInherited(k) { throw BuildError.forbiddenEnv(k) }
    }
    guard env["TALOS_APP_WORKER_THREAD"] == threadId else { throw BuildError.forbiddenEnv("TALOS_APP_WORKER_THREAD") }
    guard settingsJSON.contains("\"\(Self.telegramPlugin)\":false"), settingsJSON.contains("\"\(Self.imessagePlugin)\":false")
    else { throw BuildError.forbiddenEnv("enabledPlugins") }
    // the Talos home deny, and then the ceiling: a spec wider than main on any axis never runs
    if threadFence, !WorkerFence.missing(settingsJSON: settingsJSON, talosHome: env["TALOS_APP_HOME"] ?? "").isEmpty { throw BuildError.fenceMissing }
    // fence on or off: a session that could rewrite its own hook copy would answer its own prompts
    if !WorkerFence.workerFilesMissing(settingsJSON: settingsJSON, talosHome: env["TALOS_APP_HOME"] ?? "").isEmpty {
      throw BuildError.workerFilesOpen
    }
    let settings = (try? JSONSerialization.jsonObject(with: Data(settingsJSON.utf8))) as? [String: Any] ?? [:]
    // the switch is on (the supervisor's own read, never the spec's): the settings carry the sandbox it built, locked, and its environment
    if let sb = osSandbox, !OsSandbox.carries(settings, sb) { throw BuildError.sandboxMissing }
    // TALOS_APP_THREAD_STATE=1 exactly when the settings run both thread-state commands (the kit's session-start and compaction-guard
    // leave Main's state to Main only then): neither without the other
    let flag = env[WorkerHook.threadStateEnv]
    if let flag, flag != "1" { throw BuildError.forbiddenEnv(WorkerHook.threadStateEnv) }
    if (flag == "1") != WorkerHook.stateRegistered(settings: settings, talosHome: env["TALOS_APP_HOME"] ?? "") {
      throw BuildError.forbiddenEnv(WorkerHook.threadStateEnv)
    }
    let denied = (settings["deniedMcpServers"] as? [[String: Any]] ?? []).compactMap { $0["serverName"] as? String }
    for n in WorkerMcp.alwaysDenied where !denied.contains(n) { throw BuildError.forbiddenEnv("deniedMcpServers") }
    if let d = PrivilegeCeiling.check(
      args: args, settings: settings, mcpAllowed: mcpAllowed, mcpOwnFolder: mcpOwnFolder, main: main) { throw BuildError.escalation(d) }
  }

  /// The worker's launch file (`LaunchFile`): its env as `export`s, never in an argv, then `exec` of the worker (same pid).
  /// A file, not tmux arguments: tmux caps one command at ~16 KB, treats an argument ending in `;` as a separator, and
  /// arguments are visible in `ps`.
  public func launchScript() throws -> String { try LaunchFile.script(argv: argv, env: env) }

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
