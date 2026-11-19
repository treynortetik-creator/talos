import Foundation
import TalosDesktopCore

/// Monotonic seconds. Never the wall clock, so a clock change can't fake ten healthy minutes or empty a window.
public protocol MonotonicClock: Sendable {
  func now() -> Double
}

public struct SystemMonotonicClock: MonotonicClock {
  public init() {}
  public func now() -> Double { Double(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000_000 }
}

/// Starts, watches, restarts and resumes one Claude Code session (DESKTOP-SPEC 4.1-4.8). One instance per session: the
/// main agent is `name: "agent"`; Option C can run one per thread with its own host, config file and `name`.
///
/// Everything runs on one serial queue. A 1 s tick reads the screen and drives the state machine; nothing on the queue
/// sleeps (clean-up and stop waits are deadlines checked by the tick). The supervisor only ever signals the process
/// group of a child it started (`GroupSignaller`), and it never answers any dialog except the dev-channel
/// confirm under every `AutoConfirmGuard` condition.
public final class Supervisor: @unchecked Sendable {
  // MARK: state (queue-confined)

  public let options: Options
  let host: PtyHost
  let probe: SystemProbe
  let clock: MonotonicClock
  let timings: Timings
  let signaller: GroupSignaller
  let random: @Sendable () -> Double
  let q: DispatchQueue
  /// The agents poll's own serial queue, not `DispatchQueue.global`: that hop waits for a pool thread, and the process's own pool gives
  /// none while every cooperative thread in it is blocked (the note in SwiftTermPtyHost.swift), so no poll ran although `q` did.
  let pollQ: DispatchQueue
  var timer: DispatchSourceTimer?  // set and cleared on `q` only
  /// The shapes of unknown status parts already in the audit this run (SupervisorKeyGuard.swift).
  var unknownShapesSeen = Set<String>()
  /// The shapes of refused status parts already in the audit this run (SupervisorKeyGuard.swift).
  var refusedShapesSeen = Set<String>()
  /// Held while the tick runs and Main is live (SupervisorNapGuard.swift); tests swap it before `startTicking`.
  public var napGuard: NapGuard = ProcessActivityNapGuard(reason: "Talos supervises the agent session")

  var config: DesktopConfig { didSet { statusLock.withLock { _config = config } } }
  var phase: Phase = .idle { didSet { syncNapGuard() } }
  /// The phone was told this run that Main started with Claude Code's own computer use on (`GuardsSettings.notDenied`).
  var computerUseNotDeniedTold = false
  /// The guards' refresh at each start of Main and the check of Main's guard hook (SupervisorGuardsRefresh.swift).
  var guardsRefresh = GuardsRefreshState()
  /// The release commit Main was last restarted onto by the app updater (SupervisorAutoUpdate.swift): once per commit.
  var updateRestartedFor: String?
  var launch: Launch?  // written by the tick, and by the Mac popup's click (SupervisorDevPopup.swift), both on `q`
  /// The just-exited child's group and leader start time. Cleared once a stop completes.
  private var previousChild: (pgid: Int32, start: Double)?
  var loop: CrashLoop
  /// The auto-answers of cold starts (`Timings.coldConfirmCap`), apart from `loop`'s crash-loop count.
  var coldLoop: CrashLoop
  /// When Main ended by itself with exit code 0, within the last hour (the contract's `MAIN_RESTART.clean_exits_per_hour`). Such an
  /// exit is not a crash: it never spends the crash loop's cap and never ends in `.crashLoop` (which brings the automatic restore).
  private var cleanExits: [Double] = []
  /// The restart now waiting follows an exit with code 0: it is not recorded in the crash loop, and its launch is marked.
  private var restartAfterCleanExit = false
  /// The next launch resumes this id: `--session-id` of it was refused as already in use (`sessionTrouble`). Spent by that launch.
  private var forceResume: String?
  /// Session errors already mended once (`inuse:<id>`, `empty:<id>`): never twice, so they cannot loop.
  private var mended: Set<String> = []
  /// Set around the launch of such a restart, for `Launch.afterCleanExit`.
  private var launchingAfterCleanExit = false
  /// Tries in a row of a restart that could not launch at all (`retriesRestart`); a launch that gets its child ends the row.
  private var cannotLaunchTries = 0
  /// The restart now waiting is another try of one that could not launch: it is not recorded in the crash loop again.
  private var restartIsRetry = false
  /// Set around the launch `doRestart` makes: a launch that cannot even begin then (the channels are held, no claude, no folder) is
  /// a failed attempt that is tried again, not the end.
  private var restartingAfterCrash = false
  /// `desktop.json` was there and could not be read when this supervisor was made. Fixed for its lifetime: the app chose its host and
  /// its workers from the defaults too, so nothing is started and nothing is saved until the owner has fixed the file and reopened Talos.
  let configUnreadable: Bool
  private var attempt = -1
  private var cleanup: Cleanup?
  private var restartAt: Double?
  private var stopDeadline: Double?
  private var stopThen: StopReason = .user
  private var stopCloseHost = true
  private var afterStop: (() -> Void)?
  /// Read by the recovery tick, in the same pass that may have just raised it; `status` is the copy of the pass before.
  var needsYou: NeedsYou?
  var agentActivity: String?
  private var lastExit: ExitInfo?
  private var nextRestartIsCold = false
  /// Set by `startAnyway()` for the one cold launch that follows it; spent by that launch (or cleared right after it).
  private var skipTakeoverOnce = false
  /// Restart and restore requests, and the automatic restore (SupervisorRecovery.swift).
  var recovery = RecoveryState()
  var lastAgentsPollAt: Double = -.infinity
  var agentsPollInFlight = false
  private var cachedLaunchEnv: [String: String]?
  var resolvedClaude: String?

  private let statusLock = NSLock()
  private var _status: Status
  private var _config: DesktopConfig  // `config` as of its last change, for `currentConfig()`
  private let eventLock = NSLock()
  private var _onEvent: (@Sendable (Event) -> Void)?

  public var onEvent: (@Sendable (Event) -> Void)? {
    get { eventLock.withLock { _onEvent } }
    set { eventLock.withLock { _onEvent = newValue } }
  }

