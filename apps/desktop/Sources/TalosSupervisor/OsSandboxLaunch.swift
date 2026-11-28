import Foundation
import TalosDesktopCore

/// What the supervisor adds around `OsSandbox` (TalosDesktopCore): the one question to git, and the one call Main's start and a thread
/// session's start both make, so the two read the switch, run the preflight and refuse the same way.
enum OsSandboxLaunch {
  /// The owner's `core.excludesFile` per home, asked once per run of the app (git is not started at every plan): the value, or nil for git's
  /// default location. The first ask of a home says in the audit log when git could not be asked.
  private static let asked = NSLock()
  nonisolated(unsafe) private static var excludesFiles: [String: String?] = [:]

  /// The owner's own `core.excludesFile` (`git config --global`, read only). Asked of the git `HardenedGit.resolve` finds (never a bare
  /// /usr/bin/git: without the Command Line Tools that is a stub that opens an install dialog), once per home per run. No git: skipped, and said.
  static func configuredExcludes(home: String, audit: (String, [String: String]) -> Void) -> String? {
    asked.lock()
    defer { asked.unlock() }
    if let known = excludesFiles[home] { return known }
    var value: String?
    if let git = HardenedGit.resolve() {
      let r = ProcessRunner.run([git, "config", "--global", "--get", "core.excludesFile"], env: ["HOME": home, "PATH": "/usr/bin:/bin"], timeout: 5)
      let t = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
      if r.ok, !t.isEmpty { value = t }
    } else {
      audit("os_sandbox_excludes_skipped", ["why": "git was not found (no Command Line Tools), so the owner's own git excludes file is not added to the sandbox's"])
    }
    excludesFiles[home] = .some(value)
    return value
  }

