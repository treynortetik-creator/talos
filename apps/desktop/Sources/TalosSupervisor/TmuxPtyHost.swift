import Foundation
import TalosDesktopCore

/// The agent lives in tmux (DESKTOP-SPEC D15, 4.6): server `-L <socket>` with our own config, one session per host.
/// Quitting, crashing or reinstalling the app leaves the pane running; a new host re-attaches with `attachIfRunning()`.
/// tmux runs `/usr/bin/env -i /bin/sh <launch file>` (`LaunchFile`), and the file `exec`s claude, so the pane pid is claude,
/// its own process group and session leader. The launch's environment is only in that file: never in a tmux argv, and never
/// in the server's or the session's environment, which tmux would hand to other panes.
public final class TmuxPtyHost: PtyHost, @unchecked Sendable {
  public let kind = HostKind.tmux
  private let baseCommands: TmuxCommands
  /// The supervised pane's id (`%N`), remembered in the session option `@talos_pane` across app restarts.
  private var paneId: String?
  static let paneOption = "talos_pane"
  let pollInterval: Double
  let q: DispatchQueue
  private var timer: DispatchSourceTimer?
  private let lock = NSLock()
  private var _childPid: Int32?
  /// The leader's start time (`ProcessInspect.basic`, numeric, so a time-zone change cannot change it) when `_childPid` was recorded: the same
  /// pid with another start is another process, never our agent.
  private var _childStart: Double?
  /// When this host last began a launch (`launching`): an agent adopted later must have started after it.
  var lastLaunchAt: Date?
  /// Consecutive unanswered pane reads (`unansweredStreak`), and the owner's one-shot Start anyway (`allowStartOverUnknown`). Under `lock`.
  private var unansweredReads = 0
  private var startOverUnknown = false
  /// A new-window that did not answer may have made a pane whose id was never read: the recorded pane id is the OLD one, so it is forgotten and
  /// `loadPane` picks the pane that started after the launch. Under `lock`.
  private var awaitingNewWindow = false
  private var reported = true
  private var _onExit: (@Sendable (ExitInfo) -> Void)?
  /// Environment for tmux itself, never a launch's: a server takes its global environment from the client that starts it, so
  /// only the plain basics (`LaunchFile.serverBasics`). TMUX/TMUX_TMPDIR are not among them, so every call finds the same socket.
  private let tmuxEnv: [String: String]
  private var lastRows: [String] = []
  /// Where each launch's file is written (`LaunchFile`): a 0700 folder under the Talos home.
  let launchDir: String
  /// How tmux is run, and how a signal is sent to the server. The real ones unless a test swaps them (a fake tmux that races).
  typealias Runner = @Sendable ([String], [String: String]?, Double) -> RunResult
  typealias ServerSignaller = @Sendable (Int32, Int32) -> Void
  private let runner: Runner
  private let sendSignal: ServerSignaller
  /// Polls in a row that found the pane dead with neither an exit status nor a signal yet. Under `lock`: start, restart and attach reset it while the poll counts.
  private var deadUnread = 0
  /// Polls a dead pane may show no exit status yet before the exit is reported as it is.
  static let deadStatusPolls = 5

  public convenience init(
    commands: TmuxCommands, launchDir: String, baseEnv: [String: String] = ProcessInfo.processInfo.environment,
    pollInterval: Double = 1
  ) {
    self.init(
      commands: commands, launchDir: launchDir, baseEnv: baseEnv, pollInterval: pollInterval,
      runner: { ProcessRunner.run($0, env: $1, timeout: $2) }, sendSignal: { pid, sig in _ = kill(pid, sig) })
  }

  init(
    commands: TmuxCommands, launchDir: String, baseEnv: [String: String], pollInterval: Double, runner: @escaping Runner,
    sendSignal: @escaping ServerSignaller
  ) {
    self.runner = runner
    self.sendSignal = sendSignal
    self.baseCommands = commands
    self.launchDir = launchDir
    self.pollInterval = pollInterval
    self.q = DispatchQueue(label: "talos.tmux.\(commands.session)")
    self.tmuxEnv = LaunchFile.serverBasics(Self.clean(baseEnv))
  }

  static func clean(_ env: [String: String]) -> [String: String] {
    var e = env
    e["TMUX"] = nil
    e["TMUX_PANE"] = nil
    e["TMUX_TMPDIR"] = nil
    return e
  }

  public var childPid: Int32? { lock.withLock { _childPid } }

  /// Records the agent's pid together with its start time, so a later refusal is judged against THIS process.
  func recordChild(_ pid: Int32, start: Double? = nil) {
    let st = start ?? ProcessInspect.basic(pid)?.startTime
    lock.withLock {
      _childPid = pid
      _childStart = st
    }
  }

