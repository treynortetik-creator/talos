import Foundation
import TalosDesktopCore

/// What a `talos-app post` came to. A timeout says nothing about whether the line was sent, so it is neither a success nor a
/// failure that may be retried: a retry could post it twice.
public enum PostOutcome: Equatable, Sendable { case sent, failed, unknown }

/// Everything the supervisor reads from the machine, behind a protocol so unit tests can stub it. All reads; the only
/// writes are `post` (a headless signed bridge call) and the signals in `GroupSignaller`.
public protocol SystemProbe: AnyObject, Sendable {
  func snapshot(_ pid: Int32) -> ProcessSnapshot?
  func psInfo(_ pid: Int32) -> PsInfo?
  func readFile(_ path: String) -> Data?
  func modifiedAt(_ path: String) -> Double?
  func isExecutable(_ path: String) -> Bool
  /// `claude agents --json`. nil = couldn't read (not "no sessions").
  func agents(claude: String, env: [String: String]) -> [AgentEntry]?
  /// `claude --version`, the version token only.
  func cliVersion(claude: String, env: [String: String]) -> String?
  /// The login shell's environment (`/bin/zsh -lic 'env -0'`, 5 s timeout). nil when it failed.
  func loginShellEnv() -> [String: String]?
  /// `talos-app post <thread> <text>` (headless; no claude, no channel poller).
  func post(command: [String], thread: String, text: String, env: [String: String]) -> Bool
  /// `post`, with the timeout told apart. The default reads a refusal as `failed` (a probe that can't tell never says `unknown`).
  func postOutcome(command: [String], thread: String, text: String, env: [String: String]) -> PostOutcome
  /// The Mac's own signed system row (`SystemPost`): one HTTPS request to the relay. Blocking; whether it was taken (2xx). No
  /// default: a test probe must say what it does, so no test reaches a network.
  func send(_ request: URLRequest) -> PostOutcome
  /// `talos-app guards refresh` (GuardsRefresh), blocking, bounded by `GuardsRefresh.timeout`. The default runs `command`.
  func guardsRefresh(command: [String], env: [String: String]) -> RunResult
}

extension SystemProbe {
  public func guardsRefresh(command: [String], env: [String: String]) -> RunResult {
    ProcessRunner.run(command + GuardsRefresh.args, env: env, timeout: GuardsRefresh.timeout)
  }

  public func postOutcome(command: [String], thread: String, text: String, env: [String: String]) -> PostOutcome {
    post(command: command, thread: thread, text: text, env: env) ? .sent : .failed
  }
}

/// The answer of one `send`, written by URLSession's queue and read after the wait.
private final class OutcomeBox: @unchecked Sendable {
  private let lock = NSLock()
  private var v = PostOutcome.failed
  var value: PostOutcome {
    get { lock.withLock { v } }
    set { lock.withLock { v = newValue } }
  }
}

public final class LiveSystem: SystemProbe, @unchecked Sendable {
  let loginEnvOverride: (@Sendable () -> [String: String]?)?

  /// `loginEnv` replaces the login-shell read (tests use a fixed env and never run the owner's shell rc files).
  public init(loginEnv: (@Sendable () -> [String: String]?)? = nil) { self.loginEnvOverride = loginEnv }

  public func snapshot(_ pid: Int32) -> ProcessSnapshot? { ProcessInspect.snapshot(pid) }

  public func psInfo(_ pid: Int32) -> PsInfo? {
    guard pid > 0 else { return nil }
    var env = ProcessInfo.processInfo.environment
    env["LC_ALL"] = "C"  // lstart must not depend on the locale (as lifecycle.ts psInfo)
    let r = ProcessRunner.run(["/bin/ps", "-p", String(pid), "-o", "lstart=,command="], env: env, timeout: 5)
    guard r.ok else { return nil }
    return PsInfo.parse(r.out)
  }

  public func readFile(_ path: String) -> Data? { FileManager.default.contents(atPath: path) }

  public func modifiedAt(_ path: String) -> Double? {
    guard let a = try? FileManager.default.attributesOfItem(atPath: path), let d = a[.modificationDate] as? Date
    else { return nil }
    return d.timeIntervalSince1970
  }

  public func isExecutable(_ path: String) -> Bool { FileManager.default.isExecutableFile(atPath: path) }

  public func agents(claude: String, env: [String: String]) -> [AgentEntry]? {
    let r = ProcessRunner.run([claude] + AgentsList.argv, env: env, timeout: 15)
    guard r.ok else { return nil }
    return AgentsList.decode(r.stdout)
  }

