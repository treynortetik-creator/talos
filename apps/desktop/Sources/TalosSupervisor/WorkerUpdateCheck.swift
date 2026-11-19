import Foundation
import TalosDesktopCore

/// The read-only "what would an update restart?" report (`Talos --update-check`, UpdateCheck.swift for its words). It runs on a
/// manager made for it alone, which never ticks: it reads workers.json and config.json, runs the update check's own dry plan for each
/// running session (`dryPlanDetail`) and compares it with the session's launch record. It takes no lock (`workers.lock` is the running
/// app's), runs no tmux, writes no file, audits nothing and posts nothing.
extension WorkerManager {
  public enum UpdateCheckOutcome: Equatable, Sendable {
    case rows([UpdateCheck.Row])
    /// workers.json is there and cannot be read.
    case unreadable
    /// desktop.json is there and cannot be read: every running session is unknown.
    case launchSettingsUnreadable([UpdateCheck.Row])
  }

  /// The report. `loginEnvKnown`: the login shell's environment was read (without it the python3 and claude a start would find are
  /// not known, so every running session is unknown, as the real check would not run). `launchSettingsKnown`: desktop.json read (or
  /// is not there); when it is there and cannot be read, the launch a start would make is not known either: every running session is
  /// unknown. Only on a manager that has never ticked.
  public func updateCheck(loginEnvKnown: Bool, launchSettingsKnown: Bool = true) -> UpdateCheckOutcome {
    let out = queue.sync { updateCheckLocked(loginEnvKnown: loginEnvKnown && launchSettingsKnown) }
    guard !launchSettingsKnown, case .rows(let rows) = out else { return out }
    return .launchSettingsUnreadable(rows)
  }

  private func updateCheckLocked(loginEnvKnown: Bool) -> UpdateCheckOutcome {
    precondition(timer == nil && lockFd < 0, "the update check runs on a manager of its own, never the app's running one")
    var st = stat()
    let data = FileManager.default.contents(atPath: workersJson)
    if data == nil, lstat(workersJson, &st) == 0 { return .unreadable }  // there, and not a file this user can read
    let file: WorkersFileRead
    switch WorkersFileRead.read(data) {
    case .none: return .rows([])
    case .refused: return .unreadable
    case .read(let f): file = f
    }
    let saved = rt
    defer { rt = saved }  // nothing of this look stays in the manager
    rt = file.file.threads.mapValues { Runtime(entry: $0) }
    let settings = FileManager.default.contents(atPath: configJson).flatMap(DedicatedSettings.readable)?.judgedAgainstAgentFolder(options.agentDir)
    // the dry plan reads the config through `loadSettings`, which says new dropped entries in the audit and the default thread:
    // they count as said already here (this look says nothing to anyone)
    if let settings { droppedSaid = settings.droppedEntries.map(String.init).joined(separator: ",") }
    var rows: [UpdateCheck.Row] = []
    for id in rt.keys.sorted() where UpdateCheck.printable(id) {
      guard let e = rt[id]?.entry, e.state == "live" || e.state == "busy", e.session_id != nil else { continue }  // not running: its next start takes the new spec anyway
      guard let settings, loginEnvKnown else {
        rows.append(.init(id: id, state: .unknown))
        continue
      }
      guard let s = settings.threads[id] else { continue }  // no longer a thread with its own session: parked at the next tick, not restarted
      let current: UpdateCheck.Current
      switch dryPlanDetail(id, s) {
      case .refused: current = .refused
      case .spec(let parts, let instructions):
        current = .spec(parts.hash, instructions: instructions, specWith: { parts.hash(instructionsHash: $0) })
      }
      let started = e.launched?.cwd ?? e.cwd
      let inAgent = WorkerSpec.folderKey(started) == WorkerSpec.folderKey(options.agentDir)
      let busy = e.state == "busy" || e.turn_started_at != nil
      rows.append(.init(id: id, state: UpdateCheck.classify(current, launched: e.launched, busy: busy, startedInAgentFolder: inAgent)))
    }
    return .rows(rows)
  }
}

/// `Talos --update-check [--help]`: the arguments, the output and the exit status. `check` is called only for a run, never for help
/// or a usage error (those read nothing).
public enum UpdateCheckCommand {
  public static func run(
    _ args: [String], out: (String) -> Void, err: (String) -> Void, check: () -> WorkerManager.UpdateCheckOutcome
  ) -> Int32 {
    switch UpdateCheck.parse(args) {
    case .help:
      out(UpdateCheck.help)
      return UpdateCheck.exitOK
    case .usage(let line):
      err(line)
      return UpdateCheck.exitUsage
    case .run:
      switch check() {
      case .unreadable:
        err(UpdateCheck.unreadable)
        return UpdateCheck.exitUnreadable
      case .rows(let rows):
        for l in UpdateCheck.lines(rows) { out(l) }
        return UpdateCheck.exitOK
      case .launchSettingsUnreadable(let rows):
        err(UpdateCheck.launchSettingsUnreadable)
        for l in UpdateCheck.lines(rows) { out(l) }
        return UpdateCheck.exitOK
      }
    }
  }
}

/// What the report reads before it can work out a start: desktop.json, and the environment a start is built on. Both as the app has
/// them, never the caller's: the app is started by launchd, so its login shell is read from launchd's few variables, not from a
/// Terminal's (a venv, a pyenv or a CLAUDE_CONFIG_DIR exported there would make every session read as changed).
public enum UpdateCheckLaunch {
  /// The caller's variables kept (the ones launchd gives an app too); everything else is dropped, and PATH is launchd's.
  public static let seedNames = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"]
  public static let seedPath = "/usr/bin:/bin:/usr/sbin:/sbin"

  /// The environment the login shell is read from.
  public static func seed(caller: [String: String]) -> [String: String] {
    var out: [String: String] = ["PATH": seedPath]
    for k in seedNames { if let v = caller[k], !v.isEmpty { out[k] = v } }
    return out
  }

  /// The login shell (`zsh -lic`, as `LiveSystem.loginShellEnv` reads it), started with `seed` alone.
  public static func readLoginShell(seed: [String: String]) -> [String: String]? {
    let r = ProcessRunner.run(["/bin/zsh", "-lic", LoginShellEnv.shellScript], env: seed, timeout: LoginShellEnv.timeoutSeconds)
    return LoginShellEnv.parse(r.stdout)
  }

  /// A start's environment as `WorkerLaunchEnv.env` builds it (the login shell's, desktop.json `env` on top), from the seed; and the
  /// login shell's read (nil: it failed, and the seed stands in).
  public static func baseEnv(
    caller: [String: String], overrides: [String: String], readShell: ([String: String]) -> [String: String]? = readLoginShell
  ) -> (env: [String: String], shell: [String: String]?) {
    let s = seed(caller: caller)
    let shell = readShell(s)
    return (LoginShellEnv.build(shellEnv: shell ?? s, overrides: overrides), shell)
  }

  /// desktop.json as the report takes it: the file's config, the app's start-up one when there is none, and false when it is there
  /// and cannot be read (never the defaults in its place).
  public static func config(_ read: ConfigFile.Read, missing: () -> DesktopConfig) -> (config: DesktopConfig, known: Bool) {
    switch read {
    case .loaded(let c): return (c, true)
    case .unreadable: return (.defaults, false)
    case .missing: return (missing(), true)
    }
  }
}