  /// Whether the recorded agent's LEADER is still the same live process: nil when none is recorded. A leader that is gone (no process
  /// table row and `kill(pid, 0)` says ESRCH) or has another start time is gone, whatever else is left in its group (a child that ignores
  /// SIGHUP is the clean-up's business, never a reason to call a dead Main alive). A leader that cannot be read for another reason is alive.
  func recordedAgentAlive() -> Bool? {
    guard let (pid, start) = lock.withLock({ _childPid.map { ($0, _childStart) } }) else { return nil }
    guard let now = ProcessInspect.basic(pid) else { return ProcessInspect.alive(pid) }
    guard let start else { return true }
    return abs(now.startTime - start) <= 1
  }

  /// Commands aimed at our own pane (`%N`) once it exists.
  public var commands: TmuxCommands { lock.withLock { baseCommands.withPane(paneId) } }

  public var supervisedPaneId: String? { lock.withLock { paneId } }

  private func setPane(_ id: String) {
    lock.withLock {
      paneId = id
      awaitingNewWindow = false
    }
    tmux(baseCommands.setOption(Self.paneOption, id), timeout: lookTimeout())
  }

  /// Our pane id from the session option; a session made by an older build (no option) with exactly one pane adopts it. A session with
  /// several panes and no recorded one, or a lookup tmux did not answer, is not "no pane" (that opens a second window beside the agent): it
  /// is unresolved, and `readPane` says unknown until the pane is known.
  func loadPane() {
    if lock.withLock({ paneId }) != nil { return }
    lock.withLock { lookupUnresolved = false }
    if lookExpired {
      lock.withLock { lookupUnresolved = true }
      return
    }
    if lock.withLock({ awaitingNewWindow }) { return loadPaneAfterNewWindow() }
    let opt = tmux(baseCommands.showOption(Self.paneOption), timeout: lookTimeout())
    let v = opt.out.trimmingCharacters(in: .whitespacesAndNewlines)
    if opt.ok, TmuxCommands.isPaneId(v) {
      lock.withLock { paneId = v }
      return
    }
    let list = tmux(baseCommands.listPanes(), timeout: lookTimeout())
    guard list.ok else {
      lock.withLock { lookupUnresolved = !trustsGone(list) }
      return
    }
    let panes = list.out.split(separator: "\n").map(String.init).filter(TmuxCommands.isPaneId)
    if panes.count == 1 { setPane(panes[0]) } else if panes.count > 1 { lock.withLock { lookupUnresolved = true } }
  }

  /// After a new-window that did not answer: the session's panes that are alive and started after this launch began. Exactly one is ours; any
  /// other count (none readable, several) stays unresolved, never "none": a second window must not open beside the agent.
  private func loadPaneAfterNewWindow() {
    let list = tmux(baseCommands.listPanes(), timeout: lookTimeout())
    guard list.ok else {
      lock.withLock { lookupUnresolved = !trustsGone(list) }
      return
    }
    let launchAt = lock.withLock { lastLaunchAt }
    let at = launchAt?.timeIntervalSince1970 ?? 0
    var ours: [String] = []
    var allAnswered = true
    for id in list.out.split(separator: "\n").map(String.init).filter(TmuxCommands.isPaneId) {
      let r = tmux(baseCommands.withPane(id).paneState(), timeout: lookTimeout())
      guard r.ok, let st = TmuxCommands.parsePaneState(r.out) else {
        if !(r.ok && TmuxCommands.isEmptyPaneRow(r.out)) { allAnswered = false }
        continue
      }
      guard !st.dead, let pid = st.pid else { continue }
      guard let started = ProcessInspect.basic(pid)?.startTime else {
        allAnswered = false
        continue
      }
      if started >= at - 2 { ours.append(id) }
    }
    if ours.count == 1 {
      setPane(ours[0])
    } else if ours.isEmpty, allAnswered, let launchAt, Date().timeIntervalSince(launchAt) >= Self.newWindowGrace {
      // every pane answered and none started after the launch, long after it: the new-window never ran (it timed out before tmux did it)
      lock.withLock {
        awaitingNewWindow = false
        newWindowNeverRan = true
      }
    } else {
      lock.withLock { lookupUnresolved = true }
    }
  }

  /// How long after a new-window that did not answer, with every pane answering and none new, it is taken as never having run.
  static let newWindowGrace: Double = 15
  private var newWindowNeverRan = false

  /// Under `lock`: the pane could not be told from the session's panes (see `loadPane`).
  private var lookupUnresolved = false

  private func requireValidName() throws {
    guard baseCommands.hasValidSessionName else {
      throw PtyHostError.startFailed("invalid tmux session name \(baseCommands.session)")
    }
  }