  public func cliVersion(claude: String, env: [String: String]) -> String? {
    let r = ProcessRunner.run([claude, "--version"], env: env, timeout: 15)
    guard r.ok, let v = CLIVersion.parse(r.out) else { return nil }
    return v.description
  }

  public func loginShellEnv() -> [String: String]? {
    if let o = loginEnvOverride { return o() }
    let r = ProcessRunner.run(
      ["/bin/zsh", "-lic", LoginShellEnv.shellScript], env: ProcessInfo.processInfo.environment,
      timeout: LoginShellEnv.timeoutSeconds)
    return LoginShellEnv.parse(r.stdout)
  }

  public func post(command: [String], thread: String, text: String, env: [String: String]) -> Bool {
    ProcessRunner.run(command + ["post", thread, text], env: env, timeout: 60).ok
  }

  public func postOutcome(command: [String], thread: String, text: String, env: [String: String]) -> PostOutcome {
    let r = ProcessRunner.run(command + ["post", thread, text], env: env, timeout: 60)
    return r.timedOut ? .unknown : (r.ok ? .sent : .failed)
  }

  public func send(_ request: URLRequest) -> PostOutcome {
    let done = DispatchSemaphore(value: 0)
    let result = OutcomeBox()
    let session = URLSession(configuration: .ephemeral)
    defer { session.finishTasksAndInvalidate() }
    let task = session.dataTask(with: request) { _, response, error in
      if let code = (response as? HTTPURLResponse)?.statusCode {
        result.value = (200..<300).contains(code) ? .sent : .failed
      } else if (error as? URLError)?.code == .timedOut {
        result.value = .unknown
      }
      done.signal()
    }
    task.resume()
    // a hard deadline: the request's own timeout is per read, so a relay that trickles bytes could hold this thread for good
    guard done.wait(timeout: .now() + 45) == .success else {
      task.cancel()
      return .unknown
    }
    return result.value
  }
}

/// Signals process groups, and only the ones this supervisor owns. Never a pattern, never a bare pid, never our own
/// group, never pgid 0 or 1 (R-19, DESKTOP-SPEC 3 and 4.3 step 1a).
public final class GroupSignaller: @unchecked Sendable {
  private let lock = NSLock()
  /// pgid → the group leader's start time when we launched it (a recycled pgid is refused).
  private var owned: [Int32: Double] = [:]
  public private(set) var log: [(Int32, Int32)] = []
  let probe: SystemProbe

  public init(probe: SystemProbe) { self.probe = probe }

  public func own(_ pgid: Int32, leaderStart: Double) {
    lock.lock()
    owned[pgid] = leaderStart
    lock.unlock()
  }

  public func release(_ pgid: Int32) {
    lock.lock()
    owned[pgid] = nil
    lock.unlock()
  }

  /// (pgid, leader start time) for every owned group.
  public var ownedStarts: [(Int32, Double)] {
    lock.lock()
    defer { lock.unlock() }
    return owned.map { ($0.key, $0.value) }
  }

  public var ownedGroups: Set<Int32> {
    lock.lock()
    defer { lock.unlock() }
    return Set(owned.keys)
  }

  /// true when the signal was sent. Refuses a group we don't own, our own group, and a group whose leader pid now
  /// belongs to a different process (pid reuse).
  @discardableResult
  public func signal(_ pgid: Int32, _ sig: Int32) -> Bool {
    lock.lock()
    let start = owned[pgid]
    lock.unlock()
    guard let start, pgid > 1, pgid != getpgrp(), pgid != getpid() else { return false }
    if let leader = probe.snapshot(pgid), abs(leader.startTime - start) > 1 { return false }
    guard ProcessInspect.groupAlive(pgid) else { return false }
    let ok = killpg(pgid, sig) == 0
    lock.lock()
    log.append((pgid, sig))
    lock.unlock()
    return ok
  }

  public func alive(_ pgid: Int32) -> Bool { ProcessInspect.groupAlive(pgid) }

  /// The group's LEADER is still the process we recorded: it has a process-table row (or `kill(pid, 0)` does not say ESRCH) and, when its start
  /// time was recorded, the same one. A dead leader with a child that survives (one that ignores SIGHUP) is gone: the leftover is the
  /// clean-up's business, not a reason to call the agent alive.
  public func leaderAlive(_ pgid: Int32) -> Bool {
    guard let snap = probe.snapshot(pgid) else { return ProcessInspect.alive(pgid) }
    lock.lock()
    let start = owned[pgid]
    lock.unlock()
    guard let start else { return true }
    return abs(snap.startTime - start) <= 1
  }
}
