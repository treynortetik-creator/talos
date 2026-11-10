import Foundation
import SwiftTerm
import TalosDesktopCore
import TalosSupervisor

/// The real monotonic clock plus a jump the test adds, so "the start has waited two minutes" does not take two minutes. It only
/// ever moves forward; everything else on the supervisor's clock (backoffs, grace periods) keeps running in real time.
final class JumpClock: MonotonicClock, @unchecked Sendable {
  private let lock = NSLock()
  private var extra = 0.0
  private var asleep = 0.0
  func now() -> Double { SystemMonotonicClock().now() + lock.withLock { extra + asleep } }
  func advance(_ seconds: Double) { lock.withLock { extra += seconds } }
  /// The Mac sleeps: the monotonic and wall clocks jump, the awake clock does not (as on macOS).
  func sleep(_ seconds: Double) { lock.withLock { asleep += seconds } }
  /// Unix milliseconds on the same jumping clock, for the request file's own `ts` and the bridge status stamp.
  func wallMs() -> Double { Date().timeIntervalSince1970 * 1000 + lock.withLock { extra + asleep } * 1000 }
  /// Moves only by `advance`, so a test can put a request exactly on the edge of a window.
  func awake() -> Double { 1000 + lock.withLock { extra } }
}

/// One integration test's world: a temp folder (fake HOME, fake TALOS_APP_HOME, agent folder), a private tmux socket
/// `talos-test-<pid>-<random>` (never `-L talos`), and the fake-claude fixtures. Nothing here reads the owner's real
/// HOME, Telegram state, bridge or tmux servers. `teardown()` kills that test tmux server and the pids this test started.
final class Rig: @unchecked Sendable {
  static let fixtures: String = {
    let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    return here.deletingLastPathComponent().appendingPathComponent("Fixtures/fake-claude").path
  }()
  static let tmuxConf: String = {
    let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    return here.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources/tmux.conf").path
  }()
  static let tmuxPath: String? = {
    for p in ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]
    where FileManager.default.isExecutableFile(atPath: p) && TmuxPtyHost.isUsable(p) {
      return p
    }
    return nil
  }()
  static var hasTmux: Bool { tmuxPath != nil }

  static let sessionId = "11111111-2222-4333-8444-555555555555"

  let kind: HostKind
  /// Extra variables in the owner's login-shell env (a polluted one in the env-strip tests).
  let loginExtra: [String: String]
  let createdAt = Date().timeIntervalSince1970
  let root: String
  let home: String
  let talosHome: String
  let agentDir: String
  let agentsDir: String
  let stateDir: String
  let log: String
  let postLog: String
  let holderLog: String
  let configPath: String
  let auditPath: String
  let socket: String
  var timings: Supervisor.Timings
  /// The launch fingerprint stored as already confirmed at construction (nil for `launchConfirmed: false`).
  private(set) var seededLaunch: String?
  let clock = JumpClock()
  /// The key store that seals the confirmed launch: in memory, shared by every supervisor this rig makes (an app relaunch on the same Mac).
  let trust = MemoryLaunchTrust()
  /// How many times the restore child or a phone post was handed to `Options.background`.
  let backgroundRuns = RunCounter()
  /// Every `claude agents --json` call the current supervisor's probe made (see `RecordingProbe`).
  private(set) var agentsProbe: RecordingProbe!
  /// A wrapper to use instead of the real tmux binary (a fault or counting shim). Takes effect at the next `makeSupervisor()`.
  var tmuxBin: String?
  /// How often the tmux host's own poll reads the pane (it takes a capture each time, from its own thread). A test that logs tmux verbs
  /// sets this before `makeSupervisor()` so the poll cannot land between two verbs it is ordering.
  var hostPollInterval = 0.2
  private(set) var host: PtyHost!
  private(set) var sup: Supervisor!
  private var events: [Supervisor.Event] = []
  private let lock = NSLock()
  private var startedPids: [Int32] = []
  private var processes: [Process] = []

  static func realPath(_ p: String) -> String {
    guard let r = realpath(p, nil) else { return p }
    defer { free(r) }
    return String(cString: r)
  }

  var botPidPath: String { home + "/.claude/channels/telegram/bot.pid" }
  var bridgePidPath: String { talosHome + "/bridge.pid" }

  init(
    _ kind: HostKind, scenario: String, env extra: [String: String] = [:], timings: Supervisor.Timings? = nil,
    session: DesktopConfig.Session? = nil, loginExtra: [String: String] = [:], launchConfirmed: Bool = true,
    configure: (inout DesktopConfig) -> Void = { _ in }
  ) throws {
    self.kind = kind
    self.loginExtra = loginExtra
    let base = (NSTemporaryDirectory() as NSString).appendingPathComponent("talos-d1-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
    root = Rig.realPath(base)
    home = root + "/home"
    talosHome = root + "/talos-home"
    agentDir = root + "/agent"
    agentsDir = root + "/agents"
    stateDir = root + "/state"
    log = root + "/fake.log"
    postLog = root + "/post.log"
    holderLog = root + "/holders.log"
    configPath = root + "/desktop.json"
    auditPath = root + "/supervisor.log"
    socket = "talos-test-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
    for d in [home + "/.claude/channels/telegram", talosHome, agentDir, agentsDir, stateDir] {
      try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    }
    try "{\"agent\":{\"name\":\"Testagent\"},\"default_thread\":\"general\"}".write(
      toFile: talosHome + "/config.json", atomically: true, encoding: .utf8)

    var t = timings ?? Supervisor.Timings()
    if timings == nil {
      t.tick = 0.2
      t.agentsPoll = 0.5
      t.backoff = Backoff(steps: [0.3, 0.5, 0.5, 0.5, 0.5], jitter: 0)
      t.dialogStall = 2
      t.stopGrace = 3
    }
    self.timings = t

    var c = DesktopConfig.defaults
    c.agentDir = agentDir
    c.claudePath = Rig.fixtures + "/claude"
    c.args = [
      "--dangerously-skip-permissions", "--dangerously-load-development-channels", "server:talos-app",
    ]
    c.env = [
      "FAKE_SCENARIO": scenario, "FAKE_AGENTS_DIR": agentsDir, "FAKE_STATE_DIR": stateDir, "FAKE_LOG": log,
      "FAKE_BRIDGE_PID_FILE": bridgePidPath, "FAKE_HOLDER_LOG": holderLog, "FAKE_POST_LOG": postLog,
      "FAKE_MAX_LIFETIME": "120", "TALOS_APP_HOME": talosHome,
    ].merging(extra) { _, b in b }
    c.talosAppCommand = [Rig.fixtures + "/talos-app"]
    if let session { c.session = session }
    configure(&c)
    // A launch the owner has already confirmed (the auto-accept presses Enter only on a launch it has seen answered). `launchConfirmed:
    // false` is a first-ever start, or a launch he has just changed: the fingerprint of this very config is not stored.
    if launchConfirmed {
      LaunchSeal.confirm(
        &c, fingerprint: c.launchFingerprint(resolvedClaude: c.claudePath), parts: c.launchParts(resolvedClaude: c.claudePath), trust: trust)
      c.launchTrust = LaunchTrustMigration.version  // sealed in the current format: the migration leaves it
    }
    seededLaunch = c.confirmedLaunch
    try ConfigFile.save(c, to: configPath)
    makeSupervisor()
  }

  var loginEnv: [String: String] {
    [
      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": home, "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8",
      "TMPDIR": NSTemporaryDirectory(), "SHLVL": "3", "TERM_PROGRAM": "Apple_Terminal",
    ].merging(loginExtra) { _, b in b }
  }

  /// A new host + supervisor on the same socket and config (an app relaunch).
  @discardableResult
  func makeSupervisor() -> Supervisor {
    let env = loginEnv
    let probe = RecordingProbe(LiveSystem(loginEnv: { env }))
    agentsProbe = probe
    let h: PtyHost
    switch kind {
    case .tmux:
      h = TmuxPtyHost(
        commands: TmuxCommands(tmux: tmuxBin ?? Rig.tmuxPath!, socket: socket, configPath: Rig.tmuxConf), baseEnv: env,
        pollInterval: hostPollInterval)
    case .direct:
      h = SwiftTermPtyHost()
    }
    var o = Supervisor.Options(name: "agent", configPath: configPath, home: home, talosAppHome: talosHome, auditLogPath: auditPath)
    o.takeoverCheck = true
    o.launchTrust = trust
    let jump = clock
    o.wallClock = { jump.wallMs() }
    o.awake = { jump.awake() }
    let runs = backgroundRuns
    o.background = { work in
      runs.increment()
      Thread.detachNewThread(work)
    }
    let s = Supervisor(options: o, host: h, probe: probe, clock: clock, timings: timings, random: { 0 })
    s.onEvent = { [weak self] e in self?.lock.withLock { self?.events.append(e) } }
    host = h
    sup = s
    return s
  }

  /// `agentsProbe.summary` for this supervisor's current child, worked out here on the test's thread.
  var agentsSummary: String { agentsProbe.summary(ourPid: sup.status.childPid) }

  var allEvents: [Supervisor.Event] { lock.withLock { events } }

  func start(cold: Bool = true) {
    sup.startTicking()
    if cold { sup.start() }
  }

  /// Polls `cond` every 50 ms until it holds or `timeout` passes.
  @discardableResult
  func wait(_ timeout: Double, _ cond: () -> Bool) -> Bool {
    let until = Date().addingTimeInterval(timeout)
    while Date() < until {
      if cond() { return true }
      usleep(50_000)
    }
    return cond()
  }

  /// Bounded poll for a value: `read` is retried until it returns non-nil or `timeout` passes, then the last result is
  /// returned. For status fields the supervisor publishes a tick after the event the test just saw (fake log, screen).
  func poll<T>(_ timeout: Double, _ read: () -> T?) -> T? {
    var out: T?
    _ = wait(timeout) { out = read(); return out != nil }
    return out
  }

  func screenContains(_ s: String) -> Bool { (host.visibleRows() ?? []).joined(separator: "\n").contains(s) }

  /// The human at the Mac pressing Enter. tmux: through the test server like an attached client; owned pty: the host.
  func humanEnter() {
    if kind == .tmux {
      _ = ProcessRunner.run(
        [Rig.tmuxPath!, "-L", socket, "-f", Rig.tmuxConf, "send-keys", "-t", "=agent:", "Enter"], env: loginEnv)
    } else {
      host.send(keys: [0x0d])
    }
  }

  var config: DesktopConfig { (try? ConfigFile.load(configPath)) ?? nil ?? .defaults }
  var starts: [String] { completeLines(log) }
  var posts: [String] { completeLines(postLog) }
  /// Every message to the owner's phone (`talos-app post`); the restore the loop brings is recorded in the same log.
  var phonePosts: [String] { posts.filter { $0.hasPrefix("post ") } }
  /// The crash-loop message to the owner's phone.
  var crashPosts: [String] { phonePosts.filter { $0.contains("stopped restarting at") } }
  var holders: [Int32] {
    ((try? String(contentsOfFile: holderLog, encoding: .utf8)) ?? "").split(separator: "\n").compactMap { Int32($0) }
  }
  var audit: String { (try? String(contentsOfFile: auditPath, encoding: .utf8)) ?? "" }
  /// How many Enters the supervisor has typed on the dev-channel warning (one `auto_confirm` line each). Since 2026-11-07 a cold start
  /// is answered too, so a test that follows a start, a crash and a restart sees one for the first start and one for the restart.
  var autoConfirms: Int { audit.components(separatedBy: " auto_confirm ").count - 1 }
  /// Every start that ended on its own, as audited. Three shapes: a child that ran and exited audits `exit pid=…` (an exit during
  /// a Stop logs `exit` too, and the cap does not see it); a restart whose child died before its pid could be read audits
  /// `restart_failed` and no `exit`; and the restore's cold start dying before its pid is a `start_failed` after `restore_start`.
  /// The cap itself counts restarts, one fewer than the crashes that led to a stop. Counting `exit` lines alone falls short on a
  /// loaded runner while the loop still stops.
  var crashes: Int {
    let n = { (s: String, e: String) in s.components(separatedBy: e).count - 1 }
    return n(audit, " exit ") + n(audit, " restart_failed") + n(auditAfterRestore, " start_failed")
  }
  /// The audit from the automatic restore on: a `start_failed` here is the restore's cold start, not an unrelated failed start.
  private var auditAfterRestore: String {
    audit.range(of: " restore_start").map { String(audit[$0.upperBound...]) } ?? ""
  }
  /// The loop has stopped the agent for good: `.crashLoop`, or `.startFailed` when the restore's cold start died before its pid
  /// could be read (the start path has no crash count of its own; it stops the same way, with the same buttons, and nothing loops).
  /// A `start_failed` with no `restore_start` before it is a first start that never ran, not a loop, and is not accepted.
  var loopStopped: Bool {
    switch stopReason(phase()) {
    case .crashLoop?: return true
    case .startFailed?: return auditAfterRestore.contains(" start_failed")
    default: return false
    }
  }

  func phase() -> Supervisor.Phase { sup.status.phase }

  /// Launches a helper this test owns (a lookalike, a fake poller, a fake other session). Killed in teardown by pid.
  ///
  /// A fixture that renames itself (`exec -a NAME /bin/sleep`) is a plain `bash holder.sh` until its `exec` runs, and the fixed
  /// 150 ms below is not always enough. The takeover check looks at the command line once, so a test that started the check in
  /// that gap saw no poller (the real runner, 2026-11-01: argv still `/bin/bash holder.sh` when `spawn` returned; the same process
  /// blocked fine once it had exec'd). On the self-hosted runner this test failed in every run before the wait (four commits) and on
  /// the owner's Mac it passed; why the `exec` is that much slower there is not known. `commandLineHas` waits for the name the
  /// test relies on, and fails with what it saw if the name never shows.
  func spawn(_ argv: [String], cwd: String? = nil, commandLineHas: String? = nil) throws -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: argv[0])
    p.arguments = Array(argv.dropFirst())
    p.environment = loginEnv.merging(["FAKE_MAX_LIFETIME": "120"]) { _, b in b }
    if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try p.run()
    lock.withLock {
      startedPids.append(p.processIdentifier)
      processes.append(p)
    }
    usleep(150_000)
    if let needle = commandLineHas {
      let pid = p.processIdentifier
      let seen = wait(10) { ProcessInspect.snapshot(pid)?.commandLine.contains(needle) == true }
      guard seen else {
        throw SpawnError.neverRenamed(pid: pid, wanted: needle, saw: ProcessInspect.snapshot(pid)?.commandLine ?? "gone")
      }
    }
    return p.processIdentifier
  }

  enum SpawnError: Error, CustomStringConvertible {
    case neverRenamed(pid: Int32, wanted: String, saw: String)
    var description: String {
      switch self {
      case .neverRenamed(let pid, let wanted, let saw): return "pid \(pid) never showed \"\(wanted)\" in its command line (saw: \(saw))"
      }
    }
  }

  /// Writes an agents --json entry for a pid this test started.
  func registerAgent(pid: Int32, cwd: String, sessionId: String = "99999999-2222-4333-8444-555555555555") throws {
    try "{\"pid\":\(pid),\"kind\":\"interactive\",\"sessionId\":\"\(sessionId)\",\"cwd\":\"\(cwd)\",\"status\":\"idle\",\"startedAt\":0}"
      .write(toFile: agentsDir + "/\(pid).json", atomically: true, encoding: .utf8)
  }

  func teardown() {
    sup?.detach()
    if kind == .tmux, let t = Rig.tmuxPath {
      // Only our own test server, by its private socket name.
      _ = ProcessRunner.run([t, "-L", socket, "kill-server"], env: loginEnv, timeout: 5)
      // tmux 3.8 leaves the socket file behind; remove ours (the server behind it is gone).
      unlink("/tmp/tmux-\(getuid())/\(socket)")
    } else if let pid = host?.childPid, ProcessInspect.alive(pid), ProcessInspect.basic(pid)?.pgid == pid {
      killpg(pid, SIGKILL)  // the owned pty child this test started (its own group)
    }
    // Helpers this test spawned: their Process objects are ours, so the pid can't have been reused while running.
    for p in lock.withLock({ processes }) where p.isRunning { kill(p.processIdentifier, SIGKILL) }
    // Holders our fake sessions spawned: only a process that started after this rig and still carries the fake's
    // exact argv[0] (one argv element with spaces, which only `exec -a` makes). A recycled pid fails both.
    for pid in holders {
      guard let s = ProcessInspect.snapshot(pid), s.startTime >= createdAt - 1,
        s.argv.first == "bun apps/bridge/src/server.ts"
      else { continue }
      kill(pid, SIGKILL)
    }
    try? FileManager.default.removeItem(atPath: root)
  }
}