  public var onExit: (@Sendable (ExitInfo) -> Void)? {
    get { lock.withLock { _onExit } }
    set { lock.withLock { _onExit = newValue } }
  }

  /// tmux ≥ 3.2 at `path`?
  public static func isUsable(_ path: String) -> Bool {
    let r = ProcessRunner.run([path] + TmuxCommands.version(), timeout: 5)
    return r.ok && TmuxCommands.versionIsSupported(r.out)
  }

  @discardableResult
  func tmux(_ argv: [String], timeout: Double = 10) -> RunResult { runner(argv, tmuxEnv, timeout) }

  /// How long a bounded read keeps asking again for ONE answer (a session look, a pane look) before it stops and leaves the rest to the
  /// supervisor's ticks (`adoptPending`). Per host; a test shortens it.
  var boundedReadDeadline: Double = 3
  public func setBoundedReadDeadline(_ seconds: Double) { boundedReadDeadline = seconds }
  /// One whole look (session, pane lookup and pane read together) never holds the queue longer than this: each read's wait is cut to what is left
  /// of it, and once it is spent the remaining reads are unanswered without asking.
  static let lookBudget: Double = 10
  /// This host's look budget (a test shortens it).
  var lookBudgetSeconds: Double = TmuxPtyHost.lookBudget
  public func setLookBudget(_ seconds: Double) { lookBudgetSeconds = seconds }
  static let boundedReadTimeout: Double = 1
  static let boundedReadTimeoutMax: Double = 8
  private var lookEnds: Date?

  /// Starts a look (an entry point: attach, adopt, start, restart, the poll).
  func beginLook(budget: Double? = nil) { let b = budget ?? lookBudgetSeconds; lock.withLock { lookEnds = Date().addingTimeInterval(b) } }
  func endLook() { lock.withLock { lookEnds = nil } }
  var lookExpired: Bool { lock.withLock { lookEnds.map { Date() >= $0 } ?? false } }

  /// The wait for one read: the adaptive wait (`readTimeout`), cut to what is left of this look's budget (never below 0.2 s).
  func lookTimeout() -> Double {
    let wait = readTimeout()
    guard let ends = lock.withLock({ lookEnds }) else { return wait }
    return max(0.2, min(wait, ends.timeIntervalSinceNow))
  }

  /// How long one READ waits: `boundedReadTimeout`, doubling for every two unanswered reads up to `boundedReadTimeoutMax` (8 s). A tmux that answers
  /// slowly (a loaded Mac, a shim that sleeps) is never read at all with a fixed short wait. The wait comes back down only slowly (one level for
  /// every 5 looks that answer), so a tmux that answers in 2 s is not asked with 1 s again the moment one look gets through.
  func readTimeout() -> Double {
    let level = lock.withLock { waitLevel }
    return min(Self.boundedReadTimeoutMax, Self.boundedReadTimeout * pow(2, Double(level / 2)))
  }

  /// Every look's outcome: the streak of unanswered ones (the owner's notice) and the wait level (see `readTimeout`). Under no lock: takes it.
  func noteLook(answered: Bool) {
    lock.withLock {
      if answered {
        unansweredReads = 0
        answersSinceLevelUp += 1
        if answersSinceLevelUp >= 5, waitLevel > 0 {
          waitLevel -= 1
          answersSinceLevelUp = 0
        }
      } else {
        unansweredReads += 1
        answersSinceLevelUp = 0
        waitLevel = min(6, waitLevel + 1)
      }
    }
  }
  private var waitLevel = 0
  private var answersSinceLevelUp = 0
  static let boundedReadGap: Double = 0.15

  /// A failed tmux answer that is proof the server, session or pane is gone. What tmux printed because the SOCKET refused ("no server running
  /// on <path>", which a live server also says while it is busy) proves it only with the agent's own process group gone as well, or with no
  /// socket file at all: the agent in a live pane is never read as dead on a refusal.
  func trustsGone(_ r: RunResult) -> Bool {
    guard TmuxCommands.saysGone(status: r.status, stderr: r.err, timedOut: r.timedOut) else { return false }
    guard TmuxCommands.saysSocketGone(status: r.status, stderr: r.err, timedOut: r.timedOut) else { return true }  // tmux answered: no such session
    // The socket FILE can vanish under a live server (a /tmp cleanup, another TMUX_TMPDIR), and a refused socket is also what a busy
    // server prints: neither is proof. With the agent recorded, it is proof only when that same process is gone; with none recorded (a
    // fresh launch of the app), only when no tmux server process for this socket runs.
    if let alive = recordedAgentAlive() { return !alive }
    return !serverProcessRuns()
  }