  public var status: Status { statusLock.withLock { _status } }

  public init(
    options: Options, host: PtyHost, probe: SystemProbe, clock: MonotonicClock = SystemMonotonicClock(),
    timings: Timings = Timings(), signaller: GroupSignaller? = nil,
    random: @escaping @Sendable () -> Double = { Double.random(in: -1...1) }
  ) {
    self.options = options
    self.host = host
    self.probe = probe
    self.clock = clock
    self.timings = timings
    self.signaller = signaller ?? GroupSignaller(probe: probe)
    self.random = random
    self.q = DispatchQueue(label: "talos.supervisor.\(options.name)")
    self.pollQ = DispatchQueue(label: "talos.supervisor.agents.\(options.name)", qos: .utility)
    // Read only: the migrated config is saved below through `saveConfig`, the app's one writer of desktop.json.
    let (found, migrated) = LaunchTrustMigration.read(options.configPath)
    // No config from the load is two things: no file (not set up: the defaults) or a file that cannot be read (never the defaults).
    self.configUnreadable = options.configKnownUnreadable || (found == nil && ConfigFile.read(options.configPath) == .unreadable)
    let loaded = found ?? .defaults
    self.config = loaded
    self._config = loaded
    self.loop = CrashLoop(
      restartWindow: timings.restartWindow, restartCap: timings.restartCap, confirmWindow: timings.confirmWindow,
      confirmCap: timings.confirmCap)
    self.coldLoop = CrashLoop(confirmWindow: timings.confirmWindow, confirmCap: timings.coldConfirmCap)
    self._status = Status(host: host.kind)
    self.recovery.launchedAtMs = options.wallClock().rounded(.down)
    let queue = q
    let me = WeakRef(self)
    host.onExit = { info in queue.async { me.value?.handleExit(info) } }
    if migrated {
      audit("launch_trust_migrated", [:])
      saveConfig()  // refused when the file is unreadable, and a failed write is logged (`config_save_failed`), not swallowed
    }
    if configUnreadable {
      audit("config_unreadable", [:])
      // One line to the phone, once per run of the app: nobody may be at the Mac to see the menu. Off the caller's thread (the login
      // shell's environment is read for `talos-app`'s PATH). desktop.json says nothing now, so the post needs only `talos-app` on that
      // PATH and the default thread of the bridge's own config.json.
      q.async { [weak self] in self?.postToPhone { _ in CrashPost.configUnreadable } }
    }
    publish()
  }

  // MARK: public API (all hop onto the queue)

  /// Starts the 1 s tick. Tests that drive `tickNow()` by hand don't call this.
  public func startTicking() {
    q.async { [weak self] in
      guard let me = self, me.timer == nil else { return }
      me.detached = false
      let t = DispatchSource.makeTimerSource(queue: me.q)
      t.schedule(deadline: .now() + me.timings.tick, repeating: me.timings.tick)
      t.setEventHandler { [weak me] in me?.tick() }
      t.resume()
      me.timer = t
      me.syncNapGuard()
    }
  }

  /// App launch (4.8): re-attach to a live agent with no restart and no keypress. When nothing is alive and
  /// `allowColdStart`, a cold start (the owner presses Enter).
  public func attachOrStart(allowColdStart: Bool) {
    q.async {
      self.detached = false
      if self.attachLocked() { return }
      if allowColdStart { self.startColdLocked() }
    }
  }

  /// Manual Start, Adopt's Continue: a cold start.
  public func start() { q.async { self.detached = false; self.startColdLocked() } }

  /// The one-shot answer to a Blocked screen: start anyway, skipping the takeover check for this launch only. A cold start
  /// only (a crash restart never gets it), and never while Telegram is among the holders: that ban stands. The flag is
  /// spent by the next launch attempt of any kind, so a later start is checked again.
  public func startAnyway() {
    q.async {
      guard case .blocked(let blockers) = self.phase, !blockers.contains(where: { $0.resource == .telegram }) else {
        self.audit("start_anyway_refused", ["phase": "\(self.phase)"])
        return
      }
      self.skipTakeoverOnce = true
      self.audit("start_anyway", ["holders": blockers.map { "\($0.resource.rawValue):\($0.sessionPid)" }.joined(separator: ",")])
      self.startColdLocked()
      self.skipTakeoverOnce = false // whatever happened above (the lock was refused, say), the answer is spent
    }
  }

  /// [Start a new conversation] after a resume failure: the old id moves to `previous_ids`, then a cold start.
  public func startNewConversation() {
    q.async {
      guard !self.refusesForUnreadableConfig("new_conversation") else { return }
      self.config.session.retireCurrentId()
      self.saveConfig()
      self.startColdLocked()
    }
  }

  /// Stop (4.3 step 8): SIGTERM the group, SIGKILL after the grace, then (tmux) kill-session.
  public func stop() { q.async { self.beginStop(reason: .user, closeHost: true) } }

  /// Restart from the menu = a cold start (D2). `before` runs on the queue after the stop has finished, just before the start.
  public func restartCold(before: (@Sendable () -> Void)? = nil) {
    q.async {
      let me = WeakRef(self)
      let go = { before?(); me.value?.startColdLocked() }
      if self.isLive {
        self.afterStop = go
        self.beginStop(reason: .user, closeHost: false)
      } else {
        go()
      }
    }
  }

  /// App quit with tmux: stop watching, leave the agent running. Once detached it takes no part until started again: the exit of
  /// the child it let go (an owned pty's child goes with it) arrives on the queue after this returns, and must not take the
  /// session lock back from whoever holds it next (`handleExit` ignores it).
  public func detach() {
    q.sync {
      self.detached = true
      self.timer?.cancel()
      self.timer = nil
      self.syncNapGuard()
      self.host.detach()
      self.releaseLock()
    }
  }

  // MARK: one active supervisor per session

  /// An exclusive `flock` on `<desktop.json>.<name>.lock`. Only its holder starts, restarts, signals or types. A second
  /// supervisor of the same session (a dev build next to the installed app, `open -n`) stays passive: it watches and
  /// re-attaches after the active one restarts the pane, so a crash gets one restart and at most one Enter.
  private var lockFd: Int32 = -1
  private var detached = false
  private var passiveReattach = false
  public var holdsSessionLock: Bool { statusLock.withLock { _holdsLock } }
  private var _holdsLock = false

