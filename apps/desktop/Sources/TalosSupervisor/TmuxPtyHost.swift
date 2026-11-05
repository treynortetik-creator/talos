import Foundation
import TalosDesktopCore

/// The agent lives in tmux (DESKTOP-SPEC D15, 4.6): server `-L <socket>` with our own config, one session per host.
/// Quitting, crashing or reinstalling the app leaves the pane running; a new host re-attaches with `attachIfRunning()`.
/// tmux runs the claude argv directly (`new-session … -- <argv>`, no shell), so the pane pid is claude, its own process
/// group and session leader.
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
  private var reported = true
  private var _onExit: (@Sendable (ExitInfo) -> Void)?
  /// Environment for tmux itself. TMUX/TMUX_TMPDIR are removed so every call finds the same socket.
  private var tmuxEnv: [String: String]
  private var lastRows: [String] = []

  public init(commands: TmuxCommands, baseEnv: [String: String] = ProcessInfo.processInfo.environment, pollInterval: Double = 1) {
    self.baseCommands = commands
    self.pollInterval = pollInterval
    self.q = DispatchQueue(label: "talos.tmux.\(commands.session)")
    self.tmuxEnv = Self.clean(baseEnv)
  }

  static func clean(_ env: [String: String]) -> [String: String] {
    var e = env
    e["TMUX"] = nil
    e["TMUX_PANE"] = nil
    e["TMUX_TMPDIR"] = nil
    return e
  }

  public var childPid: Int32? { lock.withLock { _childPid } }

  /// Commands aimed at our own pane (`%N`) once it exists.
  public var commands: TmuxCommands { lock.withLock { baseCommands.withPane(paneId) } }

  public var supervisedPaneId: String? { lock.withLock { paneId } }

  private func setPane(_ id: String) {
    lock.withLock { paneId = id }
    tmux(baseCommands.setOption(Self.paneOption, id))
  }

  /// Our pane id from the session option; a session made by an older build (no option) with exactly one pane adopts it.
  private func loadPane() {
    if lock.withLock({ paneId }) != nil { return }
    let opt = tmux(baseCommands.showOption(Self.paneOption))
    let v = opt.out.trimmingCharacters(in: .whitespacesAndNewlines)
    if opt.ok, TmuxCommands.isPaneId(v) {
      lock.withLock { paneId = v }
      return
    }
    let panes = tmux(baseCommands.listPanes()).out.split(separator: "\n").map(String.init)
      .filter(TmuxCommands.isPaneId)
    if panes.count == 1 { setPane(panes[0]) }
  }

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
  func tmux(_ argv: [String], env: [String: String]? = nil) -> RunResult {
    ProcessRunner.run(argv, env: env ?? tmuxEnv, timeout: 10)
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

  func readPane() -> PaneRead {
    guard lock.withLock({ paneId }) != nil else { return .gone }
    let r = tmux(commands.paneState())
    if r.ok {
      if let st = TmuxCommands.parsePaneState(r.out) { return .state(st) }
      // exit 0 with every field empty is how tmux 3.8 says "no such pane/session"; a half-parsed row is only unknown
      return TmuxCommands.isEmptyPaneRow(r.out) ? .gone : .unknown
    }
    if TmuxCommands.saysGone(status: r.status, stderr: r.err, timedOut: r.timedOut)
      || (r.status != 0 && !r.timedOut && r.err.contains("can't find pane"))
    {
      return .gone
    }
    return .unknown
  }

  public func start(executable: String, args: [String], env: [String: String], cwd: String) throws {
    try requireValidName()  // before anything is created: an untargetable session would be unsupervised
    if sessionExists() {
      loadPane()
      if let s = paneState(), !s.dead { throw PtyHostError.alreadyRunning }
      return try respawn(executable: executable, args: args, env: env, cwd: cwd)
    }
    // The server (if this starts it) gets exactly the agent's environment, as `env -i <vars> tmux …`.
    let serverEnv = Self.clean(env)
    scrubInheritedEnvironment()  // a server that already runs may have been started by a polluted process
    lock.withLock { paneId = nil }
    let create = baseCommands.newSession(argv: [executable] + args, env: serverEnv, cwd: cwd)
    var r = tmux(create, env: serverEnv)
    // A server that was shutting down (the last session had just been killed) creates nothing; ask again (bounded).
    for _ in 0..<3 where TmuxCommands.saysServerWentAway(status: r.status, stderr: r.err, timedOut: r.timedOut) {
      r = tmux(create, env: serverEnv)
    }
    guard r.ok else { throw PtyHostError.startFailed(r.err.trimmingCharacters(in: .whitespacesAndNewlines)) }
    tmuxEnv = serverEnv
    let id = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
    guard TmuxCommands.isPaneId(id) else { throw PtyHostError.startFailed("tmux printed no pane id") }
    setPane(id)
    try adoptPane()
  }

  public func restart(executable: String, args: [String], env: [String: String], cwd: String) throws {
    try requireValidName()
    guard sessionExists() else { return try start(executable: executable, args: args, env: env, cwd: cwd) }
    try respawn(executable: executable, args: args, env: env, cwd: cwd)
  }

  /// Removes inherited Claude Code markers from the running server's global and session environment (`-e` cannot).
  func scrubInheritedEnvironment() {
    for global in [true, false] {
      let r = tmux(baseCommands.showEnvironment(global: global))
      guard r.ok else { continue }  // no server or no session yet: nothing inherited to remove
      for name in ClaudeEnvScrub.inheritedNames(inShowEnvironment: r.out) {
        tmux(baseCommands.removeEnvironment(name, global: global))
      }
    }
  }

  private func respawn(executable: String, args: [String], env: [String: String], cwd: String) throws {
    scrubInheritedEnvironment()
    loadPane()
    if paneState() == nil {
      // Our pane is gone but the session lives on (someone else's pane in it): a new window, never their pane.
      let r = tmux(baseCommands.newWindow(argv: [executable] + args, env: Self.clean(env), cwd: cwd))
      let id = r.out.trimmingCharacters(in: .whitespacesAndNewlines)
      guard r.ok, TmuxCommands.isPaneId(id) else {
        throw PtyHostError.startFailed(r.err.trimmingCharacters(in: .whitespacesAndNewlines))
      }
      setPane(id)
      return try adoptPane()
    }
    // A fresh screen and history: a notice or dialog from the previous run must never be read as this run's.
    tmux(commands.clearHistory())
    let r = tmux(commands.respawnPane(argv: [executable] + args, env: Self.clean(env), cwd: cwd))
    guard r.ok else { throw PtyHostError.startFailed(r.err.trimmingCharacters(in: .whitespacesAndNewlines)) }
    tmux(commands.clearHistory())
    try adoptPane()
  }

  private func adoptPane() throws {
    guard let s = paneState(), let pid = s.pid else {
      // It died before we could read its pid (e.g. an unknown flag exits at once). Report the exit with no pid.
      throw PtyHostError.startFailed("the agent exited immediately")
    }
    lock.withLock {
      _childPid = pid
      reported = false
    }
    watch()
  }

  public func attachIfRunning() -> Bool {
    guard sessionExists() else { return false }
    loadPane()
    guard let s = paneState() else { return false }
    guard !s.dead, let pid = s.pid else {
      // A dead pane waits (remain-on-exit); the next start respawns it. Its pid is gone.
      lock.withLock { _childPid = nil }
      return false
    }
    lock.withLock {
      _childPid = pid
      reported = false
    }
    watch()
    return true
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
    if s.dead {
      let r = tmux(commands.captureRecent(lines: 200))
      let recent = r.ok ? TmuxCommands.parseCapture(r.out).filter { !$0.hasPrefix("Pane is dead") } : rows
      report(ExitInfo(pid: pid, code: s.exitSignal == nil ? s.exitStatus : nil, signal: s.exitSignal, lastRows: recent))
    }
  }

  /// tmux can't say where the pane is. Its session being gone, or nothing left alive in the agent's process group, is a loss.
  /// An empty process group is trusted only after `unknownReadsToTrustGroup` unknown reads in a row: one failed query right
  /// after a real crash finds the group already empty, and the parent would have read the real exit on the next poll.
  private func confirmedLost(pid: Int32) -> Bool {
    let session = tmux(baseCommands.hasSession())
    if TmuxCommands.saysGone(status: session.status, stderr: session.err, timedOut: session.timedOut) { return true }
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

  public func visibleRows() -> [String]? {
    guard lock.withLock({ paneId }) != nil else { return nil }
    let r = tmux(commands.capturePane())
    return r.ok ? TmuxCommands.parseCapture(r.out) : nil
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

  public func close() {
    lock.withLock { reported = true }
    tmux(baseCommands.killSession())
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