  /// Whether a tmux SERVER process of this user runs for our private socket: argv[0] is `tmux`, `-L <socket>` are two of its own arguments, and it is
  /// not a client (a client names a command that talks to a server). Another account's process, or a command that merely quotes the words, never
  /// counts. The server keeps its argv, so it shows while it is refusing connections; a socket file left by a killed server shows none.
  func serverProcessRuns() -> Bool {
    let r = runner(["/bin/ps", "-u", "\(getuid())", "-o", "command="], ["PATH": "/usr/bin:/bin"], 5)
    guard r.ok else { return true }  // cannot tell: never "gone"
    return Self.listsServer(r.out, socket: baseCommands.socket)
  }

  static let clientCommands: Set<String> = [
    "has-session", "attach-session", "attach", "list-sessions", "list-panes", "list-clients", "display-message", "show-option", "show-options",
    "set-option", "capture-pane", "send-keys", "kill-session", "kill-server", "respawn-pane", "new-window", "clear-history", "run-shell",
    "if-shell", "pipe-pane", "select-pane", "resize-window", "set-window-option",
  ]

  public static func listsServer(_ psOutput: String, socket: String) -> Bool {
    psOutput.split(separator: "\n").contains { line in
      let t = line.split(separator: " ").map(String.init)
      guard let first = t.first, URL(fileURLWithPath: first).lastPathComponent == "tmux" else { return false }
      guard let i = t.firstIndex(of: "-L"), t.indices.contains(i + 1), t[i + 1] == socket else { return false }
      return !t.contains { clientCommands.contains($0) }
    }
  }

  enum SessionRead { case yes, no, unknown }

  func readSession(timeout: Double = 10) -> SessionRead {
    if lookExpired {
      noteLook(answered: false)  // a read skipped because the look is spent is a read nobody answered
      return .unknown
    }
    guard baseCommands.hasValidSessionName else { return .no }
    let r = tmux(baseCommands.hasSession(), timeout: timeout)
    let read: SessionRead = r.ok ? .yes : (trustsGone(r) ? .no : .unknown)
    // a session look that answers says nothing about a pane that does not: only an unanswered one counts here
    if case .unknown = read { noteLook(answered: false) }
    return read
  }

  /// Asks again within `boundedReadDeadline` while the answer is unknown; a real answer ends it at once.
  func boundedSession() -> SessionRead {
    let until = Date().addingTimeInterval(boundedReadDeadline)
    var read: SessionRead
    repeat {
      read = readSession(timeout: lookTimeout())
      guard case .unknown = read else { return read }
      usleep(UInt32(Self.boundedReadGap * 1_000_000))
    } while Date() < until && !lookExpired
    return read
  }

  func boundedPane() -> PaneRead {
    let until = Date().addingTimeInterval(boundedReadDeadline)
    var read: PaneRead
    repeat {
      read = readPane(timeout: lookTimeout())
      guard case .unknown = read else { return read }
      usleep(UInt32(Self.boundedReadGap * 1_000_000))
    } while Date() < until && !lookExpired
    return read
  }

  public func sessionExists() -> Bool { baseCommands.hasValidSessionName && tmux(baseCommands.hasSession()).ok }

  /// Our pane's state. nil when it (or the session, or the server) is gone, or before we know which pane is ours.
  public func paneState() -> TmuxCommands.PaneState? {
    if case .state(let s) = readPane() { return s }
    return nil
  }

  enum PaneRead {
    case state(TmuxCommands.PaneState)
    /// tmux itself said the pane, session or server is gone (or no pane is known yet).
    case gone
    /// tmux did not answer usefully (a timeout, a refused socket under load): says nothing about the agent.
    case unknown
  }

  func readPane(timeout: Double = 10) -> PaneRead {
    if lookExpired {
      noteLook(answered: false)  // a read skipped because the look is spent is a read nobody answered
      return .unknown
    }
    guard lock.withLock({ paneId }) != nil else { return lock.withLock { lookupUnresolved } ? .unknown : .gone }
    let read = readPaneOnce(timeout: timeout)
    if case .unknown = read { noteLook(answered: false) } else { noteLook(answered: true) }
    return read
  }

  public var unansweredStreak: Int { lock.withLock { unansweredReads } }

  public func allowStartOverUnknown() { lock.withLock { startOverUnknown = true } }

  private func readPaneOnce(timeout: Double) -> PaneRead {
    let r = tmux(commands.paneState(), timeout: timeout)
    if r.ok {
      if let st = TmuxCommands.parsePaneState(r.out) { return .state(st) }
      // exit 0 with every field empty is how tmux 3.8 says "no such pane/session"; a half-parsed row is only unknown
      return TmuxCommands.isEmptyPaneRow(r.out) ? .gone : .unknown
    }
    if trustsGone(r) || (r.status != 0 && !r.timedOut && r.err.contains("can't find pane")) { return .gone }
    return .unknown
  }

