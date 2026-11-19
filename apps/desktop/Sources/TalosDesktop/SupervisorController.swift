import AppKit
import Foundation
import TalosDesktopCore
import TalosSupervisor

/// Glue between the supervisor and the menu/windows. Thin on purpose (D2): the logic lives in TalosSupervisor.
/// The supervisor runs only when `desktop.json` exists; with no file nothing starts (the owner sets it up first, by
/// importing his command or with Adopt).
@MainActor
final class SupervisorController: ObservableObject {
  nonisolated static let supportDir = NSHomeDirectory() + "/Library/Application Support/Talos"
  static let configPath = supportDir + "/desktop.json"
  static let auditPath = NSHomeDirectory() + "/Library/Logs/Talos/supervisor.log"

  @Published var status: Supervisor.Status
  @Published var configured: Bool
  @Published var notice: String = ""
  /// The text the last supervisor `.needsYou` event put in `notice`. While `notice` still equals it, the menu follows `status.needsYou`.
  private(set) var needsYouEventNotice: String?
  /// What the menu says about thread sessions, apart from Main's `notice`: it is true or stale by what the worker manager says
  /// about the thread, never by Main's phase. Recomputed on a worker event and at the once-a-second refresh.
  @Published private(set) var threadNotice: String = ""
  private var threadNotices = ThreadNotices()
  private var threadNames: [String: String] = [:]
  /// What the worker manager says now: thread to prompt for the waiting ones, and the threads whose record says failed. Lock
  /// reads, never the workers' queue. Tests replace it.
  var threadFacts: @MainActor (SupervisorController) -> (waiting: [String: String], failed: Set<String>) = { m in
    guard let w = m.workers else { return ([:], []) }
    return (w.needsYou(), Set(w.snapshot().threads.filter { $0.value.state == "failed" }.keys))
  }
  /// Thread id to name, from the agent's config.json. Read when a worker event arrives. Tests replace it.
  var readThreadNames: @MainActor (SupervisorController) -> [String: String] = { m in
    SessionSwitcher.names(fromConfig: FileManager.default.contents(atPath: m.workersHome + "/config.json"))
  }
  /// A thread session failed: the banner (StatusCoordinator sets this; the menu line is `threadNotice`).
  var onThreadFailed: (@MainActor (_ thread: String, _ name: String, _ code: String) -> Void)?
  @Published var adopt: AdoptPlan?
  @Published var adoptNote: String = ""
  /// "Find a running session" is reading the other session (the login shell and `claude`, up to about 20 s), off the main thread.
  @Published private(set) var adoptLooking = false
  /// The three reads behind "Find a running session". They block, so they never run on the main thread. Tests replace them.
  var adoptLookup: @Sendable (Supervisor, SystemProbe, DesktopConfig) -> AdoptLookup = SupervisorController.lookForSession
  /// Bumps when Create, Adopt, Choose, Import or Adopt-a-session rewrites the config, so an open Settings window reloads its text boxes.
  @Published var configRevision = 0

  /// The running app's controller, for the main window's Terminal screen: it must not depend on the Terminals window having
  /// been opened (nothing attached the model to it on a normal launch, and the page showed no tabs).
  static weak var current: SupervisorController?

  let supervisor: Supervisor
  /// Option C (docs/OPTION-C.md): thread sessions. Runs only with the tmux host; starts nothing until the owner
  /// switches a thread to "Own session" and main's bridge writes a wake file for it.
  /// Replaced only when the Talos home changes with no thread session running (`followTalosHome`).
  private(set) var workers: WorkerManager?
  /// The Talos home `workers` was built for.
  private(set) var workersHome: String
  private var movingHome = false
  /// The app's own environment as it was at launch: the home is judged against it, not against a later `setenv`.
  let launchEnv: [String: String]
  /// Whether a thread session may be running from the manager's home (a lock read). Tests replace it.
  var workersMayRun: @MainActor (WorkerManager) -> Bool = { $0.snapshot().anyMayBeRunning }
  let workerBox = WorkerBox()
  /// The app's own updater (AutoUpdateWiring.swift); nil until set up, and never for a desktop.json that cannot be read.
  var autoUpdater: AutoUpdater?
  /// Settings edits handed to the supervisor that it has not applied yet, and the config with them laid on: what a reader on the
  /// main thread sees meanwhile (`configNow`), so no caller waits on the supervisor's queue to read its own change back.
  private var pendingEdits = 0
  private var pendingConfig: DesktopConfig?
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
  /// `unreadable`: the file is there and cannot be read. The defaults stand in only so the app can come up and say so; nothing is
  /// started from them and nothing is saved over the file (the supervisor refuses both).
  static func startupConfig(store: SettingsStore) -> (config: DesktopConfig, hasFile: Bool, unreadable: Bool) {
    switch ConfigFile.read(configPath) {
    case .loaded(let c): return (c, true, false)
    case .unreadable: return (.defaults, true, true)
    case .missing: return (PreSetup.startupConfig(file: nil, store: store), false, false)
    }
  }