  var lockPath: String { options.configPath + ".\(options.name).lock" }

  func tryLock() -> Bool {
    if lockFd >= 0 { return true }
    if detached { return false }  // let go at quit: nothing already queued (an exit, a restore) takes the session back
    let dir = (lockPath as NSString).deletingLastPathComponent
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let fd = open(lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return false }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
      close(fd)
      return false
    }
    lockFd = fd
    statusLock.withLock { _holdsLock = true }
    return true
  }

  private func releaseLock() {
    guard lockFd >= 0 else { return }
    flock(lockFd, LOCK_UN)
    close(lockFd)
    lockFd = -1
    statusLock.withLock { _holdsLock = false }
  }

  /// What the owned-pty host shows, and a way to type at it (the window for a Mac with no tmux: WP-D2 finding 9).
  public func hostScreen() -> [String] { host.visibleRows() ?? [] }
  public func hostSend(_ keys: [UInt8]) { host.send(keys: keys) }

  /// Replaces the config (Settings, Adopt). A changed launch command makes the next restart cold. It writes
  /// `desktop.json` only when the file already exists or the caller says this is the setup (`createFile`: import a
  /// command, Adopt). A settings tweak before setup stays in memory: the file's existence is what makes the next launch
  /// start a session, so a Settings toggle must not create it (D6 review).
  public func updateConfig(_ c: DesktopConfig, createFile: Bool = false) {
    q.async { self.applyConfigLocked(c, createFile: createFile) }
  }

  /// Changes the config as one step on the supervisor's own queue: `edit` sees the config as it is at that moment, including
  /// anything the supervisor itself changed meanwhile (the conversation id, the confirmation). A read, edit and `updateConfig`
  /// from outside can lose such a change; this cannot. Two callers editing different fields both keep their edit.
  /// `then` runs on the supervisor's queue once the edit is in `currentConfig()` (or was refused): a caller on the main thread
  /// hops back from it instead of waiting on the queue, which a tick can hold through its tmux calls.
  public func mutateConfig(
    createFile: Bool = false, _ edit: @escaping @Sendable (inout DesktopConfig) -> Void, then: (@Sendable () -> Void)? = nil
  ) {
    q.async {
      var c = self.config
      edit(&c)
      self.applyConfigLocked(c, createFile: createFile)
      then?()
    }
  }

  /// With `desktop.json` unreadable nothing is started and nothing is written: what is in memory is the defaults, not the owner's
  /// setup, and a start or a save from it would put the defaults in place of what he had. The refusal is logged, told to the app
  /// (`.configUnreadable`) and, for a start, shown as the reason it did not start. True when it refused.
  private func refusesForUnreadableConfig(_ what: String, isStart: Bool = true) -> Bool {
    guard configUnreadable else { return false }
    audit("config_unreadable_refused", ["what": what])
    if isStart, !isLive {
      phase = .stopped(.startFailed(SupervisorNotice.configUnreadableShort))
      publish()
    }
    emit(.configUnreadable)
    return true
  }

  private func applyConfigLocked(_ new: DesktopConfig, createFile: Bool) {
    guard !refusesForUnreadableConfig("settings", isStart: false) else { return }
    var c = new
    // A session id and a first-start confirmation belong to one folder (Claude Code keys sessions by project folder). A different
    // folder starts clean, unless the caller sets the session itself (Import or Adopt of a running session).
    let home = options.home
    if c.session == config.session,
      PathUtil.canonical(c.expandedAgentDir(home: home)) != PathUtil.canonical(config.expandedAgentDir(home: home))
    {
      c.session.id = nil
      c.session.confirmedAt = nil
      c.session.confirmedCliVersion = nil
    }
    // Both configs are hashed with the one cached resolved path, so a changed `claude_path` alone looked identical: compare the setting
    // itself and drop the cached resolution. The next start is cold, and its warning waits for the owner (its launch fingerprint differs
    // from `confirmedLaunch`: `AutoConfirmGuard` `launchChanged`). A cold start with the same launch is automatic.
    let claude = resolvedClaude ?? c.claudePath
    let programChanged = c.claudePath != config.claudePath
    if programChanged || c.launchFingerprint(resolvedClaude: claude) != config.launchFingerprint(resolvedClaude: claude)
      || c.env != config.env
    {
      nextRestartIsCold = true
      cachedLaunchEnv = nil
      if programChanged { resolvedClaude = nil }
    }
    config = c
    if createFile || FileManager.default.fileExists(atPath: options.configPath) { saveConfig() }
    publish()
  }

  /// The config as of its last change. A lock read, never the queue: the tick holds the queue through its tmux calls (10 s each),
  /// and this is read on the main thread (every 5 s by the status poll) and by the workers' tick.
  public func currentConfig() -> DesktopConfig { statusLock.withLock { _config } }

  /// The rollback command (4.7): `cd <dir> && <env> claude <args> --resume <current id>`.
  public func terminalCommand() -> String {
    q.sync { LaunchSpec.rollback(config, home: options.home).render() }
  }

  /// Runs the takeover check (4.2) now, read-only: what would block a start. The UI's "Check again"; Option C.
  public func takeoverBlockers() -> [TakeoverCheck.Blocker] {
    q.sync {
      let env = launchEnv()
      guard let claude = resolveClaude(env: env) else { return [] }
      return TakeoverCheck.check(gatherTakeover(env: env, claude: claude))
    }
  }

  /// One supervision step, synchronously. Tests call this instead of `startTicking()`.
  public func tickNow() { q.sync { tick() } }

  /// Waits for queued work (tests).
  public func drain() { q.sync {} }

  /// Groups this supervisor owns (current and just-exited child). Option C feeds these into the main TakeoverCheck.
  /// Lock-only read (never the queue), so supervisors can ask each other without deadlocking.
  public var ownedProcessGroups: Set<Int32> { status.ownedGroups }