  public func start(executable: String, args: [String], env: [String: String], cwd: String) throws {
    beginLook()
    defer { endLook() }
    try requireValidName()  // before anything is created: an untargetable session would be unsupervised
    // Nothing is created, killed or respawned on a tmux that did not answer: the agent may be running (`paneUnreadable`).
    // (The owner's Start anyway lets ONE start go ahead over an unknown session.)
    let override = lock.withLock { () -> Bool in
      defer { startOverUnknown = false }
      return startOverUnknown
    }
    switch boundedSession() {
    case .unknown where override: break
    case .unknown: throw PtyHostError.paneUnreadable(launched: false)
    case .yes:
      loadPane()
      switch boundedPane() {
      case .state(let s) where !s.dead: throw PtyHostError.alreadyRunning
      case .unknown: throw PtyHostError.paneUnreadable(launched: false)
      default: return try respawn(executable: executable, args: args, env: env, cwd: cwd)
      }
    case .no: break
    }
    lock.withLock {
      paneId = nil
      _childPid = nil
      _childStart = nil
    }
    try launching(executable, args, env) { file in
      let create = baseCommands.newSession(argv: LaunchFile.tmuxArgv(file), cwd: cwd)
      var r = tmux(create)
      // A server that was shutting down (the last session had just been killed) creates nothing; ask again (bounded).
      for _ in 0..<3 where TmuxCommands.saysServerWentAway(status: r.status, stderr: r.err, timedOut: r.timedOut) {
        r = tmux(create)
      }
      // a timeout, or the socket refusing, is not tmux saying it did not create the session: it may have. The pane is found by session later.
      if Self.launchUnknown(r) { throw PtyHostError.paneUnreadable(launched: true) }
      guard r.ok else { throw PtyHostError.startFailed(r.err.trimmingCharacters(in: .whitespacesAndNewlines)) }
      let id = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
      guard TmuxCommands.isPaneId(id) else { throw PtyHostError.startFailed("tmux printed no pane id") }
      setPane(id)
      try adoptPane()
    }
  }

  /// A launch command that failed in a way tmux did not itself report (a timeout, or the socket refusing): it may have run.
  static func launchUnknown(_ r: RunResult) -> Bool {
    !r.ok && (r.timedOut || TmuxCommands.saysSocketGone(status: r.status, stderr: r.err, timedOut: r.timedOut))
  }

  /// Writes this launch's file and runs `body` with its path. The file removes itself once the pane's shell reads it. When
  /// `body` throws it is removed here: tmux never ran it, the pane died at once, or the pane could not be read, and then a
  /// shell that has not read it yet fails rather than leave an agent running that nobody supervises.
  private func launching(_ executable: String, _ args: [String], _ env: [String: String], _ body: (String) throws -> Void) throws {
    let script: String
    do {
      script = try LaunchFile.script(argv: [executable] + args, env: Self.clean(env))
    } catch {
      throw PtyHostError.startFailed("\(error)")
    }
    let path = LaunchFile.newPath(in: launchDir, session: baseCommands.session)
    do {
      try LaunchFile.create(at: path, script: script)  // checks the folder is ours before anything in it is touched
      LaunchFile.removeStale(in: launchDir, session: baseCommands.session, except: path)
    } catch {
      throw PtyHostError.startFailed("\(error)")
    }
    lock.withLock { lastLaunchAt = Date() }
    do {
      try body(path)
    } catch {
      // after a launch that may have run, the pane's shell may not have read its file yet: it stays (it removes itself when read)
      if case PtyHostError.paneUnreadable(launched: true) = error { throw error }
      unlink(path)
      throw error
    }
  }

  public func restart(executable: String, args: [String], env: [String: String], cwd: String) throws {
    beginLook()
    defer { endLook() }
    try requireValidName()
    switch boundedSession() {
    case .unknown: throw PtyHostError.paneUnreadable(launched: false)
    case .no: return try start(executable: executable, args: args, env: env, cwd: cwd)
    case .yes: try respawn(executable: executable, args: args, env: env, cwd: cwd)
    }
  }

