import Foundation
import TalosDesktopCore

/// Watches the workers' heartbeat from its own queue, so a tick that stops while the app lives can't go unnoticed for hours. When the
/// heartbeat is older than `staleAfter` it writes one line to the app's log and files one problem for the stall (what the tick was doing,
/// and for how long), then gets the loop going again:
/// - the tick waits on a child process for `callLimit` or more: that child is killed, and the call answers "timed out" (WorkerTickWatch.swift).
///   The runner bounds its own calls well inside that, so this is a backstop for a child that outlives them;
/// - no tick has run for `staleAfter`: the loop's timer is re-made, on the workers' queue, so there is never a second loop beside a live one.
///   Ticks that run but cannot write the file are reported, not restarted;
/// - the tick is stuck in a step that is not a child (a read, a wait): nothing can safely be cut, so it is reported and watched.
/// A passive copy of the app (no `workers.lock`) writes no heartbeat and is left alone. Times are on the manager's awake clock.
public final class WorkerWatchdog: @unchecked Sendable {
  public enum Action: Equatable, Sendable {
    case none
    case waiting
    case cancelledCall(String)
    case restartedLoop
  }

  /// A heartbeat is due every `Options.heartbeat` (5 s); the hub gives up on it after 15 s.
  public var staleAfter: Double = 20
  /// Past the runner's own limit (10 s, then SIGTERM and SIGKILL): a child still running by then is not coming back by itself.
  public var callLimit: Double = 18
  public var period: Double = 5

  private let q = DispatchQueue(label: "talos.workers.watchdog")
  private var timer: DispatchSourceTimer?
  private weak var manager: WorkerManager?
  /// When (awake clock) the stall now going on was first seen; nil while the heartbeat is on time.
  private var stalledSince: Double?
  private var restartLogged = false
  /// Tests: replaces the log line and the problem file.
  public var onStall: (@Sendable (_ message: String) -> Void)?

  init(manager: WorkerManager) { self.manager = manager }

  func start() {
    q.async {
      guard self.timer == nil else { return }
      let t = DispatchSource.makeTimerSource(queue: self.q)
      t.schedule(deadline: .now() + self.period, repeating: self.period)
      t.setEventHandler { [weak self] in _ = self?.checkLocked() }
      self.timer = t
      t.resume()
    }
  }

  func stop() {
    q.async {
      self.timer?.cancel()
      self.timer = nil
      self.stalledSince = nil
    }
  }

  /// One look, now (tests; the timer calls the same).
  @discardableResult
  public func check() -> Action { q.sync { checkLocked() } }

  private func checkLocked() -> Action {
    guard let m = manager else { return .none }
    let v = m.watch.view()
    let t = m.awake()
    guard v.supervising, t - v.lastBeat > staleAfter else {
      if let since = stalledSince {
        stalledSince = nil
        restartLogged = false
        m.audit("workers_heartbeat recovered after=\(Int(t - since))s")
      }
      return .none
    }
    if stalledSince == nil {
      stalledSince = v.lastBeat
      report(m, Self.describe(v, at: t), key: v.step)
    }
    if let c = m.watch.cancelChild(olderThan: callLimit, at: t) {
      m.audit("workers_heartbeat cancelled=\"\(c.what)\" after=\(Int(t - c.since))s")
      return .cancelledCall(c.what)
    }
    if !v.inTick, t - v.stepSince > staleAfter {
      m.restartTicking()
      if !restartLogged { m.audit("workers_heartbeat restarted_loop") }
      restartLogged = true
      return .restartedLoop
    }
    return .waiting
  }

  private func report(_ m: WorkerManager, _ message: String, key: String) {
    if let onStall { return onStall(message) }
    m.audit("workers_heartbeat stalled \(message)")
    MacProblem.file(
      home: m.options.talosHome, name: "WorkerHeartbeatStalled", message: message, key: key,
      at: Date(timeIntervalSince1970: m.now()))
  }

  /// Step and command names and whole seconds only.
  static func describe(_ v: TickWatch.View, at t: Double) -> String {
    var parts = ["heartbeat \(Int(t - v.lastBeat))s old", v.inTick ? "tick in step \(v.step) for \(Int(t - v.stepSince))s" : "last tick ended \(Int(t - v.stepSince))s ago"]
    if let c = v.child { parts.append("waiting on \(c.what) for \(Int(t - c.since))s") }
    if let e = v.writeError { parts.append("last write failed: \(e)") }
    return parts.joined(separator: "; ")
  }
}
