import AppKit
import Foundation
import TalosDesktopCore
import TalosSupervisor

/// Glue between the supervisor and the menu/windows. Thin on purpose (D2): the logic lives in TalosSupervisor.
/// The supervisor runs only when `desktop.json` exists; with no file nothing starts (the owner sets it up first, by
/// importing his command or with Adopt).
@MainActor
final class SupervisorController: ObservableObject {
  static let supportDir = NSHomeDirectory() + "/Library/Application Support/Talos"
  static let configPath = supportDir + "/desktop.json"
  static let auditPath = NSHomeDirectory() + "/Library/Logs/Talos/supervisor.log"

  @Published var status: Supervisor.Status
  @Published var configured: Bool
  @Published var notice: String = ""
  /// The text the last supervisor `.needsYou` event put in `notice`. While `notice` still equals it, the menu follows `status.needsYou`.
  private(set) var needsYouEventNotice: String?
  @Published var adopt: AdoptPlan?
  @Published var adoptNote: String = ""
  /// Bumps when Create, Adopt, Choose, Import or Adopt-a-session rewrites the config, so an open Settings window reloads its text boxes.
  @Published var configRevision = 0

  /// The running app's controller, for the main window's Terminal screen: it must not depend on the Terminals window having
  /// been opened (nothing attached the model to it on a normal launch, and the page showed no tabs).
  static weak var current: SupervisorController?

  let supervisor: Supervisor
  /// Option C (docs/OPTION-C.md): thread sessions. Runs only with the tmux host; starts nothing until the owner
  /// switches a thread to "Own session" and main's bridge writes a wake file for it.
  let workers: WorkerManager?
  let probe = LiveSystem()
  let hostKind: HostKind
  let tmuxAttach: [String]?
  /// `tmux has-session` for the agent: a failed start leaves the session and its dead pane behind (audit D43).
  let tmuxHasSession: [String]?
  /// Bumped by Import with what it just did, so Mac settings can say so (U7). Empty when nothing is to be said.
  @Published var importNote: String = ""
  /// Whether any thread's own session may be running in tmux. Read off the main thread and published, so a view never waits on
  /// the worker manager's queue. Locks the host picker (see `HostChoice.canChange`).
  @Published var workersRunning = false
  /// Whether a usable tmux (3.2+) exists. Found once at launch: it runs a process, so no view asks for it.
  var tmuxUsable: Bool
  private var refresh: Timer?
  /// The popup for a thread session's start-up questions (NeedsYouPopup.swift); it never takes the keyboard.
  private var needsYouPopups: NeedsYouPopupController?
  /// Settings changed before setup wait here (U8); see `PreSetup`.
  let store: SettingsStore

  /// The config the app starts with and whether `desktop.json` exists. Without the file, settings changed before setup come back.
  static func startupConfig(store: SettingsStore) -> (config: DesktopConfig, hasFile: Bool) {
    let hasFile = FileManager.default.fileExists(atPath: configPath)
    if hasFile { return (((try? ConfigFile.load(configPath)) ?? nil) ?? .defaults, true) }
    return (PreSetup.startupConfig(file: nil, store: store), false)
  }