  /// Our groups for the takeover whitelist, each matched by (pgid, leader start time): a group whose leader pid now
  /// belongs to a process with another start time is not ours (D1-REVIEW finding 3).
  var ownedGroupsLocked: Set<Int32> {
    var known: [(Int32, Double)] = signaller.ownedStarts
    if let p = previousChild { known.append((p.pgid, p.start)) }
    if let l = launch { known.append((l.childPid, l.leaderStart)) }
    var out = Set<Int32>()
    for (pgid, start) in known where pgid > 1 {
      if let leader = probe.snapshot(pgid) {
        guard start > 0, abs(leader.startTime - start) <= 1 else { continue }
      }
      out.insert(pgid)
    }
    return out
  }

  // MARK: start

  /// The owner's Stop (or the app's quit) is in force: stopped by the user, or still in the grace period of a stop for the user with
  /// no restart waiting on it (a restart's own stop has `afterStop` set). Nothing recovery does may start the agent over it.
  var ownerStopped: Bool { phase == .stopped(.user) || (phase == .stopping && stopThen == .user && afterStop == nil) }

  var isLive: Bool {
    switch phase {
    case .starting, .running, .cleaningUp, .waitingToRestart, .stopping: return true
    default: return false
    }
  }

  private func attachLocked() -> Bool {
    guard !configUnreadable else { return false }  // not even watched: a crash would be restarted from the defaults
    guard host.attachIfRunning(), let pid = host.childPid else { return false }
    passiveReattach = false
    let snap = probe.snapshot(pid)
    // Without the lock this supervisor only watches (passive): it owns no group, so it can never signal one.
    let owner = tryLock()
    if owner { signaller.own(pid, leaderStart: snap?.startTime ?? 0) }
    previousChild = nil
    let claude = resolveClaude(env: launchEnv())
    let fp = config.launchFingerprint(resolvedClaude: claude ?? config.claudePath)
    let markerFp = host.marker("talos_launch")
    let markerSession = host.marker("talos_session")
    // A pane launched with another command or conversation keeps running, but its next restart is cold.
    if markerFp != fp || markerSession == nil || markerSession != config.session.id { nextRestartIsCold = true }
    // The pane may still be sitting on the development-channels warning (the app quit, crashed or was updated while Main was
    // starting). It is not running then: the start goes on from here, so the owner gets the card and the popup. Only the live warning
    // counts (its shape at the bottom of the screen, not the words in a transcript), only for the copy that holds the lock (a
    // passive one never types), and a screen that could not be read says nothing. The Mac never presses the Enter for an attached
    // start by itself: an earlier copy of the app may already have pressed it, and the rule is never twice (`awakeStartedAt`
    // puts this start outside the auto-accept's window whatever else matches).
    let waiting = owner && DialogMatcher.liveDevChannels(host.visibleRows() ?? [])
    // What the pane was launched with is known only when its marker is the launch the config names now.
    let sameLaunch = markerFp == fp
    launch = Launch(
      kind: .attached, resumeId: config.session.id, sessionId: markerSession ?? config.session.id ?? "",
      startedAt: clock.now(), childPid: pid, leaderStart: snap?.startTime ?? 0, fingerprint: markerFp ?? "",
      parts: sameLaunch ? config.launchParts(resolvedClaude: claude ?? config.claudePath) : [:], cliVersion: nil,
      expectsDevDialog: waiting, launchedChannels: sameLaunch ? AutoConfirmGuard.channels(inArgv: config.args) : [],
      awakeStartedAt: -.infinity, devDialogSeen: nil, dialogAnswered: !waiting, agentDir: config.expandedAgentDir(home: options.home))
    launch?.narrowed = MainNarrowed.found(
      argv: snap?.argv, env: snap?.env, sameLaunch: sameLaunch, configured: MainNarrowed.mode(args: config.args, env: launchEnv()))
    phase = waiting ? .starting : .running
    needsYou = nil
    audit("attach", ["pid": "\(pid)", "warning": waiting ? "live" : "no"])
    emit(.attached(pid: pid))
    publish()
    return true
  }

  private func startColdLocked() {
    switch phase {
    case .starting, .running, .cleaningUp, .waitingToRestart, .stopping: return
    default: break
    }
    guard !refusesForUnreadableConfig("start") else { return }
    guard tryLock() else { return fail(.startFailed("another Talos instance supervises this session")) }
    attempt = -1
    cannotLaunchTries = 0
    restartIsRetry = false
    cachedLaunchEnv = nil
    nextRestartIsCold = false
    launchLocked(kind: .cold)
  }

  private func launchLocked(kind: StartKind) {
    let env = launchEnv()
    guard let claude = resolveClaude(env: env) else {
      if retriesRestart(.claudeMissing) { return }
      return fail(.startFailed("claude was not found (claude_path \(config.claudePath))"))
    }
    let cwd = config.expandedAgentDir(home: options.home)
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: cwd, isDirectory: &isDir), isDir.boolValue else {
      if retriesRestart(.folderMissing) { return }
      return fail(.startFailed("the agent folder \(cwd) does not exist"))
    }

    // "Start anyway" skips the check for exactly this cold launch; every launch attempt, of any kind, spends it.
    let skipCheck = skipTakeoverOnce && kind == .cold
    skipTakeoverOnce = false
    if options.takeoverCheck && !skipCheck {
      let blockers = TakeoverCheck.check(gatherTakeover(env: env, claude: claude))
      if !blockers.isEmpty {
        if retriesRestart(.channelsHeld) { return }
        phase = .blocked(blockers)
        audit("blocked", ["holders": blockers.map { "\($0.resource.rawValue):\($0.sessionPid)" }.joined(separator: ",")])
        emit(.blocked(blockers))
        publish()
        return
      }
    }

