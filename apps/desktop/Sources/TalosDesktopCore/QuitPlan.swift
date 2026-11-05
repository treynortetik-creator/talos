import Foundation

/// One rule for every way Talos can be asked to quit: the top menu, the menu bar, the Dock menu and the system (Activity
/// Monitor, an update, logout). On the app's own terminal the agent is stopped first; with tmux it keeps running; a logout
/// or shutdown never waits.
public enum QuitPlan {
  public enum Decision: Equatable, Sendable {
    case terminateNow
    /// Quit now, but start the stop first and do not wait for it (a logout or shutdown must never hang).
    case terminateNowAfterStopRequest
    /// Hold the quit, stop the agent, then quit.
    case stopThenTerminate
  }

  public struct Inputs: Equatable, Sendable {
    /// macOS announced a logout, restart or shutdown (`NSWorkspace.willPowerOffNotification`).
    public var systemPowerOff: Bool
    /// The agent runs in tmux, which outlives Talos.
    public var hostKeepsAgent: Bool
    /// The owner chose "Quit and stop the agent".
    public var stopRequested: Bool
    /// A session is starting, running, restarting or stopping.
    public var sessionActive: Bool
    public init(systemPowerOff: Bool = false, hostKeepsAgent: Bool, stopRequested: Bool = false, sessionActive: Bool) {
      self.systemPowerOff = systemPowerOff
      self.hostKeepsAgent = hostKeepsAgent
      self.stopRequested = stopRequested
      self.sessionActive = sessionActive
    }
  }

  public static func decide(_ i: Inputs) -> Decision {
    if i.systemPowerOff {
      // Never hold a logout. On the app's own terminal the child dies with Talos anyway; ask it to stop on the way out.
      return (i.sessionActive && (!i.hostKeepsAgent || i.stopRequested)) ? .terminateNowAfterStopRequest : .terminateNow
    }
    if i.stopRequested { return .stopThenTerminate }
    if !i.hostKeepsAgent && i.sessionActive { return .stopThenTerminate }
    return .terminateNow
  }

  /// The longest a quit waits for the stop (SIGTERM, then SIGKILL after the grace). Logout never waits at all.
  public static let stopLimit: Double = 15
}

/// Runs the stop for a held quit. Everything is injected, so a test drives it with a fake clock. It starts the stop once, ends
/// once (stopped, or the limit passed on the monotonic clock) and ignores every call after that. A second Quit while it runs
/// joins the same stop; it never starts another.
public final class QuitDriver: @unchecked Sendable {
  private let lock = NSLock()
  private let limit: Double
  private let uptime: () -> Double
  private let stop: () -> Void
  private let isStopped: () -> Bool
  private let finish: (_ timedOut: Bool) -> Void
  private var deadline: Double?
  private var done = false

  /// `uptime` must be monotonic (`ProcessInfo.systemUptime`): a wall clock that jumps must not end the wait early or stretch it.
  public init(
    limit: Double = QuitPlan.stopLimit, uptime: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime },
    stop: @escaping () -> Void, isStopped: @escaping () -> Bool, finish: @escaping (_ timedOut: Bool) -> Void
  ) {
    self.limit = limit
    self.uptime = uptime
    self.stop = stop
    self.isStopped = isStopped
    self.finish = finish
  }

  public var isFinished: Bool { lock.withLock { done } }
  public var isRunning: Bool { lock.withLock { deadline != nil && !done } }

  /// Starts the stop (once). Returns false when it already started or ended.
  @discardableResult
  public func begin() -> Bool {
    let first: Bool = lock.withLock {
      guard deadline == nil, !done else { return false }
      deadline = uptime() + limit
      return true
    }
    if first { stop() }
    return first
  }

  /// Call every few tenths of a second while held. Ends the quit when the agent has stopped or the limit passed.
  public func poll() {
    let stopped = isStopped()
    let outcome: Bool? = lock.withLock {
      guard !done, let d = deadline else { return nil }
      let timedOut = uptime() >= d
      guard stopped || timedOut else { return nil }
      done = true
      return stopped ? false : true
    }
    if let t = outcome { finish(t) }
  }
}