/// LiveSystem that notes each `claude agents --json` call: when it began (seconds since this probe was made), how long the
/// subprocess ran and what came back. A red wait on `.stuck` prints `summary`, so the failure says which it was: no call at all
/// although the supervisor was ticked (the hop to a pool thread never ran), a call that took long (a slow subprocess), or `nil`
/// answers (unreadable, which counts neither way). Only the raw answer is kept on the poll's thread; whether our pid is in it is
/// worked out in `summary`, on the caller's.
final class RecordingProbe: SystemProbe, @unchecked Sendable {
  private let base: LiveSystem
  private let t0 = ProcessInfo.processInfo.systemUptime
  private let lock = NSLock()
  private var calls: [(at: Double, took: Double?, entries: [AgentEntry]?)] = []
  private var _answer: (@Sendable () -> [AgentEntry]?)?
  /// Replaces the subprocess with this answer, for a test that is about the hop to the poll and not about `claude agents`.
  var answer: (@Sendable () -> [AgentEntry]?)? {
    get { lock.withLock { _answer } }
    set { lock.withLock { _answer = newValue } }
  }

  init(_ base: LiveSystem) { self.base = base }

  private var now: Double { ProcessInfo.processInfo.systemUptime - t0 }

  func agents(claude: String, env: [String: String]) -> [AgentEntry]? {
    let began = now
    let i = lock.withLock { () -> Int in calls.append((began, nil, nil)); return calls.count - 1 }
    let out = answer.map { $0() } ?? base.agents(claude: claude, env: env)
    lock.withLock { calls[i].took = now - began; calls[i].entries = out }
    return out
  }