    // Session id: --resume <session.id> if set, else --session-id <new uuid>, written now (the cold start owns it).
    let mode: ResumeRewrite.Mode
    let sessionId: String
    var unsaved = false
    launchClaudeDir = claudeDir(env)  // where this start's conversation file will be (`noteConversation`)
    if let id = config.session.id {
      // desktop.json may be written by an agent and the id is outside the launch seal: anything but a UUID is not a conversation, and is
      // never put in the argv. Nothing is started and nothing is changed for the owner (no fresh conversation under the old one): the
      // menu's Start a new conversation, or a fixed file, is the way on. The value is never logged.
      guard ResumeRewrite.isUUID(id) else {
        audit("session_id_invalid", [:])
        return fail(.startFailed(SupervisorNotice.sessionIdInvalid))
      }
      // Claude Code saves a conversation only after its first message (or an /exit). One nobody has typed in has no file, and
      // `--resume` of it is refused ("No conversation found"), which stopped Main as "can't be resumed". It is the same session
      // started again: `--session-id <the same id>`. The file is looked for in Main's own config folder, under the folder's exact
      // name and then anywhere (`SessionTranscript.find`); an id the CLI refused as already in use is resumed whatever the look said.
      // Only a session whose file the app has never seen is "unsaved" (`noteConversation`): one that had a conversation and
      // whose file is not found now (deleted, another config folder) is resumed, and stops as "can't be resumed" with the owner's
      // choice, never quietly empty under the same id.
      let resumeAnyway = forceResume == id
      let had = noteConversation(id, folder: cwd)
      unsaved = !resumeAnyway && !had && !SessionTranscript.isSaved(sessionId: id, folder: cwd, claudeDir: claudeDir(env))
      forceResume = nil
      if unsaved { audit(SessionTranscript.notSavedEvent, ["session": id]) }
      mode = unsaved ? .newSession(id) : .resume(id)
      sessionId = id
    } else {
      sessionId = UUID().uuidString.lowercased()
      config.session = DesktopConfig.Session(id: sessionId, previousIds: config.session.previousIds)
      saveConfig()
      mode = .newSession(sessionId)
    }
    var args = ResumeRewrite.apply(config.args, mode)
    // the installed guards rebuilt by the bridge from this release, re-pinned to the bun and checkout found now, BEFORE they are read
    refreshGuards(env: env)
    // optional guards (talos-app install-guards): added when installed; a --settings of the owner's own wins and is warned about
    // and Claude Code's own computer use off (Talos's screen tools replace it), in the same one --settings
    let guarded = GuardsSettings.applyingToMain(to: args, talosHome: talosAppHome, cwd: cwd)
    args = guarded.args
    for w in guarded.warnings { audit("guards_not_applied", ["why": w]) }
    // Main runs with Claude Code's own computer use on: the owner hears it once per run, not only the audit log
    if guarded.warnings.contains(where: { $0.hasSuffix(GuardsSettings.notDenied) }), !computerUseNotDeniedTold {
      computerUseNotDeniedTold = postToPhone { _ in GuardsSettings.notDeniedPhoneLine }
    }
    let version = probe.cliVersion(claude: claude, env: env)