  private func respawn(executable: String, args: [String], env: [String: String], cwd: String) throws {
    loadPane()
    // before any new window or respawn-pane: a pane tmux cannot read may be a live agent, and `respawn-pane -k` would kill it
    let paneGone: Bool
    switch boundedPane() {
    case .unknown: throw PtyHostError.paneUnreadable(launched: false)
    case .gone: paneGone = true
    case .state(let st):
      // NEVER `respawn-pane -k` a live pane, whoever's it is: that kills what runs in it, and its identity cannot be proven from here. The
      // supervisor attaches to it instead. Only a DEAD pane is respawned in place.
      if !st.dead { throw PtyHostError.alreadyRunning }
      paneGone = false
    }
    // the pid recorded is the previous run's: a refusal is checked against the NEW agent (the server's own process), never the dead one
    lock.withLock {
      _childPid = nil
      _childStart = nil
    }
    try launching(executable, args, env) { file in
      if paneGone {
        // Our pane is gone but the session lives on (someone else's pane in it): a new window, never their pane.
        let r = tmux(baseCommands.newWindow(argv: LaunchFile.tmuxArgv(file), cwd: cwd))
        if Self.launchUnknown(r) {
          lock.withLock {
            paneId = nil
            awaitingNewWindow = true
          }
          throw PtyHostError.paneUnreadable(launched: true)
        }
        let id = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
        guard r.ok, TmuxCommands.isPaneId(id) else {
          throw PtyHostError.startFailed(r.err.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        setPane(id)
        return try adoptPane()
      }
      // A fresh screen and history: a notice or dialog from the previous run must never be read as this run's. The second
      // clear is part of the respawn command itself (see `respawnPane`), never a later call.
      tmux(commands.clearHistory())
      let r = tmux(commands.respawnPane(argv: LaunchFile.tmuxArgv(file), cwd: cwd))
      if Self.launchUnknown(r) { throw PtyHostError.paneUnreadable(launched: true) }
      guard r.ok else { throw PtyHostError.startFailed(r.err.trimmingCharacters(in: .whitespacesAndNewlines)) }
      try adoptPane()
    }
  }

  private func adoptPane() throws {
    // The pane exists (we just made it). If tmux cannot answer about it the agent may well be running: it is neither "exited" nor to be
    // started again. The pane id stays set and `adoptPending` takes it on a later tick.
    let read = boundedPane()
    if case .unknown = read { throw PtyHostError.paneUnreadable(launched: true) }
    guard case .state(let s) = read, let pid = s.pid else {
      // It died before we could read its pid (e.g. an unknown flag, or a resume of a conversation that is gone, exits at
      // once). Report the exit with no pid, and what it left on the screen: the caller decides what that line means.
      let r = tmux(commands.captureRecent(lines: 200))
      throw PtyHostError.exitedImmediately(rows: r.ok ? Self.deadPaneRows(r.out) : [])
    }
    recordChild(pid)
    lock.withLock {
      reported = false
      deadUnread = 0
    }
    watch()
  }

  /// A dead pane's screen and history, without the "Pane is dead" line tmux adds.
  private static func deadPaneRows(_ capture: String) -> [String] {
    TmuxCommands.parseCapture(capture).filter { !$0.hasPrefix("Pane is dead") }
  }

  public func attachIfRunning() -> Bool { attachState() == .running }

  public func attachState() -> AttachState {
    beginLook()
    defer { endLook() }
    switch boundedSession() {
    case .no: return .notRunning
    case .unknown: return .unknown
    case .yes: break
    }
    loadPane()
    let read = boundedPane()
    if case .unknown = read { return .unknown }
    guard case .state(let s) = read else { return .notRunning }
    guard !s.dead, let pid = s.pid else {
      // A dead pane waits (remain-on-exit); the next start respawns it. Its pid is gone.
      lock.withLock { _childPid = nil }
      return .notRunning
    }
    recordChild(pid)
    lock.withLock {
      reported = false
      deadUnread = 0
    }
    watch()
    return .running
  }

  /// A start threw `paneUnreadable(launched: true)`: one bounded look for the pane it made (found by session when its id was never read). Never
  /// "gone" on a lookup that did not answer. An agent older than this launch is `olderAgent`: the launch did not take effect.
  public func adoptPending() -> AdoptOutcome {
    beginLook()
    defer { endLook() }
    if lock.withLock({ paneId }) == nil {
      switch boundedSession() {
      case .unknown: return .unknown
      case .no: return .gone(rows: [])
      case .yes: loadPane()
      }
      if lock.withLock({ newWindowNeverRan }) {
        lock.withLock { newWindowNeverRan = false }
        return .notLaunched
      }
      if lock.withLock({ paneId }) == nil { return .unknown }  // a session that is there, with no pane we can tell: never "gone"
    }
    switch boundedPane() {
    case .unknown: return .unknown
    case .state(let s):
      guard !s.dead, let pid = s.pid else {
        // the dead pane's screen is evidence of THIS launch only when the pane had output after it began (a respawn that never ran leaves the
        // old run's screen, which may say "No session found" about a conversation this launch never touched)
        let at = lock.withLock { lastLaunchAt }?.timeIntervalSince1970 ?? 0
        let r = tmux(commands.captureRecent(lines: 200), timeout: lookTimeout())
        let ran = (s.activity ?? 0) >= at - 2
        return .gone(rows: r.ok && ran ? Self.deadPaneRows(r.out) : [])
      }
      // started before this launch began: it is an agent that was already there
      if let at = lock.withLock({ lastLaunchAt }), let started = ProcessInspect.basic(pid)?.startTime, started < at.timeIntervalSince1970 - 2 {
        recordChild(pid)
        lock.withLock {
          reported = false
          deadUnread = 0
        }
        watch()
        return .olderAgent(pid: pid)
      }
      recordChild(pid)
      lock.withLock {
        reported = false
        deadUnread = 0
      }
      watch()
      return .adopted(pid: pid)
    case .gone:
      let r = tmux(commands.captureRecent(lines: 200), timeout: lookTimeout())
      return .gone(rows: r.ok ? Self.deadPaneRows(r.out) : [])
    }
  }

  private func watch() {
    q.async { [weak self] in
      guard let me = self, me.timer == nil else { return }
      let t = DispatchSource.makeTimerSource(queue: me.q)
      t.schedule(deadline: .now() + me.pollInterval, repeating: me.pollInterval)
      t.setEventHandler { [weak me] in me?.poll() }
      t.resume()
      me.timer = t
    }
  }

  private static let unknownReadsToTrustGroup = 3
  /// Consecutive unknown pane reads. Touched only on `q` (the poll timer's queue).
  private var unknownReads = 0

  private func poll() {
    beginLook()
    defer { endLook() }
    let (pid, done) = lock.withLock { (_childPid, reported) }
    guard let pid, !done else { return }
    let rows = visibleRows() ?? []
    if !rows.isEmpty { lock.withLock { lastRows = rows } }
    let s: TmuxCommands.PaneState
    switch readPane() {
    case .state(let st):
      unknownReads = 0
      s = st
    case .unknown:
      unknownReads += 1
      // tmux was slow or refused this one query: not evidence the agent is gone, the next poll asks again. But a failure
      // that never ends must not hide a dead agent forever, so ask what WorkerManager.pane() asks: has-session, then the kernel.
      guard confirmedLost(pid: pid) else { return }
      report(ExitInfo(pid: pid, code: nil, signal: nil, hostLost: true, lastRows: lock.withLock { lastRows }))
      return
    case .gone:
      unknownReads = 0
      // Session or server gone under us (killed externally): the agent is gone; the next start is cold.
      report(ExitInfo(pid: pid, code: nil, signal: nil, hostLost: true, lastRows: lock.withLock { lastRows }))
      return
    }
    if !s.dead, s.pid != pid { return }  // respawned meanwhile; the new pid is adopted by start/restart
    if !s.dead { lock.withLock { deadUnread = 0 } }
    if s.dead {
      // tmux marks a pane dead when its terminal closes and reads the exit status when it reaps the process. Under load the
      // server can miss that SIGCHLD (seen on Linux, tmux 3.4): the pane then reads dead with no status and no signal, and
      // reported as it is that is an exit with no code, which Main takes for a crash (a clean exit included). Nudge the server
      // to reap and read again on the next poll, a bounded number of times; after that the exit is reported as before.
      let nudge = lock.withLock { () -> Bool in
        guard s.exitStatus == nil, s.exitSignal == nil, deadUnread < Self.deadStatusPolls else { return false }
        deadUnread += 1
        return true
      }
      if nudge {
        nudgeServer()
        return
      }
      lock.withLock { deadUnread = 0 }
      let r = tmux(commands.captureRecent(lines: 200))
      let recent = r.ok ? Self.deadPaneRows(r.out) : rows
      report(ExitInfo(pid: pid, code: s.exitSignal == nil ? s.exitStatus : nil, signal: s.exitSignal, lastRows: recent))
    }
  }

  /// SIGCHLD to our own tmux server (its pid from tmux itself, on our private socket) makes it reap exited children. Nothing
  /// else: SIGCHLD only makes a process wait for its children. A pid that does not parse as one above 1 is never signalled.
  private func nudgeServer() {
    let r = tmux(baseCommands.serverPid())
    guard r.ok, let pid = Int32(r.out.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 1 else { return }
    sendSignal(pid, SIGCHLD)
  }

  /// tmux can't say where the pane is. Its session being gone, or nothing left alive in the agent's process group, is a loss.
  /// An empty process group is trusted only after `unknownReadsToTrustGroup` unknown reads in a row: one failed query right
  /// after a real crash finds the group already empty, and the parent would have read the real exit on the next poll.
  private func confirmedLost(pid: Int32) -> Bool {
    let session = tmux(baseCommands.hasSession())
    if trustsGone(session) { return true }
    return unknownReads >= Self.unknownReadsToTrustGroup && !ProcessInspect.groupAlive(pid)
  }

  private func report(_ info: ExitInfo) {
    let cb: (@Sendable (ExitInfo) -> Void)? = lock.withLock {
      guard !reported, _childPid == info.pid else { return nil }
      reported = true
      return _onExit
    }
    cb?(info)
  }

  @discardableResult
  public func send(keys: [UInt8]) -> SendOutcome {
    // Keys go to our own pane only, never to "the active pane".
    guard !keys.isEmpty, lock.withLock({ paneId }) != nil else { return .failed }
    // A wheel-up in the viewer puts the pane in copy mode, where `send-keys` goes to the mode and the agent never sees the
    // key (the supervisor's one restart Enter would be swallowed and the restart killed). Leave the mode and send in ONE
    // tmux invocation: as two, a wheel-up between them re-enters the mode. The cancel is conditional on `#{pane_in_mode}`
    // evaluated inside tmux, so there is no separate query to time out under load.
    let r = tmux(commands.sendBytesLeavingMode(keys))
    if r.timedOut { return .unknown }
    return r.ok ? .sent : .failed
  }

  @discardableResult
  public func sendDialogKey(_ key: DialogKey) -> SendOutcome {
    guard lock.withLock({ paneId }) != nil else { return .failed }
    let r = tmux(commands.sendDialogKey(key))
    if r.timedOut { return .unknown }
    return r.ok ? .sent : .failed
  }

  @discardableResult
  public func sendSelectNumber(_ n: SelectNumber) -> SendOutcome {
    guard lock.withLock({ paneId }) != nil else { return .failed }
    let r = tmux(commands.sendSelectNumber(n))
    if r.timedOut { return .unknown }
    return r.ok ? .sent : .failed
  }

  @discardableResult
  public func sendAnswerText(_ t: AnswerText) -> SendOutcome {
    guard lock.withLock({ paneId }) != nil else { return .failed }
    let r = tmux(commands.sendAnswerText(t))
    if r.timedOut { return .unknown }
    return r.ok ? .sent : .failed
  }

  @discardableResult
  public func sendEscape() -> SendOutcome {
    guard lock.withLock({ paneId }) != nil else { return .failed }
    let r = tmux(commands.sendEscape())
    if r.timedOut { return .unknown }
    return r.ok ? .sent : .failed
  }

  public func visibleRows() -> [String]? {
    guard lock.withLock({ paneId }) != nil else { return nil }
    let r = tmux(commands.capturePane())
    return r.ok ? TmuxCommands.parseCapture(r.out) : nil
  }

  public func clientActivity() -> Double? {
    let r = tmux(commands.listClientsActivity())
    guard r.ok, let times = TmuxCommands.parseClientActivity(r.out) else { return nil }
    return times.max()
  }

  public func clientActivities() -> [Double]? {
    let r = tmux(commands.listClientsActivity())
    return r.ok ? TmuxCommands.parseClientActivity(r.out) : nil
  }

  public func lastOutputAt() -> Date? {
    paneState()?.activity.map { Date(timeIntervalSince1970: $0) }
  }

  /// Blocking stop outside a supervision loop. Signals only through `signaller`, which refuses groups it doesn't own.
  public var signaller: GroupSignaller?

  public func terminate(graceSeconds: Double) {
    if let pid = childPid, let sig = signaller {
      sig.signal(pid, SIGTERM)
      let until = Date().addingTimeInterval(graceSeconds)
      while sig.alive(pid), Date() < until { usleep(100_000) }
      if sig.alive(pid) { sig.signal(pid, SIGKILL) }
    }
    close()
  }

  public func close() { _ = closeChecked() }

  /// kill-session, and whether tmux confirmed it: it said so itself, or the session was already gone. A timeout or a refusal is not a stop.
  public func closeChecked() -> Bool {
    lock.withLock { reported = true }
    let r = tmux(baseCommands.killSession(), timeout: 3)  // retried on ticks: a short wait each time
    return r.ok || trustsGone(r)
  }

  public func detach() {
    q.sync {
      timer?.cancel()
      timer = nil
    }
  }

  public func setMarker(_ key: String, _ value: String) { tmux(baseCommands.setOption(key, value)) }

  public func marker(_ key: String) -> String? {
    let r = tmux(baseCommands.showOption(key))
    guard r.ok else { return nil }
    let v = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
    return v.isEmpty ? nil : v
  }
}
