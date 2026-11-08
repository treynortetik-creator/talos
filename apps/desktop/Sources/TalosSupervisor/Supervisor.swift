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
/// group of a child it started (`GroupSignaller`), and it never answers any dialog except the restart-only dev-channel
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
  private let pollQ: DispatchQueue
  private var timer: DispatchSourceTimer?

  private(set) var config: DesktopConfig { didSet { statusLock.withLock { _config = config } } }
  private(set) var phase: Phase = .idle
  private(set) var launch: Launch?
  /// The just-exited child's group and leader start time. Cleared once a stop completes.
  private var previousChild: (pgid: Int32, start: Double)?
  private var loop: CrashLoop
  private var attempt = -1
  private var cleanup: Cleanup?
  private var restartAt: Double?
  private var stopDeadline: Double?
  private var stopThen: StopReason = .user
  private var stopCloseHost = true
  private var afterStop: (() -> Void)?
  /// Read by the recovery tick, in the same pass that may have just raised it; `status` is the copy of the pass before.
  private(set) var needsYou: NeedsYou?
  private var agentActivity: String?
  private var lastExit: ExitInfo?
  private var nextRestartIsCold = false
  /// Set by `startAnyway()` for the one cold launch that follows it; spent by that launch (or cleared right after it).
  private var skipTakeoverOnce = false
  /// Restart and restore requests, and the automatic restore (SupervisorRecovery.swift).
  var recovery = RecoveryState()
  private var lastAgentsPollAt: Double = -.infinity
  private var agentsPollInFlight = false
  private var cachedLaunchEnv: [String: String]?
  private var resolvedClaude: String?

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
    let loaded = ((try? ConfigFile.load(options.configPath)) ?? nil) ?? .defaults
    self.config = loaded
    self._config = loaded
    self.loop = CrashLoop(
      restartWindow: timings.restartWindow, restartCap: timings.restartCap, confirmWindow: timings.confirmWindow,
      confirmCap: timings.confirmCap)
    self._status = Status(host: host.kind)
    self.recovery.launchedAtMs = options.wallClock().rounded(.down)
    let queue = q
    let me = WeakRef(self)
    host.onExit = { info in queue.async { me.value?.handleExit(info) } }
    publish()
  }

  // MARK: public API (all hop onto the queue)

  /// Starts the 1 s tick. Tests that drive `tickNow()` by hand don't call this.
  public func startTicking() {
    q.async { [weak self] in
      guard let me = self, me.timer == nil else { return }
      let t = DispatchSource.makeTimerSource(queue: me.q)
      t.schedule(deadline: .now() + me.timings.tick, repeating: me.timings.tick)
      t.setEventHandler { [weak me] in me?.tick() }
      t.resume()
      me.timer = t
    }
  }

  /// App launch (4.8): re-attach to a live agent with no restart and no keypress. When nothing is alive and
  /// `allowColdStart`, a cold start (the owner presses Enter).
  public func attachOrStart(allowColdStart: Bool) {
    q.async {
      if self.attachLocked() { return }
      if allowColdStart { self.startColdLocked() }
    }
  }

  /// Manual Start, Adopt's Continue: a cold start.
  public func start() { q.async { self.startColdLocked() } }

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

  /// App quit with tmux: stop watching, leave the agent running.
  public func detach() {
    q.sync {
      self.timer?.cancel()
      self.timer = nil
      self.host.detach()
      self.releaseLock()
    }
  }

  // MARK: one active supervisor per session

  /// An exclusive `flock` on `<desktop.json>.<name>.lock`. Only its holder starts, restarts, signals or types. A second
  /// supervisor of the same session (a dev build next to the installed app, `open -n`) stays passive: it watches and
  /// re-attaches after the active one restarts the pane, so a crash gets one restart and at most one Enter.
  private var lockFd: Int32 = -1
  private var passiveReattach = false
  public var holdsSessionLock: Bool { statusLock.withLock { _holdsLock } }
  private var _holdsLock = false

  var lockPath: String { options.configPath + ".\(options.name).lock" }

  func tryLock() -> Bool {
    if lockFd >= 0 { return true }
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
  public func mutateConfig(createFile: Bool = false, _ edit: @escaping @Sendable (inout DesktopConfig) -> Void) {
    q.async {
      var c = self.config
      edit(&c)
      self.applyConfigLocked(c, createFile: createFile)
    }
  }

  private func applyConfigLocked(_ new: DesktopConfig, createFile: Bool) {
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
    // Both configs are hashed with the one cached resolved path, so a changed `claude_path` alone looked identical and the
    // next crash restart auto-pressed Enter on a different binary. A new program is a new launch: compare the setting itself
    // and drop the cached resolution so the next start finds the new one.
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
    q.sync {
      LaunchSpec(
        agentDir: config.expandedAgentDir(home: options.home), env: config.env,
        program: config.claudePath == "auto" ? "claude" : config.claudePath, args: ResumeRewrite.strip(config.args),
        resumeId: config.session.id
      ).render()
    }
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
  private var ownedGroupsLocked: Set<Int32> {
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
    guard host.attachIfRunning(), let pid = host.childPid else { return false }
    passiveReattach = false
    let snap = probe.snapshot(pid)
    // Without the lock this supervisor only watches (passive): it owns no group, so it can never signal one.
    if tryLock() { signaller.own(pid, leaderStart: snap?.startTime ?? 0) }
    previousChild = nil
    let claude = resolveClaude(env: launchEnv())
    let fp = config.launchFingerprint(resolvedClaude: claude ?? config.claudePath)
    let markerFp = host.marker("talos_launch")
    let markerSession = host.marker("talos_session")
    // A pane launched with another command or conversation keeps running, but its next restart is cold.
    if markerFp != fp || markerSession == nil || markerSession != config.session.id { nextRestartIsCold = true }
    launch = Launch(
      kind: .attached, resumeId: config.session.id, sessionId: markerSession ?? config.session.id ?? "",
      startedAt: clock.now(), childPid: pid, leaderStart: snap?.startTime ?? 0, fingerprint: markerFp ?? "",
      cliVersion: nil,
      expectsDevDialog: false, devDialogSeen: nil, noticeSeen: true, agentDir: config.expandedAgentDir(home: options.home))
    phase = .running
    needsYou = nil
    audit("attach", ["pid": "\(pid)"])
    emit(.attached(pid: pid))
    publish()
    return true
  }

  private func startColdLocked() {
    switch phase {
    case .starting, .running, .cleaningUp, .waitingToRestart, .stopping: return
    default: break
    }
    guard tryLock() else { return fail(.startFailed("another Talos instance supervises this session")) }
    attempt = -1
    cachedLaunchEnv = nil
    nextRestartIsCold = false
    launchLocked(kind: .cold)
  }

  private func launchLocked(kind: StartKind) {
    let env = launchEnv()
    guard let claude = resolveClaude(env: env) else {
      return fail(.startFailed("claude was not found (claude_path \(config.claudePath))"))
    }
    let cwd = config.expandedAgentDir(home: options.home)
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: cwd, isDirectory: &isDir), isDir.boolValue else {
      return fail(.startFailed("the agent folder \(cwd) does not exist"))
    }

    // "Start anyway" skips the check for exactly this cold launch; every launch attempt, of any kind, spends it.
    let skipCheck = skipTakeoverOnce && kind == .cold
    skipTakeoverOnce = false
    if options.takeoverCheck && !skipCheck {
      let blockers = TakeoverCheck.check(gatherTakeover(env: env, claude: claude))
      if !blockers.isEmpty {
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
    if let id = config.session.id {
      mode = .resume(id)
      sessionId = id
    } else {
      sessionId = UUID().uuidString.lowercased()
      config.session = DesktopConfig.Session(id: sessionId, previousIds: config.session.previousIds)
      saveConfig()
      mode = .newSession(sessionId)
    }
    var args = ResumeRewrite.apply(config.args, mode)
    // optional guards (talos-app install-guards): added when installed; a --settings of the owner's own wins and is warned about
    let guarded = GuardsSettings.applying(to: args, talosHome: talosAppHome)
    args = guarded.args
    if let w = guarded.warning { audit("guards_not_applied", ["why": w]) }
    let version = probe.cliVersion(claude: claude, env: env)

    do {
      // A cold start refuses a live pane; a restart replaces the dead one in place (tmux respawn-pane).
      if kind == .cold {
        try host.start(executable: claude, args: args, env: env, cwd: cwd)
      } else {
        try host.restart(executable: claude, args: args, env: env, cwd: cwd)
      }
    } catch {
      if resumeMissingAtStart(error, mode) { return }
      // A restart whose child dies before its pid can be read is a crash like any other: it counts toward the cap.
      if kind == .supervisorRestart { return crashedWithoutChild(String(describing: error)) }
      return fail(.startFailed("\(error)"))
    }
    guard let pid = host.childPid else {
      if kind == .supervisorRestart { return crashedWithoutChild("no child pid") }
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
      cliVersion: version,
      expectsDevDialog: expects, devDialogSeen: nil, agentDir: cwd)
    lastAgentsPollAt = -.infinity
    needsYou = nil
    phase = expects ? .starting : .running
    audit(
      "start",
      ["kind": kind.rawValue, "pid": "\(pid)", "session": sessionId, "resume": launch?.resumeId == nil ? "no" : "yes"])
    publish()
  }

  private func fail(_ reason: StopReason) {
    phase = .stopped(reason)
    audit("start_failed", [:])
    emit(.stopped(reason))
    publish()
  }

  func launchEnv() -> [String: String] {
    if let e = cachedLaunchEnv { return e }
    let shell = probe.loginShellEnv() ?? ProcessInfo.processInfo.environment
    let e = LoginShellEnv.build(shellEnv: shell, overrides: config.env)
    cachedLaunchEnv = e
    return e
  }

  private func resolveClaude(env: [String: String]) -> String? {
    let raw = config.claudePath == "auto" ? "claude" : PathUtil.expandTilde(config.claudePath, home: options.home)
    let r = LoginShellEnv.which(raw, path: env["PATH"], isExecutable: probe.isExecutable)
    resolvedClaude = r
    return r
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

  // MARK: takeover inputs (read-only)

  func gatherTakeover(env: [String: String], claude: String) -> TakeoverCheck.Inputs {
    var processes: [Int32: ProcessSnapshot] = [:]
    var bot: TakeoverCheck.BotPid?
    if let d = probe.readFile(botPidPath),
      let pid = Int32(String(decoding: d, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0
    {
      let holder = probe.snapshot(pid)
      bot = TakeoverCheck.BotPid(pid: pid, fileModifiedAt: probe.modifiedAt(botPidPath) ?? 0, holder: holder)
      if let g = holder?.pgid, processes[g] == nil { processes[g] = probe.snapshot(g) }
    }
    var bridge: TakeoverCheck.BridgePid?
    if let d = probe.readFile(bridgePidPath),
      let rec = try? JSONDecoder().decode(TakeoverCheck.BridgePidRecord.self, from: d)
    {
      let holder = probe.snapshot(rec.pid)
      bridge = TakeoverCheck.BridgePid(record: rec, ps: probe.psInfo(rec.pid), holder: holder)
      if let g = holder?.pgid, processes[g] == nil { processes[g] = probe.snapshot(g) }
    }
    let agents = probe.agents(claude: claude, env: env)
    for e in agents ?? [] where e.isInteractive {
      if let pid = e.pid, processes[pid] == nil { processes[pid] = probe.snapshot(pid) }
    }
    return TakeoverCheck.Inputs(
      ourPgids: ownedGroupsLocked.union(options.siblingGroups?() ?? []), botPid: bot, bridgePid: bridge, agents: agents, processes: processes)
  }

  /// bot.pid / bridge.pid holders inside our child's group, recorded so clean-up can wait for them (4.3 step 1a).
  private func recordHolders(_ l: inout Launch) {
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
    publish()
  }

  private func superviseLive(_ now: Double) {
    guard var l = launch else { return }
    // A screen that could not be read says nothing: not "no dialog". Nothing is read from it (no dialog is raised, cleared or
    // answered), but the start deadline and the agent poll below still run, so a capture that keeps failing cannot hide a start
    // that never settles or a session that has dropped out of the agent list. The notice deadline (it stops the session) does not.
    let read = host.visibleRows()
    let rows = read ?? []
    let unread = read == nil
    let screen = DialogMatcher.classify(rows)
    if case .devChannels(let d) = screen { l.devDialogSeen = d }
    if !unread { watchPrompt(rows, launch: &l, now: now) }

    // The registration notice: channels are live, so the dialog was answered. It only counts after this start showed
    // the dialog (a stale notice in old scrollback must never look like a confirmation).
    let dialogOnScreen: Bool = { if case .devChannels = screen { return true } else { return false } }()
    if l.expectsDevDialog, !l.noticeSeen, !dialogOnScreen, DialogMatcher.noticeSeen(rows) {
      if l.devDialogSeen != nil {
        l.noticeSeen = true
        phase = .running
        needsYou = nil
        if l.confirmsSent == 0 {
          recordHumanConfirm(&l, now: now)
        } else {
          audit("auto_confirm_ok", ["session": l.sessionId])
        }
        adoptReportedIdIfNeeded(&l)
      } else if now - l.startedAt >= timings.noticeWait {
        // Channels are live but this start never showed the dialog (a CLI change?). Running, nothing recorded.
        l.noticeSeen = true
        phase = .running
        // The start-stalled alarm was about this very wait, which is over: a healthy running session must not keep it.
        if needsYou == .startStalled { needsYou = nil }
        audit("notice_without_dialog", ["session": l.sessionId])
      }
    }

    if phase == .starting, l.expectsDevDialog {
      if l.kind == .supervisorRestart {
        if l.confirmSentAt == nil {
          if case .devChannels = screen {
            let decision = AutoConfirmGuard.decide(
              AutoConfirmGuard.Inputs(
                enabled: config.autoConfirmRestart, startKind: .supervisorRestart, launchedResumeId: l.resumeId,
                session: config.session, cliVersion: l.cliVersion, screen: screen, confirmsThisStart: l.confirmsSent,
                loop: loop, now: now))
            switch decision {
            case .confirm:
              // A definite failure (no pane, tmux exited non-zero) means the Enter never arrived: it does not count, and the
              // next tick tries again. A timeout may have delivered it, and the rule is never press twice, so it counts.
              if host.send(keys: [0x0d]) == .failed {
                audit("auto_confirm_send_failed", ["session": l.sessionId, "pid": "\(l.childPid)"])
                break
              }
              l.confirmsSent += 1
              // After the send returns, not the tick's start: host.send and visibleRows can each block for seconds, and the
              // agent's noticeWait begins when the Enter has been delivered.
              l.confirmSentAt = clock.now()
              loop.recordAutoConfirm(now: now)
              audit("auto_confirm", ["session": l.sessionId, "pid": "\(l.childPid)"])
              emit(.autoConfirmed(sessionId: l.sessionId))
            case .refuse(let why):
              if l.notifiedScreens.contains("refuse"), case .restartNotConfirmed(let told) = needsYou {
                // Already told once. A later reading may name a different reason (the first came from a screen still being
                // drawn): the reason shown is replaced, nobody is told again, and still nothing is pressed.
                if told != why {
                  needsYou = .restartNotConfirmed(why)
                  l.question = needsYou
                  audit("needs_you_reason", ["why": "refuse", "reason": why.rawValue])
                }
              } else {
                raiseNeedsYou(.restartNotConfirmed(why), key: "refuse", launch: &l)
              }
            }
          }
        } else if !l.noticeSeen {
          if case .devChannels = screen, l.confirmsSent > 0, now - (l.confirmSentAt ?? now) >= timings.tick * 2 {
            // The dialog is back after our one Enter: never press twice.
            raiseNeedsYou(.restartNotConfirmed(.alreadyConfirmedThisStart), key: "twice", launch: &l)
          }
          // Not on a screen that could not be read: the notice may be up where we cannot see it, and stopping a healthy agent for
          // that would be an action taken on no information. The start deadline below warns instead.
          if !unread, now - (l.confirmSentAt ?? now) >= timings.noticeWait {
            audit("auto_confirm_no_notice", ["session": l.sessionId])
            emit(.confirmFailed)
            launch = l
            beginStop(reason: .noNotice, closeHost: false)
            return
          }
        }
      } else if case .devChannels = screen {
        raiseNeedsYou(.confirmColdStart, key: "cold", launch: &l)
      }
    }

    // A dialog that has gone from the screen, or been replaced by another, is dealt with: its stall warning is over, and the
    // same kind of dialog appearing again later (a second login expiry) must raise a new one. Only the key of the dialog
    // still showing is kept.
    if !unread {
      let showing = screen.isDialog ? "stall:\(screen.label)" : nil
      l.notifiedScreens = l.notifiedScreens.filter { !$0.hasPrefix("stall:") || $0 == showing }
      // The start-stalled warning is over too once the dev-channel dialog is up: the wait it was about has an answer.
      var over = needsYou == .startStalled && dialogOnScreen
      if case .dialog(let named) = needsYou, !screen.isDialog || named != screen.label { over = true }
      // A held question is about the dialog on screen. Once that is gone and the stall was told before, the stall is what is left.
      if needsYouNamesTheDialog, !dialogOnScreen, l.notifiedScreens.contains("start") { over = true }
      // A screen read blank between two dialogs empties the slot while the cold-start question is still held. The dev-channel
      // dialog itself (never another dialog) coming up on an empty slot gets the question back, quietly, before the stall check.
      if needsYou == nil, phase == .starting, l.question != nil, dialogOnScreen { over = true }
      if over { needsYou = Self.alarmUnderneath(l, phase: phase, devDialogOnScreen: dialogOnScreen) }
    }

    // Dialog stall (4.3 step 3): no output for 60 s and a dialog on screen. The generic "a dialog needs you" is the
    // fallback for dialogs nothing above has already named: while the dev-channel dialog is still on screen and the
    // cold-start or refused-restart question about it is held, the stall must not replace it with the vaguer one. A
    // different dialog (trust, consent, login) is not covered by that question, so the stall still raises for it.
    if screen.isDialog, !(dialogOnScreen && needsYouNamesTheDialog), let last = host.lastOutputAt(), Date().timeIntervalSince(last) >= timings.dialogStall {
      raiseNeedsYou(.dialog(screen.label), key: "stall:\(screen.label)", launch: &l)
    }

    // A start that shows nothing Talos recognises must not wait forever. Only when the owner has not already been told
    // something (the cold-start question, a refused restart, a dialog) that explains why it is still starting. A held
    // question about the dev-channel dialog explains the wait only while that dialog is still on screen.
    if phase == .starting, needsYou == nil || (needsYouNamesTheDialog && !dialogOnScreen && !unread), now - l.startedAt >= timings.startWait {
      raiseNeedsYou(.startStalled, key: "start", launch: &l)
    }

    launch = l

    if now - lastAgentsPollAt >= timings.agentsPoll, !agentsPollInFlight {
      lastAgentsPollAt = now
      pollAgents()
    }
  }

  /// What the one `needsYou` slot held before a dialog's warning took it. The alarms are raised once, so their keys outlive the
  /// warning: when the dialog is over and the cause still stands, the alarm comes back (nothing is told twice). The cold-start or
  /// refused-restart question comes back, with its own reason, while the dev-channel dialog it is about is on screen again.
  static func alarmUnderneath(_ l: Launch, phase: Phase, devDialogOnScreen: Bool) -> NeedsYou? {
    if devDialogOnScreen, phase == .starting, let q = l.question { return q }
    if l.notifiedScreens.contains("stuck") { return .stuck }
    if l.notifiedScreens.contains("start"), phase == .starting { return .startStalled }
    return nil
  }

  /// The owner has already been told what to do about the dialog on screen (press Enter, or why Talos did not).
  private var needsYouNamesTheDialog: Bool {
    switch needsYou {
    case .confirmColdStart, .restartNotConfirmed: return true
    default: return false
    }
  }

  private func raiseNeedsYou(_ n: NeedsYou, key: String, launch l: inout Launch) {
    guard !l.notifiedScreens.contains(key) else { return }
    l.notifiedScreens.insert(key)
    needsYou = n
    switch n {
    case .confirmColdStart, .restartNotConfirmed: l.question = n
    default: break
    }
    audit("needs_you", ["why": key])
    emit(.needsYou(n))
    if n == .confirmColdStart { postColdStartToPhone() }
    if config.openTerminalOnDialog { emit(.openTerminal) }
  }

  /// Whether a running session belongs to the folder the config names now. After a switch of folder nothing restarts, so the old
  /// session goes on, and what it reports or has confirmed is the old folder's: never written into the new folder's setup.
  private func isForConfiguredFolder(_ l: Launch) -> Bool {
    PathUtil.canonical(l.agentDir) == PathUtil.canonical(config.expandedAgentDir(home: options.home))
  }

  private func recordHumanConfirm(_ l: inout Launch, now: Double) {
    guard let d = l.devDialogSeen, let channels = d.channels, isForConfiguredFolder(l) else { return }
    config.session.id = l.sessionId
    config.session.confirmedAt = ISO8601DateFormatter().string(from: Date())
    config.session.confirmedCliVersion = l.cliVersion
    config.session.approvedDevChannels = channels
    saveConfig()
    audit("human_confirm", ["session": l.sessionId])
    emit(.humanConfirmed(sessionId: l.sessionId))
  }

  private func pollAgents() {
    guard let l = launch, let claude = resolvedClaude ?? resolveClaude(env: launchEnv()) else { return }
    let env = launchEnv()
    let pid = l.childPid
    agentsPollInFlight = true
    let probe = self.probe
    let queue = q
    let me = WeakRef(self)
    pollQ.async {
      let entries = probe.agents(claude: claude, env: env)
      queue.async { me.value?.handleAgents(entries, pid: pid) }
    }
  }

  private func handleAgents(_ entries: [AgentEntry]?, pid: Int32) {
    agentsPollInFlight = false
    guard var l = launch, l.childPid == pid, phase == .running || phase == .starting else { return }
    recordHolders(&l)
    agentActivity = nil
    if let entries {
      if let e = AgentsList.interactive(entries, pid: pid) {
        agentActivity = e.status
        l.agentsMisses = 0
        // It's listed again: no longer stuck, whatever the slot holds now (a dialog may have taken it).
        if needsYou == .stuck { needsYou = nil }
        l.notifiedScreens.remove("stuck")
        if let sid = e.sessionId, sid != l.sessionId {
          l.reportedSessionId = sid
          if l.noticeSeen || !l.expectsDevDialog { adoptReportedIdIfNeeded(&l) }
        }
      } else if phase == .running {
        l.agentsMisses += 1
        if l.agentsMisses >= timings.hangPolls { raiseNeedsYou(.stuck, key: "stuck", launch: &l) }
      }
    }
    launch = l
    publish()
  }

  /// `agents --json` reports a different id than we launched with (4.4): follow it, after the notice, and move the
  /// human confirmation with it only if this start was confirmed.
  private func adoptReportedIdIfNeeded(_ l: inout Launch) {
    guard let sid = l.reportedSessionId, sid != l.sessionId, ResumeRewrite.isUUID(sid), isForConfiguredFolder(l) else { return }
    let old = l.sessionId
    var s = config.session
    let keepConfirm = s.confirmedAt != nil && s.id == old && (l.noticeSeen || !l.expectsDevDialog)
    s.previousIds.removeAll { $0 == old }
    s.previousIds.append(old)
    if s.previousIds.count > 5 { s.previousIds.removeFirst(s.previousIds.count - 5) }
    s.id = sid
    if !keepConfirm {
      s.confirmedAt = nil
      s.confirmedCliVersion = nil
    }
    config.session = s
    l.sessionId = sid
    host.setMarker("talos_session", sid)
    saveConfig()
    audit("session_id_changed", ["from": old, "to": sid])
  }

  // MARK: exit, clean-up, restart

  private func handleExit(_ info: ExitInfo) {
    guard let l = launch, info.pid == l.childPid else { return }
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
    if case .cleaningUp = phase { return }

    var lm = l
    recordHolders(&lm)
    launch = lm
    let holders = lm.holders
    if info.hostLost { nextRestartIsCold = true }

    let rows = info.lastRows.isEmpty ? (host.visibleRows() ?? []) : info.lastRows
    if let rid = l.resumeId, DialogMatcher.resumeMissing(rows) {
      return resumeMissingStop(rid, pgid: l.childPid, holders: holders, now: now)
    }
    guard config.autoRestart else {
      return beginCleanup(pgid: l.childPid, holders: holders, now: now, then: .stop(.crashedNoAutoRestart, closeHost: false))
    }
    let expectsDialog = config.args.contains("--dangerously-load-development-channels")
    let confirmCapHit = expectsDialog && !loop.mayAutoConfirm(now: now) && !nextRestartIsCold
    guard loop.mayRestart(now: now), !confirmCapHit else {
      audit("crash_loop", ["restarts": "\(loop.restartsInWindow(now: now))", "confirms": "\(loop.autoConfirmsInWindow(now: now))"])
      postCrashLoopOnce()
      emit(.stoppedRestarting)
      return beginCleanup(pgid: l.childPid, holders: holders, now: now, then: .stop(.crashLoop, closeHost: false))
    }
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
    loop.recordRestart(now: now)
    let kind: StartKind = nextRestartIsCold ? .cold : .supervisorRestart
    if nextRestartIsCold {
      cachedLaunchEnv = nil
      nextRestartIsCold = false
    }
    audit("restart", ["attempt": "\(attempt)", "kind": kind.rawValue])
    launchLocked(kind: kind)
  }

  // MARK: stop

  private func beginStop(reason: StopReason, closeHost: Bool) {
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

  private func saveConfig() {
    do { try ConfigFile.save(config, to: options.configPath) } catch { audit("config_save_failed", [:]) }
  }

  func emit(_ e: Event) { onEvent?(e) }

  private func publish() {
    let s = Status(
      phase: phase, host: host.kind, childPid: launch?.childPid, sessionId: config.session.id,
      startKind: launch?.kind, needsYou: needsYou, lastExit: lastExit,
      restartsInWindow: loop.restartsInWindow(now: clock.now()), cliVersion: launch?.cliVersion,
      ownedGroups: ownedGroupsLocked, agentActivity: phase == .running ? agentActivity : nil)
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