  init(store: SettingsStore = DefaultsStore()) {
    self.store = store
    let start = Self.startupConfig(store: store)
    let cfg = start.config
    configured = start.hasFile
    // A file that exists is the truth. Values held from before it was made are stale, and a later Import or Adopt must not lay
    // them over the live settings.
    // (Not for a file that cannot be read: nothing of the owner's is dropped while his setup is in doubt.)
    if start.hasFile, !start.unreadable { PreSetup.finish(store: store, fileExists: true) }
    let env = ProcessInfo.processInfo.environment
    launchEnv = env
    let host: PtyHost
    var attach: [String]?
    var has: [String]?
    let foundTmux = Self.findTmux(env: env)
    let tmuxConf = Bundle.main.path(forResource: "tmux", ofType: "conf")
    tmuxUsable = foundTmux != nil && tmuxConf != nil  // what the host choice below can actually use
    if cfg.host != .direct, let tmux = foundTmux, let conf = tmuxConf {
      let cmds = TmuxCommands(tmux: tmux, socket: TmuxCommands.defaultSocket, configPath: conf)
      host = TmuxPtyHost(commands: cmds, launchDir: LaunchFile.dir(talosHome: Self.talosHome(cfg: cfg, env: env)), baseEnv: env)
      attach = cmds.attach()
      has = cmds.hasSession()
    } else {
      host = SwiftTermPtyHost()
    }
    hostKind = host.kind
    tmuxAttach = attach
    tmuxHasSession = has
    let box = workerBox
    workersHome = Self.talosHome(cfg: cfg, env: env)
    var opts = Supervisor.Options(
      name: TmuxCommands.mainSession, configPath: Self.configPath, home: NSHomeDirectory(), auditLogPath: Self.auditPath)
    // our own worker panes never block main's takeover check (OPTION-C 4.4)
    opts.siblingGroups = { box.groups }
    opts.launchTrust = Self.launchTrust
    opts.checksBridge = true  // Main's Talos bridge must show a live status after the warning is answered, or the owner is told
    opts.configKnownUnreadable = start.unreadable
    let sup = Supervisor(options: opts, host: host, probe: probe)
    supervisor = sup
    workers = Self.makeWorkers(cfg: cfg, env: env, probe: probe, mainPid: { sup.status.childPid ?? 0 }, current: { sup.currentConfig() },
      mainNarrowed: { sup.status.mainNarrowed })
    status = supervisor.status
    // Before setup the file doesn't exist and the supervisor would start from the defaults: hand it the held values.
    if !start.hasFile {
      sup.updateConfig(cfg)
      sup.drain()  // ticking has not started, so this is instant; `currentConfig()` below must see the held values
    }
    supervisor.onEvent = { [weak self] e in Task { @MainActor in self?.handle(e) } }
    wire(workers)
    // the Mac popup: the workers' dialogs, and Main's own development-channels warning (no bridge runs while Main waits on it).
    // The box, not the manager: the popup follows a manager that was replaced for a new Talos home.
    needsYouPopups = NeedsYouPopupController(
      source: MainAndWorkersPopupSource(workers: box, main: sup),
      quiet: { MainActor.assumeIsolated { NeedsYouPopupController.statusQuiet() } })
    refresh = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refreshNow() }
    }
    if supervisor.status.configUnreadable {
      // Nothing starts: not Main, not a thread session (the workers were built from the defaults too). The menu says why.
      notice = SupervisorNotice.configUnreadable
    } else if configured {
      supervisor.startTicking()
      // A rescue relaunch (Quit & Reopen) joins a live session but never starts a new one by itself.
      supervisor.attachOrStart(allowColdStart: cfg.startSessionOnLaunch && !RelaunchWatchdog.isRelaunch(CommandLine.arguments))
      workers?.startTicking()
      startAutoUpdater()
    }
    // A tap on a banner opens the pane before any menu button has attached a model to it.
    Self.current = self
    TerminalWindowController.shared.attach(model: self)
  }

  /// The once-a-second look: the supervisor's status, whether a thread session runs, the thread sessions' menu line, and whether
  /// desktop.json now names another Talos home. Lock reads only; nothing here waits on a queue.
  func refreshNow() {
    status = supervisor.status
    if let w = workers {
      WorkersRunningPoll.poll(w) { running in if self.workersRunning != running { self.workersRunning = running } }
    }
    refreshThreadNotice()
    followTalosHome()
    ScreenHelperHost.shared.follow(home: Self.talosHome(cfg: supervisor.currentConfig(), env: launchEnv))
  }

  /// Everything the controller hangs on a worker manager, for the one built at launch and for one built for a new Talos home.
  private func wire(_ m: WorkerManager?) {
    workerBox.manager = m
    guard let m else { return }
    let sup = supervisor
    // Main's development-channels warning, when refused, goes to the owner as a card the bridge posts (SupervisorDevCard.swift)
    m.setMainDialog { [weak sup] in sup?.status.devDialog }
    // a worker stuck on a prompt gets one line in its own thread, through the same signed `talos-app post` main's notices use
    m.postNotice = { [weak sup] thread, text in sup?.postToThread(thread, text: text) ?? .failed }
    m.onEvent = { [weak self] e in Task { @MainActor in self?.handleWorker(e) } }
    // asked from the worker queue: nothing here waits for the main thread. False when there is no controller to ask.
    m.openTerminals = { [weak self] thread in
      guard self != nil else { return false }
      Task { @MainActor in self?.showThreadTerminal(thread) }
      return true
    }
  }

  /// desktop.json can name another Talos home after the app opened (an imported `TALOS_APP_HOME=… claude …`). Main and its bridge
  /// use it from their next start; a worker manager still watching the old home would leave every own-session thread to Main
  /// with nothing said. With no thread session running the manager is rebuilt for the new home; with one running nothing moves
  /// (it would be orphaned) and the menu says a restart is needed.
  func followTalosHome() {
    guard let old = workers, !movingHome, !supervisor.status.configUnreadable else { return }
    let cfg = supervisor.currentConfig()
    let env = launchEnv
    let wanted = Self.talosHome(cfg: cfg, env: env)
    switch TalosHomeChange.plan(built: workersHome, wanted: wanted, workersMayRun: workersMayRun(old)) {
    case .same:
      if notice.hasPrefix(TalosHomeChange.restartPrefix) { notice = "" }
    case .restartNeeded:
      // never over another line (Main's own "needs you" must not be replaced once a second): it waits for the menu to be free
      let text = TalosHomeChange.restartNotice(to: wanted)
      if notice.isEmpty || (notice.hasPrefix(TalosHomeChange.restartPrefix) && notice != text) { notice = text }
    case .move:
      movingHome = true
      let sup = supervisor
      let o = old.options
      // `detach` waits for the tick in flight (its tmux calls), so it runs off the main thread
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        old.detach()
        // that last tick may have started a session after the look above: then nothing moves
        let started = old.snapshot().anyMayBeRunning
        Task { @MainActor in
          guard let self else { return }
          self.movingHome = false
          guard !started else {
            if self.configured { old.startTicking() }  // it keeps its sessions; the next look says a restart is needed
            return
          }
          let made = Self.makeWorkers(
            cfg: cfg, env: env, probe: self.probe, mainPid: { sup.status.childPid ?? 0 }, current: { sup.currentConfig() },
            tmux: o.tmux, conf: o.tmuxConf, mainNarrowed: { sup.status.mainNarrowed })
          self.wire(made)
          self.workers = made
          self.workersHome = wanted
          if self.notice.hasPrefix(TalosHomeChange.restartPrefix) { self.notice = "" }
          if self.configured { made?.startTicking() }
        }
      }
    }
  }

  /// The key store that seals `confirmed_launch`: in memory until the app's own start swaps in the Keychain one (`TalosApp.init`), so a test that
  /// makes a controller never reads or writes the owner's Keychain.
  nonisolated(unsafe) static var launchTrust: LaunchTrust = MemoryLaunchTrust()

  nonisolated static func talosHome(cfg: DesktopConfig, env: [String: String]) -> String {
    TalosHomeChange.home(configEnv: cfg.env, processEnv: env, userHome: NSHomeDirectory())
  }

  /// The worker manager for Option C, or nil without tmux (workers live only in `tmux -L talos`, OPTION-C decision 1).
  /// Nothing here reads the login shell: this runs in `init`, on the main thread. A thread session's environment is built at each
  /// start by `WorkerLaunchEnv` (the login shell read in the background, `desktop.json` `env` as it is now on top), as Main's is.
  /// `tmux` and `conf` are for tests; the app finds its own.
  static func makeWorkers(
    cfg: DesktopConfig, env: [String: String], probe: SystemProbe, mainPid: @escaping @Sendable () -> Int32,
    current: (@Sendable () -> DesktopConfig)? = nil, tmux: String? = nil, conf: String? = nil, auditPath: String? = nil,
    mainNarrowed: (@Sendable () -> String?)? = nil
  ) -> WorkerManager? {
    guard cfg.host != .direct, let tmux = tmux ?? findTmux(env: env),
      let conf = conf ?? Bundle.main.path(forResource: "tmux", ofType: "conf")
    else { return nil }
    let talosHome = Self.talosHome(cfg: cfg, env: env)
    let now = current ?? { cfg }
    let auditPath = auditPath ?? Self.auditPath
    let launchEnv = WorkerLaunchEnv(probe: probe, appEnv: env, overrides: { now().env }, auditLogPath: auditPath)
    launchEnv.refresh()  // in the background, so the first start usually finds it done
    let o = workerOptions(cfg: cfg, talosHome: talosHome, tmux: tmux, conf: conf, auditPath: auditPath)
    let m = WorkerManager(options: o, probe: probe, baseEnv: { launchEnv.env() }, mainPanePid: mainPid)
    m.launchSource = { Self.launchSource(now(), loginEnv: launchEnv.env()) }
    m.hasLoginEnv = { launchEnv.hasLoginEnv }
    // restart on update: desktop.json `env` as it is now is part of a thread session's launch spec (`launch-env`)
    m.updateRestart.launchEnv = { now().env }
    m.mainRunsNarrowed = mainNarrowed
    return m
  }

  /// The worker manager's options from desktop.json: the app's, and the read-only update report's (`UpdateCheckCLI`), so both work
  /// out a session's launch the same way.
  nonisolated static func workerOptions(cfg: DesktopConfig, talosHome: String, tmux: String, conf: String, auditPath: String?)
    -> WorkerManager.Options
  {
    // "auto" is looked up again at every tick (`launchSource`), once the login shell's PATH is known; a bare name runs off PATH
    var o = WorkerManager.Options(
      talosHome: talosHome, agentDir: cfg.agentDir, claudePath: cfg.claudePath == "auto" ? "claude" : cfg.claudePath,
      permissionFlag: MainArgs.bypassFlag(cfg.args),
      tmux: tmux, tmuxConf: conf)
    o.mainArgs = cfg.args
    o.managedDir = MainManagedSettings.systemDir
    o.auditLogPath = auditPath
    // the app bundle's own sealed copy: never the checkout (a thread working there could edit the script that answers its own
    // prompts), and never a path guessed inside the agent folder (an older one keeps its hooks elsewhere)
    o.permissionHook = WorkerHook.appSource
    return o
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
      permissionFlag: MainArgs.bypassFlag(cfg.args),
      mainArgs: cfg.args)
  }

  /// How many times tmux was looked for (it runs `tmux -V`). A test asserts a window being open adds none.
  nonisolated(unsafe) static var findTmuxCalls = 0
  private static let findTmuxLock = NSLock()

  static func findTmux(env: [String: String]) -> String? {
    findTmuxLock.withLock { findTmuxCalls += 1 }
    // the process PATH, then Homebrew and ~/.local (a Finder or login-item launch has none of them on its PATH)
    guard
      let t = TalosAppLocator.findTmux(
        envPath: env["PATH"], home: NSHomeDirectory(), isExecutable: FileManager.default.isExecutableFile)
    else {
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
    case .configUnreadable: notice = SupervisorNotice.configUnreadable
    case .recovered(let o): notice = SupervisorNotice.recovery(o)
    case .stopped(let r):
      switch r {
      case .user: notice = ""
      case .startFailed:
        let d = r.startDetail
        notice = d.isEmpty ? SupervisorNotice.couldNotStart : "\(SupervisorNotice.couldNotStart): \(d)"
      case .crashedNoAutoRestart: notice = SupervisorNotice.crashedNoRestart
      case .cleanExitLoop: notice = SupervisorNotice.cleanExitLoop
      default: break
      }
    default: break
    }
  }

  /// What the menu says about a thread session. The thread's own line goes out through `postNotice`; this is the Mac's side.
  /// A thread session's own lines go to `threadNotice`, never to `notice`: Main's staleness rules would hide a waiting line while
  /// Main is fine and keep it after the prompt was answered.
  func handleWorker(_ e: WorkerManager.Event) {
    switch e {
    case .needsYou(let thread, _):
      threadNotices.set(.waiting, thread: thread)
      threadNames = readThreadNames(self)
      refreshThreadNotice()
      onThreadNeedsYou?()
    case .noticeFailed(let thread):
      threadNotices.set(.untold, thread: thread)
      threadNames = readThreadNames(self)
      refreshThreadNotice()
    case .failed(let thread, let code):
      threadNotices.set(.failed(code: code), thread: thread)
      threadNames = readThreadNames(self)
      refreshThreadNotice()
      onThreadFailed?(thread, ThreadNotices.name(thread, names: threadNames), code)
    case .started(let thread, _):
      threadNotices.clear(thread: thread)
      refreshThreadNotice()
    case .recordsUnreadable(let threads, let others): notice = WorkersFileRead.entriesNotice(threads: threads, others: others)
    case .fileUnreadable: notice = WorkersFileRead.fileNoticeText
    default: break
    }
  }

  /// A thread session waits on a prompt: the "needs you" banner (StatusCoordinator sets this).
  var onThreadNeedsYou: (@MainActor () -> Void)?

  private func refreshThreadNotice() {
    let facts = threadFacts(self)
    setIfChanged(\.threadNotice, to: threadNotices.line(waiting: facts.waiting, failed: facts.failed, names: threadNames))
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
    case .dialog(let what): return SupervisorNotice.mainDialog(what)
    case .confirmColdStart: return "accept the dev-channel warning in the Talos popup"
    case .restartNotConfirmed(let why): return "the restart's dialog wasn't confirmed (\(why.rawValue))"
    case .stuck: return "the session looks stuck"
    case .startStalled: return "Claude has not finished starting; look at the pane"
    case .bridgeNotLive(let why): return SupervisorNotice.bridgeNotLive(why)
    case .relayUnreachable(let code): return SupervisorNotice.relayUnreachable(closeCode: code)
    case .notReading: return SupervisorNotice.mainNotReading
    case .stalled(let at, let did): return SupervisorNotice.mainStalled(since: at, did: did)
    }
  }

  var statusLine: String {
    guard configured else { return SupervisorNotice.notSetUp }
    let s = status
    if s.configUnreadable { return SupervisorNotice.configUnreadableStatus }
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
      saved: configNow.host, runningTmux: hostKind == .tmux, tmuxUsable: tmuxUsable)
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
        // "stop the agent" means every session: nothing runs on with no supervisor. Asked, not waited for: the stop runs on
        // the workers' queue behind a tick that can take many seconds, and the quit's time limit is a timer on this thread.
        self.workers?.beginStopAll()
      },
      isStopped: { [weak self] in
        guard let self else { return true }
        guard self.workers?.isAllStopped ?? true else { return false }  // the thread sessions are still being stopped
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

  /// The rollback command (4.7), from the config as it is now. Built here from a lock read: `Supervisor.terminalCommand()` waits on
  /// the supervisor's queue, which a tick can hold for seconds.
  var terminalCommand: String {
    LaunchSpec.rollback(configNow, home: NSHomeDirectory()).render()
  }

  /// A saved id that is not a session id would be left out of the command, which would start a fresh conversation: refused instead,
  /// with the same reason the app's own start gives.
  func copyTerminalCommand() {
    if let id = configNow.session.id, !ResumeRewrite.isUUID(id) { return notice = SupervisorNotice.sessionIdInvalid }
    copy(terminalCommand)
  }

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
      var c = PreSetup.base(for: settledConfig(), configured: configured, store: store)
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
  /// This is the one place the main thread still waits for the supervisor's queue: its callers answer "was the file written" at
  /// once (Import, Adopt, Create), and they are the setup, not a settings change.
  /// What the setup builds on: the supervisor's config once its queue has run. The setup replaces the whole config, so it must
  /// start from what a tick in flight has just published (a new conversation id), not from a copy read before that tick ended.
  /// It waits, as `commitSetup` does right after.
  private func settledConfig() -> DesktopConfig {
    supervisor.drain()
    pendingConfig = nil  // every edit sent so far has been applied
    return supervisor.currentConfig()
  }

  private func commitSetup(_ c: DesktopConfig) -> Bool {
    // The file is there (so the check below would pass) but nothing was written: the supervisor refuses while it cannot be read.
    guard !refusedForUnreadableConfig() else { return false }
    supervisor.updateConfig(c, createFile: true)
    supervisor.drain()
    pendingConfig = nil  // every edit queued before this has been applied, and `c` replaced the config
    guard FileManager.default.fileExists(atPath: Self.configPath) else { return false }
    PreSetup.finish(store: store, fileExists: true)
    configured = true
    configRevision += 1
    // setup finished: own-session threads must not wait for a relaunch (D10). Not while the manager is being replaced for a new
    // Talos home: this one is being let go, and the one that replaces it is started when the move ends.
    if !movingHome { workers?.startTicking() }
    return true
  }

  /// Create, Adopt and Choose end here: name the folder. Before setup this makes `desktop.json` with the Talos launch flags; after
  /// it only the folder changes (the launch command is the owner's, and a running session keeps its folder until it restarts).
  /// nil = saved; a string is the reason it was not.
  func useAgentFolder(_ dir: String, launchArgs: [String]) -> String? {
    let home = NSHomeDirectory()
    let shown = dir.hasPrefix(home + "/") ? "~" + dir.dropFirst(home.count) : dir
    guard configured else {
      var c = PreSetup.base(for: settledConfig(), configured: false, store: store)
      c.agentDir = shown
      c.args = launchArgs
      c.env = BridgeEnv.merged(c.env)
      return commitSetup(c) ? nil : SetupText.importNotSaved(path: Self.configPath)
    }
    guard !refusedForUnreadableConfig() else { return SupervisorNotice.configUnreadable }
    edit({ $0.agentDir = shown }, bumpRevision: true)
    return nil
  }

  /// The config as the main thread should read it: `currentConfig()` with the edits this controller has sent and the supervisor
  /// has not applied yet. Once they are all applied it is `currentConfig()` again.
  var configNow: DesktopConfig { pendingConfig ?? supervisor.currentConfig() }

  /// One settings edit, without waiting on the supervisor's queue (a tick holds it through its tmux calls and the login-shell
  /// read). The edit still runs there, on the config as it is at that moment; `configNow` shows it at once. `bumpRevision`: tell
  /// the open windows to reload, once `currentConfig()` has it.
  private func edit(_ change: @escaping @Sendable (inout DesktopConfig) -> Void, bumpRevision: Bool = false) {
    var c = configNow
    change(&c)
    pendingConfig = c
    pendingEdits += 1
    supervisor.mutateConfig(change) { [weak self] in
      Task { @MainActor in
        guard let self else { return }
        self.pendingEdits -= 1
        if self.pendingEdits == 0 { self.pendingConfig = nil }
        // a refused edit (the settings file cannot be read) is not in the config: the windows reload and show what is
        if bumpRevision || self.supervisor.status.configUnreadable { self.configRevision += 1 }
      }
    }
  }

  /// With `desktop.json` unreadable no setting is saved (the supervisor refuses, whoever asks); this puts the reason in the menu at
  /// once, for the callers that report their own result. True when that is the case.
  private func refusedForUnreadableConfig() -> Bool {
    guard supervisor.status.configUnreadable else { return false }
    notice = SupervisorNotice.configUnreadable
    return true
  }

  /// Saves one Mac setting. The edit runs on the supervisor's own queue, so a change the supervisor made meanwhile (the
  /// conversation id) is kept. Before setup the file must not appear, so the values are held for Import or Adopt instead.
  /// It does not wait for the supervisor: read the result with `configNow`, not `supervisor.currentConfig()`.
  func saveSetting(_ edit: @escaping @Sendable (inout DesktopConfig) -> Void) {
    guard !refusedForUnreadableConfig() else { return }
    self.edit(edit)
    if !configured { PreSetup.record(configNow, in: store) }
  }

  /// The compose hotkey, after setup (before it the hotkey lives in the app's own defaults: `HotkeyView`).
  func saveComposeHotkey(_ saved: String) { saveSetting { $0.hotkeys.compose = saved } }

  /// The launch command box (Mac settings → Session). Program and arguments only; see `LaunchEdit`.
  func editLaunchLine(_ text: String) -> LaunchEdit.Outcome {
    guard configured else { return .refused(SetupText.launchNeedsSetup) }
    guard !refusedForUnreadableConfig() else { return .refused(SupervisorNotice.configUnreadable) }
    let o = LaunchEdit.evaluate(text, against: configNow, home: NSHomeDirectory())
    if case .updated(let path, let args) = o {
      edit(
        { c in
          c.claudePath = path
          c.args = args
        }, bumpRevision: true)
    }
    return o
  }

  /// Adopt (4.7): read the live session that blocks us and pre-fill the config from it. Read-only. The reads run the owner's login
  /// shell (5 s limit) and `claude` (15 s limit) and wait on the supervisor's queue, so they run off the main thread; the window
  /// says "Looking…" meanwhile and a second click while one search runs does nothing.
  func findSessionToAdopt() {
    guard !adoptLooking else {
      adoptNote = AdoptLookup.looking  // one search at a time; the window still says so
      return
    }
    adoptLooking = true
    adopt = nil
    adoptNote = AdoptLookup.looking
    let lookup = adoptLookup
    let sup = supervisor
    let probe: SystemProbe = self.probe
    let cfg = configNow
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let found = lookup(sup, probe, cfg)
      Task { @MainActor in
        guard let self else { return }
        self.adoptLooking = false
        self.adopt = found.plan
        self.adoptNote = found.note
      }
    }
  }

  /// The blocking half of "Find a running session". Never on the main thread.
  nonisolated static func lookForSession(supervisor: Supervisor, probe: SystemProbe, cfg: DesktopConfig) -> AdoptLookup {
    guard let b = supervisor.takeoverBlockers().first else {
      return AdoptLookup(plan: nil, note: "No other session holds Telegram or the bridge.")
    }
    guard let snap = ProcessInspect.snapshot(b.sessionPid) else {
      return AdoptLookup(plan: nil, note: "Couldn't read pid \(b.sessionPid).")
    }
    let claude = cfg.claudePath == "auto" ? "claude" : cfg.claudePath
    let env = LoginShellEnv.build(shellEnv: probe.loginShellEnv() ?? [:], overrides: [:])
    let resolved = LoginShellEnv.which(claude, path: env["PATH"], isExecutable: FileManager.default.isExecutableFile)
    let entry = resolved.flatMap { probe.agents(claude: $0, env: env) }.flatMap { AgentsList.interactive($0, pid: b.sessionPid) }
    guard let plan = AdoptPlan.from(snapshot: snap, agentsEntry: entry, loginEnv: env) else {
      return AdoptLookup(plan: nil, note: "Couldn't read that session's command.")
    }
    return AdoptLookup(
      plan: plan,
      note: plan.envReadable
        ? "Type /exit in that terminal, then press Continue."
        : "macOS doesn't show another process's environment. If your Terminal command sets variables (VAR=value claude …), paste the whole command into Import below first. Then type /exit in that terminal and press Continue."
    )
  }

  func continueAdopt() {
    guard let plan = adopt else { return }
    let base = PreSetup.base(for: settledConfig(), configured: configured, store: store)
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

/// The Needs-you popup asks the box, so it follows a manager that was replaced; with none, there is nothing to offer.
extension WorkerBox: NeedsYouPopupSource {
  func popupOffers() -> [NeedsYouPopupItem] { manager?.popupOffers() ?? [] }
  func popupAnswer(
    thread: String, dialogId: String, action: NeedsYouPopupAction, completion: @escaping @Sendable (PopupAnswerResult) -> Void
  ) {
    guard let m = manager else { return completion(.nothing(.notOffered)) }
    m.popupAnswer(thread: thread, dialogId: dialogId, action: action, completion: completion)
  }
}

/// What "Find a running session" found: the plan to show, or nil with the reason in `note`.
struct AdoptLookup: Sendable, Equatable {
  static let looking = "Looking for a running session…"
  var plan: AdoptPlan?
  var note: String
}