  init(store: SettingsStore = DefaultsStore()) {
    self.store = store
    let start = Self.startupConfig(store: store)
    let cfg = start.config
    configured = start.hasFile
    // A file that exists is the truth. Values held from before it was made are stale, and a later Import or Adopt must not lay
    // them over the live settings.
    if start.hasFile { PreSetup.finish(store: store, fileExists: true) }
    let env = ProcessInfo.processInfo.environment
    let host: PtyHost
    var attach: [String]?
    var has: [String]?
    let foundTmux = Self.findTmux(env: env)
    let tmuxConf = Bundle.main.path(forResource: "tmux", ofType: "conf")
    tmuxUsable = foundTmux != nil && tmuxConf != nil  // what the host choice below can actually use
    if cfg.host != .direct, let tmux = foundTmux, let conf = tmuxConf {
      let cmds = TmuxCommands(tmux: tmux, socket: TmuxCommands.defaultSocket, configPath: conf)
      host = TmuxPtyHost(commands: cmds, baseEnv: env)
      attach = cmds.attach()
      has = cmds.hasSession()
    } else {
      host = SwiftTermPtyHost()
    }
    hostKind = host.kind
    tmuxAttach = attach
    tmuxHasSession = has
    let box = WorkerBox()
    var opts = Supervisor.Options(
      name: TmuxCommands.mainSession, configPath: Self.configPath, home: NSHomeDirectory(), auditLogPath: Self.auditPath)
    // our own worker panes never block main's takeover check (OPTION-C 4.4)
    opts.siblingGroups = { box.groups }
    opts.launchTrust = Self.launchTrust
    let sup = Supervisor(options: opts, host: host, probe: probe)
    supervisor = sup
    workers = Self.makeWorkers(cfg: cfg, env: env, probe: probe, mainPid: { sup.status.childPid ?? 0 }, current: { sup.currentConfig() })
    box.manager = workers
    // Main's development-channels warning, when refused, goes to the owner as a card the bridge posts (SupervisorDevCard.swift)
    workers?.setMainDialog { [weak sup] in sup?.status.devDialog }
    // a worker stuck on a prompt gets one line in its own thread, through the same signed `talos-app post` main's notices use
    workers?.postNotice = { [weak sup] thread, text in sup?.postToThread(thread, text: text) ?? .failed }
    status = supervisor.status
    // Before setup the file doesn't exist and the supervisor would start from the defaults: hand it the held values.
    if !start.hasFile {
      sup.updateConfig(cfg)
      sup.drain()  // ticking has not started, so this is instant; `currentConfig()` below must see the held values
    }
    supervisor.onEvent = { [weak self] e in Task { @MainActor in self?.handle(e) } }
    workers?.onEvent = { [weak self] e in Task { @MainActor in self?.handleWorker(e) } }
    // asked from the worker queue: nothing here waits for the main thread. False when there is no controller to ask.
    workers?.openTerminals = { [weak self] thread in
      guard self != nil else { return false }
      Task { @MainActor in self?.showThreadTerminal(thread) }
      return true
    }
    // the Mac popup: the workers' dialogs, and Main's own development-channels warning (no bridge runs while Main waits on it)
    needsYouPopups = NeedsYouPopupController(
      source: MainAndWorkersPopupSource(workers: workers ?? NoWorkerPopups(), main: sup),
      quiet: { MainActor.assumeIsolated { NeedsYouPopupController.statusQuiet() } })
    refresh = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in
        guard let self else { return }
        self.status = self.supervisor.status
        if let w = self.workers {
          WorkersRunningPoll.poll(w) { running in if self.workersRunning != running { self.workersRunning = running } }
        }
      }
    }
    if configured {
      supervisor.startTicking()
      // A rescue relaunch (Quit & Reopen) joins a live session but never starts a new one by itself.
      supervisor.attachOrStart(allowColdStart: cfg.startSessionOnLaunch && !RelaunchWatchdog.isRelaunch(CommandLine.arguments))
      workers?.startTicking()
    }
    // A tap on a banner opens the pane before any menu button has attached a model to it.
    Self.current = self
    TerminalWindowController.shared.attach(model: self)
  }

  /// The key store that seals `confirmed_launch`: in memory until the app's own start swaps in the Keychain one (`TalosApp.init`), so a test that
  /// makes a controller never reads or writes the owner's Keychain.
  nonisolated(unsafe) static var launchTrust: LaunchTrust = MemoryLaunchTrust()

  /// The worker manager for Option C, or nil without tmux (workers live only in `tmux -L talos`, OPTION-C decision 1).
  static func makeWorkers(
    cfg: DesktopConfig, env: [String: String], probe: LiveSystem, mainPid: @escaping @Sendable () -> Int32,
    current: (@Sendable () -> DesktopConfig)? = nil
  ) -> WorkerManager? {
    guard cfg.host != .direct, let tmux = findTmux(env: env), let conf = Bundle.main.path(forResource: "tmux", ofType: "conf")
    else { return nil }
    let home = NSHomeDirectory()
    let talosHome = cfg.env["TALOS_APP_HOME"] ?? env["TALOS_APP_HOME"] ?? home + "/.config/talos/app"
    let loginEnv = LoginShellEnv.build(shellEnv: probe.loginShellEnv() ?? env, overrides: [:])
    let claude =
      cfg.claudePath == "auto"
      ? (LoginShellEnv.which("claude", path: loginEnv["PATH"], isExecutable: FileManager.default.isExecutableFile) ?? "claude")
      : cfg.claudePath
    var o = WorkerManager.Options(
      talosHome: talosHome, agentDir: cfg.agentDir, claudePath: claude,
      permissionFlag: cfg.args.contains("--dangerously-skip-permissions") ? "--dangerously-skip-permissions" : nil,
      tmux: tmux, tmuxConf: conf)
    o.mainArgs = cfg.args
    o.auditLogPath = Self.auditPath
    let m = WorkerManager(options: o, probe: probe, baseEnv: { loginEnv }, mainPanePid: mainPid)
    if let current { m.launchSource = { Self.launchSource(current(), loginEnv: loginEnv) } }
    return m
  }

  /// The folder, claude path and permission flag as desktop.json says now (D10). The login-shell lookup runs per call only
  /// when the path is "auto" and is cheap (a PATH walk over the env already built).
  nonisolated static func launchSource(_ cfg: DesktopConfig, loginEnv: [String: String]) -> WorkerManager.LaunchSource {
    let claude =
      cfg.claudePath == "auto"
      ? (LoginShellEnv.which("claude", path: loginEnv["PATH"], isExecutable: FileManager.default.isExecutableFile) ?? "claude")
      : cfg.claudePath
    return .init(
      agentDir: cfg.expandedAgentDir(home: NSHomeDirectory()), claudePath: claude,
      permissionFlag: cfg.args.contains("--dangerously-skip-permissions") ? "--dangerously-skip-permissions" : nil, mainArgs: cfg.args)
  }

  /// How many times tmux was looked for (it runs `tmux -V`). A test asserts a window being open adds none.
  nonisolated(unsafe) static var findTmuxCalls = 0
  private static let findTmuxLock = NSLock()

  static func findTmux(env: [String: String]) -> String? {
    findTmuxLock.withLock { findTmuxCalls += 1 }
    let path = (env["PATH"] ?? "") + ":/opt/homebrew/bin:/usr/local/bin"
    guard let t = LoginShellEnv.which("tmux", path: path, isExecutable: FileManager.default.isExecutableFile) else {
      return nil
    }
    return TmuxPtyHost.isUsable(t) ? t : nil
  }

  /// What "open the terminal when the agent needs you" does. Tests replace it with a spy.
  /// It orders the pane to the front but does not take the keyboard (a stray Return into a trust dialog would answer it for
  /// the owner) and stays away inside the owner's quiet window; the notice still shows in the menu.
  var openTerminalPane: @MainActor () -> Void = {
    if StatusCoordinator.shared.quietNow == true { return }
    TerminalWindowController.shared.show(takeFocus: false)
  }

  func handle(_ e: Supervisor.Event) {
    status = supervisor.status
    switch e {
    case .needsYou(let n):
      notice = "\(SupervisorNotice.needsYou): \(Self.describe(n))"
      needsYouEventNotice = notice
    case .openTerminal:
      // Emitted when `open_terminal_on_dialog` is on. Nothing handled it, so the setting did nothing (audit D8).
      TerminalWindowController.shared.attach(model: self)
      openTerminalPane()
    case .autoConfirmed: notice = SupervisorNotice.restarted
    case .stoppedRestarting: notice = SupervisorNotice.stoppedRestarting
    case .resumeFailed: notice = SupervisorNotice.resumeFailed
    case .blocked(let b): notice = "\(SupervisorNotice.blocked)\(b.first.map { ": " + $0.message } ?? "")"
    case .confirmFailed: notice = SupervisorNotice.confirmFailed
    case .recovered(let o): notice = SupervisorNotice.recovery(o)
    case .stopped(let r):
      switch r {
      case .user: notice = ""
      case .startFailed:
        let d = r.startDetail
        notice = d.isEmpty ? SupervisorNotice.couldNotStart : "\(SupervisorNotice.couldNotStart): \(d)"
      case .crashedNoAutoRestart: notice = SupervisorNotice.crashedNoRestart
      default: break
      }
    default: break
    }
  }

  /// What the menu says about a thread session. The thread's own line goes out through `postNotice`; this is the Mac's side.
  func handleWorker(_ e: WorkerManager.Event) {
    switch e {
    case .needsYou(let thread, let prompt):
      notice = "\(SupervisorNotice.needsYou): the \(thread) session is waiting on a '\(prompt)' prompt. Open Terminals…"
    case .noticeFailed(let thread):
      notice = "Couldn't tell the \(thread) thread its session is waiting on a prompt. Open Terminals… to answer it."
    default: break
    }
  }

  /// What the menu says for `notice`. The supervisor's own needs-you line describes `status.needsYou` as it is now: it puts the
  /// question back quietly (no event) after a blank screen or when another dialog's warning ends, so the text of the last event
  /// can be about a dialog that is gone. Every other notice, and a thread session's needs-you line, is shown as it was set.
  static func following(_ notice: String, eventNotice: String?, current: Supervisor.NeedsYou?) -> String {
    guard let current, notice == eventNotice else { return notice }
    return "\(SupervisorNotice.needsYou): \(describe(current))"
  }

  static func describe(_ n: Supervisor.NeedsYou) -> String {
    switch n {
    case .dialog(let what): return "\(what) on screen"
    case .confirmColdStart: return "accept the dev-channel warning in the Talos popup"
    case .restartNotConfirmed(let why): return "the restart's dialog wasn't confirmed (\(why.rawValue))"
    case .stuck: return "the session looks stuck"
    case .startStalled: return "Claude has not finished starting; look at the pane"
    }
  }

  var statusLine: String {
    guard configured else { return SupervisorNotice.notSetUp }
    let s = status
    let host = s.host == .tmux ? "tmux" : "owned pty"
    switch s.phase {
    case .idle: return "Session: not started · \(host)"
    case .blocked: return "Blocked: another session holds the channels"
    case .starting: return "Session: starting · \(host)"
    case .running: return "Session: running · \(host)\(s.childPid.map { " · pid \($0)" } ?? "")"
    case .cleaningUp, .waitingToRestart: return "Session: restarting · \(host)"
    case .stopping: return "Session: stopping"
    case .stopped(let r): return r.isFailure ? "Session stopped. \(r.plainSentence)" : "Session: stopped"
    }
  }

  // MARK: actions

  /// Every start (Start, Restart, a new conversation) asks this first. The saved terminal host applies at the next launch; until
  /// then a start would run the agent in the old host and leave it alive under the new one, so it is refused with the reason
  /// (`HostChoice.startBlock`). When it goes ahead, the Import note ("Nothing has started") is no longer true and goes.
  func prepareToStart() -> Bool {
    if let why = HostChoice.startBlock(
      saved: supervisor.currentConfig().host, runningTmux: hostKind == .tmux, tmuxUsable: tmuxUsable)
    {
      notice = why
      return false
    }
    importNote = ""
    return true
  }

  @discardableResult func start() -> Bool {
    guard prepareToStart() else { return false }
    supervisor.startTicking(); supervisor.start()
    return true
  }
  /// What finishing the setup does to start the session. False = it did not start (the reason is in `notice`). Tests replace it
  /// with a spy, so no test ever starts a real claude.
  var beginSession: @MainActor (SupervisorController) -> Bool = { $0.start() }
  /// The Blocked screen's one-shot answer (BlockedText.startAnywayButton). The supervisor refuses it unless it is blocked now
  /// and no holder is Telegram, so a stale click does nothing.
  func startAnyway() {
    guard prepareToStart() else { return }
    supervisor.startTicking(); supervisor.startAnyway()
  }
  func stop() { supervisor.stop() }

  /// "Quit and stop the agent": the same quit as every other, with the stop forced. The quit is held until the stop has finished
  /// (SIGTERM, SIGKILL after the grace, kill-session) or 15 seconds have passed, so the menu never claims a stop that hasn't
  /// happened (D1-REVIEW finding 6). It goes through `QuitCoordinator`, which replies to AppKit when done, so `terminate` is
  /// called once and never re-enters.
  func stopThenQuit() {
    RelaunchGuard.shared.deliberateQuit()  // the owner asked: no rescue relaunch
    QuitCoordinator.shared.quitAndStop()
  }

  /// What the quit coordinator needs from the app. Called once the app is up.
  func installQuitHooks() {
    QuitCoordinator.shared.observePowerOff()
    QuitCoordinator.shared.hooks = QuitCoordinator.Hooks(
      inputs: { [weak self] in
        QuitPlan.Inputs(hostKeepsAgent: self?.hostKind == .tmux, sessionActive: self?.sessionIsUp ?? false)
      },
      stop: { [weak self] in
        guard let self else { return }
        self.supervisor.startTicking()  // the stop's grace and SIGKILL are driven by the tick
        self.supervisor.stop()
        self.workers?.stopAll()  // "stop the agent" means every session: nothing runs on with no supervisor
      },
      isStopped: { [weak self] in
        guard let self else { return true }
        let phase = self.supervisor.status.phase
        if case .stopped = phase { return true }
        return phase == .idle
      },
      reply: { NSApp.reply(toApplicationShouldTerminate: $0) })
  }

  func restart() {
    guard prepareToStart() else { return }
    supervisor.startTicking(); supervisor.restartCold()
  }
  func startNewConversation() {
    guard prepareToStart() else { return }
    supervisor.startTicking(); supervisor.startNewConversation()
  }

  /// Whether the agent's tmux session exists, live or with a dead pane. Short and bounded; the terminal window asks only when
  /// the supervisor has no child.
  func agentSessionExists() -> Bool {
    guard let argv = tmuxHasSession else { return false }
    return ProcessRunner.run(argv, timeout: 2).ok
  }

  func copyTerminalCommand() { copy(supervisor.terminalCommand()) }

  func copyAttachCommand() {
    guard let a = tmuxAttach else { return }
    copy(a.map(LaunchSpec.shellQuote).joined(separator: " "))
  }

  private func copy(_ s: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(s, forType: .string)
  }

  /// "Import a pasted command" (4.1). nil = saved (and `importNote` says so); a string is the reason it was not. `thenStart`:
  /// the setup is made, so start the session too, unless one is already running (it keeps the command it started with).
  func importCommand(_ text: String, thenStart: Bool = false) -> String? {
    importNote = ""
    do {
      let spec = try LaunchSpec.parse(text, home: NSHomeDirectory())
      // Settings changed before setup join the file now; the pasted line's own folder still wins over a held one.
      var c = PreSetup.base(for: supervisor.currentConfig(), configured: configured, store: store)
      if let d = spec.agentDir { c.agentDir = d }
      c.claudePath = spec.program == "claude" ? "auto" : spec.program
      c.args = spec.args
      c.env = BridgeEnv.merged(spec.env)  // the bridge variables stay even when the pasted line has none (audit D45)
      if let id = spec.resumeId, id != c.session.id { c.session = DesktopConfig.Session(id: id, previousIds: c.session.previousIds) }
      guard commitSetup(c) else { return SetupText.importNotSaved(path: Self.configPath) }
      if sessionIsUp {
        importNote = SetupText.importSavedRunning
      } else {
        importNote = thenStart && beginSession(self) ? SetupText.importSaved : SetupText.importSavedNotStarted
      }
      return nil
    } catch let e as LaunchSpec.ParseError {
      return e.description
    } catch {
      return "\(error)"
    }
  }

  /// The setup is made: `desktop.json` is written (importing a command, Adopt and Create are the setup, so they may create it),
  /// the held pre-setup values are dropped and the supervisor and the workers go on. False when the file did not appear.
  private func commitSetup(_ c: DesktopConfig) -> Bool {
    supervisor.updateConfig(c, createFile: true)
    supervisor.drain()
    guard FileManager.default.fileExists(atPath: Self.configPath) else { return false }
    PreSetup.finish(store: store, fileExists: true)
    configured = true
    configRevision += 1
    workers?.startTicking()  // setup finished: own-session threads must not wait for a relaunch (D10)
    return true
  }

  /// Create, Adopt and Choose end here: name the folder. Before setup this makes `desktop.json` with the Talos launch flags; after
  /// it only the folder changes (the launch command is the owner's, and a running session keeps its folder until it restarts).
  /// nil = saved; a string is the reason it was not.
  func useAgentFolder(_ dir: String, launchArgs: [String]) -> String? {
    let home = NSHomeDirectory()
    let shown = dir.hasPrefix(home + "/") ? "~" + dir.dropFirst(home.count) : dir
    guard configured else {
      var c = PreSetup.base(for: supervisor.currentConfig(), configured: false, store: store)
      c.agentDir = shown
      c.args = launchArgs
      c.env = BridgeEnv.merged(c.env)
      return commitSetup(c) ? nil : SetupText.importNotSaved(path: Self.configPath)
    }
    supervisor.mutateConfig { $0.agentDir = shown }
    supervisor.drain()
    configRevision += 1
    return nil
  }

  /// Saves one Mac setting. The edit runs on the supervisor's own queue, so a change the supervisor made meanwhile (the
  /// conversation id) is kept. Before setup the file must not appear, so the values are held for Import or Adopt instead.
  func saveSetting(_ edit: @escaping @Sendable (inout DesktopConfig) -> Void) {
    supervisor.mutateConfig(edit)
    supervisor.drain()
    if !configured { PreSetup.record(supervisor.currentConfig(), in: store) }
  }

  /// The launch command box (Mac settings → Session). Program and arguments only; see `LaunchEdit`.
  func editLaunchLine(_ text: String) -> LaunchEdit.Outcome {
    guard configured else { return .refused(SetupText.launchNeedsSetup) }
    let o = LaunchEdit.evaluate(text, against: supervisor.currentConfig(), home: NSHomeDirectory())
    if case .updated(let path, let args) = o {
      supervisor.mutateConfig { c in
        c.claudePath = path
        c.args = args
      }
      supervisor.drain()
      configRevision += 1
    }
    return o
  }

  /// Adopt (4.7): read the live session that blocks us and pre-fill the config from it. Read-only.
  func findSessionToAdopt() {
    let blockers = supervisor.takeoverBlockers()
    guard let b = blockers.first else {
      adopt = nil
      adoptNote = "No other session holds Telegram or the bridge."
      return
    }
    guard let snap = ProcessInspect.snapshot(b.sessionPid) else {
      adoptNote = "Couldn't read pid \(b.sessionPid)."
      return
    }
    let cfg = supervisor.currentConfig()
    let claude = cfg.claudePath == "auto" ? "claude" : cfg.claudePath
    let env = LoginShellEnv.build(shellEnv: probe.loginShellEnv() ?? [:], overrides: [:])
    let resolved = LoginShellEnv.which(claude, path: env["PATH"], isExecutable: FileManager.default.isExecutableFile)
    let entry = resolved.flatMap { probe.agents(claude: $0, env: env) }.flatMap { AgentsList.interactive($0, pid: b.sessionPid) }
    adopt = AdoptPlan.from(snapshot: snap, agentsEntry: entry, loginEnv: env)
    adoptNote =
      adopt == nil
      ? "Couldn't read that session's command."
      : (adopt!.envReadable
        ? "Type /exit in that terminal, then press Continue."
        : "macOS doesn't show another process's environment. If your Terminal command sets variables (VAR=value claude …), paste the whole command into Import below first. Then type /exit in that terminal and press Continue.")
  }

  func continueAdopt() {
    guard let plan = adopt else { return }
    let base = PreSetup.base(for: supervisor.currentConfig(), configured: configured, store: store)
    guard commitSetup(plan.applied(to: base, home: NSHomeDirectory())) else {
      adoptNote = SetupText.importNotSaved(path: Self.configPath)
      return
    }
    adopt = nil
    start()  // a cold start: re-runs the takeover check; the owner confirms the dialog once in the pane
  }
}

/// Lets main's supervisor ask for the worker groups without owning the manager.
final class WorkerBox: @unchecked Sendable {
  private let lock = NSLock()
  private var _manager: WorkerManager?
  var manager: WorkerManager? {
    get { lock.withLock { _manager } }
    set { lock.withLock { _manager = newValue } }
  }
  var groups: Set<Int32> { manager?.ownedGroups ?? [] }
}
