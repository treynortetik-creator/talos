import Foundation
import TalosDesktopCore

/// A thread session's launch, as the start builds it and as the update check's dry plan works it out (restart on update, the Linux
/// twin is workers-wiring.ts `plan({dry})`). Both build the spec through `specInputs` and hash it through `launchSpecHash`, so the hash
/// a dry plan gives is the one a start records. Split out of `WorkerManager` to keep that file under the size limit.
extension WorkerManager {
  /// Any value for the dry plan's nonce: the spec never holds it.
  static let dryNonce = String(repeating: "0", count: 32)

  /// What a dry plan says: the start would be refused (and why), or it would run with this spec hash (nil: none could be made).
  enum DryPlan: Equatable {
    case refused(String)
    case hash(String?)
  }

  /// The same, with the spec kept whole (the update check compares it with the launch record in more than one way).
  enum DryDetail {
    case refused(String)
    /// `instructions`: the start's `instructions_hash` (nil in the agent folder).
    case spec(LaunchSpecHash.Parts, instructions: String?)
  }

  /// `WorkerSpec.Inputs` for a start of `id` in `cwd`, the same for a real start and a dry plan.
  func specInputs(
    _ id: String, _ s: ThreadSessionSettings, cwd: String, parent: String?, hook: WorkerHook.Installed, main: MainOwnSettings.Ceiling,
    plan: WorkerMcp.Plan?, mcpConfigPath: String?, sessionId: String, resume: Bool, nonce: String, base: [String: String],
    threadFence: Bool, osSandbox: OsSandbox.Pieces? = nil
  ) -> WorkerSpec.Inputs {
    let claudeDir = WorkerMcp.claudeDir(home: options.home, env: base)
    var i = WorkerSpec.Inputs(
      threadId: id, claudePath: options.claudePath, baseEnv: base, talosHome: options.talosHome,
      agentDir: options.agentDir, permissionHook: hook, cwd: cwd, model: s.model, effort: s.effort,
      permissionFlag: main.noBypass ? nil : options.permissionFlag,
      sessionId: sessionId, resume: resume, nonce: nonce, preamble: preamble(id),
      mcpConfigPath: plan == nil ? mcpConfigPath : nil, mcp: plan,
      mainMcpServers: WorkerMcp.visibleNames(
        cwd: options.agentDir, home: options.home, claudeDir: claudeDir, configDirSet: WorkerMcp.configDirSet(env: base)),
      mainDenyRules: main.denyRules, mainArgs: main.permissionArgs,
      mainDefaultMode: main.defaultMode, parentCwd: parent, otherFolders: threadFolders ?? [])
    i.threadFence = threadFence
    i.osSandbox = osSandbox
    return i
  }

  /// The developer thread fence for one start, read from config.json again each time (never the last good read: a file that cannot
  /// be read keeps the fence on). A real start that finds it off says so in the audit log, once per start; a dry plan says nothing.
  func threadFenceForStart(_ id: String, dry: Bool) -> Bool {
    let on = WorkerFence.threadFenceOn(configJSON: FileManager.default.contents(atPath: configJson))
    if !on, !dry { audit("worker_thread_fence_off thread=\(id)") }
    return on
  }

  /// The opt-in OS sandbox for one start, read from config.json again each time: nil while the switch is off, else the preflight's refusal or
  /// the pieces. A config.json that exists and cannot be read keeps the state of the last good reading, off when there was none (audited; a lock kept on is told once per run). A dry plan writes nothing and
  /// says nothing. `start` runs it again right before the tmux call (the TypeScript twin is PtyLaunch.beforeStart / workers-wiring).
  func osSandboxForStart(_ id: String, cwd: String, base: [String: String], dry: Bool) -> OsSandbox.Prepared? {
    switch OsSandbox.switchState(talosHome: options.talosHome, onNotRecorded: { if !dry { self.audit("os_sandbox_record_failed thread=\(id) why=the lock is on but could not be written down as the last good reading") } }) {
    case .off: return nil
    case .unreadable(let why, let keptOn):
      // an unreadable config.json keeps the state of the last good reading, off when there was none (the TypeScript side's rule); a lock kept on is said once
      if !dry {
        audit("os_sandbox_config_unreadable thread=\(id) lock=\(keptOn ? "kept on" : "kept off") why=\(why)")
        if keptOn, OsSandboxLaunch.firstUnreadable(talosHome: options.talosHome) { tell(id, slot: \.refusedNote, kind: "os sandbox config unreadable", OsSandboxLaunch.unreadableNotice) }
      }
      if !keptOn { return nil }
    case .on: break
    }
    // a thread outside the agent folder loads the owner's settings only (the worker spec's user-only setting sources)
    let own = WorkerSpec.folderKey(cwd) != WorkerSpec.folderKey(options.agentDir)
    return OsSandboxLaunch.prepare(
      talosHome: options.talosHome, home: options.home, folder: cwd, claudeDir: WorkerMcp.claudeDir(home: options.home, env: base), env: base,
      loadsProject: !own, dry: dry, agentDir: options.agentDir, audit: { audit("\($0) thread=\(id) why=\($1["why"] ?? "")") })
  }