    do {
      // A cold start refuses a live pane; a restart replaces the dead one in place (tmux respawn-pane).
      if kind == .cold {
        try host.start(executable: claude, args: args, env: env, cwd: cwd)
      } else {
        try host.restart(executable: claude, args: args, env: env, cwd: cwd)
      }
    } catch {
      // the child was gone before its pid could be read: the same two mends as an exit at the start, then the launch again
      if case PtyHostError.exitedImmediately(let rows) = error, sessionTrouble(mode, sessionId, folder: cwd, env: env, rows: rows) {
        return launchLocked(kind: kind)
      }
      if resumeMissingAtStart(error, mode) { return }
      // A restart whose child dies before its pid can be read is a crash like any other: it counts toward the cap.
      // (Any restart after a crash, a cold one too: the launch changed or the host was lost. Only a start the owner made ends at once.)
      if restartingAfterCrash { return crashedWithoutChild(String(describing: error)) }
      return fail(.startFailed("\(error)"))
    }
    guard let pid = host.childPid else {
      if restartingAfterCrash { return crashedWithoutChild("no child pid") }
      return fail(.startFailed("no child pid after start"))
    }
    let snap = probe.snapshot(pid)
    signaller.own(pid, leaderStart: snap?.startTime ?? 0)
    let fp = config.launchFingerprint(resolvedClaude: claude)
    host.setMarker("talos_launch", fp)
    host.setMarker("talos_session", sessionId)
    let expects = config.args.contains("--dangerously-load-development-channels")
    launch = Launch(
      kind: kind, resumeId: { if case .resume(let id) = mode { return id } else { return nil } }(),
      sessionId: sessionId, startedAt: clock.now(), childPid: pid, leaderStart: snap?.startTime ?? 0, fingerprint: fp,
      parts: config.launchParts(resolvedClaude: claude), cliVersion: version,
      expectsDevDialog: expects, launchedChannels: AutoConfirmGuard.channels(inArgv: args), awakeStartedAt: options.awake(),
      devDialogSeen: nil, startedWallMs: options.wallClock(), agentDir: cwd, afterCleanExit: launchingAfterCleanExit)
    launch?.narrowed = MainNarrowed.mode(args: args, env: env)
    lastAgentsPollAt = -.infinity
    cannotLaunchTries = 0
    needsYou = nil
    phase = expects ? .starting : .running
    audit(
      "start",
      ["kind": kind.rawValue, "pid": "\(pid)", "session": sessionId, "resume": launch?.resumeId == nil ? "no" : "yes"])
    publish()
  }

  /// A restart after a crash that cannot launch at all right now: another session holds the channels (the dead agent's own
  /// children can take a moment to go, or the owner opened a second session), claude is not where it was (an update in progress),
  /// the folder is not there (a volume not mounted yet). Each used to end the restart for good, silently. It is a failed attempt
  /// tried again after the backoff, but outside the crash loop (nothing crashed): it has the contract's own budget
  /// (`MAIN_RESTART.cannot_launch_tries`, the same on Linux). True when another try is scheduled. False for a start the owner made
  /// (it ends at once, with its reason) and at the last try: the caller then ends as it always did (Blocked, or could not start),
  /// nothing is restored, and the owner's phone gets one line, since nobody may be at the Mac.
  private func retriesRestart(_ why: CrashPost.RestartBlock) -> Bool {
    guard restartingAfterCrash else { return false }
    let now = clock.now()
    cannotLaunchTries += 1
    audit("restart_not_possible", ["why": why.rawValue, "tries": "\(cannotLaunchTries)"])
    guard cannotLaunchTries < timings.cannotLaunchTries else {
      cannotLaunchTries = 0
      audit("restart_gave_up", ["why": why.rawValue])
      postToPhone { CrashPost.restartGaveUp(agentName: $0, why: why, at: CrashPost.clockTime(Date())) }
      return false
    }
    attempt += 1
    let delay = timings.backoff.delay(attempt: attempt, unit: random())
    restartAt = now + delay
    restartAfterCleanExit = false
    restartIsRetry = true  // the next try is not another restart for the crash loop's count
    phase = .waitingToRestart
    emit(.restarting(attempt: attempt, delay: delay))
    publish()
    return true
  }

  private func claudeDir(_ env: [String: String]) -> String { WorkerMcp.claudeDir(home: options.home, env: env) }
  /// Claude Code's config folder as the last start this app decided saw it; nil before any.
  var launchClaudeDir: String?

  /// Whether the current session is known to have a conversation: its file has been seen on disk, now or before
  /// (`session.conversation_seen`, written the first time, so it outlives the file and a change of config folder). Claude Code
  /// writes the file at the first message, so "seen" is "has had a turn". Looked at when a start is decided, while the session
  /// runs (with the agents poll) and when it exits, in the config folder of the last start this app made (none yet: not looked
  /// at until the next start). False for any id but the configured one.
  @discardableResult
  func noteConversation(_ id: String, folder: String) -> Bool {
    guard config.session.id == id, let dir = launchClaudeDir else { return false }
    if config.session.conversationSeen == id { return true }
    guard SessionTranscript.find(sessionId: id, folder: folder, claudeDir: dir) != nil else { return false }
    config.session.conversationSeen = id
    saveConfig()
    return true
  }

  /// The two session errors of the CLI the next launch can mend (the Linux supervisor's rule, seen with Claude Code 2.1.322), each
  /// at most once per id, so neither can loop:
  ///   - `--session-id` refused as already in use: the session is saved after all (the look missed it), so it is resumed;
  ///   - `--resume` of a file that holds no conversation (an /exit before anything was typed): it can never be resumed, so the id
  ///     moves to `previous_ids` and the next launch makes a new one.
  /// True when the next launch is mended; anything else is not mended here (a real resume error still stops Main).
  private func sessionTrouble(_ mode: ResumeRewrite.Mode, _ sessionId: String, folder: String, env: [String: String], rows: [String]) -> Bool {
    switch mode {
    case .newSession:
      guard SessionTranscript.sessionInUse(rows), !mended.contains("inuse:" + sessionId) else { return false }
      mended.insert("inuse:" + sessionId)
      forceResume = sessionId
      audit(SessionTranscript.inUseResumeEvent, ["session": sessionId])
      return true
    case .resume:
      guard DialogMatcher.resumeMissing(rows), !mended.contains("empty:" + sessionId), config.session.id == sessionId,
        SessionTranscript.conversationEmpty(sessionId: sessionId, folder: folder, claudeDir: claudeDir(env))
      else { return false }
      mended.insert("empty:" + sessionId)
      config.session.retireCurrentId()
      saveConfig()
      audit(SessionTranscript.emptyNewIdEvent, ["session": sessionId])
      return true
    }
  }

  private func fail(_ reason: StopReason) {
    phase = .stopped(reason)
    audit("start_failed", [:])
    emit(.stopped(reason))
    publish()
  }

  func launchEnv() -> [String: String] {
    if let e = cachedLaunchEnv { return e }
    let login = probe.loginShellEnv()
    let e = LoginShellEnv.build(shellEnv: login ?? ProcessInfo.processInfo.environment, overrides: config.env)
    // An unreadable login shell (it timed out) leaves the app's own environment, often the bare launchd PATH. desktop.json's `env` is on top
    // either way (PATH included), the fallback is not remembered (the next start tries the login shell again), and the log says so.
    if login == nil { audit("login_env_unreadable", ["path_from": config.env["PATH"] == nil ? "app" : "desktop.json"]); return e }
    cachedLaunchEnv = e
    return e
  }

  func resolveClaude(env: [String: String]) -> String? {
    let r = whichClaude(env: env)
    resolvedClaude = r
    return r
  }

  /// Where `claude` is for this config and env, as a start would find it; remembers nothing (the restart check asks every 5 s).
  func whichClaude(env: [String: String]) -> String? {
    let raw = config.claudePath == "auto" ? "claude" : PathUtil.expandTilde(config.claudePath, home: options.home)
    return LoginShellEnv.which(raw, path: env["PATH"], isExecutable: probe.isExecutable)
  }

  var talosAppHome: String {
    if let h = options.talosAppHome { return h }
    if let h = (cachedLaunchEnv ?? config.env)["TALOS_APP_HOME"], !h.isEmpty { return h }
    return options.home + "/.config/talos/app"
  }

  var botPidPath: String {
    if let d = (cachedLaunchEnv ?? config.env)["TELEGRAM_STATE_DIR"], !d.isEmpty { return d + "/bot.pid" }
    return options.home + "/.claude/channels/telegram/bot.pid"
  }

  var bridgePidPath: String { talosAppHome + "/bridge.pid" }

  /// bot.pid / bridge.pid holders inside our child's group, recorded so clean-up can wait for them (4.3 step 1a).
  func recordHolders(_ l: inout Launch) {
    let pgid = l.childPid
    var found: [Holder] = []
    if let d = probe.readFile(botPidPath),
      let pid = Int32(String(decoding: d, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)),
      let s = probe.snapshot(pid), s.pgid == pgid
    {
      found.append(Holder(pid: pid, start: s.startTime))
    }
    if let d = probe.readFile(bridgePidPath),
      let rec = try? JSONDecoder().decode(TakeoverCheck.BridgePidRecord.self, from: d),
      let s = probe.snapshot(rec.pid), s.pgid == pgid
    {
      found.append(Holder(pid: rec.pid, start: s.startTime))
    }
    for h in found where !l.holders.contains(h) { l.holders.append(h) }
  }

  // MARK: tick

  private func tick() {
    let now = clock.now()
    switch phase {
    case .starting, .running: superviseLive(now)
    case .cleaningUp: continueCleanup(now)
    case .waitingToRestart:
      if let at = restartAt, now >= at {
        restartAt = nil
        doRestart(now)
      }
    case .stopping: continueStop(now)
    case .idle:
      if passiveReattach { _ = attachLocked() }
    default: break
    }
    recoveryTick(now)
    restartCheckTick(now)
    guardHookTick(now)
    publish()
  }

  // MARK: exit, clean-up, restart

  private func handleExit(_ info: ExitInfo) {
    guard !detached, let l = launch, info.pid == l.childPid else { return }
    lastExit = info
    let now = clock.now()
    if !tryLock() {
      // Passive: another supervisor owns this session and restarts it. Never signal or start; re-attach later.
      audit("exit_passive", ["pid": "\(info.pid)"])
      launch = nil
      phase = .idle
      passiveReattach = true
      publish()
      return
    }
    previousChild = (l.childPid, l.leaderStart)
    audit(
      "exit",
      [
        "pid": "\(info.pid)", "code": info.code.map { "\($0)" } ?? "-", "signal": info.signal.map { "\($0)" } ?? "-",
        "host_lost": info.hostLost ? "1" : "0",
      ])

    if phase == .stopping { return continueStop(now) }
    if stopsForOwnerExit(l) { return }
    if case .cleaningUp = phase { return }

    var lm = l
    recordHolders(&lm)
    launch = lm
    let holders = lm.holders
    if info.hostLost { nextRestartIsCold = true }

    let rows = info.lastRows.isEmpty ? (host.visibleRows() ?? []) : info.lastRows
    // The CLI's resume error means a failed `--resume` only on an exit at the start (within the contract's window of the spawn,
    // a start still on its warning included), as for a thread session (`WorkerManager.exited`). A session that ran and then crashed with those words on its screen
    // (a transcript that quotes them) crashed: it is restarted, and its conversation is not declared gone.
    let atTheStart = now - l.startedAt <= timings.resumeMissingWindow
    noteConversation(l.sessionId, folder: l.agentDir)  // a first message typed just before the crash
    // A failed start the next launch can mend, once each (`sessionTrouble`); not when the owner turned restarts off.
    if atTheStart, config.autoRestart,
      sessionTrouble(
        l.resumeId.map { .resume($0) } ?? .newSession(l.sessionId), l.sessionId, folder: l.agentDir, env: launchEnv(), rows: rows)
    {
      restartAfterCleanExit = false
      restartAt = now
      return beginCleanup(pgid: l.childPid, holders: holders, now: now, then: .restart)
    }
    if atTheStart, let rid = l.resumeId, DialogMatcher.resumeMissing(rows) {
      return resumeMissingStop(rid, pgid: l.childPid, holders: holders, now: now)
    }
    guard config.autoRestart else {
      return beginCleanup(pgid: l.childPid, holders: holders, now: now, then: .stop(.crashedNoAutoRestart, closeHost: false))
    }
    // Exit code 0 (no signal, the host not lost) is Main ending by itself, not a crash: claude also exits 0 after a self-update.
    // The contract's rule (packages/protocol/src/supervisor.ts, `MAIN_RESTART`), the same on Linux: it restarts at the first backoff
    // step, never counts toward the crash loop and never brings the automatic restore. Its own cap: more than
    // `cleanExitsPerHour` of them in an hour stops Main (`clean_exit_loop`), with one line to the phone and nothing restored.
    // (With auto-restart off no exit restarts Main, a clean one included: the guard above.)
    let clean = info.code == 0 && info.signal == nil && !info.hostLost
    if clean {
      cleanExits = (cleanExits + [now]).filter { now - $0 < timings.cleanExitWindow }
      guard cleanExits.count <= timings.cleanExitsPerHour else {
        audit(MainRestartContract.cleanExitLoop, ["exits": "\(cleanExits.count)"])
        postToPhone { _ in CrashPost.cleanExitLoop(at: CrashPost.clockTime(Date())) }
        return beginCleanup(pgid: l.childPid, holders: holders, now: now, then: .stop(.cleanExitLoop, closeHost: false))
      }
      restartAfterCleanExit = true
      attempt = -1  // a crash after it starts the steps over too
      let delay = timings.backoff.delay(attempt: 0, unit: random())
      restartAt = now + delay
      emit(.restarting(attempt: 0, delay: delay))
      return beginCleanup(pgid: l.childPid, holders: holders, now: now, then: .restart)
    } else {
      // Only the restart count is the crash loop. The auto-confirm cap ends the pressing, not the restarting: past it the restart
      // still happens and its warning waits for the owner (`AutoConfirmGuard` refuses with `rateLimited`: the card, the popup, the
      // phone line). Stopping there called three answered restarts in an hour a crash loop and put back the last good setup.
      guard loop.mayRestart(now: now) else {
        audit("crash_loop", ["restarts": "\(loop.restartsInWindow(now: now))", "confirms": "\(loop.autoConfirmsInWindow(now: now))"])
        postCrashLoopOnce()
        emit(.stoppedRestarting)
        return beginCleanup(pgid: l.childPid, holders: holders, now: now, then: .stop(.crashLoop, closeHost: false))
      }
    }
    restartAfterCleanExit = false
    attempt = timings.backoff.nextAttempt(previous: attempt, runStartedAt: l.startedAt, crashAt: now)
    let delay = timings.backoff.delay(attempt: attempt, unit: random())
    restartAt = now + delay
    emit(.restarting(attempt: attempt, delay: delay))
    beginCleanup(pgid: l.childPid, holders: holders, now: now, then: .restart)
  }

  private func crashedWithoutChild(_ why: String) {
    let now = clock.now()
    audit("restart_failed", [:])
    guard loop.mayRestart(now: now) else {
      postCrashLoopOnce()
      emit(.stoppedRestarting)
      return finishStop(.crashLoop, closeHost: false)
    }
    attempt += 1
    let delay = timings.backoff.delay(attempt: attempt, unit: random())
    restartAt = now + delay
    restartAfterCleanExit = false
    phase = .waitingToRestart
    emit(.restarting(attempt: attempt, delay: delay))
    publish()
  }

  func beginCleanup(pgid: Int32, holders: [Holder], now: Double, then: AfterCleanup) {
    signaller.signal(pgid, SIGTERM)
    cleanup = Cleanup(pgid: pgid, deadline: now + timings.cleanupWait, holders: holders, then: then)
    phase = .cleaningUp
    continueCleanup(now)
    publish()
  }

  private func holderGone(_ h: Holder) -> Bool {
    guard let s = probe.snapshot(h.pid) else { return true }
    return abs(s.startTime - h.start) > 1
  }

  private func continueCleanup(_ now: Double) {
    guard let c = cleanup else { return }
    let groupGone = !signaller.alive(c.pgid)
    let holdersGone = !c.holders.isEmpty && c.holders.allSatisfy(holderGone)
    guard groupGone || holdersGone || now >= c.deadline else { return }
    if !groupGone {
      signaller.signal(c.pgid, SIGKILL)
      audit("cleanup_kill", ["pgid": "\(c.pgid)"])
    }
    cleanup = nil
    switch c.then {
    case .restart:
      // The dead group is gone; stop owning its pgid (it stays in the takeover whitelist as the just-exited child).
      signaller.release(c.pgid)
      phase = .waitingToRestart
      if let at = restartAt, now >= at {
        restartAt = nil
        doRestart(now)
      }
    case .stop(let reason, let close, let announcing):
      finishStop(reason, closeHost: close, announcing: announcing)
    }
  }

  private func doRestart(_ now: Double) {
    let afterCleanExit = restartAfterCleanExit
    restartAfterCleanExit = false
    if !afterCleanExit, !restartIsRetry { loop.recordRestart(now: now) }
    restartIsRetry = false
    let kind: StartKind = nextRestartIsCold ? .cold : .supervisorRestart
    if nextRestartIsCold {
      cachedLaunchEnv = nil
      nextRestartIsCold = false
    }
    audit("restart", ["attempt": "\(attempt)", "kind": kind.rawValue])
    restartingAfterCrash = true
    launchingAfterCleanExit = afterCleanExit
    launchLocked(kind: kind)
    restartingAfterCrash = false
    launchingAfterCleanExit = false
  }

  // MARK: stop

  func beginStop(reason: StopReason, closeHost: Bool) {
    guard tryLock() else {
      audit("stop_refused_passive", [:])
      emit(.actionRefusedNotOwner)
      return
    }
    guard let l = launch, isLive else {
      if reason == .user, host.kind == .tmux, closeHost { host.close() }
      phase = .stopped(reason)
      emit(.stopped(reason))
      publish()
      let a = afterStop
      afterStop = nil
      a?()
      return
    }
    restartAt = nil
    cleanup = nil
    stopThen = reason
    stopCloseHost = closeHost
    stopDeadline = clock.now() + timings.stopGrace
    phase = .stopping
    signaller.signal(l.childPid, SIGTERM)
    audit("stop", ["reason": "\(reason)"])
    continueStop(clock.now())
    publish()
  }

  private func continueStop(_ now: Double) {
    guard let l = launch, let deadline = stopDeadline else { return }
    let gone = !signaller.alive(l.childPid)
    guard gone || now >= deadline else { return }
    if !gone { signaller.signal(l.childPid, SIGKILL) }
    stopDeadline = nil
    finishStop(stopThen, closeHost: stopCloseHost)
  }

  func finishStop(_ reason: StopReason, closeHost: Bool, announcing: Event? = nil) {
    // The group is gone: forget it, so its pid number can never whitelist someone else's session later.
    if let l = launch { signaller.release(l.childPid) }
    if let p = previousChild { signaller.release(p.pgid) }
    previousChild = nil
    launch = nil
    if closeHost { host.close() }
    phase = .stopped(reason)
    publish()
    if let e = announcing { emit(e) }  // after the status: a listener that reads it sees the stop
    emit(.stopped(reason))
    let a = afterStop
    afterStop = nil
    a?()
  }

  // MARK: plumbing

  func saveConfig() {
    // The one place the app writes desktop.json, so the rule sits here too, whatever the caller checked: never over a file that
    // could not be read when the app opened (what is in memory then is the defaults, not the owner's setup).
    guard !configUnreadable else { return audit("config_unreadable_refused", ["what": "save"]) }
    do {
      // A file that has become unreadable since (the app holds the owner's real settings then) is set aside, not overwritten:
      // say where it went (the name only, next to desktop.json).
      if let moved = try ConfigFile.save(config, to: options.configPath) {
        audit("config_unreadable_set_aside", ["file": (moved as NSString).lastPathComponent])
      }
    } catch { audit("config_save_failed", [:]) }
  }

  func emit(_ e: Event) { onEvent?(e) }

  func publish() {
    let s = Status(
      phase: phase, host: host.kind, childPid: launch?.childPid, sessionId: config.session.id,
      startKind: launch?.kind, needsYou: needsYou, lastExit: lastExit,
      restartsInWindow: loop.restartsInWindow(now: clock.now()), cliVersion: launch?.cliVersion,
      ownedGroups: ownedGroupsLocked, agentActivity: phase == .running ? agentActivity : nil, devDialog: launch?.devCard.offer,
      devPhoneTold: launch?.devCard.phoneTold ?? false, bridgeLive: launch?.bridgeSeenLive ?? false,
      configUnreadable: configUnreadable, mainNarrowed: launch?.narrowed)
    statusLock.withLock { _status = s }
  }

  /// `~/Library/Logs/Talos/supervisor.log`: event names and ids only, never screen text or content.
  func audit(_ event: String, _ fields: [String: String]) {
    guard let path = options.auditLogPath else { return }
    let ts = ISO8601DateFormatter().string(from: Date())
    let kv = fields.keys.sorted().map { "\($0)=\(fields[$0] ?? "")" }.joined(separator: " ")
    let line = "\(ts) \(options.name) \(event)\(kv.isEmpty ? "" : " " + kv)\n"
    AuditLog.append(line, to: path)
  }
}