  /// The bun(s) and the bridge folder Talos itself recorded, where a session cannot write: the pins in the installed guards' hook
  /// (`<home>/guards/settings.json`, protected from sessions: `<bun> <clone>/apps/bridge/src/cli.ts guard-hook ...`, kept current by the guards refresh) and the
  /// buns from the fixed list the refresh uses. By real path. nil when the guards are not installed, or when the CLONE sits in the Talos home or a
  /// temp folder (a place a session can write): a `talos-app` server entry is then refused, not trusted. The session's own folder never decides
  /// this: a folder that holds or sits inside the clone must still get the record, or the clone fence (OsSandboxFolder.cloneFenceProblem) and the
  /// write blocks would be dropped for exactly that folder. The first executable bun is the record's bun; the others (not in a temp folder) are
  /// `extraBuns`; the record's bun in a temp folder or the Talos home sets `bunInTemp` (a `talos-app` entry that runs it is refused).
  static func recordedBridge(talosHome: String, home: String, tmpRoots: [String] = GuardsRefresh.tmpRoots) -> OsSandbox.TrustedBridge? {
    guard let data = FileManager.default.contents(atPath: GuardsSettings.path(talosHome: talosHome)), let pins = GuardsRefresh.pins(settings: data),
      let cli = Supervisor.realPath(pins.cli)
    else { return nil }
    let candidates = GuardsRefresh.bunCandidates(home: home) + [pins.bun]
    var buns: [String] = []
    for b in candidates.compactMap({ Supervisor.realPath($0) }) where FileManager.default.isExecutableFile(atPath: b) && !buns.contains(b) { buns.append(b) }
    guard let bun = buns.first else { return nil }
    let bridge = ((cli as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
    let clone = ((bridge as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
    let roots = ([talosHome] + tmpRoots).map { Supervisor.realPath($0) ?? $0 }
    if GuardsRefresh.isUnder(clone, roots) || GuardsRefresh.isUnder(bridge, roots) { return nil }
    return .init(bun: bun, bridgeDir: bridge, extraBuns: buns.dropFirst().filter { !GuardsRefresh.isUnder($0, roots) }, bunInTemp: GuardsRefresh.isUnder(bun, roots))
  }

  /// TESTS ONLY: one hook per Talos home, run right after a real (not dry) start's first check for that home, before anything else: where a test
  /// makes the second name that only the check at the spawn can see. Keyed by home and lock-guarded, so two suites running together each keep
  /// their own; a test removes only its own key (a nil hook).
  private static let hookLock = NSLock()
  nonisolated(unsafe) private static var afterFirstCheckHooks: [String: () -> Void] = [:]
  static func setAfterFirstCheck(home: String, _ hook: (() -> Void)?) {
    hookLock.lock()
    defer { hookLock.unlock() }
    afterFirstCheckHooks[home] = hook
  }
  private static func runAfterFirstCheck(home: String) {
    hookLock.lock()
    let hook = afterFirstCheckHooks[home]
    hookLock.unlock()
    hook?()
  }

  /// The sandbox for one start: the preflight, the folder checks, the pieces and the excludes file (nothing written when `dry`). `env` is the
  /// environment the session starts in (the login environment): its own `GIT_CONFIG_COUNT` is kept, ours added after, and the kit release is
  /// found from it, never from this app's own environment. `agentDir` is the agent folder Main runs in; it no longer decides the recorded bridge
  /// (the folder checks and the clone fence use the record whatever folder holds the clone). `tmpRoots` is for tests.
  static func prepare(
    talosHome: String, home: String, folder: String, claudeDir: String, env: [String: String], loadsProject: Bool, dry: Bool, launchArgs: [String] = [], agentDir: String? = nil,
    writableRoots: [String]? = nil, tmpRoots: [String] = GuardsRefresh.tmpRoots, audit: (String, [String: String]) -> Void
  ) -> OsSandbox.Prepared {
    var input = OsSandbox.Input(
      talosHome: talosHome, userHome: home, folder: folder, claudeDir: claudeDir, gitConfigCount: Int(env["GIT_CONFIG_COUNT"] ?? "") ?? 0,
      loadsProject: loadsProject,
      ownerExcludes: OsSandbox.ownerExcludes(userHome: home, configured: configuredExcludes(home: home, audit: dry ? { _, _ in } : audit)))
    input.launchArgs = launchArgs
    input.writableRoots = writableRoots
    input.trustedBridge = recordedBridge(talosHome: talosHome, home: home, tmpRoots: tmpRoots)
    let r = OsSandbox.prepare(input, dry: dry, kitDir: OsSandbox.kitDir(userHome: home, env: env))
    if case .refused(let why) = r, !dry { audit("os_sandbox_refused", ["why": why]) }
    if !dry { runAfterFirstCheck(home: talosHome) }
    return r
  }
}

extension OsSandboxLaunch {
  /// The one line the owner gets when config.json cannot be read and the lock, on at the last good reading, stays on (the same words as the bridge's).
  static let unreadableNotice = "Talos couldn't read its settings, so the extra lock stays on"
  private static let toldLock = NSLock()
  nonisolated(unsafe) private static var toldUnreadable: Set<String> = []
  /// True once per run of the app for one Talos home: the notice is said once, however many starts find the file unreadable. Keyed by the
  /// home (the app has one), so a second home in the same process (a test, a second app instance) gets its own notice and an earlier
  /// start elsewhere cannot use this one up.
  static func firstUnreadable(talosHome: String) -> Bool {
    toldLock.lock()
    defer { toldLock.unlock() }
    return toldUnreadable.insert(talosHome).inserted
  }
}

extension Supervisor {
  /// Main's one `--settings` (GuardsSettings.applyingToMain): the optional guards, Claude Code's own computer use turned off, and, with the OS
  /// sandbox switch ("Extra lock on protected files", config.json os_sandbox, read again at every start) on, the sandbox block and its
  /// environment. With the switch on, a start that cannot carry the lock is refused: the one line is returned and nothing is started. A
  /// config.json that cannot be read keeps the state of the last good reading, off when there was none (an audit line; one notice when it stays on), as on the TypeScript side.
  func mainGuards(_ args: inout [String], env: [String: String], cwd: String) -> String? {
    for n in OsSandbox.clearLegacyFlags(talosHome: talosAppHome) { audit("os_sandbox_old_lock", ["why": n]) }
    var on = false
    var keptOnNotice = false
    switch OsSandbox.switchState(talosHome: talosAppHome, onNotRecorded: { self.audit("os_sandbox_record_failed", ["why": "the lock is on but could not be written down as the last good reading"]) }) {
    case .off: break
    case .on: on = true
    case .unreadable(let why, let keptOn):
      on = keptOn
      audit("os_sandbox_config_unreadable", ["why": why, "lock": keptOn ? "kept on" : "kept off"])
      keptOnNotice = keptOn
    }
    let given = args
    let guarded = GuardsSettings.applyingToMain(
      to: args, talosHome: talosAppHome, cwd: cwd,
      sandbox: on
        ? {
          OsSandboxLaunch.prepare(
            talosHome: self.talosAppHome, home: self.options.home, folder: cwd, claudeDir: WorkerMcp.claudeDir(home: self.options.home, env: env),
            env: env, loadsProject: true, dry: false, launchArgs: given, agentDir: cwd, audit: { self.audit($0, $1) })
        } : nil)
    if let why = guarded.refusal { return why }
    args = guarded.args
    // the owner hears of a kept-on lock only when this start really carries it (no refusal, no "not active" warning), and once per run; a lock
    // never switched on is not announced
    if keptOnNotice, !guarded.warnings.contains(where: { $0.hasSuffix(GuardsSettings.sandboxNotOn) }), OsSandboxLaunch.firstUnreadable(talosHome: talosAppHome) {
      _ = postToPhone { _ in OsSandboxLaunch.unreadableNotice }
    }
    for w in guarded.warnings { audit("guards_not_applied", ["why": w]) }
    // Main runs with Claude Code's own computer use on: the owner hears it once per run, not only the audit log
    if guarded.warnings.contains(where: { $0.hasSuffix(GuardsSettings.notDenied) }), !computerUseNotDeniedTold {
      computerUseNotDeniedTold = postToPhone { _ in GuardsSettings.notDeniedPhoneLine }
    }
    return nil
  }

  /// The last step before Main's process starts (the TypeScript twin is PtyLaunch.beforeStart): with the switch on, the whole check runs again
  /// (nothing written), so a second name made for a protected file between the first check and the spawn refuses the start. The line, or nil.
  func sandboxRecheck(env: [String: String], cwd: String, args: [String]) -> String? {
    if !OsSandbox.switchState(talosHome: talosAppHome).isOn { return nil }
    let r = OsSandboxLaunch.prepare(
      talosHome: talosAppHome, home: options.home, folder: cwd, claudeDir: WorkerMcp.claudeDir(home: options.home, env: env), env: env,
      loadsProject: true, dry: true, launchArgs: args, agentDir: cwd, audit: { _, _ in })
    guard case .refused(let why) = r else { return nil }
    audit("os_sandbox_refused", ["why": why, "at": "spawn"])
    return why
  }
}