  /// The last step before a thread session's process starts: the sandbox's whole check again, nothing written (a second name made since the first
  /// check refuses it). True when it refused: the launch script is removed and the start has failed with the line.
  func sandboxRefusedAtSpawn(_ id: String, cwd: String, base: [String: String], launch: String) -> Bool {
    guard case .refused(let why)? = osSandboxForStart(id, cwd: cwd, base: base, dry: true) else { return false }
    unlink(launch)
    fail(id, "start_failed", why)
    return true
  }

  /// The files of a launch's spec, each by the exact bytes the start writes for the session: its settings (the guards, the fence's
  /// deny rules and the inlined status-line recorder are all in them), the MCP config it is given, the permission hook and its helper
  /// as copied, and the launch config's env (`desktop.json` `env`, which arrives folded into the login environment and so is never in
  /// `env`). The system prompt rides in argv (`--append-system-prompt`). The nonce file is never one of them.
  func launchSpecFiles(spec: WorkerSpec, plan: WorkerMcp.Plan?, talosOnly: Data?, hook: WorkerHook.Installed) -> [String: Data?] {
    var files: [String: Data?] = [
      "settings.json": Data(spec.settingsJSON.utf8),
      "mcp.json": plan?.configJSON ?? talosOnly,
      // a session in the agent folder with no list loads that folder's talos-app entry itself, as written there (Linux's `agent-mcp.json`)
      "agent-mcp.json": plan == nil && !spec.foldersSettingsOff ? talosMcpBytes() : nil,
      "permission-hook": hook.hookBytes,
      "permission-hook-helper": hook.helperBytes,
      "launch-env": (try? JCS.text(.strings(updateRestart.launchEnv?() ?? [:]))).map { Data($0.utf8) },
    ]
    // the thread-state hook's files as staged: a release that changes them restarts sessions for it too
    for (name, bytes) in WorkerHook.stateLaunchFiles(hook) { files[name] = bytes }
    return files
  }

  /// A built spec's parts (`spec_hash` is their hash, never a reason to refuse the start when it cannot be made).
  func launchSpecParts(spec: WorkerSpec, plan: WorkerMcp.Plan?, talosOnly: Data?, hook: WorkerHook.Installed, base: [String: String])
    -> LaunchSpecHash.Parts
  {
    .init(
      argv: spec.argv, env: spec.env, baseEnv: base, files: launchSpecFiles(spec: spec, plan: plan, talosOnly: talosOnly, hook: hook),
      token: spec.promptToken)
  }

  /// `instructions_hash` for a built spec: only for a session outside the agent folder, whose instruction files the start hands it.
  /// In the agent folder the session loads that folder's files itself: they are never hashed, so it never reads as "instructions changed".
  static func instructionsHash(_ spec: WorkerSpec, _ parts: LaunchSpecHash.Parts) -> String? {
    spec.foldersSettingsOff ? parts.instructionsHash : nil
  }

  /// The `--mcp-config` for a folder outside the agent folder (`mcpConfig`), worked out and not written: where it goes and its bytes.
  func talosOnlyMcp(_ id: String, cwd: String) -> (path: String, bytes: Data)? {
    guard cwd != options.agentDir, let out = talosMcpBytes() else { return nil }
    return (dir(id) + "/mcp.json", out)
  }

  /// The agent folder's `talos-app` server entry, cleaned (`WorkerSpec.cleanMcpEntry`), as sorted JSON; nil when there is none.
  func talosMcpBytes() -> Data? {
    guard let d = FileManager.default.contents(atPath: options.agentDir + "/.mcp.json"),
      let root = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
      let servers = root["mcpServers"] as? [String: Any], let talos = servers["talos-app"] as? [String: Any]
    else { return nil }
    return try? JSONSerialization.data(withJSONObject: ["mcpServers": ["talos-app": WorkerSpec.cleanMcpEntry(talos)]], options: [.sortedKeys])
  }

