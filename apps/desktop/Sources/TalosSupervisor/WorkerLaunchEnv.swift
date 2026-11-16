import Foundation
import TalosDesktopCore

/// The environment a thread session starts with, built each time it is asked for the way Main's is (`Supervisor.launchEnv`):
/// the login shell's, then `desktop.json` `env` as it is now on top (its `PATH` wins), through `LoginShellEnv.build`.
///
/// The login shell is slow (it runs the owner's rc files, 5 s at most) and can fail, so it is never read by the caller:
/// - a read runs on a background queue, one at a time, and the last one that worked is kept;
/// - a kept one is read again when it is `refreshAfter` old; a failed read is tried again after `retryAfter`, doubling up to `retryCap`;
/// - a failed read keeps the last good one. With none yet, the app's own environment stands in (the bare launchd `PATH` for an
///   app opened from Finder), still with `desktop.json` on top, and the log says `login_env_unreadable` with where `PATH` came from.
///
/// `env()` never waits on the main thread. Anywhere else it waits only for the first read since the app opened (no good read yet,
/// none failed yet, one running), `waitLimit` at most, so a start is not built from the bare `PATH` a moment before the real one
/// arrives. Once a read has failed, retries run in the background and an ask takes the stand-in at once: a broken login shell must
/// not hold the workers' tick for seconds at every retry.
public final class WorkerLaunchEnv: @unchecked Sendable {
  public struct Timing: Sendable {
    /// How old a good read may get before the next ask starts another.
    public var refreshAfter: Double = 900
    /// The wait after a failed read, doubled per failure in a row up to `retryCap`.
    public var retryAfter: Double = 30
    public var retryCap: Double = 300
    /// The longest `env()` waits for a read in flight. Longer than the read's own timeout, so a wait normally ends with its answer.
    public var waitLimit: Double = LoginShellEnv.timeoutSeconds + 7
    public init() {}
  }

  private let probe: SystemProbe
  private let appEnv: [String: String]
  private let overrides: @Sendable () -> [String: String]
  private let auditLogPath: String?
  private let timing: Timing
  /// Seconds that do not jump with the wall clock (a refresh that falls due during sleep just runs after it).
  private let clock: @Sendable () -> Double
  private let cond = NSCondition()
  private var good: [String: String]?
  private var inFlight = false
  private var nextAttempt: Double = 0
  private var failures = 0

  public init(
    probe: SystemProbe, appEnv: [String: String], overrides: @escaping @Sendable () -> [String: String], auditLogPath: String?,
    timing: Timing = Timing(), clock: @escaping @Sendable () -> Double = { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 }
  ) {
    self.probe = probe
    self.appEnv = appEnv
    self.overrides = overrides
    self.auditLogPath = auditLogPath
    self.timing = timing
    self.clock = clock
  }

  /// Starts a read in the background when one is due and none is running. Returns at once.
  public func refresh() {
    cond.lock()
    startIfDueLocked()
    cond.unlock()
  }

  /// The environment for a start made now. See the type's note for when this waits.
  public func env() -> [String: String] {
    cond.lock()
    startIfDueLocked()
    if good == nil, failures == 0, inFlight, !Thread.isMainThread {
      let until = Date().addingTimeInterval(timing.waitLimit)
      while good == nil, failures == 0, inFlight, cond.wait(until: until) {}
    }
    let shell = good
    cond.unlock()
    return LoginShellEnv.build(shellEnv: shell ?? appEnv, overrides: overrides())
  }

  /// Whether a login-shell read has worked since the app opened.
  public var hasLoginEnv: Bool {
    cond.lock()
    defer { cond.unlock() }
    return good != nil
  }

  private func startIfDueLocked() {
    guard !inFlight, clock() >= nextAttempt else { return }
    inFlight = true
    DispatchQueue.global(qos: .userInitiated).async { [self] in finish(probe.loginShellEnv()) }
  }

  private func finish(_ read: [String: String]?) {
    cond.lock()
    inFlight = false
    let hadGood = good != nil
    if let read {
      good = read
      failures = 0
      nextAttempt = clock() + timing.refreshAfter
    } else {
      failures += 1
      nextAttempt = clock() + min(timing.retryAfter * pow(2, Double(min(failures, 16) - 1)), timing.retryCap)
    }
    cond.broadcast()
    cond.unlock()
    guard read == nil, let path = auditLogPath else { return }
    let from = hadGood ? "last_good" : (overrides()["PATH"] == nil ? "app" : "desktop.json")
    let ts = ISO8601DateFormatter().string(from: Date())
    AuditLog.append("\(ts) workers login_env_unreadable path_from=\(from)\n", to: path)
  }
}