  /// The last six calls, newest last, and the time now: `+start duration result` (`listed`: `ourPid` is in the answer, `absent`: it
  /// is not, `nil`: unreadable), or `+start running` for one not back yet.
  func summary(ourPid: Int32?) -> String {
    let (all, at) = (lock.withLock { calls }, now)
    let last = all.suffix(6).map { c -> String in
      guard let took = c.took else { return String(format: "+%.1fs running", c.at) }
      let result = c.entries.map { e in ourPid.flatMap { AgentsList.interactive(e, pid: $0) } == nil ? "absent" : "listed" } ?? "nil"
      return String(format: "+%.1fs %.2fs %@", c.at, took, result)
    }
    return String(format: "agents calls %d (now +%.1fs): ", all.count, at) + (last.isEmpty ? "none" : last.joined(separator: ", "))
  }

  func snapshot(_ pid: Int32) -> ProcessSnapshot? { base.snapshot(pid) }
  func psInfo(_ pid: Int32) -> PsInfo? { base.psInfo(pid) }
  func readFile(_ path: String) -> Data? { base.readFile(path) }
  func modifiedAt(_ path: String) -> Double? { base.modifiedAt(path) }
  func isExecutable(_ path: String) -> Bool { base.isExecutable(path) }
  func cliVersion(claude: String, env: [String: String]) -> String? { base.cliVersion(claude: claude, env: env) }
  func loginShellEnv() -> [String: String]? { base.loginShellEnv() }
  func post(command: [String], thread: String, text: String, env: [String: String]) -> Bool {
    base.post(command: command, thread: thread, text: text, env: env)
  }
  func postOutcome(command: [String], thread: String, text: String, env: [String: String]) -> PostOutcome {
    base.postOutcome(command: command, thread: thread, text: text, env: env)
  }
}