  /// The spec a start of this running session would launch now, and its hash, with nothing written: no folder made, nothing copied,
  /// no file removed, nothing audited, no line told and no state changed. It runs the real start's read-only checks, so a start the
  /// real one would refuse is refused here too (and the session is then left as it is).
  func dryPlan(_ id: String, _ s: ThreadSessionSettings) -> DryPlan {
    switch dryPlanDetail(id, s) {
    case .refused(let why): return .refused(why)
    case .spec(let parts, _): return .hash(parts.hash)
    }
  }

  /// `dryPlan`, with the spec's parts.
  func dryPlanDetail(_ id: String, _ s: ThreadSessionSettings) -> DryDetail {
    guard let entry = rt[id]?.entry, let sessionId = entry.session_id else { return .refused("no conversation to resume") }
    if let mode = mainNarrowedMode() { return .refused(MainNarrowed.detail(mode)) }
    if options.threadsHeld { return .refused("a saved launch change waits for the owner's confirmation") }
    guard let source = options.permissionHook else { return .refused(WorkerHook.noBundledHook) }
    if let why = s.sub?.refusal { return .refused(why) }
    if let why = unreadFolderRefusal(id, s) { return .refused(why) }
    // the folder, as `startFolder` resolves it, made nowhere: a sub-thread's own folder must already be there
    var wanted = s.cwd ?? options.agentDir
    var parent: String?
    if let sub = s.sub, !sub.shares {
      guard sub.ownCwd, let p = sub.parentCwd else { return .refused("sub-thread folder: it has none of its own inside its parent's") }
      if p != options.agentDir, let why = WorkerSpec.folderProblem(p, home: options.home, talosHome: options.talosHome) {
        return .refused("sub-thread folder: the parent's folder: \(why)")
      }
      if let why = SubThreadFolder.problem(cwd: wanted, parentCwd: p) { return .refused("sub-thread folder: \(why)") }
      wanted = realpath(wanted, nil).map { r in
        defer { free(r) }
        return String(cString: r)
      } ?? wanted
      parent = p
    }
    let cwd = realpath(wanted, nil).map { r in
      defer { free(r) }
      return String(cString: r)
    } ?? wanted
    if wanted != options.agentDir {
      for path in [wanted, cwd] {
        if let why = WorkerSpec.folderProblem(path, home: options.home, talosHome: options.talosHome) { return .refused("thread folder: \(why)") }
      }
    }
    if let why = folderProblem(cwd) { return .refused(why) }
    let own = readMainOwnSettings()
    if case .unreadable = own { return .refused("main's own settings cannot be read") }
    let base = baseEnv()
    let hook: WorkerHook.Installed
    switch WorkerHook.install(
      talosHome: options.talosHome, source: source, path: base["PATH"], fenced: [options.agentDir, cwd], python: pythonRules(threadFolders ?? []),
      dry: true)
    {
    case .installed(let h, _): hook = h
    case .problem(let why): return .refused(why)
    }
    let claudeDir = WorkerMcp.claudeDir(home: options.home, env: base)
    let main = mainCeiling(own, claudeDir: claudeDir, quiet: true)
    var plan: WorkerMcp.Plan?
    if let allow = s.mcpAllow {
      plan = WorkerMcp.plan(
        allow: allow, agentDir: options.agentDir, cwd: cwd, home: options.home, claudeDir: claudeDir, talosHome: options.talosHome,
        threadId: id, configDirSet: WorkerMcp.configDirSet(env: base))
      if plan == nil { return .refused("the MCP list needs a talos-app server in the agent folder's .mcp.json") }
    }
    let talosOnly = plan == nil ? talosOnlyMcp(id, cwd: cwd) : nil
    let sandbox = osSandboxForStart(id, cwd: cwd, base: base, dry: true)
    if case .refused(let why)? = sandbox { return .refused(why) }
    do {
      let spec = try WorkerSpec.build(
        specInputs(
          id, s, cwd: cwd, parent: parent, hook: hook, main: main, plan: plan, mcpConfigPath: talosOnly?.path, sessionId: sessionId,
          resume: true, nonce: Self.dryNonce, base: base, threadFence: threadFenceForStart(id, dry: true), osSandbox: sandbox?.pieces))
      let parts = launchSpecParts(spec: spec, plan: plan, talosOnly: talosOnly?.bytes, hook: hook, base: base)
      return .spec(parts, instructions: Self.instructionsHash(spec, parts))
    } catch {
      return .refused("\(error)")
    }
  }
}