final class RunCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0
  var count: Int { lock.withLock { n } }
  func increment() { lock.withLock { n += 1 } }
}

/// The finished lines of a log a fake appends to. bash 3.2's printf writes a line over 1024 bytes in two writes, so a reader
/// can catch the first 1024 bytes of a line with no newline yet; that half line is not a line. (A worker start line is about
/// 1,330 bytes with `--resume <sid>` at its end: counting the half line once made a resume look like a fresh start.)
func completeLines(_ path: String) -> [String] {
  let s = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
  guard let end = s.lastIndex(of: "\n") else { return [] }
  return s[...end].split(separator: "\n").map(String.init)
}

extension LocalProcess {
  /// What the owner types into a viewer, written straight to the viewer's pty. `send(data:)` goes through a DispatchIO at default
  /// QoS, and in a full run the @Tests that block in `usleep` hold every cooperative thread (OBSERVED, 2026-11-07: the viewer's
  /// Enter reached the pty 22 to 24 s after the test sent it, two runs in a row; see
  /// `anEnterGetsThroughWhileTheDispatchPoolIsStarved` for how the pool is held). The viewer tests are about what tmux does with
  /// the bytes, not about how SwiftTerm queues them, so they must not wait on that queue. The descriptor is non-blocking, so a
  /// full pty buffer (`EAGAIN`) is retried, bounded. False when the process is gone or the bytes did not all go in.
  @discardableResult
  func typeDirectly(_ data: ArraySlice<UInt8>) -> Bool {
    let fd = childfd
    guard fd >= 0 else { return false }
    var rest = data[...]
    let until = Date().addingTimeInterval(5)
    while !rest.isEmpty {
      let n = rest.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
      if n > 0 {
        rest = rest.dropFirst(n)
      } else if n < 0, errno == EAGAIN || errno == EINTR, Date() < until {
        usleep(10_000)
      } else {
        return false
      }
    }
    return true
  }
}
